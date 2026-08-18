/**
 * Legacy migration regressions (Test G–L): a REAL pre-fix artifact
 * (`.jsonl.zstd`, checksummed concatenated frames) carrying the legacy
 * `alignment/*` vocabulary.
 *
 *   G. a bare DSH reader refuses the legacy fixture
 *      (SessionFormatUnsupportedError — the bug the migration fixes);
 *   H. after migration, a bare DSH reader (plugin absent) loads it;
 *   I. migration preserves every event invariant: count, type, seq, time,
 *      data, order — the ONLY change is `ignorable: true` on whitelisted
 *      alignment events;
 *   J. an unrelated unknown event stays untouched, so the migrated session
 *      still refuses to load (over-repair would be a failure);
 *   K. migrating + importing yields exactly the legacy fold's AlignmentStatus;
 *   L. a legacy parent forked from a pre-v2 boundary inherits v1 — the
 *      imported timeline keeps historical boundaries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SessionId, SessionStore, type Session } from '@deepseek-ai/dsh-session';
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { Storage } from '@deepseek-ai/dsh-storage';
import { apply as storageJsonApply } from '@deepseek-ai/dsh-storage-json';
import { apply as storageDomainApply } from '@deepseek-ai/dsh-storage-domain';
import { RequirementsAlignmentController } from '../src/index.ts';
import { compressZstdFrame, migrateLegacyArtifact, parseArtifactText, scanZstdFrames } from '../src/migration.ts';
import { foldAlignmentStatus } from '../src/status.ts';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';

const CWD = join(tmpdir(), 'dsh-alignment-migration-workspace');

/** The artifact layout mirrors of the JSONL backend (same as migration.ts). */
function encodeSegment(raw: string): string {
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

/**
 * Build a legacy artifact exactly as the pre-fix writer produced it: the
 * header line plus official events and legacy alignment events (no
 * `ignorable`), encoded as checksummed zstd frames.
 */
async function writeLegacyArtifact(root: string, id: string, events: Array<Record<string, unknown>>) {
    const header = {
        type: 'session',
        version: 0,
        id,
        createdAt: 1700000000000,
        cwd: CWD,
        delegationDepth: 0
    };
    const lines = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))];
    const frames = [
        await compressZstdFrame(lines[0]! + '\n'),
        await compressZstdFrame(lines.slice(1).join('\n') + '\n')
    ];
    const target = join(root, projectKey(CWD), encodeSegment(id), 'session.jsonl.zstd');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.concat(frames));
    return target;
}

/** The legacy alignment events a v0.2 session carried (all six vocabulary types where sensible). */
function legacyAlignmentEvents(offset: number, includeStatus = false): Array<Record<string, unknown>> {
    const events: Array<Record<string, unknown>> = [
        { type: 'alignment/baseline', seq: offset, time: 1700000000100, data: { baseline: { revision: 1, goal: 'v1', updatedAt: 1700000000100 } } },
        { type: 'alignment/drift', seq: offset + 1, time: 1700000000200, data: { reason: 'scope-expansion', description: 'd1', at: 1700000000200 } },
        { type: 'alignment/decision', seq: offset + 2, time: 1700000000300, data: { driftSeq: offset + 1, decision: 'reject', at: 1700000000300 } },
        { type: 'alignment/baseline-updated', seq: offset + 3, time: 1700000000400, data: { baseline: { revision: 2, goal: 'v2', updatedAt: 1700000000400 } } },
        { type: 'alignment/manual-check', seq: offset + 4, time: 1700000000500, data: { at: 1700000000500 } }
    ];
    if (includeStatus) {
        events.push({ type: 'alignment/status', seq: offset + 5, time: 1700000000600, data: { kind: 'manual-check', at: 1700000000600 } });
    }
    return events;
}

