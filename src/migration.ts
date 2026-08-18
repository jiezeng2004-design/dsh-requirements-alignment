/**
 * Legacy session artifact migration for Requirements Alignment — the
 * EXPLICIT, gated recovery path for sessions whose logs still carry the
 * private `alignment/*` events this plugin used to append.
 *
 * Phase 1 (this module): compatibility repair of the persisted artifact.
 *
 *   decode the artifact (concatenated checksummed Zstandard frames)
 *   -> parse header + every event line
 *   -> add `ignorable: true` to whitelisted legacy alignment events ONLY
 *   -> re-encode (same physical format)
 *   -> verify event invariants on the temp artifact
 *   -> load the temp artifact through the REAL DSH persistence reader
 *   -> atomic replace, with a byte-for-byte backup + SHA-256 of the original
 *
 * Every step must pass before the original file is touched; any failure
 * leaves the original byte-identical and rethrows. The repair is idempotent:
 * an artifact whose whitelisted alignment events already carry
 * `ignorable: true` is left untouched (no rewrite, no new backup).
 *
 * The ONLY permitted change is the envelope key `ignorable: true` on the six
 * legacy alignment event types (`LEGACY_ALIGNMENT_EVENT_TYPES`). Type, seq,
 * time, data, event order, and event count never change; foreign events —
 * including other unknown event types — stay byte-identical, so a session
 * carrying an unrelated unknown event still refuses to load AFTER migration
 * (over-repairing would hide exactly the incompatibility this tool must not
 * paper over).
 *
 * Never treat `.jsonl.zstd` as text: the codec below is the migration-specific
 * strict re-implementation of the rc.6 concatenated-frame container
 * (magic, frame header, block walk, 4-byte content checksum), re-encoding
 * with the same checksummed frames the backend writes.
 *
 * @module dsh-requirements-alignment/migration
 */
import { createHash } from 'node:crypto';
import {
    mkdir, mkdtemp, readFile, rename, rm, writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { constants, zstdCompress, zstdDecompress } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
import { SessionId, SessionStore, decodeStorageRecord, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import { SessionFormatUnsupportedError, type SessionPersistence, type SessionLocation } from '@deepseek-ai/dsh-session-persistence';
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { isLegacyAlignmentEventType, LEGACY_ALIGNMENT_EVENT_TYPES } from './types.ts';

const zstdCompressAsync = promisify(zstdCompress);
const zstdDecompressAsync = promisify(zstdDecompress);
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } } as const;

/** The zstd frame magic (little-endian bytes `28 B5 2F FD`). */
const ZSTD_MAGIC = 0xfd2fb528;

/** Physical encoding of one artifact, from its filename suffix. */
export type ArtifactCompression = 'zstd' | 'none';

/** Byte range of one structurally complete Zstandard frame. */
export interface ZstdFrameRange {
    start: number;
    end: number;
}

/**
 * Structural scan of a concatenated Zstandard stream: locate complete frames
 * by walking the frame header and block headers (magic, FHD flags, window
 * descriptor, optional dict id / frame content size, block size fields, and
 * the 4-byte content checksum when flagged). Invalid complete structure
 * rejects; EOF inside a frame reports its start as a torn tail.
 */
