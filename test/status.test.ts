import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import {
    appendBaseline,
    appendBaselineUpdated,
    appendDecision,
    appendDrift,
    appendManualCheck,
    foldAlignmentStatus,
    foldRequirementBaseline,
    type AlignmentLog
} from '../src/status.ts';
import type { RequirementBaseline } from '../src/types.ts';

function event(type: string, data: unknown, seq: number): SessionEvent {
    return { seq, time: 0, type, data } as unknown as SessionEvent;
}

function toolCall(name: string, seq: number): SessionEvent {
    return event('tool/call', { turn: 1, step: 1, callId: `call-${name}`, name, arguments: '{}' }, seq);
}

function baseline(overrides: Partial<RequirementBaseline> = {}): RequirementBaseline {
    return { revision: 1, updatedAt: 1000, ...overrides };
}

function drift(reason: string, seq: number): SessionEvent {
    return event('alignment/drift', { reason, description: `change ${reason}`, at: 2000 }, seq);
}

function decision(driftSeq: number, decisionKind: string, seq: number): SessionEvent {
    return event('alignment/decision', { driftSeq, decision: decisionKind, at: 3000 }, seq);
}

/** A session double whose append returns the logged event with its seq. */
function makeLog(seed: SessionEvent[] = []) {
    const events: SessionEvent[] = [...seed];
    const log: AlignmentLog = {
        append: ((type: string, data: unknown) => {
            const appended = { seq: events.length, time: 0, type, data } as unknown as SessionEvent;
            events.push(appended);
            return appended;
        }) as never
    };
    return { events, log };
}

test('status: empty log folds to zero state with unknown posture', () => {
    assert.deepEqual(foldAlignmentStatus([]), {
        revision: 0,
        driftCount: 0,
        status: 'unknown',
        manualChecks: 0
    });
});

test('status: baseline fold — none recorded yields undefined', () => {
    assert.equal(foldRequirementBaseline([]), undefined);
    assert.equal(foldRequirementBaseline([toolCall('read', 0)]), undefined);
});

test('status: baseline fold — the last baseline event wins', () => {
    const events = [
        event('alignment/baseline', { baseline: baseline({ revision: 1, goal: 'v1' }) }, 0),
        event('alignment/baseline-updated', { baseline: baseline({ revision: 2, goal: 'v2' }) }, 1),
        event('alignment/baseline', { baseline: baseline({ revision: 3, goal: 'v3' }) }, 2)
    ];
    assert.equal(foldRequirementBaseline(events)?.revision, 3);
    assert.equal(foldRequirementBaseline(events)?.goal, 'v3');
    assert.equal(foldAlignmentStatus(events).revision, 3);
});

test('status: baseline fold — defensive against malformed payloads', () => {
    const events = [
        event('alignment/baseline', { baseline: { not: 'a baseline' } }, 0),
        event('alignment/baseline-updated', { nope: true }, 1)
    ] as unknown as SessionEvent[];
    assert.equal(foldRequirementBaseline(events), undefined);
    assert.equal(foldAlignmentStatus(events).revision, 0);
});

test('status: drift events count and the last one wins', () => {
    const events = [drift('scope-expansion', 0), drift('architecture-shift', 1), toolCall('read', 2)];
    const status = foldAlignmentStatus(events);
    assert.equal(status.driftCount, 2);
    assert.equal(status.lastDrift?.reason, 'architecture-shift');
    assert.equal(status.lastDrift?.description, 'change architecture-shift');
    assert.equal(status.status, 'drift-pending');
});

test('status: a paired reject keeps the baseline in force (aligned, revision unchanged)', () => {
    const events = [
        event('alignment/baseline', { baseline: baseline({ revision: 1, goal: 'v1' }) }, 0),
        drift('constraint-conflict', 5),
        decision(5, 'reject', 6)
    ];
    const status = foldAlignmentStatus(events);
    assert.equal(status.status, 'aligned');
    assert.equal(status.revision, 1);
    assert.equal(status.lastDecision?.decision, 'reject');
    assert.equal(status.lastDecision?.driftSeq, 5);
});

test('status: an unanswered last drift stays drift-pending even with older decisions', () => {
    const events = [drift('scope-expansion', 1), decision(1, 'approve', 2), drift('architecture-shift', 3)];
    const status = foldAlignmentStatus(events);
    assert.equal(status.status, 'drift-pending');
    assert.equal(status.driftCount, 2);
});

test('status: approve without a following baseline event folds to baseline-update-pending', () => {
    const events = [
        event('alignment/baseline', { baseline: baseline({ revision: 1, goal: 'v1' }) }, 0),
        drift('architecture-shift', 1),
        decision(1, 'approve', 2)
    ];
    const status = foldAlignmentStatus(events);
    assert.equal(status.status, 'baseline-update-pending');
    assert.equal(status.revision, 1);
    assert.equal(status.baseline?.goal, 'v1');
});

test('status: revise without a following baseline event folds to baseline-update-pending', () => {
    const events = [
        event('alignment/baseline', { baseline: baseline({ revision: 1, goal: 'v1' }) }, 0),
        drift('user-direction-change', 1),
        decision(1, 'revise', 2)
    ];
    const status = foldAlignmentStatus(events);
    assert.equal(status.status, 'baseline-update-pending');
    assert.equal(status.revision, 1);
});

