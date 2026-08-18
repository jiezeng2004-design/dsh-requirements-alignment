/**
 * AlignmentStateStore unit/integration tests over the in-memory port:
 * durable-first mutation ordering, identity binding, fork inheritance
 * (latest + historical), child independence, legacy import idempotency, and
 * the crash-state semantics (drift-pending / baseline-update-pending).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import {
    AlignmentStateStore,
    entryOnlyAlignmentStatePort,
    memoryAlignmentStatePort,
    type AlignmentSessionRecord
} from '../src/alignment-state-store.ts';
import { fakeSession, legacyEvent, makeStore } from './helpers.ts';
import type { RequirementBaseline } from '../src/types.ts';

function baseline(revision: number, goal: string): RequirementBaseline {
    return { revision, goal, updatedAt: 1000 + revision };
}

/** Push `count` filler events so the fake session's seq advances. */
function grow(fake: ReturnType<typeof fakeSession>, count: number): void {
    for (let i = 0; i < count; i++) fake.push(legacyEvent('tool/call', { name: 'read', arguments: '{}' }, fake.events.length));
}

/** The store's in-memory record map (test observation of the internal view). */
function recordsOf(store: AlignmentStateStore): Map<string, AlignmentSessionRecord> {
    return (store as unknown as { records: Map<string, AlignmentSessionRecord> }).records;
}

test('store: fresh session derives the empty status and records nothing until a mutation', async () => {
    const store = await makeStore();
    const { session } = fakeSession();
    assert.deepEqual(store.getStatus(session), { revision: 0, driftCount: 0, status: 'unknown', manualChecks: 0 });
    await store.recordBaseline(session, baseline(1, 'v1'));
    const status = store.getStatus(session);
    assert.equal(status.revision, 1);
    assert.equal(status.status, 'aligned');
});

test('store: durable-first — a failed durable write surfaces and leaves no memory state', async () => {
    const ctx = new Context();
    const store = new AlignmentStateStore(ctx, { port: entryOnlyAlignmentStatePort() });
    await store.open();
    const { session } = fakeSession();
    await assert.rejects(() => store.recordBaseline(session, baseline(1, 'v1')), /cannot persist alignment state/);
    // No live/discordant state after the failed write.
    assert.equal(store.getStatus(session).revision, 0);
});

test('store: resume restores state from the durable medium through a fresh store instance', async () => {
    const port = memoryAlignmentStatePort();
    const ctx1 = new Context();
    const store1 = new AlignmentStateStore(ctx1, { port });
    await store1.open();
    const { session } = fakeSession([], { id: 's-resume' });
    await store1.recordBaseline(session, baseline(1, 'v1'));
    const { driftSeq } = await store1.recordDrift(session, { reason: 'scope-expansion', description: 'd', at: 5 });
    await store1.recordDecision(session, { driftSeq, decision: 'approve', at: 6 });
    const expected = store1.getStatus(session);

    // Cold load in a fresh process-like store over the SAME medium.
    const ctx2 = new Context();
    const store2 = new AlignmentStateStore(ctx2, { port });
    await store2.open();
    const resumed = fakeSession([], { id: 's-resume' });
    const status = store2.getStatus(resumed.session);
    assert.deepEqual(status, expected);
    assert.equal(status.status, 'baseline-update-pending');
});

test('store: identity binding — a reused id with a different lifecycle does not leak state', async () => {
    const port = memoryAlignmentStatePort();
    const ctx1 = new Context();
    const store1 = new AlignmentStateStore(ctx1, { port });
    await store1.open();
    const first = fakeSession([], { id: 'reused-id', createdAt: 1111 });
    await store1.recordBaseline(first.session, baseline(1, 'old lifecycle'));
    // A NEW session reusing the id (different createdAt): the stale record is
    // shadowed, and the new session's first write replaces it.
    const ctx2 = new Context();
    const store2 = new AlignmentStateStore(ctx2, { port });
    await store2.open();
    const second = fakeSession([], { id: 'reused-id', createdAt: 2222 });
    assert.equal(store2.getStatus(second.session).revision, 0, 'stale state must not load');
    await store2.recordBaseline(second.session, baseline(1, 'new lifecycle'));
    assert.equal(store2.getStatus(second.session).baseline?.goal, 'new lifecycle');
    // And the old lifecycle still reads its own record through the same medium.
    assert.equal(store1.getStatus(first.session).baseline?.goal, 'old lifecycle');
});

