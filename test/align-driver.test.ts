/**
 * Align driver tests: config validation (v0.2.1) plus the v0.2.2 regression
 * suite proving the driver resolves the alignment store LAZILY.
 *
 * The bugfixed behavior (dogfood 03 gate): when the driver's `apply()` runs
 * before the RequirementsAlignmentController (and its sidecar store) are
 * available, the driver must NOT permanently capture `undefined`; every later
 * status read must re-resolve the store and return the durable sidecar view
 * (baseline revision >= 1), never the legacy session-log fold (revision 0).
 *
 * Scenario mirrored from dogfood 03:
 *
 *   1. `apply(ctx)` runs while `ctx.requirementsAlignment` is undefined;
 *   2. the driver finishes registering;
 *   3. the controller (and its store) become available afterwards;
 *   4. the sidecar store already holds baseline revision = 1 for the session;
 *   5. the session log carries no `alignment/*` events at all (the legacy
 *      fold therefore derives revision = 0);
 *   6. the driver's later status reads must yield the sidecar revision 1 —
 *      `baseline exists` + `revision === 1` — not the fold's revision 0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { apply as applyAlignDriver, resolveAlignDriverConfig } from '../src/align-driver.ts';
import { foldAlignmentStatus } from '../src/status.ts';
import { fakeSession, legacyEvent, makeStore } from './helpers.ts';

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
    assert.deepEqual(resolveAlignDriverConfig({ verifyRegistrations: true }), { verifyRegistrations: true });
    assert.deepEqual(resolveAlignDriverConfig({ recordPath: 'r.jsonl', runAlign: true, verifyPolicySection: true, verifyRegistrations: true }), {
        recordPath: 'r.jsonl',
        runAlign: true,
        verifyPolicySection: true,
        verifyRegistrations: true
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
    assert.throws(() => resolveAlignDriverConfig({ verifyRegistrations: 'yes' } as never), /verifyRegistrations must be a boolean/);
});

/** Read the driver's JSONL record file into parsed records. */
async function readRecords(recordPath: string): Promise<Array<Record<string, unknown>>> {
    const text = await readFile(recordPath, 'utf8');
    return text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('align-driver: resolves alignment store lazily after apply', async () => {
    const ctx = new Context();
    const dir = await mkdtemp(join(tmpdir(), 'align-driver-lazy-'));
    const recordPath = join(dir, 'records.jsonl');
    try {
        // 1. apply() runs BEFORE any alignment service exists.
        assert.equal(ctx.get('requirementsAlignment'), undefined, 'precondition: the store is not mounted at apply() time');
        applyAlignDriver(ctx, { recordPath, snapshotFirstMutation: true });

        // 2. The sidecar store becomes available LATER and already holds
        //    baseline revision 1 for the session; the session log carries NO
        //    alignment/* events (the legacy fold therefore sees revision 0).
        const store = await makeStore();
        const { session, events } = fakeSession();
        await store.recordBaseline(session, {
            revision: 1,
            goal: 'Fix the dogfood 03 regression',
            explicitConstraints: ['no session events'],
            updatedAt: 1
        });
        assert.equal(store.getStatus(session).revision, 1, 'the sidecar store holds revision 1');
        assert.equal(foldAlignmentStatus(events).revision, 0, 'the legacy fold sees no baseline — the log carries no alignment/* events');
        ctx.provide('requirementsAlignment', { stateStore: store });
        const agent = { session, steer: () => { } };

        // 3. The agent starts: the driver must read the CURRENT store view
        //    (revision 1), never the fold (revision 0).
        ctx.emit('agent/session-start', { agent } as never);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const records = await readRecords(recordPath);
        const start = records.find((record) => record.phase === 'start');
        assert.ok(start, 'a start snapshot is recorded');
        assert.equal(start.baselineRecorded, true, 'baseline exists — the driver sees the sidecar record');
        assert.equal(start.revision, 1, 'the driver reads the sidecar revision, not the legacy fold revision 0');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('align-driver: turn-end and first-mutation snapshots also resolve the store lazily', async () => {
    const ctx = new Context();
    const dir = await mkdtemp(join(tmpdir(), 'align-driver-lazy-'));
    const recordPath = join(dir, 'records.jsonl');
    try {
        applyAlignDriver(ctx, { recordPath, snapshotFirstMutation: true });
        // The store appears after apply(); the agents service is mounted so
        // the session/event path can resolve the agent.
        const store = await makeStore();
        const { session } = fakeSession();
        await store.recordBaseline(session, {
            revision: 1,
            goal: 'Later snapshots resolve the store too',
            explicitConstraints: [],
            updatedAt: 1
        });
        ctx.provide('requirementsAlignment', { stateStore: store });
        const agent = { session, steer: () => { } };
        ctx.provide('agents', { get: () => agent });

        ctx.emit('session/event', session as never, { type: 'turn/end' } as never);
        // A planning-only tool call (todo_write) must NOT count as the first
        // mutation; only the first workspace-mutating tool call does.
        ctx.emit('session/event', session as never, { type: 'tool/call', data: { name: 'todo_write' } } as never);
        ctx.emit('session/event', session as never, { type: 'tool/call', data: { name: 'edit' } } as never);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const records = await readRecords(recordPath);
        const turnEnd = records.find((record) => record.phase === 'turn-end');
        assert.ok(turnEnd, 'a turn-end snapshot is recorded');
        assert.equal(turnEnd.revision, 1, 'turn-end reads the lazily-resolved store');
        const firstMutation = records.find((record) => record.phase === 'first-mutation');
        assert.ok(firstMutation, 'a first-mutation snapshot is recorded');
        assert.equal(firstMutation.revision, 1, 'first-mutation reads the lazily-resolved store');
        assert.equal(firstMutation.toolName, 'edit', 'todo_write is planning-only and must not count as the first mutation');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('align-driver: legacy fold fallback is preserved when no store ever appears', async () => {
    const ctx = new Context();
    const dir = await mkdtemp(join(tmpdir(), 'align-driver-lazy-'));
    const recordPath = join(dir, 'records.jsonl');
    try {
        applyAlignDriver(ctx, { recordPath });
        // No requirementsAlignment service is ever mounted: a legacy session
        // whose log still carries alignment/* events must fold through the
        // compatibility layer (never crash, never invent a store).
        const { session, events } = fakeSession();
        events.push(legacyEvent('alignment/baseline', {
            baseline: { revision: 1, goal: 'legacy session', explicitConstraints: [], updatedAt: 1 }
        }, 0));
        const agent = { session, steer: () => { } };
        ctx.emit('agent/session-start', { agent } as never);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const records = await readRecords(recordPath);
        const start = records.find((record) => record.phase === 'start');
        assert.ok(start, 'a start snapshot is recorded');
        assert.equal(start.revision, 1, 'legacy fold fallback still derives the legacy baseline');
        assert.equal(start.baselineRecorded, true);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});