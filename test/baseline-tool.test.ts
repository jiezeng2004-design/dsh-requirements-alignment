import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
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

/** A session double with a real event log and append returning logged events. */
function makeSession() {
    const events: SessionEvent[] = [];
    const session = {
        events: events as never,
        append: ((type: string, data: unknown) => {
            const appended = { seq: events.length, time: 0, type, data } as unknown as SessionEvent;
            events.push(appended);
            return appended;
        }) as never
    };
    return { session, events };
}

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

function execFor(session: ReturnType<typeof makeSession>['session']) {
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

test('baseline-tool: establish_baseline records silently without asking the user', async () => {
    const { ctx, definitions } = makeCtx({});
    registerEstablishBaseline(ctx);
    assert.equal(definitions.length, 1);
    const { session, events } = makeSession();
    const { exec } = execFor(session);
    const result = await definitions[0]!.execute({ baseline: { goal: 'Fix typo', explicitConstraints: ['no UI change'] } }, exec);
    assert.deepEqual(result, { revision: 1 });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'alignment/baseline');
    const status = foldAlignmentStatus(events);
    assert.equal(status.revision, 1);
    assert.equal(status.baseline?.goal, 'Fix typo');
    // A second call updates the revision instead of re-recording.
    await definitions[0]!.execute({ baseline: { goal: 'Fix typo', explicitConstraints: ['no UI change', 'no API change'] } }, exec);
    assert.equal(events.length, 2);
    assert.equal(events[1]!.type, 'alignment/baseline-updated');
    assert.equal(foldAlignmentStatus(events).revision, 2);
});

test('baseline-tool: establish_baseline validates its input', async () => {
    const { ctx, definitions } = makeCtx({});
    registerEstablishBaseline(ctx);
    const { session } = makeSession();
    const { exec } = execFor(session);
    await assert.rejects(
        definitions[0]!.execute({ baseline: {} }, exec),
        /must include a goal or at least one/
    );
});

test('baseline-tool: establish_baseline requires a calling agent', async () => {
    const { ctx, definitions } = makeCtx({});
    registerEstablishBaseline(ctx);
    await assert.rejects(
        definitions[0]!.execute({ baseline: { goal: 'x' } }, { agent: undefined, signal: new AbortController().signal } as never),
        /requires a calling agent/
    );
});

test('baseline-tool: report_drift asks the user and records drift + decision', async () => {
    const { ctx, definitions } = makeCtx({ answer: approveAnswer });
    registerReportDrift(ctx);
    assert.equal(definitions.length, 1);
    const { session, events } = makeSession();
    const { exec } = execFor(session);
    const result = await definitions[0]!.execute({
        reason: 'architecture-shift',
        description: 'add cloud sync',
        requiredChange: 'baseline becomes cross-device'
    }, exec);
    assert.deepEqual(result, { decision: 'approve', requiredChange: 'baseline becomes cross-device' });
    assert.equal(events.length, 2);
    assert.equal(events[0]!.type, 'alignment/drift');
    assert.equal((events[0]!.data as { reason: string }).reason, 'architecture-shift');
    assert.equal(events[1]!.type, 'alignment/decision');
    assert.equal((events[1]!.data as { decision: string }).decision, 'approve');
    assert.equal((events[1]!.data as { driftSeq: number }).driftSeq, 0);
    // Approve without a recorded new baseline is the durability state, not aligned.
    assert.equal(foldAlignmentStatus(events).status, 'baseline-update-pending');
});

test('baseline-tool: report_drift maps default approve, default reject, and free text', async () => {
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
    const { ctx, definitions } = makeCtx({ answer: emptyAnswer });
    registerReportDrift(ctx);
    const { session, events } = makeSession();
    const { exec } = execFor(session);
    await assert.rejects(
        definitions[0]!.execute({ reason: 'behavior-change', description: 'x' }, exec),
        /without a selection/
    );
    // The drift candidate stays durable; no decision is fabricated.
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'alignment/drift');
    assert.equal(foldAlignmentStatus(events).status, 'drift-pending');
});

