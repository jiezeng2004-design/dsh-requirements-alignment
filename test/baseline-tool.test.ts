import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions';
import {
    buildBaseline,
    buildDriftQuestion,
    DEFAULT_DRIFT_OPTIONS,
    mapDriftAnswer,
    registerEstablishBaseline,
    registerReportDrift,
    renderDriftOutcome,
    validateBaselineInput,
    validateDriftArgs,
    validateDriftOptions,
    withDefaultOptions
} from '../src/baseline-tool.ts';
import { foldAlignmentStatus } from '../src/status.ts';
import { fakeSession, makeStore, legacyEvent } from './helpers.ts';

interface FakeAsk {
    answer?: unknown;
    error?: Error;
}

/** A fake context exposing tools.register and ctx.get('userQuestions'). */
function makeCtx(fakeAsk: FakeAsk, noQuestions = false) {
    const definitions: ToolDefinition[] = [];
    const userQuestions = {
        ask: async () => {
            if (fakeAsk.error !== undefined) throw fakeAsk.error;
            return fakeAsk.answer;
        }
    };
    const ctx = {
        tools: {
            register: (definition: ToolDefinition) => {
                definitions.push(definition);
                return () => { };
            }
        },
        get: (name: string) => (name === 'userQuestions' ? (noQuestions ? undefined : userQuestions) : undefined)
    };
    return { ctx: ctx as never, definitions };
}

function execFor(session: ReturnType<typeof fakeSession>['session']) {
    const agent = { session };
    return { exec: { agent, signal: new AbortController().signal } as never };
}

const approveAnswer = { answers: [{ id: 'alignment-drift', selected: [DEFAULT_DRIFT_OPTIONS[0].label] }] };
const emptyAnswer = { answers: [{ id: 'alignment-drift', selected: [] }] };

test('baseline-tool: validateBaselineInput accepts a minimal baseline', () => {
    assert.deepEqual(validateBaselineInput({ goal: 'Fix the form bug', explicitConstraints: ['no UI change'] }), {
        goal: 'Fix the form bug',
        explicitConstraints: ['no UI change']
    });
});

test('baseline-tool: validateBaselineInput rejects empty and malformed input', () => {
    assert.throws(() => validateBaselineInput({}), /must include a goal or at least one/);
    assert.throws(() => validateBaselineInput({ goal: '   ' }), /must include a goal or at least one/);
    assert.throws(() => validateBaselineInput({ goal: 42 }), /goal must be a string/);
    assert.throws(() => validateBaselineInput({ explicitConstraints: 'nope' }), /must be an array of strings/);
    assert.throws(() => validateBaselineInput(null), /must be an object/);
});

test('baseline-tool: buildBaseline advances the revision', () => {
    const first = buildBaseline({ goal: 'v1' }, undefined, 100);
    assert.equal(first.revision, 1);
    assert.equal(first.updatedAt, 100);
    const second = buildBaseline({ goal: 'v2' }, first, 200);
    assert.equal(second.revision, 2);
    assert.equal(second.goal, 'v2');
});

test('baseline-tool: establish_baseline records silently in the store without asking the user', async () => {
    const store = await makeStore();
    const { ctx, definitions } = makeCtx({});
    registerEstablishBaseline(ctx, store);
    assert.equal(definitions.length, 1);
    const { session } = fakeSession();
    const { exec } = execFor(session);
    const result = await definitions[0]!.execute({ baseline: { goal: 'Fix typo', explicitConstraints: ['no UI change'] } }, exec);
    assert.deepEqual(result, { revision: 1 });
    // The baseline lives in the sidecar store, never in session events.
    assert.equal(session.events.length, 0);
    const status = store.getStatus(session);
    assert.equal(status.revision, 1);
    assert.equal(status.baseline?.goal, 'Fix typo');
    assert.equal(status.status, 'aligned');
    // A second call updates the revision instead of re-recording.
    await definitions[0]!.execute({ baseline: { goal: 'Fix typo', explicitConstraints: ['no UI change', 'no API change'] } }, exec);
    assert.equal(store.getStatus(session).revision, 2);
    assert.equal(session.events.length, 0, 'no alignment session events may ever be appended');
});

