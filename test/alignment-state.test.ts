/**
 * Pure alignment-domain unit tests: transitions, posture derivation,
 * checkpoint stateAt resolution, and the legacy fold-to-checkpoints mirror.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    EMPTY_ALIGNMENT_STATE,
    applyBaseline,
    applyDecision,
    applyDrift,
    applyManualCheck,
    deriveAlignmentStatus,
    foldLegacyTimeline,
    latestState,
    snapshotToStatus,
    stateAt
} from '../src/alignment-state.ts';
import { foldAlignmentStatus } from '../src/status.ts';
import type { RequirementBaseline } from '../src/types.ts';
import { legacyEvent } from './helpers.ts';

function baseline(overrides: Partial<RequirementBaseline> = {}): RequirementBaseline {
    return { revision: 1, updatedAt: 1000, ...overrides };
}

test('alignment-state: empty state derives unknown and projects the zero status', () => {
    assert.equal(deriveAlignmentStatus(EMPTY_ALIGNMENT_STATE), 'unknown');
    assert.deepEqual(snapshotToStatus(EMPTY_ALIGNMENT_STATE), {
        revision: 0,
        driftCount: 0,
        status: 'unknown',
        manualChecks: 0
    });
});

test('alignment-state: baseline transition replaces the whole value and advances the order', () => {
    const first = applyBaseline(EMPTY_ALIGNMENT_STATE, baseline({ revision: 1, goal: 'v1' }), 10);
    assert.equal(first.baseline?.goal, 'v1');
    assert.equal(first.lastBaselineOrder, 10);
    assert.equal(deriveAlignmentStatus(first), 'aligned');
    const second = applyBaseline(first, baseline({ revision: 2, goal: 'v2' }), 20);
    assert.equal(second.baseline?.goal, 'v2');
    assert.equal(second.lastBaselineOrder, 20);
    assert.equal(second.driftCount, 0);
});

test('alignment-state: drift/decision transitions and pairing by driftSeq', () => {
    const withDrift = applyDrift(EMPTY_ALIGNMENT_STATE, { reason: 'scope-expansion', description: 'x', at: 1 }, 5);
    assert.equal(withDrift.driftCount, 1);
    assert.equal(withDrift.lastDrift?.driftSeq, 5);
    assert.equal(deriveAlignmentStatus(withDrift), 'drift-pending');
    const withDecision = applyDecision(withDrift, { driftSeq: 5, decision: 'reject', at: 2 }, 6);
    // Rejected drift, no baseline: unknown (exactly the legacy fold's answer).
    assert.equal(deriveAlignmentStatus(withDecision), 'unknown');
    // A decision answering a DIFFERENT drift keeps the open drift pending.
    const mismatched = applyDecision(withDrift, { driftSeq: 999, decision: 'approve', at: 2 }, 6);
    assert.equal(deriveAlignmentStatus(mismatched), 'drift-pending');
    // With a baseline, a paired reject stays aligned.
    const based = applyBaseline(withDecision, baseline({ revision: 1, goal: 'v1' }), 7);
    assert.equal(deriveAlignmentStatus(based), 'aligned');
});

test('alignment-state: approve without a newer baseline derives baseline-update-pending even at the same order', () => {
    // Decision order == baseline order (mutations recorded at the same log
    // position): the decision is still NEWER in mutation order, so the
    // posture must be baseline-update-pending — the order comparison, not the
    // log position, decides.
    const base = applyBaseline(EMPTY_ALIGNMENT_STATE, baseline({ revision: 1, goal: 'v1' }), 1);
    const drift = applyDrift(base, { reason: 'architecture-shift', description: 'cloud', at: 1 }, 1);
    const decision = applyDecision(drift, { driftSeq: 1, decision: 'approve', at: 1 }, 2);
    assert.equal(deriveAlignmentStatus(decision), 'baseline-update-pending');
    // Recording the new baseline (higher order) resolves it.
    const updated = applyBaseline(decision, baseline({ revision: 2, goal: 'v2' }), 3);
    assert.equal(deriveAlignmentStatus(updated), 'aligned');
});

test('alignment-state: manual checks count and project', () => {
    const one = applyManualCheck(EMPTY_ALIGNMENT_STATE, 100);
    const two = applyManualCheck(one, 200);
    assert.equal(two.manualChecks, 2);
    assert.equal(two.lastManualCheckAt, 200);
    assert.equal(snapshotToStatus(two).manualChecks, 2);
});

test('alignment-state: stateAt resolves the last checkpoint at or before the boundary', () => {
    const checkpoints = [
        { visibleThroughSeq: 10, state: applyBaseline(EMPTY_ALIGNMENT_STATE, baseline({ revision: 1, goal: 'v1' }), 1) },
        { visibleThroughSeq: 20, state: applyDrift(applyBaseline(EMPTY_ALIGNMENT_STATE, baseline({ revision: 1, goal: 'v1' }), 1), { reason: 'scope-expansion', description: 'd', at: 2 }, 2) },
        { visibleThroughSeq: 30, state: applyBaseline(EMPTY_ALIGNMENT_STATE, baseline({ revision: 2, goal: 'v2' }), 3) }
    ];
    assert.equal(stateAt(checkpoints, 9).baseline, undefined);
    assert.equal(stateAt(checkpoints, 10).baseline?.goal, 'v1');
    assert.equal(stateAt(checkpoints, 15).baseline?.goal, 'v1');
    assert.equal(stateAt(checkpoints, 20).lastDrift?.description, 'd');
    assert.equal(stateAt(checkpoints, 29).baseline?.goal, 'v1');
    assert.equal(stateAt(checkpoints, 30).baseline?.goal, 'v2');
    assert.equal(stateAt(checkpoints, 10_000).baseline?.goal, 'v2');
    assert.equal(stateAt([], 5).driftCount, 0);
});

test('alignment-state: foldLegacyTimeline mirrors foldAlignmentStatus exactly', () => {
    const events = [
        legacyEvent('tool/call', { turn: 1, step: 1, callId: 'c', name: 'read', arguments: '{}' }, 0),
        legacyEvent('alignment/baseline', { baseline: baseline({ revision: 1, goal: 'v1' }) }, 1),
        legacyEvent('alignment/drift', { reason: 'scope-expansion', description: 'd1', at: 2 }, 2),
        legacyEvent('alignment/decision', { driftSeq: 2, decision: 'reject', at: 3 }, 3),
        legacyEvent('alignment/manual-check', { at: 4 }, 4),
        legacyEvent('alignment/status', { kind: 'manual-check', at: 5 }, 5),
        legacyEvent('alignment/baseline-updated', { baseline: baseline({ revision: 2, goal: 'v2' }) }, 6)
    ];
    const checkpoints = foldLegacyTimeline(events);
    const folded = foldAlignmentStatus(events);
    // One checkpoint per legacy mutation, ascending, bound to event seqs.
    assert.deepEqual(checkpoints.map((entry) => entry.visibleThroughSeq), [1, 2, 3, 4, 5, 6]);
    // The final checkpoint's public view equals the fold.
    assert.deepEqual(snapshotToStatus(latestState(checkpoints)), folded);
    // Historical boundary: state at seq 2 (before the decision) is drift-pending.
    assert.equal(snapshotToStatus(stateAt(checkpoints, 2)).status, 'drift-pending');
    assert.equal(snapshotToStatus(stateAt(checkpoints, 3)).status, 'aligned');
    assert.equal(snapshotToStatus(stateAt(checkpoints, 6)).revision, 2);
});

test('alignment-state: foldLegacyTimeline ignores malformed baselines like the fold', () => {
    const events = [
        legacyEvent('alignment/baseline', { baseline: { not: 'a baseline' } }, 0),
        legacyEvent('alignment/baseline-updated', { nope: true }, 1)
    ] as never as Parameters<typeof foldLegacyTimeline>[0];
    const checkpoints = foldLegacyTimeline(events);
    assert.equal(checkpoints.length, 0);
    assert.equal(foldAlignmentStatus(events).revision, 0);
});

test('alignment-state: foldLegacyTimeline keeps v0.1 alignment/status manual checks', () => {
    const events = [
        legacyEvent('alignment/status', { kind: 'manual-check', at: 100 }, 0),
        legacyEvent('alignment/status', { kind: 'something-else', at: 200 }, 1)
    ];
    const checkpoints = foldLegacyTimeline(events);
    assert.equal(checkpoints.length, 1);
    assert.equal(latestState(checkpoints).manualChecks, 1);
    assert.equal(latestState(checkpoints).lastManualCheckAt, 100);
});