test('baseline-tool: report_drift records a revise decision with the custom note and returns it', async () => {
    const { ctx, definitions } = makeCtx({ answer: { answers: [{ id: 'alignment-drift', selected: [], custom: 'Sync via export files instead.' }] } });
    registerReportDrift(ctx);
    const { session, events } = makeSession();
    const { exec } = execFor(session);
    const result = await definitions[0]!.execute({ reason: 'user-direction-change', description: 'sync' }, exec);
    // The tool result feeds the user's exact choice back to the agent, so it
    // never has to re-ask which direction was picked.
    assert.deepEqual(result, { decision: 'revise', note: 'Sync via export files instead.' });
    assert.equal(events.length, 2);
    const decisionData = events[1]!.data as { decision: string; note: string };
    assert.equal(decisionData.decision, 'revise');
    assert.equal(decisionData.note, 'Sync via export files instead.');
});

test('baseline-tool: report_drift returns the selected custom option label as the note', async () => {
    const { ctx, definitions } = makeCtx({ answer: { answers: [{ id: 'alignment-drift', selected: ['Use export files'] }] } });
    registerReportDrift(ctx);
    const { session, events } = makeSession();
    const { exec } = execFor(session);
    const result = await definitions[0]!.execute({
        reason: 'user-direction-change',
        description: 'cross-device',
        requiredChange: 'baseline becomes cross-device',
        options: [{ label: 'Use export files' }, { label: 'Add cloud sync' }]
    }, exec);
    assert.deepEqual(result, { decision: 'revise', note: 'Use export files', requiredChange: 'baseline becomes cross-device' });
    assert.equal(events.length, 2);
    assert.equal((events[1]!.data as { note: string }).note, 'Use export files');
});

test('baseline-tool: report_drift records the drift even when the question fails (child escalation)', async () => {
    const { ctx, definitions } = makeCtx({ error: new UserQuestionError('children cannot ask', 'DELEGATED_CALLER') });
    registerReportDrift(ctx);
    const { session, events } = makeSession();
    const { exec } = execFor(session);
    await assert.rejects(
        definitions[0]!.execute({ reason: 'constraint-conflict', description: 'api must change' }, exec),
        /child agent.*Requirement drift candidate/s
    );
    // The drift candidate is durable; no decision was recorded.
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'alignment/drift');
    assert.equal(foldAlignmentStatus(events).status, 'drift-pending');
});

test('baseline-tool: report_drift handles cancelled questions and missing channels', async () => {
    const cancelled = makeCtx({ error: new UserQuestionError('dismissed', 'ASK_CANCELLED') });
    registerReportDrift(cancelled.ctx);
    const { session } = makeSession();
    const { exec } = execFor(session);
    await assert.rejects(
        cancelled.definitions[0]!.execute({ reason: 'scope-expansion', description: 'x' }, exec),
        /wait for their message/
    );
    // A missing channel is a prerequisite, validated BEFORE the durable write:
    // the tool fails with a clean log.
    const noChannel = makeCtx({}, true);
    registerReportDrift(noChannel.ctx);
    const { session: session2, events: events2 } = makeSession();
    const { exec: exec2 } = execFor(session2);
    await assert.rejects(
        noChannel.definitions[0]!.execute({ reason: 'scope-expansion', description: 'x' }, exec2),
        /no user-questions channel/
    );
    assert.equal(events2.length, 0);
});

test('baseline-tool: invalid report_drift arguments fail before any durable write', async () => {
    const { ctx, definitions } = makeCtx({ answer: approveAnswer });
    registerReportDrift(ctx);
    const { session, events } = makeSession();
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
        // the tool fails and the session log stays clean.
        await assert.rejects(
            definitions[0]!.execute(args as never, exec),
            /report_drift:|invalid arguments/
        );
        assert.equal(events.length, 0, `args ${JSON.stringify(args)} must not append any event`);
    }
    assert.equal(foldAlignmentStatus(events).driftCount, 0);
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
