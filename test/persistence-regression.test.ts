/**
 * REAL persistence regressions for the Requirements Alignment
 * persistence-compatibility fix.
 *
 * These tests cross the REAL DSH persistence boundary — the JSONL backend
 * (`session.jsonl.zstd` artifacts), the storage hub with the `json` backend,
 * the storage-domain KV layer, and the real session store — with no fakes for
 * the medium. They prove:
 *
 *   A. sessions created by the fixed plugin contain ZERO `alignment/*`
 *      events and load under a bare DSH reader (plugin absent);
 *   B. write -> flush -> dispose -> cold load -> resume restores identical
 *      alignment state (baseline/revision/status/drift/decision/checks);
 *   C. a fork at the parent head inherits the parent's latest baseline;
 *   D. a HISTORICAL fork inherits the state in force at the old boundary,
 *      never the parent's latest;
 *   E. child and parent alignment state stay independent;
 *   F. a compacted transcript (official compaction events + surface
 *      replacement) survives flush/close/cold load with alignment state
 *      intact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { Storage } from '@deepseek-ai/dsh-storage';
import { apply as storageJsonApply } from '@deepseek-ai/dsh-storage-json';
import { apply as storageDomainApply } from '@deepseek-ai/dsh-storage-domain';
import type { Session } from '@deepseek-ai/dsh-session';
import type { SessionEventType } from '@deepseek-ai/dsh-session/types';
import { RequirementsAlignmentController } from '../src/index.ts';
import type { RequirementBaseline } from '../src/types.ts';

/**
 * Append an official event whose data shape is declared by a package that is
 * not a compile-time dependency here (the compaction vocabulary, branded
 * message ids): the runtime envelope is validated by Session.append itself.
 */
function appendOfficial(session: Session, type: string, data: unknown, opts?: { surfaceOp?: unknown; sourceEventSeqs?: number[] }): void {
    session.append(type as SessionEventType, data as never, opts as never);
}

/** A full harness: real session store + JSONL persistence + storage stack (+ the plugin). */
async function mountHarness(options: { withPlugin?: boolean; sessionsRoot?: string; storagesRoot?: string } = {}) {
    const ctx = new Context();
    const sessionsRoot = options.sessionsRoot ?? await mkdtemp(join(tmpdir(), 'dsh-alignment-sessions-'));
    const storagesRoot = options.storagesRoot ?? await mkdtemp(join(tmpdir(), 'dsh-alignment-storages-'));
    ctx.plugin(SessionStore);
    await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, packChunks: true });
    ctx.plugin(Storage);
    // The storage backend/domain plugins declare `inject: ['storage']` on
    // their exports; direct ctx.plugin must carry it explicitly (the loader
    // does this automatically for profile rows).
    await ctx.plugin({ apply: storageJsonApply, inject: ['storage'] }, { root: storagesRoot });
    await ctx.plugin({ apply: storageDomainApply, inject: ['storage'] }, { backend: 'json' });
    if (options.withPlugin !== false) {
        // The controller's static inject surface (as in the real profile).
        ctx.provide('systemPrompt', { section: () => () => { } });
        ctx.provide('tools', { register: () => () => { } });
        await ctx.plugin(RequirementsAlignmentController, { mode: 'auto' });
        // The controller registers its commands through ctx.inject (microtask).
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const controller = (ctx as unknown as { requirementsAlignment?: RequirementsAlignmentController }).requirementsAlignment;
    return {
        ctx,
        controller,
        sessionsRoot,
        storagesRoot,
        dispose: async (opts: { keepRoots?: boolean } = {}) => {
            const fiber = (ctx as unknown as { fiber?: { dispose(): Promise<void> } }).fiber;
            await fiber?.dispose().catch(() => { });
            if (opts.keepRoots) return;
            await rm(sessionsRoot, { recursive: true, force: true }).catch(() => { });
            await rm(storagesRoot, { recursive: true, force: true }).catch(() => { });
        }
    };
}

/** The deterministic workspace path used as the session cwd (a path key only). */
const CWD = join(tmpdir(), 'dsh-alignment-test-workspace');