export function scanZstdFrames(buffer: Buffer, maxFrames: number = Number.POSITIVE_INFINITY): {
    frames: ZstdFrameRange[];
    tornStart?: number;
} {
    const frames: ZstdFrameRange[] = [];
    let offset = 0;
    while (offset < buffer.length) {
        if (frames.length >= maxFrames) break;
        if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
            return { frames, tornStart: offset };
        }
        const descriptor = buffer[offset + 4]!;
        const contentSizeFlag = descriptor >> 6;
        const singleSegment = (descriptor >> 5) & 1;
        const checksumFlag = (descriptor >> 2) & 1;
        const dictFlag = descriptor & 3;
        let pos = offset + 5;
        if (singleSegment === 0) pos += 1; // window descriptor
        if (dictFlag !== 0) pos += [0, 1, 2, 4][dictFlag]!; // dictionary id
        if (contentSizeFlag !== 0) pos += [0, 1, 2, 8][contentSizeFlag]!; // frame content size
        else if (singleSegment !== 0) pos += 1; // single-segment frames always carry FCS (1 byte when flag 0)
        let last = false;
        while (!last) {
            if (pos + 3 > buffer.length) return { frames, tornStart: offset };
            const blockHeader = buffer.readUIntLE(pos, 3);
            last = (blockHeader & 1) === 1;
            const blockType = (blockHeader >> 1) & 3;
            const blockSize = blockHeader >> 3;
            pos += 3;
            if (blockType === 0) {
                pos += blockSize; // raw block
            } else if (blockType === 1) {
                pos += 1; // RLE block
            } else if (blockType === 2) {
                pos += 4 + (blockSize - 4); // compressed block: 4-byte regenerated size + payload
            } else {
                throw new Error(`corrupt Zstandard session log: reserved block type at byte ${pos - 3}`);
            }
            if (pos > buffer.length) return { frames, tornStart: offset };
        }
        if (checksumFlag !== 0) pos += 4; // content checksum
        if (pos > buffer.length) return { frames, tornStart: offset };
        frames.push({ start: offset, end: pos });
        offset = pos;
    }
    return { frames };
}

/** Decompress every complete frame and concatenate the plaintext. */
export async function decompressZstdFrames(buffer: Buffer): Promise<string> {
    const { frames, tornStart } = scanZstdFrames(buffer);
    if (tornStart !== undefined) {
        throw new Error(`corrupt Zstandard session log: incomplete final frame at byte ${tornStart}`);
    }
    let text = '';
    for (const frame of frames) {
        const plain = await zstdDecompressAsync(buffer.subarray(frame.start, frame.end));
        text += plain.toString('utf8');
    }
    return text;
}

/** Compress one checksummed Zstandard frame (the backend's frame format). */
export async function compressZstdFrame(input: string | Buffer): Promise<Buffer> {
    return zstdCompressAsync(Buffer.from(input), CHECKSUM_OPTIONS);
}

/** The artifact layout helpers (mirrors of the rc.6 JSONL backend). */
function encodeSegment(raw: string): string {
    if (raw.length === 0) throw new Error('cannot encode an empty path segment');
    if (raw === '.') return '~002E';
    if (raw === '..') return '~002E~002E';
    let out = '';
    for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        const ch = String.fromCharCode(code);
        if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
        else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
    }
    return out;
}

function projectKey(cwd: string): string {
    if (cwd.length === 0) throw new Error('cannot encode an empty project path');
    let readable = '';
    let separatorRun = false;
    for (let i = 0; i < cwd.length; i++) {
        const code = cwd.charCodeAt(i);
        const ch = String.fromCharCode(code);
        if (ch === '/' || ch === '\\' || ch === ':') {
            if (!separatorRun) readable += '-';
            separatorRun = true;
        } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
            readable += ch;
            separatorRun = false;
        } else {
            readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
            separatorRun = false;
        }
    }
    return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** The session artifact path the JSONL backend resolves for a session. */
export function artifactPathFor(root: string, cwd: string | undefined, id: string, compression: ArtifactCompression): string {
    const project = cwd === undefined ? '_no-cwd' : projectKey(cwd);
    return join(root, project, encodeSegment(id), compression === 'zstd' ? 'session.jsonl.zstd' : 'session.jsonl');
}

/** Detect the artifact encoding from its file name. */
export function compressionOf(filename: string): ArtifactCompression | undefined {
    if (filename.endsWith('.jsonl.zstd')) return 'zstd';
    if (filename.endsWith('.jsonl')) return 'none';
    return undefined;
}