/** Official transcript events with contiguous seqs starting at `offset`. */
function officialEvents(offset: number): Array<Record<string, unknown>> {
    return [
        { type: 'turn/start', seq: offset, time: 1700000000000, data: { turn: 1 } },
        {
            type: 'user/message', seq: offset + 1, time: 1700000000001,
            data: { id: 'm-legacy', role: 'user', content: [{ type: 'text', text: 'legacy request' }], source: { kind: 'user' } },
            surfaceOp: 'append'
        },
        { type: 'turn/end', seq: offset + 2, time: 1700000000002, data: { turn: 1, reason: { kind: 'completed' } } }
    ];
}

/** A bare reader harness (NO requirements-alignment plugin) over one sessions root. */
async function bareReader(sessionsRoot: string) {
    const ctx = new Context();
    ctx.plugin(SessionStore);
    await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, packChunks: true });
    return {
        ctx,
        dispose: async () => {
            const fiber = (ctx as unknown as { fiber?: { dispose(): Promise<void> } }).fiber;
            await fiber?.dispose().catch(() => { });
        }
    };
}

/** A full harness (storage stack + plugin) over one sessions + storages root. */
async function fullHarness(sessionsRoot: string, storagesRoot: string) {
    const ctx = new Context();
    ctx.plugin(SessionStore);
    await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, packChunks: true });
    ctx.plugin(Storage);
    await ctx.plugin({ apply: storageJsonApply, inject: ['storage'] }, { root: storagesRoot });
    await ctx.plugin({ apply: storageDomainApply, inject: ['storage'] }, { backend: 'json' });
    ctx.provide('systemPrompt', { section: () => () => { } });
    ctx.provide('tools', { register: () => () => { } });
    await ctx.plugin(RequirementsAlignmentController, { mode: 'auto' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const controller = (ctx as unknown as { requirementsAlignment?: RequirementsAlignmentController }).requirementsAlignment;
    return {
        ctx,
        controller,
        dispose: async () => {
            const fiber = (ctx as unknown as { fiber?: { dispose(): Promise<void> } }).fiber;
            await fiber?.dispose().catch(() => { });
        }
    };
}

/** A complete legacy fixture: official transcript + the v0.2 alignment events + a v0.1 status event. */
function fullLegacyEvents(): Array<Record<string, unknown>> {
    return [...officialEvents(0), ...legacyAlignmentEvents(3, true)];
}

/** Decode every frame of a concatenated zstd artifact (one-shot decompress only handles the first frame). */
async function decodeAllFrames(buffer: Buffer): Promise<string> {
    const { zstdDecompress } = await import('node:zlib');
    const { promisify } = await import('node:util');
    const decompress = promisify(zstdDecompress);
    const { frames } = scanZstdFrames(buffer);
    let text = '';
    for (const frame of frames) text += (await decompress(buffer.subarray(frame.start, frame.end))).toString();
    return text;
}

// ── Test G: migration 前必须失败 ────────────────────────────────────────────

test('migration G: a bare DSH reader refuses the legacy fixture before migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-alignment-migrate-g-'));
    try {
        await writeLegacyArtifact(root, 's-legacy', fullLegacyEvents());
        const bare = await bareReader(root);
        try {
            await assert.rejects(
                bare.ctx.sessionPersistence.load(SessionId('s-legacy')),
                (error: unknown) => error instanceof Error && /SessionFormatUnsupportedError|unknown to this harness|not marked ignorable|alignment\/baseline/.test(String(error))
                    || /alignment\/baseline/.test(String(error)),
                'the legacy artifact must refuse to load under a bare reader'
            );
        } finally {
            await bare.dispose();
        }
    } finally {
        await rm(root, { recursive: true, force: true }).catch(() => { });
    }
});

// ── Test H + I: migration repairs the artifact; invariants hold; bare reader loads ──

