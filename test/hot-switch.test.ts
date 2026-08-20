import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';
import {
    RequirementsAlignmentController
} from '../src/index.ts';
import type { AlignmentMode } from '../src/types.ts';
import { SETTINGS_NAMESPACE } from '../src/settings-mode-store.ts';
import { fakeSession, fakeStorageDomain } from './helpers.ts';

/**
 * A minimal in-memory settings provider with the same observable two-layer
 * semantics the real DSH Settings service has, restricted to the surface this
 * plugin's port uses: `register -> {get, watch, update, replace}`,
 * `describe -> [{ns, user}]`, and the `settings/document-updated` event.
 * Raw-section changes are routed through the real Cordis context so the
 * port's `ctx.on('settings/document-updated')` listener observes them, exactly
 * as the file provider's `publish()` does on a hot reload.
 */
function fakeSettings(ctx: Context, initialDocument: Record<string, unknown> = {}) {
    const document: Record<string, unknown> = { ...initialDocument };
    let failWrites = false;
    interface Registration {
        ns: string;
        base: Record<string, unknown> | undefined;
        watchers: Set<(value: unknown, prev: unknown) => void>;
    }
    const registrations = new Map<string, Registration>();
    const resolvedValues = new Map<string, unknown>();

    function resolve(ns: string, section: unknown): unknown {
        const reg = registrations.get(ns);
        const base = reg?.base ?? {};
        if (section !== undefined && typeof section === 'object' && !Array.isArray(section)) {
            return { ...base, ...(section as Record<string, unknown>) };
        }
        return { ...base };
    }

    // Mirror the real provider's `publish`: a raw document change re-resolves
    // the affected namespace, then announces the raw-section-change event.
    function publishRawChange(ns: string): void {
        resolvedValues.set(ns, resolve(ns, document[ns]));
        // MessagesService.emit is strictly typed against the Events map; the
        // settings package augments that map, but the test shim simply casts.
        (ctx as unknown as { emit(name: string, ...args: unknown[]): unknown }).emit('settings/document-updated', ns);
    }
    function notify(ns: string, next: unknown, prev: unknown): void {
        for (const cb of [...(registrations.get(ns)?.watchers ?? [])]) {
            try { cb(next, prev); } catch { /* contained */ }
        }
    }

    const provider = {
        register<T>(ns: string, _schema: unknown, options?: { base?: Partial<T> }): {
            get: () => T;
            watch: (cb: (next: T, prev: T) => void) => () => void;
            update: (patch: object) => Promise<void>;
            replace: (section: object) => Promise<void>;
        } {
            const reg: Registration = {
                ns,
                base: options?.base as Record<string, unknown> | undefined,
                watchers: new Set()
            };
            registrations.set(ns, reg);
            resolvedValues.set(ns, resolve(ns, document[ns]));
            const persist = async (): Promise<void> => {
                if (failWrites) throw new Error('injected settings write failure');
            };
            return {
                get: () => resolvedValues.get(ns) as T,
                watch: (cb) => {
                    reg.watchers.add(cb as unknown as (value: unknown, prev: unknown) => void);
                    return () => reg.watchers.delete(cb as unknown as (value: unknown, prev: unknown) => void);
                },
                update: async (patch: object) => {
                    await persist();
                    const current = (document[ns] ?? {}) as Record<string, unknown>;
                    const next = { ...current, ...(patch as Record<string, unknown>) };
                    const prev = resolvedValues.get(ns);
                    document[ns] = next;
                    resolvedValues.set(ns, resolve(ns, next));
                    publishRawChange(ns);
                    notify(ns, resolvedValues.get(ns), prev);
                },
                replace: async (section: object) => {
                    await persist();
                    const prev = resolvedValues.get(ns);
                    if (section && typeof section === 'object' && Object.keys(section).length === 0) {
                        delete document[ns];
                    } else {
                        document[ns] = { ...(section as Record<string, unknown>) };
                    }
                    resolvedValues.set(ns, resolve(ns, document[ns]));
                    publishRawChange(ns);
                    notify(ns, resolvedValues.get(ns), prev);
                }
            };
        },
        describe(): Array<{ ns: string; user?: unknown }> {
            const out: Array<{ ns: string; user?: unknown }> = [];
            for (const ns of registrations.keys()) {
                const desc: { ns: string; user?: unknown } = { ns };
                if (document[ns] !== undefined) desc.user = document[ns];
                out.push(desc);
            }
            return out;
        }
    };

    return {
        provider,
        setFailWrites: (value: boolean) => { failWrites = value; },
        /** Simulate the file provider hot-reloading the raw document. */
        publish: (ns: string) => publishRawChange(ns),
        __document: document,
        __raw: (ns: string) => document[ns]
    };
}

