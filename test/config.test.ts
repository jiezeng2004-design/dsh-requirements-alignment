import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ALIGNMENT_MODES,
    ConfigSchema,
    RequirementsAlignmentController,
    resolveConfig
} from '../src/index.ts';

/** Apply the shipped Config schema (the same object Cordis uses at load). */
function applySchema(input?: unknown) {
    return ConfigSchema(input as never);
}

function schemaAccepts(input: unknown): boolean {
    try {
        applySchema(input);
        return true;
    } catch {
        return false;
    }
}

function resolverAccepts(input: unknown): boolean {
    try {
        resolveConfig(input as never);
        return true;
    } catch {
        return false;
    }
}

test('config: defaults to auto mode with no section', () => {
    assert.deepEqual(resolveConfig(), { mode: 'auto' });
    assert.deepEqual(resolveConfig({}), { mode: 'auto' });
});

test('config: accepts every mode', () => {
    assert.deepEqual(resolveConfig({ mode: 'manual' }), { mode: 'manual' });
    assert.deepEqual(resolveConfig({ mode: 'off' }), { mode: 'off' });
    assert.deepEqual(resolveConfig({ mode: 'auto' }), { mode: 'auto' });
});

test('config: accepts a non-empty custom section', () => {
    assert.deepEqual(resolveConfig({ section: 'Custom policy.' }), { mode: 'auto', section: 'Custom policy.' });
});

test('config: rejects unknown keys', () => {
    assert.throws(() => resolveConfig({ mode: 'auto', nope: true } as never), /unknown key\(s\) nope/);
});

test('config: rejects an invalid mode', () => {
    assert.throws(() => resolveConfig({ mode: 'sometimes' } as never), /mode must be 'auto', 'manual', or 'off'/);
});

test('config: rejects blank or non-string section', () => {
    assert.throws(() => resolveConfig({ section: '   ' }), /non-empty/);
    assert.throws(() => resolveConfig({ section: 42 } as never), /must be a string/);
});

test('config: plugin Config is the shipped Schemastery schema (enum auto / manual / off)', () => {
    assert.equal(RequirementsAlignmentController.Config, ConfigSchema);
    assert.equal(ConfigSchema.type, 'object');
    assert.equal(ConfigSchema.dict?.mode?.type, 'union');
    assert.deepEqual(
        ConfigSchema.dict?.mode?.list?.map((entry) => entry.value),
        [...ALIGNMENT_MODES]
    );
    assert.deepEqual([...ALIGNMENT_MODES], ['auto', 'manual', 'off']);
});

test('config: shipped schema defaults to auto and accepts every legal mode', () => {
    assert.equal(applySchema().mode, 'auto');
    assert.equal(applySchema({}).mode, 'auto');
    assert.equal(applySchema({ mode: 'auto' }).mode, 'auto');
    assert.equal(applySchema({ mode: 'manual' }).mode, 'manual');
    assert.equal(applySchema({ mode: 'off' }).mode, 'off');
    assert.equal(applySchema({ section: 'Custom policy.' }).mode, 'auto');
    assert.equal(applySchema({ section: 'Custom policy.' }).section, 'Custom policy.');
});

test('config: shipped schema rejects an invalid mode', () => {
    assert.throws(() => applySchema({ mode: 'sometimes' }), /auto|manual|off|expected/);
    assert.throws(() => applySchema({ mode: 'disable' }), /auto|manual|off|expected/);
    assert.throws(() => applySchema({ mode: 'guard' }), /auto|manual|off|expected/);
});

test('config: shipped schema rejects blank or non-string section', () => {
    assert.throws(() => applySchema({ section: '   ' }));
    assert.throws(() => applySchema({ section: '' }));
    assert.throws(() => applySchema({ section: 42 }));
});

test('config: schema enum and resolveConfig accept or reject the same values', () => {
    const modes: unknown[] = ['auto', 'manual', 'off', 'disable', 'guard', 'AUTO', '', 'sometimes', 1, null];
    for (const mode of modes) {
        const input = { mode };
        assert.equal(
            schemaAccepts(input),
            resolverAccepts(input),
            `mode ${JSON.stringify(mode)}: schema=${schemaAccepts(input)} resolver=${resolverAccepts(input)}`
        );
    }
    assert.equal(schemaAccepts({}), resolverAccepts({}));
    assert.equal(schemaAccepts({ section: 'Custom policy.' }), resolverAccepts({ section: 'Custom policy.' }));
    assert.equal(schemaAccepts({ section: '   ' }), resolverAccepts({ section: '   ' }));
    assert.equal(schemaAccepts({ section: 42 }), resolverAccepts({ section: 42 }));
});
