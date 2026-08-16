import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, resolveScriptedConfig } from '../src/scripted-provider.ts';

test('scripted-provider: default config answers with an empty selection', () => {
    assert.deepEqual(resolveScriptedConfig(), { answers: [], default: { selected: [] } });
    assert.deepEqual(resolveScriptedConfig({}), { answers: [], default: { selected: [] } });
});

test('scripted-provider: validates config and rejects unknown keys', () => {
    assert.throws(() => resolveScriptedConfig({ nope: 1 } as never), /unknown key\(s\) nope/);
    assert.throws(() => resolveScriptedConfig({ answers: 'nope' } as never), /answers must be an array/);
    const resolved = resolveScriptedConfig({ answers: [{ match: 'drift', selected: ['a'] }], default: { custom: 'x' }, recordPath: 'r.jsonl' });
    assert.equal(resolved.answers.length, 1);
    assert.equal(resolved.default.custom, 'x');
    assert.equal(resolved.recordPath, 'r.jsonl');
});

test('scripted-provider: optionMatch config shape is accepted', () => {
    const resolved = resolveScriptedConfig({ answers: [{ optionMatch: 'export' }], default: { optionMatch: 'Approve' } });
    assert.equal(resolved.answers[0]!.optionMatch, 'export');
    assert.equal(resolved.default.optionMatch, 'Approve');
});

/** Mount the provider on a fake ctx and capture its registered ask function. */
function mount(config: Parameters<typeof apply>[1]) {
    let captured: ((request: { questions: Array<{ id: string; question: string; options?: Array<{ label: string }> }> }) => Promise<unknown>) | undefined;
    const ctx = {
        userQuestions: {
            registerProvider: (provider: { ask: typeof captured }) => {
                captured = provider.ask;
            }
        }
    };
    apply(ctx as never, config);
    return { ask: captured! };
}

test('scripted-provider: optionMatch selects the presented option whose label contains the substring', async () => {
    const { ask } = mount({ answers: [{ match: 'change the task direction', optionMatch: 'export' }], default: { selected: [] } });
    const result = await ask({
        questions: [{
            id: 'alignment-drift',
            question: 'This action would change the task direction: sync across devices. How should I proceed?',
            options: [{ label: 'Use export files' }, { label: 'Add cloud sync' }]
        }]
    }) as { answers: Array<{ id: string; selected: string[] }> };
    assert.deepEqual(result.answers[0]!.selected, ['Use export files']);
});

test('scripted-provider: optionMatch falls back to the answer selected when no presented option matches', async () => {
    const { ask } = mount({ answers: [{ match: 'change the task direction', optionMatch: 'zzz', selected: ['Manual fallback'] }], default: { selected: [] } });
    const result = await ask({
        questions: [{
            id: 'alignment-drift',
            question: 'This action would change the task direction: x. How should I proceed?',
            options: [{ label: 'Use export files' }, { label: 'Add cloud sync' }]
        }]
    }) as { answers: Array<{ id: string; selected: string[] }> };
    assert.deepEqual(result.answers[0]!.selected, ['Manual fallback']);
});