/** Assemble the full controller with fake registries, settings, and the storage-domain seam. */
async function mount(config: object, settingsInitial: Record<string, unknown> = {}) {
    const ctx = new Context();
    const sections: PromptSection[] = [];
    const commands: CommandDefinition[] = [];
    const tools: ToolDefinition[] = [];
    ctx.provide('systemPrompt', {
        section: (section: PromptSection) => {
            sections.push(section);
            return () => {
                const i = sections.indexOf(section);
                if (i >= 0) sections.splice(i, 1);
            };
        }
    });
    ctx.provide('commands', {
        register: (definition: CommandDefinition) => {
            commands.push(definition);
            return () => {
                const i = commands.indexOf(definition);
                if (i >= 0) commands.splice(i, 1);
            };
        }
    });
    ctx.provide('tools', {
        register: (definition: ToolDefinition) => {
            tools.push(definition);
            return () => {
                const i = tools.indexOf(definition);
                if (i >= 0) tools.splice(i, 1);
            };
        }
    });
    const settings = fakeSettings(ctx, settingsInitial);
    ctx.provide('settings', settings.provider);
    // The storage-domain seam: state records land here (process-durable), so
    // the state-preservation matrix below records baselines durably.
    const storage = fakeStorageDomain();
    ctx.provide('storageDomain', storage);
    await ctx.plugin(RequirementsAlignmentController, config);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
        ctx,
        controller: (ctx as unknown as { requirementsAlignment: RequirementsAlignmentController }).requirementsAlignment,
        settings,
        sections,
        commands,
        tools
    };
}

function activeNames(sections: PromptSection[], commands: CommandDefinition[], tools: ToolDefinition[]): string[] {
    return [
        ...sections.map((s) => `policy:${s.name}`),
        ...tools.map((t) => `tool:${t.name}`),
        ...commands.map((c) => `cmd:${c.name}`)
    ].sort();
}

const EXPECTED: Record<AlignmentMode, string[]> = {
    // /align-migrate is a v0.2.2 alignment capability (auto/manual only), so
    // it rides the interactive group alongside /align.
    auto: ['cmd:align', 'cmd:align-migrate', 'cmd:align-mode', 'policy:requirements-alignment:policy', 'tool:establish_baseline', 'tool:report_drift'],
    manual: ['cmd:align', 'cmd:align-migrate', 'cmd:align-mode', 'tool:establish_baseline', 'tool:report_drift'],
    off: ['cmd:align-mode']
};

function assertActive(h: Awaited<ReturnType<typeof mount>>, mode: AlignmentMode) {
    assert.equal(h.controller.runtime.activeMode, mode, `runtime active mode is ${mode}`);
    assert.deepEqual(activeNames(h.sections, h.commands, h.tools), EXPECTED[mode], `active capability set for ${mode}`);
}

// --- persisted override wins at startup (Case 6 end-to-end) -----------------
test('hot-switch: a persisted override wins over the profile default at startup', async () => {
    const h = await mount({ mode: 'auto' }, { [SETTINGS_NAMESPACE]: { mode: 'manual' } });
    assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveSource, 'override');
    assertActive(h, 'manual');
});

// --- setMode: transition + persist + effective snapshot ---------------------
test('hot-switch: setMode transitions the runtime, persists the override, returns the snapshot', async () => {
    const h = await mount({ mode: 'auto' });
    assertActive(h, 'auto');

    const snap = await h.controller.setMode('off');
    assert.equal(snap.effectiveMode, 'off');
    assert.equal(snap.effectiveSource, 'override');
    // Off must unregister every capability (public contract).
    assertActive(h, 'off');
    assert.deepEqual(h.settings.__raw(SETTINGS_NAMESPACE), { mode: 'off' }, 'override persisted');

    const snap2 = await h.controller.setMode('manual');
    assert.equal(snap2.effectiveMode, 'manual');
    assertActive(h, 'manual');
    assert.deepEqual(h.settings.__raw(SETTINGS_NAMESPACE), { mode: 'manual' }, 'override updated');
});