test('baseline-tool: establish_baseline validates its input', async () => {
    const store = await makeStore();
    const { ctx, definitions } = makeCtx({});
    registerEstablishBaseline(ctx, store);
    const { session } = fakeSession();
    const { exec } = execFor(session);
    await assert.rejects(
        definitions[0]!.execute({ baseline: {} }, exec),
        /must include a goal or at least one/
    );
    assert.equal(store.getStatus(session).revision, 0, 'nothing recorded for invalid input');
});

test('baseline-tool: establish_baseline requires a calling agent', async () => {
    const store = await makeStore();
    const { ctx, definitions } = makeCtx({});
    registerEstablishBaseline(ctx, store);
    await assert.rejects(
        definitions[0]!.execute({ baseline: { goal: 'x' } }, { agent: undefined, signal: new AbortController().signal } as never),
        /requires a calling agent/
    );
});

test('baseline-tool: report_drift asks the user and records drift + decision in the store', async () => {
    const store = await makeStore();
    const { ctx, definitions } = makeCtx({ answer: approveAnswer });
    registerReportDrift(ctx, store);
    assert.equal(definitions.length, 1);
    const { session } = fakeSession();
    const { exec } = execFor(session);
    const result = await definitions[0]!.execute({
        reason: 'architecture-shift',
        description: 'add cloud sync',
        requiredChange: 'baseline becomes cross-device'
    }, exec);
    assert.deepEqual(result, { decision: 'approve', requiredChange: 'baseline becomes cross-device' });
    const status = store.getStatus(session);
    assert.equal(status.driftCount, 1);
    assert.equal(status.lastDrift?.reason, 'architecture-shift');
    assert.equal(status.lastDecision?.decision, 'approve');
    // The decision pairs the drift by the store's drift seq (the public
    // AlignmentStatus.lastDrift deliberately carries no driftSeq, like the
    // legacy fold).
    assert.equal(status.lastDecision?.driftSeq, 0);
    // Approve without a recorded new baseline is the durability state, not aligned.
    assert.equal(status.status, 'baseline-update-pending');
    assert.equal(session.events.length, 0, 'no alignment session events may ever be appended');
});

test('baseline-tool: mapDriftAnswer maps default approve, default reject, and free text', () => {
    assert.equal(mapDriftAnswer([DEFAULT_DRIFT_OPTIONS[0].label], undefined).decision, 'approve');
    assert.equal(mapDriftAnswer([DEFAULT_DRIFT_OPTIONS[1].label], undefined).decision, 'reject');
    const revised = mapDriftAnswer([], 'Use file export instead.');
    assert.equal(revised.decision, 'revise');
    assert.equal(revised.note, 'Use file export instead.');
});

test('baseline-tool: a model-supplied custom option maps to revise with its label as note', () => {
    const presented = [{ label: 'Use export files' }, { label: 'Add cloud sync' }];
    const first = mapDriftAnswer(['Use export files'], undefined, presented);
    assert.equal(first.decision, 'revise');
    assert.equal(first.note, 'Use export files');
    const second = mapDriftAnswer(['Add cloud sync'], undefined, presented);
    assert.equal(second.decision, 'revise');
    assert.equal(second.note, 'Add cloud sync');
});