/** Create a live session with a realistic official transcript (one completed turn). */
function createConversation(ctx: Context, id: string, turns = 1) {
    const session = ctx.sessions.create(SessionId(id), { meta: { cwd: CWD } });
    for (let turn = 1; turn <= turns; turn++) {
        appendOfficial(session, 'turn/start', { turn });
        appendOfficial(session, 'user/message', {
            id: `m-${turn}`,
            role: 'user',
            content: [{ type: 'text', text: `request ${turn}` }],
            source: { kind: 'user' }
        }, { surfaceOp: 'append' });
        appendOfficial(session, 'turn/end', { turn, reason: { kind: 'completed' } });
    }
    return session;
}

function baseline(revision: number, goal: string): RequirementBaseline {
    return { revision, goal, updatedAt: 1000 + revision };
}

// ── Test A: new sessions carry no private events and load under a bare reader ─

test('persistence A: new session writes zero alignment/* events and a bare reader loads it', async () => {
    const h = await mountHarness();
    try {
        const session = createConversation(h.ctx, 's-a');
        const store = h.controller!.stateStore;
        await store.recordBaseline(session, baseline(1, 'v1'));
        const { driftSeq } = await store.recordDrift(session, { reason: 'scope-expansion', description: 'd', at: 5 });
        await store.recordDecision(session, { driftSeq, decision: 'approve', at: 6 });
        await store.recordManualCheck(session, 7);
        await h.ctx.sessions.flush(session);
        assert.equal(session.events.filter((event) => event.type.startsWith('alignment/')).length, 0,
            'the live log must never carry alignment/* events');

        // The persisted artifact contains no alignment/* lines either.
        const raw = await h.ctx.sessionPersistence.readRaw(session.id);
        assert.ok(raw, 'artifact materialized');
        const lines = raw!.content.split('\n').filter(Boolean);
        const alignmentLines = lines.slice(1).filter((line) => {
            const parsed = JSON.parse(line) as { type?: string };
            return typeof parsed.type === 'string' && parsed.type.startsWith('alignment/');
        });
        assert.equal(alignmentLines.length, 0, 'persisted transcript must contain zero alignment/* events');

        // Bare reader (NO requirements-alignment plugin) over the SAME root:
        // cold load succeeds.
        const bare = await mountHarness({ withPlugin: false, sessionsRoot: h.sessionsRoot });
        try {
            const inspection = await bare.ctx.sessionPersistence.load(session.id);
            assert.equal(String(inspection.meta.id), 's-a');
            assert.equal(inspection.events.filter((event) => event.type.startsWith('alignment/')).length, 0);
        } finally {
            await bare.dispose();
        }
    } finally {
        await h.dispose();
    }
});

// ── Test B: write -> close -> replay -> resume across contexts ──────────────

test('persistence B: write -> flush -> dispose -> cold load -> resume restores identical state', async () => {
    const h1 = await mountHarness();
    let expected: ReturnType<RequirementsAlignmentController['stateStore']['getStatus']>;
    try {
        const session = createConversation(h1.ctx, 's-b');
        const store = h1.controller!.stateStore;
        await store.recordBaseline(session, baseline(1, 'v1'));
        const { driftSeq } = await store.recordDrift(session, { reason: 'architecture-shift', description: 'cloud sync', at: 5 });
        await store.recordDecision(session, { driftSeq, decision: 'approve', at: 6 });
        await store.recordManualCheck(session, 7);
        expected = store.getStatus(session);
        assert.equal(expected.status, 'baseline-update-pending');
        await h1.ctx.sessions.flush(session);
    } finally {
        // Close the harness WITHOUT deleting the roots: Context B reuses them.
        await h1.dispose({ keepRoots: true });
    }

    // Context B: cold load through the REAL persistence backend, then resume —
    // over the SAME roots (a process restart reuses the same DSH_HOME).
    const h2 = await mountHarness({ sessionsRoot: h1.sessionsRoot, storagesRoot: h1.storagesRoot });
    try {
        const prepared = await h2.ctx.sessionPersistence.prepare(SessionId('s-b'));
        try {
            const resumed = prepared.session;
            assert.equal(resumed.header.id, 's-b');
            const status = h2.controller!.stateStore.getStatus(resumed);
            assert.deepEqual(status, expected, 'resume must restore baseline/revision/status/drift/decision/checks');
            assert.equal(status.baseline?.goal, 'v1');
            assert.equal(status.revision, 1);
            assert.equal(status.driftCount, 1);
            assert.equal(status.lastDrift?.description, 'cloud sync');
            assert.equal(status.lastDecision?.decision, 'approve');
            assert.equal(status.manualChecks, 1);
            assert.equal(status.status, 'baseline-update-pending');
        } finally {
            prepared[Symbol.dispose]();
        }
    } finally {
        await h2.dispose();
    }
});