// --- setMode invalid: rejected before any transition or persist -------------
test('hot-switch: an invalid setMode is rejected without touching the runtime or the document', async () => {
    const h = await mount({ mode: 'auto' });
    await assert.rejects(() => h.controller.setMode('banana' as AlignmentMode), /must be 'auto', 'manual', or 'off'/);
    assertActive(h, 'auto');
    assert.equal(h.settings.__raw(SETTINGS_NAMESPACE), undefined, 'nothing persisted');
});

// --- resetMode: drops override, returns to profile default ------------------
test('hot-switch: resetMode drops the override and returns to the profile default', async () => {
    const h = await mount({ mode: 'manual' }, { [SETTINGS_NAMESPACE]: { mode: 'off' } });
    assertActive(h, 'off');

    const snap = await h.controller.resetMode();
    assert.equal(snap.effectiveMode, 'manual');
    assert.equal(snap.effectiveSource, 'profile');
    assertActive(h, 'manual');
    assert.equal(h.settings.__raw(SETTINGS_NAMESPACE), undefined, 'override cleared');
});

// --- external document edit: hot-reload applies through the subscription ----
test('hot-switch: an external document edit re-applies the effective mode to the runtime', async () => {
    const h = await mount({ mode: 'auto' });
    assertActive(h, 'auto');

    // Simulate a settings.yaml hot reload: replace the stored override and
    // publish the raw-section change (exactly the file provider's `publish`),
    // which re-resolves the namespace and emits `settings/document-updated`.
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'off' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'off');
    assertActive(h, 'off');
});

// --- persistence failure: runtime compensated back to the prior mode ---------
test('hot-switch: a persistence failure compensates the runtime back to the prior mode', async () => {
    const h = await mount({ mode: 'auto' });
    assertActive(h, 'auto');

    h.settings.setFailWrites(true);
    await assert.rejects(() => h.controller.setMode('off'), /injected settings write failure/);
    h.settings.setFailWrites(false);

    // The transition happened but the persist failed, so the controller
    // compensated the runtime back to the prior (auto) mode.
    assertActive(h, 'auto');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'auto');
    assert.equal(h.settings.__raw(SETTINGS_NAMESPACE), undefined, 'nothing persisted after a failed write');

    // Recoverable: a fresh write with the flag cleared succeeds.
    await h.controller.setMode('off');
    assertActive(h, 'off');
});

// --- state preservation: mode switches never touch the alignment baseline ----
test('hot-switch: establishing a baseline then auto->manual->off->auto preserves the baseline and store state', async () => {
    const h = await mount({ mode: 'auto' });
    assertActive(h, 'auto');

    const { session } = fakeSession();
    await h.controller.stateStore.recordBaseline(session, {
        revision: 1,
        goal: 'Fix the form bug',
        explicitConstraints: ['no UI change'],
        updatedAt: 1
    });
    assert.equal(h.controller.stateStore.getBaseline(session)?.revision, 1);

    // Walk the full switch matrix; alignment canonical state must survive.
    for (const mode of ['manual', 'off', 'auto'] as const) {
        await h.controller.setMode(mode);
        assertActive(h, mode);
        assert.equal(h.controller.stateStore.getBaseline(session)?.revision, 1, 'baseline survives mode switch');
        assert.equal(h.controller.stateStore.getBaseline(session)?.goal, 'Fix the form bug');
    }
    assertActive(h, 'auto');
});

test('hot-switch: /align-mode remains registered in Off and can switch back', async () => {
    const h = await mount({ mode: 'auto' });
    const modeCommand = h.commands.find((command) => command.name === 'align-mode');
    assert.ok(modeCommand, '/align-mode is registered in Auto');
    const { session } = fakeSession();
    const invoke = (input: string) => modeCommand.handler({
        agent: { session, steer: () => { } } as never,
        rawInput: input,
        signal: new AbortController().signal,
        commandId: `hot-mode-${input}` as never
    });

    const off = await invoke('off');
    assert.equal(off.kind, 'success');
    assertActive(h, 'off');
    assert.ok(h.commands.some((command) => command.name === 'align-mode'));

    const back = await invoke('manual');
    assert.equal(back.kind, 'success');
    assertActive(h, 'manual');
});