test('store: fork child inherits the parent state at seedLength - 1 (latest fork)', async () => {
    const store = await makeStore();
    const parent = fakeSession([], { id: 'parent', createdAt: 1 });
    await store.recordBaseline(parent.session, baseline(1, 'v1'));
    grow(parent, 1); // the baseline era ends at log length 1
    const parentStatus = store.getStatus(parent.session);
    // Child fork @ parent head: seedLength = parent log length.
    const child = fakeSession([], {
        id: 'child',
        parentSession: 'parent',
        seedLength: parent.events.length,
        createdAt: 2
    });
    await store.initializeFork(child.session);
    assert.equal(store.getStatus(child.session).baseline?.goal, 'v1');
    assert.deepEqual(store.getStatus(child.session), parentStatus);
});

test('store: historical fork inherits the state at the OLD boundary, not the parent latest', async () => {
    const store = await makeStore();
    const parent = fakeSession([], { id: 'parent', createdAt: 1 });
    await store.recordBaseline(parent.session, baseline(1, 'v1')); // checkpoint @0
    grow(parent, 10); // seq advances past v1's boundary
    await store.recordBaseline(parent.session, baseline(2, 'v2')); // checkpoint @10
    grow(parent, 10);
    await store.recordBaseline(parent.session, baseline(3, 'v3')); // checkpoint @20
    // Fork @ boundary A = 1 (inside the v1 era: no checkpoint between 0 and 10).
    const boundaryA = 1;
    const child = fakeSession([], {
        id: 'child-old',
        parentSession: 'parent',
        seedLength: boundaryA + 1,
        createdAt: 2
    });
    await store.initializeFork(child.session);
    const inherited = store.getStatus(child.session);
    assert.equal(inherited.baseline?.goal, 'v1', 'historical fork must inherit v1, not v3');
    assert.equal(inherited.revision, 1);
    // The store's own boundary query agrees.
    const atBoundary = store.getStatusAtBoundary(parent.session, boundaryA);
    assert.equal(atBoundary.baseline?.goal, 'v1');
    assert.equal(store.getStatus(parent.session).baseline?.goal, 'v3', 'parent latest unchanged');
});

test('store: child and parent states are independent after the fork', async () => {
    const store = await makeStore();
    const parent = fakeSession([], { id: 'parent', createdAt: 1 });
    await store.recordBaseline(parent.session, baseline(1, 'v1'));
    grow(parent, 1);
    const child = fakeSession([], {
        id: 'child',
        parentSession: 'parent',
        seedLength: parent.events.length,
        createdAt: 2
    });
    await store.initializeFork(child.session);
    grow(child, child.events.length + 1); // inherited prefix + the fork marker
    assert.equal(store.getStatus(child.session).baseline?.goal, 'v1');
    // Child revises its own baseline; the parent must not move.
    await store.recordBaseline(child.session, baseline(2, 'child v2'));
    assert.equal(store.getStatus(child.session).baseline?.goal, 'child v2');
    assert.equal(store.getStatus(parent.session).baseline?.goal, 'v1');
    // And the parent's later mutation must not move the child.
    await store.recordBaseline(parent.session, baseline(2, 'parent v2'));
    assert.equal(store.getStatus(parent.session).baseline?.goal, 'parent v2');
    assert.equal(store.getStatus(child.session).baseline?.goal, 'child v2');
    // The child's boundary inside its inherited prefix still resolves v1
    // (its own v2 checkpoint lives at a later log length).
    assert.equal(store.getStatusAtBoundary(child.session, 0).baseline?.goal, 'v1');
});

test('store: grandchild inherits through a child record (lineage walk)', async () => {
    const store = await makeStore();
    const parent = fakeSession([], { id: 'parent', createdAt: 1 });
    await store.recordBaseline(parent.session, baseline(1, 'v1'));
    grow(parent, 1);
    const child = fakeSession([], { id: 'child', parentSession: 'parent', seedLength: 1, createdAt: 2 });
    await store.initializeFork(child.session);
    // Grandchild forked from the child at its head.
    const grandchild = fakeSession([], { id: 'grand', parentSession: 'child', seedLength: 1, createdAt: 3 });
    await store.initializeFork(grandchild.session);
    assert.equal(store.getStatus(grandchild.session).baseline?.goal, 'v1');
});

test('store: legacy timeline import is idempotent and matches the fold', async () => {
    const store = await makeStore();
    const events = [
        legacyEvent('alignment/baseline', { baseline: baseline(1, 'legacy v1') }, 0),
        legacyEvent('alignment/drift', { reason: 'scope-expansion', description: 'd', at: 1 }, 1),
        legacyEvent('alignment/decision', { driftSeq: 1, decision: 'approve', at: 2 }, 2),
        legacyEvent('alignment/manual-check', { at: 3 }, 3)
    ];
    const session = fakeSession(events, { id: 'legacy' });
    await store.initializeSession(session.session);
    const status = store.getStatus(session.session);
    assert.equal(status.baseline?.goal, 'legacy v1');
    assert.equal(status.driftCount, 1);
    assert.equal(status.manualChecks, 1);
    assert.equal(status.status, 'baseline-update-pending');
    // Idempotent: adopting again changes nothing.
    await store.initializeSession(session.session);
    const again = store.getStatus(session.session);
    assert.deepEqual(again, status);
    // Explicit import path is a no-op once imported.
    await store.importLegacyTimeline(session.session);
    assert.deepEqual(store.getStatus(session.session), status);
});

