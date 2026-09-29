import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings';
import { ConfigSchema, resolveConfig } from '../src/index.ts';
import { createModeStore } from '../src/settings-mode-store.ts';

test('modern config exposes live default and neutral shared override', () => {
    const parsed = ConfigSchema({ mode: 'manual', runtimeMode: 'off' });
    assert.equal(parsed.mode.get(), 'manual');
    assert.equal(parsed.runtimeMode.get(), 'off');
    // Schemastery treats a null default as optional; both absent and explicit
    // null are neutral, while persisted reset uses explicit null.
    assert.equal(ConfigSchema({}).runtimeMode.get() == null, true);
    assert.equal(ConfigSchema({ runtimeMode: null }).runtimeMode.get(), null);
    assert.equal(resolveConfig(parsed).runtimeMode, 'off');
    assert.throws(() => resolveConfig({ runtimeMode: 'invalid' } as never), /runtimeMode/);
});

function fixture(owner = true) {
    const ctx = new Context();
    const value: { mode: string; runtimeMode: string | null; untouched: string } = {
        mode: 'manual', runtimeMode: null, untouched: 'keep'
    };
    let revision = 4;
    let fail = false;
    let writable = true;
    const settings = {
        get writable() { return writable; },
        describe: () => [{ ns: 'custom-entry', value, user: value, base: { mode: 'auto' }, revision }],
        async mutate(ns: string, ops: Array<{ path: string[]; value: string | null }>, expected: number) {
            assert.equal(ns, 'custom-entry');
            assert.equal(expected, revision);
            assert.deepEqual(ops[0]!.path, ['runtimeMode']);
            if (fail) throw new Error('fixture write refused');
            value.runtimeMode = ops[0]!.value;
            revision++;
            ctx.emit('settings/document-updated', ns as SettingsNamespace, revision);
        }
    };
    ctx.provide('settings', settings as never);
    // A distinct wrapper with the same uid: do not compare object references.
    ctx.provide('configEditor', { entries: () => [{ options: { id: 'custom-entry' }, fiber: { uid: owner ? ctx.fiber.uid : -1 } }] } as never);
    const store = createModeStore(ctx, { mode: 'auto' });
    return { ctx, store, value, fail: () => { fail = true; }, readonly: () => { writable = false; } };
}

test('modern mode binds renamed owner and reset follows later defaults without erasing config', async () => {
    const h = fixture();
    try {
        assert.equal(h.store.getSnapshot().effectiveMode, 'manual');
        await h.store.setOverride('off');
        assert.equal(h.store.getSnapshot().effectiveSource, 'override');
        await h.store.resetOverride();
        assert.equal(h.value.runtimeMode, null);
        assert.equal(h.value.untouched, 'keep');
        h.value.mode = 'auto';
        assert.equal(h.store.getSnapshot().effectiveMode, 'auto');
        assert.equal(h.store.getSnapshot().effectiveSource, 'profile');
    } finally { h.store.dispose(); await h.ctx.fiber.dispose(); }
});

test('modern settings write failures and readonly profiles do not change mode', async () => {
    const h = fixture();
    try {
        h.fail();
        await assert.rejects(h.store.setOverride('off'), /write refused/);
        assert.equal(h.store.getSnapshot().effectiveMode, 'manual');
        h.readonly();
        await assert.rejects(h.store.setOverride('off'), /cannot persist/);
        assert.equal(h.value.runtimeMode, null);
    } finally { h.store.dispose(); await h.ctx.fiber.dispose(); }
});

test('modern settings refuses a familiar descriptor owned by another fiber', async () => {
    const h = fixture(false);
    try { await assert.rejects(h.store.setOverride('off'), /cannot persist/); }
    finally { h.store.dispose(); await h.ctx.fiber.dispose(); }
});