test('migration H+I: migration repairs the artifact, preserves every invariant, and a bare reader then loads it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-alignment-migrate-h-'));
    try {
        const artifact = await writeLegacyArtifact(root, 's-legacy', fullLegacyEvents());
        const beforeBytes = await readFile(artifact);

        // The migration runs against the REAL persistence service.
        const harness = await fullHarness(root, await mkdtemp(join(tmpdir(), 'dsh-alignment-migrate-store-')));
        let report: Awaited<ReturnType<typeof migrateLegacyArtifact>>;
        try {
            report = await migrateLegacyArtifact(SessionId('s-legacy'), {
                persistence: harness.ctx.sessionPersistence,
                sessions: harness.ctx.sessions
            });
        } finally {
            await harness.dispose();
        }
        assert.equal(report.migrated, true);
        assert.equal(report.repairedEvents, 6, 'all five v0.2 alignment events plus the v0.1 status event gained ignorable');
        assert.equal(report.header.id, 's-legacy');
        assert.equal(report.backupPath !== undefined, true);
        // The backup is byte-for-byte the original.
        assert.deepEqual(await readFile(report.backupPath!), beforeBytes);
        assert.equal(report.originalSha256.length, 64);

        // Invariants: decode the migrated artifact and compare logically.
        const afterBytes = await readFile(artifact);
        const { frames, tornStart } = scanZstdFrames(afterBytes);
        assert.equal(tornStart, undefined);
        assert.ok(frames.length >= 2);
        const text = await decodeAllFrames(afterBytes);
        const parsed = parseArtifactText(text);
        const before = parseArtifactText(await decodeAllFrames(beforeBytes));
        assert.equal(parsed.events.length, before.events.length, 'event count identical');
        const whitelist = new Set(['alignment/status', 'alignment/baseline', 'alignment/baseline-updated', 'alignment/drift', 'alignment/decision', 'alignment/manual-check']);
        for (let i = 0; i < before.events.length; i++) {
            const b = before.events[i]!;
            const a = parsed.events[i]!;
            assert.equal(a.type, b.type, `event ${i} type`);
            assert.equal(a.seq, b.seq, `event ${i} seq`);
            assert.equal(a.time, b.time, `event ${i} time`);
            assert.deepEqual(a.data, b.data, `event ${i} data`);
            if (whitelist.has(b.type)) {
                assert.equal(a.ignorable, true, `event ${i} gained ignorable`);
            } else {
                assert.equal(a.ignorable, undefined, `event ${i} untouched`);
            }
        }

        // Bare reader (plugin absent) now loads the migrated session.
        const bare = await bareReader(root);
        try {
            const inspection = await bare.ctx.sessionPersistence.load(SessionId('s-legacy'));
            assert.equal(String(inspection.meta.id), 's-legacy');
            const alignment = inspection.events.filter((event) => event.type.startsWith('alignment/'));
            assert.equal(alignment.length, 6, 'legacy alignment events remain in the log (nothing deleted)');
            assert.ok(alignment.every((event) => event.ignorable === true));
        } finally {
            await bare.dispose();
        }
    } finally {
        await rm(root, { recursive: true, force: true }).catch(() => { });
    }
});

// ── Test J: unrelated unknown events stay untouched ─────────────────────────

test('migration J: an unrelated unknown event is untouched, so the session still refuses to load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-alignment-migrate-j-'));
    try {
        const events = [
            ...officialEvents(0),
            { type: 'alignment/baseline', seq: 3, time: 1700000000100, data: { baseline: { revision: 1, goal: 'v1', updatedAt: 1700000000100 } } },
            { type: 'third-party/important-event', seq: 4, time: 1700000000900, data: { payload: 'do not touch' } }
        ];
        const artifact = await writeLegacyArtifact(root, 's-foreign', events);
        const beforeBytes = await readFile(artifact);

        const harness = await fullHarness(root, await mkdtemp(join(tmpdir(), 'dsh-alignment-migrate-store-')));
        let report: Awaited<ReturnType<typeof migrateLegacyArtifact>>;
        try {
            report = await migrateLegacyArtifact(SessionId('s-foreign'), {
                persistence: harness.ctx.sessionPersistence,
                sessions: harness.ctx.sessions
            });
        } finally {
            await harness.dispose();
        }
        assert.equal(report.migrated, true);
        assert.equal(report.repairedEvents, 1, 'only the whitelisted alignment event is repaired');

        // The third-party event keeps its exact bytes (no ignorable, no rewrite).
        const afterBytes = await readFile(artifact);
        const textA = await decodeAllFrames(afterBytes);
        const textB = await decodeAllFrames(beforeBytes);
        const lineOf = (text: string, needle: string) => text.split('\n').find((line) => line.includes(needle))!;
        assert.equal(lineOf(textA, 'third-party/important-event'), lineOf(textB, 'third-party/important-event'), 'foreign event line byte-identical');
        const parsed = parseArtifactText(textA);
        assert.equal(parsed.events[4]!.ignorable, undefined, 'foreign event must not gain ignorable');

        // The bare reader STILL refuses: the unrelated unknown event remains
        // an unknown required event.
        const bare = await bareReader(root);
        try {
            await assert.rejects(
                bare.ctx.sessionPersistence.load(SessionId('s-foreign')),
                /third-party\/important-event/,
                'a session with an unrelated unknown event must still refuse to load'
            );
        } finally {
            await bare.dispose();
        }
    } finally {
        await rm(root, { recursive: true, force: true }).catch(() => { });
    }
});