test('store: legacy historical fork resolves the pre-migration boundary', async () => {
    const store = await makeStore();
    const events = [
        legacyEvent('alignment/baseline', { baseline: baseline(1, 'legacy v1') }, 0),
        legacyEvent('alignment/drift', { reason: 'scope-expansion', description: 'd', at: 1 }, 1),
        legacyEvent('alignment/decision', { driftSeq: 1, decision: 'approve', at: 2 }, 2),
        legacyEvent('alignment/baseline-updated', { baseline: baseline(2, 'legacy v2') }, 3)
    ];
    const parent = fakeSession(events, { id: 'legacy-parent' });
    await store.initializeSession(parent.session);
    // Fork from the v1 era: boundary 0 (seedLength 1) must inherit v1.
    const child = fakeSession([], { id: 'legacy-child', parentSession: 'legacy-parent', seedLength: 1, createdAt: 2 });
    await store.initializeFork(child.session);
    assert.equal(store.getStatus(child.session).baseline?.goal, 'legacy v1');
    assert.equal(store.getStatus(child.session).status, 'aligned');
    // A fork right after the drift (boundary 1: drift durable, decision not
    // yet visible) inherits drift-pending.
    const child2 = fakeSession([], { id: 'legacy-child2', parentSession: 'legacy-parent', seedLength: 2, createdAt: 3 });
    await store.initializeFork(child2.session);
    assert.equal(store.getStatus(child2.session).status, 'drift-pending');
    // A fork right after the approve decision (boundary 2, before the v2
    // baseline) inherits baseline-update-pending.
    const child3 = fakeSession([], { id: 'legacy-child3', parentSession: 'legacy-parent', seedLength: 3, createdAt: 4 });
    await store.initializeFork(child3.session);
    assert.equal(store.getStatus(child3.session).status, 'baseline-update-pending');
    assert.equal(store.getStatus(child3.session).baseline?.goal, 'legacy v1');
});

test('store: legacy parent without a record folds the child seed prefix', async () => {
    const store = await makeStore();
    // The parent has NO sidecar record (never adopted): the child's seed is
    // the parent's prefix, so the store folds it through the compatibility
    // layer.
    const seed = [
        legacyEvent('alignment/baseline', { baseline: baseline(1, 'v1') }, 0),
        legacyEvent('alignment/baseline-updated', { baseline: baseline(2, 'v2') }, 1)
    ];
    const child = fakeSession(seed, { id: 'child', parentSession: 'never-adopted', seedLength: 2, createdAt: 2 });
    assert.equal(store.getStatus(child.session).baseline?.goal, 'v2');
    // A mutation materializes the child record with the folded inherited state.
    await store.recordManualCheck(child.session, 5);
    assert.equal(store.getStatus(child.session).manualChecks, 1);
    const record = recordsOf(store).get('child') as AlignmentSessionRecord;
    assert.equal(record.checkpoints.length, 2, 'inherited fold checkpoint + the manual-check checkpoint');
    assert.equal(record.checkpoints[0]!.state.baseline?.goal, 'v2');
});

test('store: crash semantics — drift durable without decision is drift-pending on resume', async () => {
    const port = memoryAlignmentStatePort();
    const ctx1 = new Context();
    const store1 = new AlignmentStateStore(ctx1, { port });
    await store1.open();
    const { session } = fakeSession([], { id: 'crash-drift' });
    await store1.recordDrift(session, { reason: 'scope-expansion', description: 'd', at: 1 });
    // "Crash" before the decision.
    const ctx2 = new Context();
    const store2 = new AlignmentStateStore(ctx2, { port });
    await store2.open();
    const resumed = fakeSession([], { id: 'crash-drift' });
    assert.equal(store2.getStatus(resumed.session).status, 'drift-pending');
});