/** Structural header validation mirroring the rc.6 backend's `isHeaderLine`. */
export function parseAndValidateHeaderLine(line: string): SessionHeader {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch (error) {
        throw new Error('migration: artifact header line is not valid JSON', { cause: error });
    }
    const fail = (why: string): never => { throw new Error(`migration: invalid session header: ${why}`); };
    if (typeof parsed !== 'object' || parsed === null) fail('not an object');
    const value = parsed as Record<string, unknown>;
    if (value.type !== 'session') fail('first line is not a session record');
    const numberField = (field: unknown, why: string): number => {
        if (typeof field !== 'number') throw new Error(`migration: invalid session header: ${why}`);
        return field;
    };
    const stringField = (field: unknown, why: string): string => {
        if (typeof field !== 'string') throw new Error(`migration: invalid session header: ${why}`);
        return field;
    };
    const version = numberField(value.version, 'version must be a number');
    if (version !== 0) fail(`unsupported format version ${String(version)} (this build reads 0)`);
    const id = stringField(value.id, 'id must be a string');
    const createdAt = numberField(value.createdAt, 'createdAt must be a non-negative safe integer');
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) fail('createdAt must be a non-negative safe integer');
    const delegationDepth = numberField(value.delegationDepth, 'delegationDepth must be a non-negative safe integer');
    if (!Number.isSafeInteger(delegationDepth) || delegationDepth < 0) fail('delegationDepth must be a non-negative safe integer');
    if (value.origin !== undefined && value.origin !== 'subagent') fail('origin must be "subagent" when present');
    if (value.agentPreset !== undefined && typeof value.agentPreset !== 'string') fail('agentPreset must be a string when present');
    const cwd = value.cwd;
    if (cwd !== undefined && typeof cwd !== 'string') fail('cwd must be a string when present');
    const parentSession = value.parentSession;
    if (parentSession !== undefined && typeof parentSession !== 'string') fail('parentSession must be a string when present');
    const seedLength = value.seedLength;
    if (seedLength !== undefined && typeof seedLength !== 'number') fail('seedLength must be a number when present');
    const origin = value.origin;
    const agentPreset = value.agentPreset;
    return {
        version,
        id: id as SessionId,
        createdAt,
        ...(cwd === undefined ? {} : { cwd: cwd as string }),
        ...(parentSession === undefined ? {} : { parentSession: parentSession as SessionId }),
        ...(seedLength === undefined ? {} : { seedLength: seedLength as number }),
        ...(origin === undefined ? {} : { origin: origin as 'subagent' }),
        delegationDepth,
        ...(agentPreset === undefined ? {} : { agentPreset: agentPreset as string })
    };
}

/**
 * Repair one parsed event record: whitelisted alignment events that do not
 * carry `ignorable: true` yet get it; everything else is returned unchanged.
 */
export function repairEventEnvelope(record: Record<string, unknown>): Record<string, unknown> {
    if (typeof record.type === 'string' && isLegacyAlignmentEventType(record.type) && record.ignorable !== true) {
        return { ...record, ignorable: true };
    }
    return record;
}

/** A parsed artifact: header line + ordered event lines + the expanded logical events. */
export interface ParsedArtifact {
    header: SessionHeader;
    headerLine: string;
    /** The event lines in order (packed rows included, verbatim). */
    lines: string[];
    /** The expanded logical events (packed rows expanded via the DSH decoder). */
    events: SessionEvent[];
}

