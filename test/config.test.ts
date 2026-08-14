import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/index.ts';

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