test('status: full chain baseline v1 -> drift -> approve -> baseline v2 -> aligned with revision increment', () => {
    const events = [
        event('alignment/baseline', { baseline: baseline({ revision: 1, goal: 'v1' }) }, 0),
        drift('architecture-shift', 1),
        decision(1, 'approve', 2),
        event('alignment/baseline-updated', { baseline: baseline({ revision: 2, goal: 'v2', updatedAt: 4000 }) }, 3)
    ];
    const status = foldAlignmentStatus(events);
    assert.equal(status.status, 'aligned');
    assert.equal(status.revision, 2);
    assert.equal(status.baseline?.goal, 'v2');
});

test('status: full chain baseline v1 -> drift -> reject -> aligned with revision unchanged', () => {
    const events = [
        event('alignment/baseline', { baseline: baseline({ revision: 1, goal: 'v1' }) }, 0),
        drift('scope-expansion', 1),
        decision(1, 'reject', 2)
    ];
    const status = foldAlignmentStatus(events);
    assert.equal(status.status, 'aligned');
    assert.equal(status.revision, 1);
});

test('status: approve with no baseline at all folds to baseline-update-pending, never aligned', () => {
    const events = [drift('behavior-change', 1), decision(1, 'approve', 2)];
    const status = foldAlignmentStatus(events);
    assert.equal(status.status, 'baseline-update-pending');
    assert.equal(status.revision, 0);
});

test('status: a second approve after the baseline update re-enters baseline-update-pending', () => {
    const events = [
        event('alignment/baseline', { baseline: baseline({ revision: 1, goal: 'v1' }) }, 0),
        drift('architecture-shift', 1),
        decision(1, 'approve', 2),
        event('alignment/baseline-updated', { baseline: baseline({ revision: 2, goal: 'v2' }) }, 3),
        decision(1, 'approve', 4)
    ];
    const status = foldAlignmentStatus(events);
    assert.equal(status.status, 'baseline-update-pending');
    assert.equal(status.revision, 2);
});

test('status: drift then reject then a newer baseline records aligned once recorded', () => {
    const events = [
        event('alignment/baseline', { baseline: baseline({ revision: 1, goal: 'v1' }) }, 0),
        drift('constraint-conflict', 1),
        decision(1, 'reject', 2),
        event('alignment/baseline-updated', { baseline: baseline({ revision: 2, goal: 'v1' }) }, 3)
    ];
    const status = foldAlignmentStatus(events);
    assert.equal(status.status, 'aligned');
    assert.equal(status.revision, 2);
});

test('status: tool/call records never count (unrelated ask_user_question isolation)', () => {
    const events = [toolCall('ask_user_question', 0), toolCall('ask_user_question', 1), toolCall('bash', 2)];
    const status = foldAlignmentStatus(events);
    assert.equal(status.driftCount, 0);
    assert.equal(status.revision, 0);
    assert.equal(status.status, 'unknown');
    assert.equal(status.manualChecks, 0);
});

test('status: manual checks count new and legacy v0.1 events', () => {
    const events = [
        event('alignment/manual-check', { at: 100 }, 0),
        event('alignment/status', { kind: 'manual-check', at: 200 }, 1),
        event('alignment/status', { kind: 'something-else', at: 300 }, 2),
        event('alignment/manual-check', { at: 400 }, 3)
    ];
    const status = foldAlignmentStatus(events);
    assert.equal(status.manualChecks, 3);
    assert.equal(status.lastManualCheckAt, 400);
});

test('status: old v0.1 session logs fold safely (no baseline, legacy checks, ignored questions)', () => {
    const legacy = [
        toolCall('ask_user_question', 0),
        event('alignment/status', { kind: 'manual-check', at: 500 }, 1),
        toolCall('read', 2)
    ];
    const status = foldAlignmentStatus(legacy);
    assert.deepEqual(status, {
        revision: 0,
        driftCount: 0,
        status: 'unknown',
        manualChecks: 1,
        lastManualCheckAt: 500
    });
});

test('status: append helpers record whole-value events with the right types', () => {
    const { events, log } = makeLog();
    appendBaseline(log, baseline({ revision: 1 }));
    appendBaselineUpdated(log, baseline({ revision: 2 }));
    const driftEvent = appendDrift(log, { reason: 'behavior-change', description: 'x', at: 10 });
    appendDecision(log, { driftSeq: driftEvent.seq, decision: 'approve', at: 20 });
    appendManualCheck(log, 30);
    assert.deepEqual(events.map((entry) => entry.type), [
        'alignment/baseline',
        'alignment/baseline-updated',
        'alignment/drift',
        'alignment/decision',
        'alignment/manual-check'
    ]);
    assert.equal(driftEvent.seq, 2);
});

test('status: full fold after the append helpers is coherent', () => {
    const { events, log } = makeLog();
    appendBaseline(log, baseline({ revision: 1, goal: 'Fix the form bug' }));
    const driftEvent = appendDrift(log, { reason: 'scope-expansion', description: 'refactor state management', at: 10 });
    appendDecision(log, { driftSeq: driftEvent.seq, decision: 'reject', at: 20 });
    const status = foldAlignmentStatus(events);
    assert.equal(status.revision, 1);
    assert.equal(status.baseline?.goal, 'Fix the form bug');
    assert.equal(status.driftCount, 1);
    assert.equal(status.status, 'aligned');
});