// ── Test C: fork at the parent head inherits the parent's latest baseline ────

test('persistence C: latest fork — the child inherits the parent baseline v1', async () => {
    const h = await mountHarness();
    try {
        const parent = h.ctx.sessions.create(SessionId('s-c'), { meta: { cwd: CWD } });
        // The baseline is recorded DURING the turn (log length 2), before the
        // turn completes — the realistic establish_baseline timing.
        appendOfficial(parent, 'turn/start', { turn: 1 });
        appendOfficial(parent, 'user/message', { id: 'm-1', role: 'user', content: [{ type: 'text', text: 'request 1' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
        await h.controller!.stateStore.recordBaseline(parent, baseline(1, 'v1'));
        appendOfficial(parent, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
        await h.ctx.sessions.flush(parent);
        const child = h.ctx.sessions.fork(parent, undefined, SessionId('s-c-child'));
        assert.equal(String(child.header.parentSession), 's-c');
        assert.equal(child.header.seedLength, parent.events.length, 'official seedLength = inherited prefix length');
        const status = h.controller!.stateStore.getStatus(child);
        assert.equal(status.baseline?.goal, 'v1');
        assert.equal(status.status, 'aligned');
    } finally {
        await h.dispose();
    }
});

// ── Test D: historical fork inherits the OLD boundary state, never the latest ─

test('persistence D: historical fork at an old boundary inherits v1, not the latest v3', async () => {
    const h = await mountHarness();
    try {
        const parent = createConversation(h.ctx, 's-d');
        const store = h.controller!.stateStore;
        // v1 recorded at log length 3 (after turn 1).
        await store.recordBaseline(parent, baseline(1, 'v1'));
        // Another completed turn (log length 6), then v2.
        appendOfficial(parent, 'turn/start', { turn: 2 });
        appendOfficial(parent, 'user/message', { id: 'm-2', role: 'user', content: [{ type: 'text', text: 'request 2' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
        appendOfficial(parent, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
        await store.recordBaseline(parent, baseline(2, 'v2'));
        // A third turn (log length 9), then v3.
        appendOfficial(parent, 'turn/start', { turn: 3 });
        appendOfficial(parent, 'user/message', { id: 'm-3', role: 'user', content: [{ type: 'text', text: 'request 3' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
        appendOfficial(parent, 'turn/end', { turn: 3, reason: { kind: 'completed' } });
        await store.recordBaseline(parent, baseline(3, 'v3'));
        await h.ctx.sessions.flush(parent);
        assert.equal(store.getStatus(parent).baseline?.goal, 'v3', 'parent latest is v3');

        // Fork @ boundary 5: the last event of turn 2's predecessor era —
        // the v1 era (v1 checkpoint visible through seq 3..5).
        const child = h.ctx.sessions.fork(parent, 5, SessionId('s-d-child'));
        const status = h.controller!.stateStore.getStatus(child);
        assert.equal(status.baseline?.goal, 'v1', 'historical fork must inherit v1, not v3');
        assert.equal(status.revision, 1);

        // And the store's boundary query on the parent agrees.
        assert.equal(store.getStatusAtBoundary(parent, 5).baseline?.goal, 'v1');
    } finally {
        await h.dispose();
    }
});

// ── Test E: child and parent state stay independent ─────────────────────────

test('persistence E: child and parent alignment state are independent', async () => {
    const h = await mountHarness();
    try {
        const parent = h.ctx.sessions.create(SessionId('s-e'), { meta: { cwd: CWD } });
        const store = h.controller!.stateStore;
        appendOfficial(parent, 'turn/start', { turn: 1 });
        appendOfficial(parent, 'user/message', { id: 'm-1', role: 'user', content: [{ type: 'text', text: 'request 1' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
        await store.recordBaseline(parent, baseline(1, 'v1'));
        appendOfficial(parent, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
        await h.ctx.sessions.flush(parent);
        const child = h.ctx.sessions.fork(parent, undefined, SessionId('s-e-child'));
        assert.equal(store.getStatus(child).baseline?.goal, 'v1');

        // Child records its own baseline: parent must not move.
        await store.recordBaseline(child, baseline(2, 'child v2'));
        assert.equal(store.getStatus(child).baseline?.goal, 'child v2');
        assert.equal(store.getStatus(parent).baseline?.goal, 'v1');

        // Parent records a new baseline: child must not move.
        await store.recordBaseline(parent, baseline(2, 'parent v2'));
        assert.equal(store.getStatus(parent).baseline?.goal, 'parent v2');
        assert.equal(store.getStatus(child).baseline?.goal, 'child v2');
        await h.ctx.sessions.flush(child);
        await h.ctx.sessions.flush(parent);
    } finally {
        await h.dispose();
    }
});

// ── Test F: compaction leaves alignment state intact across close/reload ────

test('persistence F: compaction -> flush -> close -> cold load -> resume keeps alignment state', async () => {
    const h1 = await mountHarness();
    let expected: ReturnType<RequirementsAlignmentController['stateStore']['getStatus']>;
    try {
        const session = createConversation(h1.ctx, 's-f');
        const store = h1.controller!.stateStore;
        await store.recordBaseline(session, baseline(1, 'v1'));
        const { driftSeq } = await store.recordDrift(session, { reason: 'scope-expansion', description: 'd', at: 5 });
        await store.recordDecision(session, { driftSeq, decision: 'reject', at: 6 });
        expected = store.getStatus(session);
        assert.equal(expected.status, 'aligned');

        // The official compaction log shape: lock marker, prune shadow-price,
        // a replacement user/message shadowing the compacted surface range,
        // then the release marker.
        appendOfficial(session, 'compaction/start', { compactionId: 'c-1', turn: null });
        appendOfficial(session, 'compaction/prune', {
            shadowedRange: { start: 1, end: 1 },
            shadowedSeqs: [1],
            shadowedTokenCount: 10
        });
        appendOfficial(session, 'user/message', {
            id: 'm-compacted',
            role: 'user',
            content: [{ type: 'text', text: 'compacted summary of request 1' }],
            source: { kind: 'user' }
        }, { surfaceOp: { op: 'replace', start: 1, end: 1 }, sourceEventSeqs: [1] });
        appendOfficial(session, 'compaction/end', { compactionId: 'c-1', turn: null });
        await h1.ctx.sessions.flush(session);
        // The surface is compacted: only the replacement node remains.
        assert.equal(session.surface.nodes.length, 1);
    } finally {
        await h1.dispose({ keepRoots: true });
    }

    // Cold reopen + resume over the SAME roots: the alignment state (sidecar)
    // is untouched by the transcript compaction.
    const h2 = await mountHarness({ sessionsRoot: h1.sessionsRoot, storagesRoot: h1.storagesRoot });
    try {
        const prepared = await h2.ctx.sessionPersistence.prepare(SessionId('s-f'));
        try {
            const resumed = prepared.session;
            // The compacted transcript still replays (the replacement node).
            assert.equal(resumed.surface.nodes.length, 1);
            const status = h2.controller!.stateStore.getStatus(resumed);
            assert.deepEqual(status, expected, 'compaction must not disturb canonical alignment state');
            assert.equal(status.baseline?.goal, 'v1');
            assert.equal(status.driftCount, 1);
            assert.equal(status.lastDecision?.decision, 'reject');
            assert.equal(status.status, 'aligned');
        } finally {
            prepared[Symbol.dispose]();
        }
    } finally {
        await h2.dispose();
    }
});