// ── Test K: import correctness — store state equals the legacy fold ─────────

test('migration K: after migration + import, the store state equals the legacy fold', async () => {
    const sessionsRoot = await mkdtemp(join(tmpdir(), 'dsh-alignment-migrate-k-'));
    const storagesRoot = await mkdtemp(join(tmpdir(), 'dsh-alignment-migrate-k-store-'));
    try {
        const legacy = fullLegacyEvents();
        await writeLegacyArtifact(sessionsRoot, 's-k', legacy);
        const harness = await fullHarness(sessionsRoot, storagesRoot);
        try {
            await migrateLegacyArtifact(SessionId('s-k'), {
                persistence: harness.ctx.sessionPersistence,
                sessions: harness.ctx.sessions
            });
            // Resume the session through the REAL persistence backend.
            const prepared = await harness.ctx.sessionPersistence.prepare(SessionId('s-k'));
            let session: Session | undefined;
            try {
                session = prepared.session;
                const expected = foldAlignmentStatus(session.events);
                // Explicit import (idempotent).
                await harness.controller!.stateStore.importLegacyTimeline(session);
                await harness.controller!.stateStore.importLegacyTimeline(session);
                const status = harness.controller!.stateStore.getStatus(session);
                assert.deepEqual(status, expected, 'imported store state must equal the legacy fold');
                assert.equal(status.baseline?.goal, 'v2');
                assert.equal(status.revision, 2);
                assert.equal(status.driftCount, 1);
                assert.equal(status.lastDrift?.description, 'd1');
                assert.equal(status.lastDecision?.decision, 'reject');
                assert.equal(status.manualChecks, 2, 'new manual-check + the legacy v0.1 alignment/status check');
                assert.equal(status.status, 'aligned');
            } finally {
                prepared[Symbol.dispose]();
            }
        } finally {
            await harness.dispose();
        }
    } finally {
        await rm(sessionsRoot, { recursive: true, force: true }).catch(() => { });
        await rm(storagesRoot, { recursive: true, force: true }).catch(() => { });
    }
});

// ── Test L: legacy historical fork ──────────────────────────────────────────