/** Parse artifact text: validate the header and every line, expand packed rows. */
export function parseArtifactText(text: string): ParsedArtifact {
    const normalized = text.endsWith('\n') ? text : text + '\n';
    const lines = normalized.split('\n');
    const last = lines[lines.length - 1];
    if (last !== '') throw new Error('migration: artifact text does not end with a newline-terminated record');
    lines.pop();
    const [headerLine, ...eventLines] = lines;
    if (headerLine === undefined) throw new Error('migration: artifact has no header line');
    const header = parseAndValidateHeaderLine(headerLine);
    const events: SessionEvent[] = [];
    for (const line of eventLines) {
        if (line === '') throw new Error('migration: empty line in artifact');
        let record: unknown;
        try {
            record = JSON.parse(line);
        } catch (error) {
            throw new Error('migration: event line is not valid JSON', { cause: error });
        }
        if (typeof record !== 'object' || record === null) throw new Error('migration: event line is not an object');
        const expanded = decodeStorageRecord(record as Record<string, unknown>);
        for (const event of expanded) {
            if (typeof event.type !== 'string' || typeof event.seq !== 'number') {
                throw new Error('migration: malformed event row (missing type/seq)');
            }
            events.push(event as SessionEvent);
        }
    }
    for (let index = 0; index < events.length; index++) {
        const event = events[index]!;
        if (event.seq !== index) {
            throw new Error(`migration: non-contiguous seq at index ${index}: expected ${index}, got ${event.seq}`);
        }
    }
    return { header, headerLine, lines: eventLines, events };
}

/** Deep equality of two JSON values (structural, no prototypes). */
function jsonEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    const aArr = Array.isArray(a);
    const bArr = Array.isArray(b);
    if (aArr !== bArr) return false;
    if (aArr) {
        const aa = a as unknown[];
        const bb = b as unknown[];
        if (aa.length !== bb.length) return false;
        return aa.every((entry, index) => jsonEqual(entry, bb[index]));
    }
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => jsonEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/**
 * The services the migration needs: the persistence seam plus an optional
 * live-session registry for the no-live-writer gate.
 */
export interface MigrationServices {
    /** The session persistence service (`ctx.sessionPersistence`). */
    persistence: SessionPersistence;
    /** The live session store (`ctx.sessions`), when mounted. */
    sessions?: { get(id: SessionId): unknown };
}

/** The result of one migration run. */
export interface MigrationReport {
    /** The migrated session id. */
    id: string;
    /** Absolute path of the (possibly replaced) artifact. */
    artifactPath: string;
    /** Physical encoding of the artifact. */
    compression: ArtifactCompression;
    /** SHA-256 of the ORIGINAL artifact bytes (before replacement). */
    originalSha256: string;
    /** Absolute path of the byte-for-byte backup of the original. */
    backupPath?: string;
    /** How many legacy alignment events gained `ignorable: true`. */
    repairedEvents: number;
    /** False when the artifact needed no repair (idempotent no-op). */
    migrated: boolean;
    /** The validated session header. */
    header: SessionHeader;
    /**
     * When the repaired artifact still refuses to load because of an
     * UNRELATED unknown event (out of the legacy alignment vocabulary), the
     * reader's refusal message. The repair itself succeeded — the foreign
     * event is out of scope and must be handled by its owning plugin.
     */
    foreignRefusal?: string;
}

/** The real-reader gate result: the temp artifact either loads, or refuses for a FOREIGN reason. */
interface ReaderGateResult {
    /** Whether the real reader accepted the temp artifact as-is. */
    loadable: boolean;
    /** The refusal reason, when it is NOT caused by a legacy alignment event. */
    foreignRefusal?: string;
}

/**
 * The bare DSH reader gate: stage the artifact and load it with the REAL
 * reader. A refusal caused by a whitelisted legacy alignment event means the
 * repair is INCOMPLETE and the migration must abort; a refusal caused by an
 * unrelated unknown event is out of scope and reported as `foreignRefusal`
 * (the migration still replaces — the whitelisted events are repaired).
 */
async function verifyWithRealReader(
    id: string,
    cwd: string | undefined,
    compression: ArtifactCompression,
    artifactBytes: Buffer
): Promise<ReaderGateResult> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-alignment-migrate-'));
    try {
        const target = artifactPathFor(root, cwd, id, compression);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, artifactBytes);
        const ctx = new Context();
        try {
            ctx.plugin(SessionStore);
            await ctx.plugin(JsonlSessionPersistence, {
                root,
                packChunks: true,
                compression: compression === 'zstd' ? 'zstd' : 'none'
            });
            await ctx.sessionPersistence.inspect(SessionId(id));
            return { loadable: true };
        } catch (error) {
            if (error instanceof SessionFormatUnsupportedError) {
                const message = error.message;
                const whitelisted = [...LEGACY_ALIGNMENT_EVENT_TYPES].filter((type) => message.includes(type));
                if (whitelisted.length > 0) throw error; // repair incomplete: never replace
                return { loadable: false, foreignRefusal: message };
            }
            throw error;
        } finally {
            // Dispose the root fiber (the runtime `ctx.fiber` shape).
            const fiber = (ctx as unknown as { fiber?: { dispose(): Promise<void> } }).fiber;
            await fiber?.dispose().catch(() => { });
        }
    } finally {
        await rm(root, { recursive: true, force: true }).catch(() => { });
    }
}