test('baseline-tool: withDefaultOptions always offers the exact defaults alongside model options', () => {
    // Model options alone: defaults are appended.
    const appended = withDefaultOptions([{ label: 'Use export files' }, { label: 'Add cloud sync' }]);
    assert.deepEqual(appended.map((option) => option.label), [
        'Use export files',
        'Add cloud sync',
        DEFAULT_DRIFT_OPTIONS[0].label,
        DEFAULT_DRIFT_OPTIONS[1].label
    ]);
    // Model options that already contain a default label: no duplicate.
    const deduped = withDefaultOptions([{ label: 'Stay within the current scope' }, { label: 'Use export files' }]);
    assert.deepEqual(deduped.map((option) => option.label), [
        'Stay within the current scope',
        'Use export files',
        DEFAULT_DRIFT_OPTIONS[0].label
    ]);
    // Defaults alone: unchanged.
    assert.deepEqual(withDefaultOptions([...DEFAULT_DRIFT_OPTIONS]).map((option) => option.label),
        DEFAULT_DRIFT_OPTIONS.map((option) => option.label));
    // A user picking the exact default stay option rejects even when the
    // model offered a look-alike label of its own.
    const mixed = withDefaultOptions([{ label: 'Stay within UI-only scope' }, { label: 'Refactor the backend' }]);
    const answer = mapDriftAnswer([DEFAULT_DRIFT_OPTIONS[1].label], undefined, mixed);
    assert.deepEqual(answer, { decision: 'reject' });
});

test('baseline-tool: uninterpretable answers fail loud instead of silently rejecting', () => {
    const presented = [{ label: 'Use export files' }, { label: 'Add cloud sync' }];
    // A label that matches no presented option.
    assert.throws(() => mapDriftAnswer(['Something else entirely'], undefined, presented), /not one of the presented options/);
    // No selection and no free text.
    assert.throws(() => mapDriftAnswer([], undefined), /without a selection/);
    // Multiple selections.
    assert.throws(() => mapDriftAnswer(['a', 'b'], undefined), /multiple options/);
});

test('baseline-tool: an empty answer fails the report_drift tool and records no decision', async () => {
    const store = await makeStore();
    const { ctx, definitions } = makeCtx({ answer: emptyAnswer });
    registerReportDrift(ctx, store);
    const { session } = fakeSession();
    const { exec } = execFor(session);
    await assert.rejects(
        definitions[0]!.execute({ reason: 'behavior-change', description: 'x' }, exec),
        /without a selection/
    );
    // The drift candidate stays durable; no decision is fabricated.
    const status = store.getStatus(session);
    assert.equal(status.driftCount, 1);
    assert.equal(status.status, 'drift-pending');
    assert.equal(session.events.length, 0);
});

test('baseline-tool: report_drift records a revise decision with the custom note and returns it', async () => {
    const store = await makeStore();
    const { ctx, definitions } = makeCtx({ answer: { answers: [{ id: 'alignment-drift', selected: [], custom: 'Sync via export files instead.' }] } });
    registerReportDrift(ctx, store);
    const { session } = fakeSession();
    const { exec } = execFor(session);
    const result = await definitions[0]!.execute({ reason: 'user-direction-change', description: 'sync' }, exec);
    // The tool result feeds the user's exact choice back to the agent, so it
    // never has to re-ask which direction was picked.
    assert.deepEqual(result, { decision: 'revise', note: 'Sync via export files instead.' });
    const status = store.getStatus(session);
    assert.equal(status.lastDecision?.decision, 'revise');
    assert.equal(status.lastDecision?.note, 'Sync via export files instead.');
    assert.equal(session.events.length, 0);
});

test('baseline-tool: report_drift returns the selected custom option label as the note', async () => {
    const store = await makeStore();
    const { ctx, definitions } = makeCtx({ answer: { answers: [{ id: 'alignment-drift', selected: ['Use export files'] }] } });
    registerReportDrift(ctx, store);
    const { session } = fakeSession();
    const { exec } = execFor(session);
    const result = await definitions[0]!.execute({
        reason: 'user-direction-change',
        description: 'cross-device',
        requiredChange: 'baseline becomes cross-device',
        options: [{ label: 'Use export files' }, { label: 'Add cloud sync' }]
    }, exec);
    assert.deepEqual(result, { decision: 'revise', note: 'Use export files', requiredChange: 'baseline becomes cross-device' });
    assert.equal(store.getStatus(session).lastDecision?.note, 'Use export files');
});