test('migration L: a fork from a pre-v2 boundary of a migrated legacy parent inherits v1', async () => {
    const sessionsRoot = await mkdtemp(join(tmpdir(), 'dsh-alignment-migrate-l-'));
    const storagesRoot = await mkdtemp(join(tmpdir(), 'dsh-alignment-migrate-l-store-'));
    try {
        // baseline v1 (seq 3) ... baseline-updated v2 (seq 6).
        const events = [
            ...officialEvents(0),
            { type: 'alignment/baseline', seq: 3, time: 1700000000100, data: { baseline: { revision: 1, goal: 'v1', updatedAt: 1700000000100 } } },
            { type: 'alignment/drift', seq: 4, time: 1700000000200, data: { reason: 'scope-expansion', description: 'd', at: 1700000000200 } },
            { type: 'alignment/decision', seq: 5, time: 1700000000300, data: { driftSeq: 4, decision: 'approve', at: 1700000000300 } },
            { type: 'alignment/baseline-updated', seq: 6, time: 1700000000400, data: { baseline: { revision: 2, goal: 'v2', updatedAt: 1700000000400 } } }
        ];
        await writeLegacyArtifact(sessionsRoot, 's-l', events);
        const harness = await fullHarness(sessionsRoot, storagesRoot);
        try {
            await migrateLegacyArtifact(SessionId('s-l'), {
                persistence: harness.ctx.sessionPersistence,
                sessions: harness.ctx.sessions
            });
            // Resume the migrated parent, then fork from the v1 era
            // (boundary 3, before v2 at seq 6).
            const prepared = await harness.ctx.sessionPersistence.prepare(SessionId('s-l'));
            let parentEvents: readonly SessionEvent[] = [];
            try {
                parentEvents = prepared.session.events;
                await harness.controller!.stateStore.importLegacyTimeline(prepared.session);
            } finally {
                prepared[Symbol.dispose]();
            }
            const parentId = 's-l';
            // The official fork construction: a live child seeded with the
            // parent prefix + the durable lineage fields.
            const seed = parentEvents.filter((event) => event.seq <= 3);
            const child = harness.ctx.sessions.create(SessionId('s-l-child'), {
                seed: seed as never,
                meta: {
                    cwd: CWD,
                    parentSession: parentId as SessionId,
                    seedLength: 4
                }
            });
            const status = harness.controller!.stateStore.getStatus(child);
            assert.equal(status.baseline?.goal, 'v1', 'legacy historical fork must inherit v1, not v2');
            assert.equal(status.revision, 1);
            assert.equal(status.status, 'aligned');
        } finally {
            await harness.dispose();
        }
    } finally {
        await rm(sessionsRoot, { recursive: true, force: true }).catch(() => { });
        await rm(storagesRoot, { recursive: true, force: true }).catch(() => { });
    }
});

// ── idempotency + no-op: already-ignorable artifacts are left untouched ─────

test('migration: a second run is an idempotent no-op and leaves the artifact byte-identical', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-alignment-migrate-idem-'));
    try {
        const artifact = await writeLegacyArtifact(root, 's-idem', fullLegacyEvents());
        const harness = await fullHarness(root, await mkdtemp(join(tmpdir(), 'dsh-alignment-migrate-store-')));
        try {
            const first = await migrateLegacyArtifact(SessionId('s-idem'), {
                persistence: harness.ctx.sessionPersistence,
                sessions: harness.ctx.sessions
            });
            assert.equal(first.migrated, true);
            const afterFirst = await readFile(artifact);
            const second = await migrateLegacyArtifact(SessionId('s-idem'), {
                persistence: harness.ctx.sessionPersistence,
                sessions: harness.ctx.sessions
            });
            assert.equal(second.migrated, false, 'second run reports no-op');
            assert.equal(second.repairedEvents, 0);
            assert.deepEqual(await readFile(artifact), afterFirst, 'no rewrite on the second run');
        } finally {
            await harness.dispose();
        }
    } finally {
        await rm(root, { recursive: true, force: true }).catch(() => { });
    }
});

// ── safety gate: a live session refuses migration ───────────────────────────

test('migration: refuses to migrate a session with a live writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-alignment-migrate-live-'));
    try {
        await writeLegacyArtifact(root, 's-live', fullLegacyEvents());
        const harness = await fullHarness(root, await mkdtemp(join(tmpdir(), 'dsh-alignment-migrate-store-')));
        try {
            // Create the session LIVE in the store (same id as the artifact).
            // NO flush: flushing would trigger the coordinator's adoption of
            // the legacy artifact (which refuses — the bug itself). The
            // live-writer guard must fire before any artifact work.
            harness.ctx.sessions.create(SessionId('s-live'), { meta: { cwd: CWD } });
            await assert.rejects(
                migrateLegacyArtifact(SessionId('s-live'), {
                    persistence: harness.ctx.sessionPersistence,
                    sessions: harness.ctx.sessions
                }),
                /live writer/,
                'migration must refuse while the session is live'
            );
        } finally {
            await harness.dispose();
        }
    } finally {
        await rm(root, { recursive: true, force: true }).catch(() => { });
    }
});