/** Atomic replace with a POSIX rename and a Windows fallback + restore. */
async function atomicReplace(tempPath: string, targetPath: string, backupPath: string): Promise<void> {
    try {
        await rename(tempPath, targetPath);
    } catch {
        // Windows cannot rename over an existing file: remove then rename.
        // The byte-for-byte backup covers the small window; restore on failure.
        try {
            await rm(targetPath, { force: true });
            await rename(tempPath, targetPath);
        } catch (error) {
            await readFile(backupPath).then((bytes) => writeFile(targetPath, bytes)).catch(() => { });
            throw error;
        }
    }
}

/**
 * Migrate one session artifact (explicit, gated, idempotent). The original
 * file is replaced ONLY when every safety gate passes; any failure leaves it
 * byte-identical.
 *
 * @param id The persisted session id to repair.
 * @param services Persistence seam + optional live-session guard.
 * @param options Optional behavior switches.
 * @throws When any gate fails (original untouched), when the session has no
 *   materialized artifact, or when the session is currently live.
 */
export async function migrateLegacyArtifact(
    id: SessionId,
    services: MigrationServices,
    options: { signal?: AbortSignal } = {}
): Promise<MigrationReport> {
    const { persistence, sessions } = services;
    const raw = await persistence.readRaw(id, options.signal);
    if (raw === undefined) {
        throw new Error(`migration: no stored session artifact found for ${String(id)}`);
    }
    const location: SessionLocation | undefined = persistence.locate(raw.meta);
    if (location === undefined) {
        throw new Error(`migration: backend provides no artifact location for ${String(id)}`);
    }
    // The physical encoding comes from the real artifact path (the raw read's
    // `filename` is a fixed base name and does not carry the suffix).
    const compression = compressionOf(location.path);
    if (compression === undefined) {
        throw new Error(`migration: unrecognized artifact path "${location.path}" for ${String(id)}`);
    }
    if (sessions !== undefined && sessions.get(id) !== undefined) {
        throw new Error(`migration: session ${String(id)} has a live writer; close/resume it before migrating`);
    }
    // The artifact is staged at `location.path`; when the backend cannot
    // resolve it there, fall back to the layout helper.
    let artifactPath = location.path;
    let bytes: Buffer;
    try {
        bytes = await readFile(artifactPath);
    } catch {
        const staged = artifactPathFor(dirname(artifactPath), raw.meta.cwd, String(id), compression);
        bytes = await readFile(staged);
        artifactPath = staged;
    }
    const originalSha256 = createHash('sha256').update(bytes).digest('hex');

    // Decode. For zstd artifacts a torn final frame means the artifact was
    // never cleanly closed: refuse (the normal load path repairs it).
    let text: string;
    if (compression === 'zstd') {
        text = await decompressZstdFrames(bytes);
    } else {
        text = bytes.toString('utf8');
    }
    // Cross-check our decode against the backend's own raw read.
    if (raw.content !== text) {
        throw new Error('migration: decoded artifact differs from the backend raw read; refusing to proceed');
    }
    const parsed = parseArtifactText(text);

    // Repair: whitelisted alignment events gain ignorable:true; nothing else changes.
    let repairedEvents = 0;
    const repairedLines: string[] = [];
    for (const line of parsed.lines) {
        let record: Record<string, unknown>;
        try {
            record = JSON.parse(line) as Record<string, unknown>;
        } catch (error) {
            throw new Error('migration: event line is not valid JSON', { cause: error });
        }
        if (isLegacyAlignmentEventType(String(record.type)) && record.ignorable !== true) {
            repairedEvents++;
            repairedLines.push(JSON.stringify(repairEventEnvelope(record)));
        } else {
            repairedLines.push(line);
        }
    }
    if (repairedEvents === 0) {
        // Idempotent no-op: nothing to repair, leave the artifact untouched.
        return {
            id: String(id),
            artifactPath,
            compression,
            originalSha256,
            migrated: false,
            repairedEvents: 0,
            header: parsed.header
        };
    }

    // Re-encode: header frame + events frame (checksummed), or plain text.
    const headerText = parsed.headerLine + '\n';
    const eventsText = repairedLines.join('\n') + '\n';
    const tempPath = join(dirname(artifactPath), `.session.migration-${Date.now()}.tmp`);
    let newBytes: Buffer;
    if (compression === 'zstd') {
        const headerFrame = await compressZstdFrame(headerText);
        const eventsFrame = await compressZstdFrame(eventsText);
        newBytes = Buffer.concat([headerFrame, eventsFrame]);
    } else {
        newBytes = Buffer.from(headerText + eventsText, 'utf8');
    }
    await mkdir(dirname(tempPath), { recursive: true });
    await writeFile(tempPath, newBytes);

    // Verify the temp artifact: decode fully + event invariants.
    let foreignRefusal: string | undefined;
    try {
        const tempText = compression === 'zstd'
            ? await decompressZstdFrames(newBytes)
            : newBytes.toString('utf8');
        const repaired = parseArtifactText(tempText);
        if (repaired.events.length !== parsed.events.length) {
            throw new Error(`migration: event count changed (${parsed.events.length} -> ${repaired.events.length})`);
        }
        for (let index = 0; index < parsed.events.length; index++) {
            const before = parsed.events[index]!;
            const after = repaired.events[index]!;
            if (after.type !== before.type || after.seq !== before.seq || after.time !== before.time) {
                throw new Error(`migration: event ${index} envelope changed (type/seq/time)`);
            }
            if (!jsonEqual(after.data, before.data)) {
                throw new Error(`migration: event ${index} data changed`);
            }
            const wasLegacy = isLegacyAlignmentEventType(before.type);
            if (!wasLegacy && after.ignorable === true) {
                throw new Error(`migration: non-whitelisted event ${index} gained ignorable`);
            }
            if (wasLegacy && before.ignorable !== true && after.ignorable !== true) {
                throw new Error(`migration: legacy event ${index} did not gain ignorable`);
            }
        }
        // Load the temp artifact through the REAL DSH persistence reader.
        const gate = await verifyWithRealReader(parsed.header.id, parsed.header.cwd, compression, newBytes);
        if (!gate.loadable) {
            // The whitelisted alignment events are repaired, but the session
            // still carries an unrelated unknown event: the migration scope is
            // exactly the legacy alignment vocabulary, so the repair proceeds
            // and the foreign refusal is recorded.
            foreignRefusal = gate.foreignRefusal;
        }
    } catch (error) {
        await rm(tempPath, { force: true }).catch(() => { });
        throw error;
    }

    // All gates passed: byte-for-byte backup, then atomic replace.
    const backupPath = join(dirname(artifactPath), `session.jsonl.zstd.bak-${Date.now()}`);
    await writeFile(backupPath, bytes);
    try {
        await atomicReplace(tempPath, artifactPath, backupPath);
    } catch (error) {
        await rm(tempPath, { force: true }).catch(() => { });
        throw error;
    }
    return {
        id: String(id),
        artifactPath,
        compression,
        originalSha256,
        backupPath,
        migrated: true,
        repairedEvents,
        header: parsed.header,
        ...(foreignRefusal === undefined ? {} : { foreignRefusal })
    };
}

export default migrateLegacyArtifact;
