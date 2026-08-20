import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseSidecarDocument,
    statusFromSidecarRecord,
    simulateSidecarBaselineUpdate
} from '../src/sidecar-fold.ts';
import type { AlignmentSessionRecord } from '../src/alignment-state-store.ts';

const pendingRecord: AlignmentSessionRecord = {
    schemaVersion: 1,
    identity: { id: 's-1', createdAt: 1, cwd: '/tmp' },
    checkpoints: [
        {
            visibleThroughSeq: 10,
            state: {
                lastBaselineOrder: 1,
                driftCount: 1,
                lastDecisionOrder: 2,
                manualChecks: 0,
                baseline: { revision: 1, goal: 'keep it local', explicitConstraints: ['no cloud'], updatedAt: 1 },
                lastDrift: {
                    driftSeq: 10,
                    reason: 'user-direction-change',
                    description: 'make it work across devices',
                    at: 2
                },
                lastDecision: { driftSeq: 10, decision: 'approve', at: 3 }
            }
        }
    ]
};

test('sidecar-fold: parseSidecarDocument reads the sessions table', () => {
    const sessions = parseSidecarDocument(JSON.stringify({
        unit: { name: 'requirements_alignment', version: 1 },
        global: null,
        tables: { sessions: { 's-1': pendingRecord } }
    }));
    assert.equal(Object.keys(sessions).length, 1);
    assert.equal(sessions['s-1']?.identity.id, 's-1');
});

test('sidecar-fold: parseSidecarDocument rejects a foreign unit', () => {
    assert.throws(
        () => parseSidecarDocument(JSON.stringify({ unit: { name: 'other' }, tables: { sessions: {} } })),
        /not a requirements_alignment sidecar document/
    );
});

test('sidecar-fold: statusFromSidecarRecord derives baseline-update-pending from the latest checkpoint', () => {
    const status = statusFromSidecarRecord(pendingRecord);
    assert.equal(status.status, 'baseline-update-pending');
    assert.equal(status.revision, 1);
    assert.equal(status.lastDecision?.decision, 'approve');
});

test('sidecar-fold: simulateSidecarBaselineUpdate yields aligned at the next revision', () => {
    const after = simulateSidecarBaselineUpdate(pendingRecord, 'Make it work across devices', 9);
    assert.equal(after.status, 'aligned');
    assert.equal(after.revision, 2);
    assert.equal(after.baseline?.goal, 'Make it work across devices');
});
