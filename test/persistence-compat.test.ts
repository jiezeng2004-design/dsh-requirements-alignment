import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLegacyMigrationHost } from '../src/persistence-compat.ts';

test('migration refuses handle-based hosts before any legacy reader or writer runs', () => {
    let touched = false;
    const legacy = { readRaw() { touched = true; }, locate() { touched = true; } };
    assert.doesNotThrow(() => assertLegacyMigrationHost(legacy));
    assert.throws(() => assertLegacyMigrationHost({ ...legacy, open() { touched = true; } }), /immutable generations/);
    assert.throws(() => assertLegacyMigrationHost({}), /unsupported/);
    assert.equal(touched, false);
});
