import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAlignDriverConfig } from '../src/align-driver.ts';

test('align-driver: default config is empty', () => {
    assert.deepEqual(resolveAlignDriverConfig(), {});
    assert.deepEqual(resolveAlignDriverConfig({}), {});
});

test('align-driver: accepts a record path, run flag, and isolation flag', () => {
    assert.deepEqual(resolveAlignDriverConfig({ recordPath: 'records/r.jsonl' }), { recordPath: 'records/r.jsonl' });
    assert.deepEqual(resolveAlignDriverConfig({ injectAskUserCall: true }), { injectAskUserCall: true });
    assert.deepEqual(resolveAlignDriverConfig({ runAlign: true }), { runAlign: true });
    assert.deepEqual(resolveAlignDriverConfig({ recordPath: 'r.jsonl', runAlign: false, injectAskUserCall: false }), {
        recordPath: 'r.jsonl',
        runAlign: false,
        injectAskUserCall: false
    });
});

test('align-driver: accepts the mutation-snapshot, halt, and policy-verify flags', () => {
    assert.deepEqual(resolveAlignDriverConfig({ snapshotFirstMutation: true }), { snapshotFirstMutation: true });
    assert.deepEqual(resolveAlignDriverConfig({ haltAtDecision: true }), { haltAtDecision: true });
    assert.deepEqual(resolveAlignDriverConfig({ snapshotFirstMutation: true, haltAtDecision: true }), {
        snapshotFirstMutation: true,
        haltAtDecision: true
    });
    assert.deepEqual(resolveAlignDriverConfig({ verifyPolicySection: true }), { verifyPolicySection: true });
    assert.deepEqual(resolveAlignDriverConfig({ recordPath: 'r.jsonl', runAlign: true, verifyPolicySection: true }), {
        recordPath: 'r.jsonl',
        runAlign: true,
        verifyPolicySection: true
    });
});

test('align-driver: rejects unknown keys', () => {
    assert.throws(() => resolveAlignDriverConfig({ nope: 1 } as never), /unknown key\(s\) nope/);
});

test('align-driver: rejects non-boolean flags', () => {
    assert.throws(() => resolveAlignDriverConfig({ injectAskUserCall: 'yes' } as never), /injectAskUserCall must be a boolean/);
    assert.throws(() => resolveAlignDriverConfig({ runAlign: 1 } as never), /runAlign must be a boolean/);
    assert.throws(() => resolveAlignDriverConfig({ snapshotFirstMutation: 'yes' } as never), /snapshotFirstMutation must be a boolean/);
    assert.throws(() => resolveAlignDriverConfig({ haltAtDecision: 1 } as never), /haltAtDecision must be a boolean/);
    assert.throws(() => resolveAlignDriverConfig({ verifyPolicySection: 'yes' } as never), /verifyPolicySection must be a boolean/);
});
