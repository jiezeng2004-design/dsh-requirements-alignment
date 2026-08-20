/**
 * Dogfood-only helper: fold the PERSISTED alignment state of an interrupted
 * DSH run from the canonical sidecar (`storages/requirements_alignment.json`),
 * and optionally simulate the post-resume `establish_baseline` call.
 *
 * Usage:
 *   node scripts/fold-session.mjs <dshHome> <sessionId> [--simulate-update <goal>]
 *
 * Output (JSON):
 *   { found, source, file, before: <AlignmentStatus>, summary, after? }
 *
 * Prefers the sidecar (v0.2.2+ canonical medium). Falls back to the legacy
 * session-log fold only when the sidecar has no record for this session —
 * old v0.1/v0.2 artifacts, never a live production path.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { decodeStorageRecord } from '@deepseek-ai/dsh-session';
import { foldAlignmentStatus, foldRequirementBaseline } from '../lib/status.js';
import { buildBaseline } from '../lib/baseline-tool.js';
import { baselineSummary } from '../lib/policy.js';
import {
    parseSidecarDocument,
    statusFromSidecarRecord,
    simulateSidecarBaselineUpdate
} from '../lib/sidecar-fold.js';

const [dshHome, sessionId, ...rest] = process.argv.slice(2);
const simulateIndex = rest.indexOf('--simulate-update');
const simulateGoal = simulateIndex >= 0 ? rest[simulateIndex + 1] : undefined;

if (!dshHome || !sessionId) {
    console.error('usage: node scripts/fold-session.mjs <dshHome> <sessionId> [--simulate-update <goal>]');
    process.exit(2);
}

/** Recursively find a file whose basename matches `name`. */
function findFileNamed(root, name) {
    if (!existsSync(root)) return undefined;
    const queue = [root];
    while (queue.length > 0) {
        const dir = queue.shift();
        let entries;
        try {
            entries = readdirSync(dir);
        } catch {
            continue;
        }
        for (const entry of entries) {
            const path = join(dir, entry);
            let st;
            try {
                st = statSync(path);
            } catch {
                continue;
            }
            if (st.isDirectory()) {
                queue.push(path);
            } else if (entry === name) {
                return path;
            }
        }
    }
    return undefined;
}

/** Recursively find the session log file for one session id. */
function findSessionFile(root, id) {
    const sessionsRoot = join(root, 'sessions');
    if (!existsSync(sessionsRoot)) return undefined;
    const queue = [sessionsRoot];
    while (queue.length > 0) {
        const dir = queue.shift();
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) {
                if (name === id) {
                    for (const candidate of ['session.jsonl.zstd', 'session.jsonl']) {
                        const file = join(path, candidate);
                        if (existsSync(file)) return file;
                    }
                    return undefined;
                }
                queue.push(path);
            }
        }
    }
    return undefined;
}

const ZSTD_MAGIC = 0xFD2FB528;

/** Locate complete zstd frames (same scan as dsh-session-persistence-jsonl). */
function scanZstdFrames(buffer) {
    const frames = [];
    let offset = 0;
    while (offset < buffer.length) {
        const start = offset;
        if (buffer.length - offset < 4) return frames;
        if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt session log: bad frame magic at byte ${offset}`);
        offset += 4;
        if (offset === buffer.length) return frames;
        const descriptor = buffer.readUInt8(offset);
        offset += 1;
        if ((descriptor & 24) !== 0) throw new Error(`corrupt session log: reserved frame-header bit at byte ${offset - 1}`);
        const contentSizeFlag = descriptor >>> 6;
        const singleSegment = (descriptor & 32) !== 0;
        const checksum = (descriptor & 4) !== 0;
        const dictionaryFlag = descriptor & 3;
        const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
        const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
        const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
        if (buffer.length - offset < remainingHeaderBytes) return frames;
        offset += remainingHeaderBytes;
        for (;;) {
            if (buffer.length - offset < 3) return frames;
            const blockHeader = buffer.readUIntLE(offset, 3);
            offset += 3;
            const lastBlock = (blockHeader & 1) !== 0;
            const blockType = blockHeader >>> 1 & 3;
            const blockSize = blockHeader >>> 3;
            if (blockType === 3) throw new Error(`corrupt session log: reserved block type at byte ${offset - 3}`);
            const payloadBytes = blockType === 1 ? 1 : blockSize;
            if (buffer.length - offset < payloadBytes) return frames;
            offset += payloadBytes;
            if (lastBlock) break;
        }
        if (checksum) {
            if (buffer.length - offset < 4) return frames;
            offset += 4;
        }
        frames.push({ start, end: offset });
    }
    return frames;
}

/** Read and decode the persisted log into { seq, time, type, data } events. */
function readEvents(file) {
    const isZstd = basename(file).endsWith('.zstd');
    const events = [];
    if (!isZstd) {
        for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
            if (line.trim() === '') continue;
            const parsed = JSON.parse(line);
            if (parsed.type === 'session') continue;
            for (const event of decodeStorageRecord(parsed)) events.push(event);
        }
        return events;
    }
    const buffer = readFileSync(file);
    for (const frame of scanZstdFrames(buffer)) {
        const plaintext = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8');
        for (const line of plaintext.split(/\r?\n/)) {
            if (line.trim() === '') continue;
            const parsed = JSON.parse(line);
            if (parsed.type === 'session') continue;
            for (const event of decodeStorageRecord(parsed)) events.push(event);
        }
    }
    return events;
}

function foldFromSidecar() {
    const direct = join(dshHome, 'storages', 'requirements_alignment.json');
    const file = existsSync(direct) ? direct : findFileNamed(dshHome, 'requirements_alignment.json');
    if (file === undefined) return undefined;
    const sessions = parseSidecarDocument(readFileSync(file, 'utf8'));
    const record = sessions[sessionId];
    if (record === undefined) return { file, record: undefined };
    const before = statusFromSidecarRecord(record);
    const out = {
        found: true,
        source: 'sidecar',
        file,
        before,
        summary: baselineSummary(before)
    };
    if (simulateGoal !== undefined) {
        out.after = simulateSidecarBaselineUpdate(record, simulateGoal);
    }
    return out;
}

function foldFromSessionLog() {
    const file = findSessionFile(dshHome, sessionId);
    if (file === undefined) return undefined;
    const events = readEvents(file);
    const before = foldAlignmentStatus(events);
    const out = {
        found: true,
        source: 'session-log',
        file,
        events: events.length,
        before,
        summary: baselineSummary(before)
    };
    if (simulateGoal !== undefined) {
        const current = foldRequirementBaseline(events);
        const baseline = buildBaseline({ goal: simulateGoal }, current, Date.now());
        const simulated = [...events, {
            seq: Math.max(0, ...events.map((e) => e.seq)) + 1,
            time: Date.now(),
            type: 'alignment/baseline-updated',
            data: { baseline }
        }];
        out.after = foldAlignmentStatus(simulated);
    }
    return out;
}

const sidecar = foldFromSidecar();
if (sidecar?.found === true) {
    console.log(JSON.stringify(sidecar, null, 2));
    process.exit(0);
}

const legacy = foldFromSessionLog();
if (legacy !== undefined) {
    console.log(JSON.stringify(legacy, null, 2));
    process.exit(0);
}

console.log(JSON.stringify({
    found: false,
    sessionId,
    sidecarFile: sidecar?.file,
    hint: 'no sidecar record and no session log for this id'
}, null, 2));
process.exit(1);
