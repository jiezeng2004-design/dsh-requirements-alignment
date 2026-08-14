import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAlignDriverConfig } from '../src/align-driver.ts';

test('align-driver: default config is empty', () => {
    assert.deepEqual(resolveAlignDriverConfig(), {});
    assert.deepEqual(resolveAlignDriverConfig({}), {});
});

test('align-driver: accepts a record path', () => {
    assert.deepEqual(resolveAlignDriverConfig({ recordPath: 'records/r.jsonl' }), { recordPath: 'records/r.jsonl' });
});

test('align-driver: rejects unknown keys', () => {
    assert.throws(() => resolveAlignDriverConfig({ nope: 1 } as never), /unknown key\(s\) nope/);
});