test('baseline-tool: report_drift records the drift even when the question fails (child escalation)', async () => {
    const store = await makeStore();
    const { ctx, definitions } = makeCtx({ error: new UserQuestionError('children cannot ask', 'DELEGATED_CALLER') });
    registerReportDrift(ctx, store);
    const { session } = fakeSession();
    const { exec } = execFor(session);
    await assert.rejects(
        definitions[0]!.execute({ reason: 'constraint-conflict', description: 'api must change' }, exec),
        /child agent.*Requirement drift candidate/s
    );
    // The drift candidate is durable; no decision was recorded.
    const status = store.getStatus(session);
    assert.equal(status.driftCount, 1);
    assert.equal(status.lastDecision, undefined);
    assert.equal(status.status, 'drift-pending');
});

test('baseline-tool: report_drift handles cancelled questions and missing channels', async () => {
    const store1 = await makeStore();
    const cancelled = makeCtx({ error: new UserQuestionError('dismissed', 'ASK_CANCELLED') });
    registerReportDrift(cancelled.ctx, store1);
    const { session } = fakeSession();
    const { exec } = execFor(session);
    await assert.rejects(
        cancelled.definitions[0]!.execute({ reason: 'scope-expansion', description: 'x' }, exec),
        /wait for their message/
    );
    // A missing channel is a prerequisite, validated BEFORE the durable write:
    // the tool fails with no durable residue at all.
    const store2 = await makeStore();
    const noChannel = makeCtx({}, true);
    registerReportDrift(noChannel.ctx, store2);
    const { session: session2 } = fakeSession();
    const { exec: exec2 } = execFor(session2);
    await assert.rejects(
        noChannel.definitions[0]!.execute({ reason: 'scope-expansion', description: 'x' }, exec2),
        /no user-questions channel/
    );
    assert.equal(store2.getStatus(session2).driftCount, 0, 'no drift recorded without a question channel');
});

test('baseline-tool: invalid report_drift arguments fail before any durable write', async () => {
    const store = await makeStore();
    const { ctx, definitions } = makeCtx({ answer: approveAnswer });
    registerReportDrift(ctx, store);
    const { session } = fakeSession();
    const { exec } = execFor(session);
    const invalid = [
        { reason: 'not-a-reason', description: 'x' },
        { reason: 'scope-expansion', description: '   ' },
        { reason: 'scope-expansion', description: 'x', requiredChange: 42 },
        { reason: 'scope-expansion', description: 'x', options: [{ label: 'a' }, { label: 'a' }] },
        { reason: 'scope-expansion', description: 'x', options: [{ label: 'a' }] },
        { reason: 'scope-expansion', description: 'x', options: [{ label: '  ' }, { label: 'b' }] },
        { reason: 'scope-expansion', description: 'x', options: 'nope' }
    ];
    for (const args of invalid) {
        // Schema-level violations surface as ToolArgsError before execute;
        // plugin-level violations carry the report_drift: prefix. Either way
        // the tool fails and the store stays clean.
        await assert.rejects(
            definitions[0]!.execute(args as never, exec),
            /report_drift:|invalid arguments/
        );
        assert.equal(store.getStatus(session).driftCount, 0, `args ${JSON.stringify(args)} must not record anything`);
    }
    assert.equal(store.getStatus(session).driftCount, 0);
});