test('store: crash semantics — decision durable without the baseline update is baseline-update-pending on resume', async () => {
    const port = memoryAlignmentStatePort();
    const ctx1 = new Context();
    const store1 = new AlignmentStateStore(ctx1, { port });
    await store1.open();
    const { session } = fakeSession([], { id: 'crash-decision' });
    await store1.recordBaseline(session, baseline(1, 'v1'));
    const { driftSeq } = await store1.recordDrift(session, { reason: 'architecture-shift', description: 'cloud', at: 1 });
    await store1.recordDecision(session, { driftSeq, decision: 'approve', at: 2 });
    // "Crash" before establish_baseline recorded the new baseline.
    const ctx2 = new Context();
    const store2 = new AlignmentStateStore(ctx2, { port });
    await store2.open();
    const resumed = fakeSession([], { id: 'crash-decision' });
    const status = store2.getStatus(resumed.session);
    assert.equal(status.status, 'baseline-update-pending');
    assert.equal(status.baseline?.goal, 'v1', 'the stale baseline stays in force');
});

test('store: per-session writes are serialized (no interleaved checkpoint states)', async () => {
    const store = await makeStore();
    const { session } = fakeSession();
    await Promise.all([
        store.recordBaseline(session, baseline(1, 'a')),
        store.recordBaseline(session, baseline(2, 'b')),
        store.recordManualCheck(session, 1)
    ]);
    const status = store.getStatus(session);
    assert.equal(status.revision, 2);
    assert.equal(status.manualChecks, 1);
    const record = recordsOf(store).get(String(session.id)) as AlignmentSessionRecord;
    assert.equal(record.checkpoints.length, 3);
});

// ── statusCache session-identity regression ───────────────────────────────────

/**
 * Regression: a cached status must not leak across a session-id reuse with a
 * different lifecycle identity. getStatus(sessionA) primes the statusCache
 * with A's OLD baseline; a NEW session B reusing the same id but a different
 * createdAt must MISS that cache and derive a fresh status, never A's.
 */
test('store: statusCache identity — reused id (different createdAt) does not leak a stale cached baseline', async () => {
    const store = await makeStore();
    // Session A lifecycle: id = same-id, createdAt = 1.
    const a = fakeSession([], { id: 'same-id', createdAt: 1 });
    await store.recordBaseline(a.session, baseline(1, 'OLD'));
    const aStatus = store.getStatus(a.session);
    assert.equal(aStatus.baseline?.goal, 'OLD', 'A primes the cache with its OLD baseline');
    assert.equal(aStatus.revision, 1);
    // Session B reuses the SAME id but is a DIFFERENT lifecycle (createdAt =
    // 2), and is NOT a continuation of A (no parentSession).
    const b = fakeSession([], { id: 'same-id', createdAt: 2 });
    const bStatus = store.getStatus(b.session);
    assert.equal(bStatus.baseline, undefined, 'B must NOT inherit A OLD baseline through the cache');
    assert.equal(bStatus.revision, 0, 'B is a fresh session: revision must be 0');
    assert.equal(bStatus.status, 'unknown', 'B is a fresh session: posture must be unknown');
    // And B's own lifecycle writes then work independently (a fresh record
    // with B's identity replaces the shadowed slot).
    await store.recordBaseline(b.session, baseline(1, 'NEW'));
    assert.equal(store.getStatus(b.session).baseline?.goal, 'NEW');
});

/**
 * Regression: a cached unknown/fresh status must not (a) leak across a
 * session-id reuse, nor (b) suppress the lineage inheritance the new lifecycle
 * is entitled to. getStatus(A) caches the fresh/unknown status for
 * id = same-id; a NEW session B reusing the id with a fork parent must MISS
 * that cache, run its identity + lineage lookup, and correctly inherit the
 * parent's baseline.
 */
test('store: statusCache identity — reused-id fork inherits parent, not the cached unknown', async () => {
    const store = await makeStore();
    // A parent whose state the fork child B should inherit.
    const parent = fakeSession([], { id: 'parent', createdAt: 1 });
    await store.recordBaseline(parent.session, baseline(1, 'parent v1'));
    // Session A: id = same-id, fresh/unknown, no record, no lineage. Priming
    // its cache with the fresh/unknown status is what the bug used to leak.
    const a = fakeSession([], { id: 'same-id', createdAt: 1 });
    const aStatus = store.getStatus(a.session);
    assert.equal(aStatus.status, 'unknown', 'A is fresh/unknown and must prime the cache');
    assert.equal(aStatus.revision, 0);
    // Session B reuses the SAME id with a different identity but is a fork of
    // the parent: lineage lookup must inherit parent v1.
    const b = fakeSession([], { id: 'same-id', parentSession: 'parent', seedLength: 1, createdAt: 2 });
    await store.initializeFork(b.session);
    const bStatus = store.getStatus(b.session);
    assert.equal(bStatus.baseline?.goal, 'parent v1', 'B must inherit the parent baseline via lineage');
    assert.equal(bStatus.revision, 1, 'B inherited revision reflects the parent baseline');
    // The cache neither leaked A's unknown nor suppressed B's inheritance.
    assert.equal(aStatus.status, 'unknown');
});