test('baseline-tool: report_drift validates its arguments', () => {
    assert.throws(() => validateDriftOptions([{ label: 'a' }]), /2-3 items/);
    assert.throws(() => validateDriftOptions([{ label: 'a' }, { label: 'a' }]), /distinct/);
    assert.throws(() => validateDriftOptions([{ label: 'a' }, { label: '  ' }]), /blank/);
    assert.throws(() => validateDriftOptions([{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }]), /2-3 items/);
    assert.throws(() => validateDriftOptions('nope'), /must be an array/);
    assert.deepEqual(validateDriftOptions(undefined), undefined);
    assert.deepEqual(validateDriftOptions([{ label: 'a' }, { label: 'b', description: 'd' }]), [
        { label: 'a' },
        { label: 'b', description: 'd' }
    ]);
});

test('baseline-tool: validateDriftArgs rejects every invalid shape', () => {
    assert.throws(() => validateDriftArgs(null), /must be an object/);
    assert.throws(() => validateDriftArgs({ reason: 'nope', description: 'x' }), /reason must be one of/);
    assert.throws(() => validateDriftArgs({ reason: 'scope-expansion' }), /description must be a non-empty string/);
    assert.throws(() => validateDriftArgs({ reason: 'scope-expansion', description: 'x', requiredChange: 3 }), /requiredChange must be a string/);
    assert.throws(() => validateDriftArgs({ reason: 'scope-expansion', description: 'x', options: [{ label: 'a' }, { label: 'a' }] }), /distinct/);
    const valid = validateDriftArgs({ reason: 'scope-expansion', description: 'x', requiredChange: 'y', options: [{ label: 'a' }, { label: 'b' }] });
    assert.deepEqual(valid, { reason: 'scope-expansion', description: 'x', requiredChange: 'y', options: [{ label: 'a' }, { label: 'b' }] });
    assert.deepEqual(validateDriftArgs({ reason: 'user-direction-change', description: 'x' }), { reason: 'user-direction-change', description: 'x' });
});

test('baseline-tool: drift question renders reason, description, and required change', () => {
    const question = buildDriftQuestion('data-model-change', 'tasks need sync', 'baseline becomes cross-device', [...DEFAULT_DRIFT_OPTIONS]);
    assert.equal(question.id, 'alignment-drift');
    assert.match(question.question, /data-model-change/);
    assert.match(question.question, /tasks need sync/);
    assert.match(question.detail, /Required baseline change: baseline becomes cross-device/);
    assert.equal(question.options.length, 2);
});

test('baseline-tool: renderDriftOutcome instructs the follow-up and names the user choice', () => {
    assert.match(renderDriftOutcome('approve'), /establish_baseline/);
    assert.match(renderDriftOutcome('reject'), /stay within the current requirement baseline/);
    assert.match(renderDriftOutcome('revise'), /establish_baseline/);
    // The exact chosen direction and the required change are fed back verbatim.
    assert.match(renderDriftOutcome('revise', 'Use export files'), /"Use export files"/);
    assert.match(renderDriftOutcome('approve', undefined, 'baseline becomes cross-device'), /Required baseline change: baseline becomes cross-device/);
    assert.match(renderDriftOutcome('revise', 'Use export files', 'baseline becomes cross-device'), /"Use export files"/);
    assert.match(renderDriftOutcome('revise', 'Use export files', 'baseline becomes cross-device'), /Required baseline change: baseline becomes cross-device/);
});

// --- store parity: a store-driven session must match the legacy fold -------
test('baseline-tool: store state after drift/decision equals the legacy fold of equivalent events', async () => {
    const store = await makeStore();
    const { session } = fakeSession();
    await store.recordDrift(session, { reason: 'scope-expansion', description: 'refactor state management', at: 10 });
    const decisionStatus = store.getStatus(session);
    assert.equal(decisionStatus.driftCount, 1);
    // Equivalent legacy events fold to the same posture.
    const legacy = foldAlignmentStatus([
        legacyEvent('alignment/drift', { reason: 'scope-expansion', description: 'refactor state management', at: 10 }, 0)
    ]);
    assert.equal(legacy.status, decisionStatus.status);
    assert.equal(legacy.driftCount, decisionStatus.driftCount);
    assert.equal(session.events.length, 0);
});
