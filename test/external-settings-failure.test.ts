import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';
import { RequirementsAlignmentController } from '../src/index.ts';
import { SETTINGS_NAMESPACE } from '../src/settings-mode-store.ts';
import { fakeStorageDomain } from './helpers.ts';

/**
 * Regression tests for the external-settings failure path: when a hot-edited
 * settings document resolves to a new mode but the runtime transition fails
 * (injected during the Auto policy registration), the controller must
 * compensate — restore the persisted user layer to the previous snapshot's
 * source, re-commit the previous snapshot as state, and stay recoverable —
 * instead of leaving a ModeStore/Runtime split-brain
 * (`{ effective: auto, runtime: manual }`).
 *
 * The runtime never survives a failed transition: `AlignmentRuntime.applyMode`
 * rolls its own registrations back, so the assertions below focus on the
 * persisted layer, the ModeStore snapshot/source, and exactly-one (no
 * duplicates, no listener growth, no recursion).
 */

/** Same minimal two-layer settings double as hot-switch.test.ts, with a watcher-count probe. */
function fakeSettings(ctx: Context, initialDocument: Record<string, unknown> = {}) {
    const document: Record<string, unknown> = { ...initialDocument };
    let failWrites = false;
    let writeCount = 0;
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

    function publishRawChange(ns: string): void {
        resolvedValues.set(ns, resolve(ns, document[ns]));
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
                // Count every write attempt so tests can prove bounded retries.
                writeCount += 1;
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
        /** Number of settings write attempts (update/replace) so far. */
        get writeCount(): number { return writeCount; },
        publish: (ns: string) => publishRawChange(ns),
        __document: document,
        __raw: (ns: string) => document[ns],
        __watcherCount: (ns: string) => registrations.get(ns)?.watchers.size ?? 0
    };
}

/**
 * Assemble the full controller with fake registries, settings, and the
 * storage-domain seam, exposing the Auto policy-section registration for
 * failure injection (`systemPrompt.section` — the runtime reads it lazily, so
 * the overload is observed by the next transition).
 */
async function mount(config: object, settingsInitial: Record<string, unknown> = {}) {
    const ctx = new Context();
    const sections: PromptSection[] = [];
    const commands: CommandDefinition[] = [];
    const tools: ToolDefinition[] = [];
    let failPolicy = false;
    const registerSection = (section: PromptSection): (() => void) => {
        sections.push(section);
        return () => {
            const i = sections.indexOf(section);
            if (i >= 0) sections.splice(i, 1);
        };
    };
    ctx.provide('systemPrompt', {
        section: (section: PromptSection): (() => void) => {
            if (failPolicy) throw new Error('injected policy registration failure');
            return registerSection(section);
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
    ctx.provide('storageDomain', fakeStorageDomain());
    await ctx.plugin(RequirementsAlignmentController, config);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
        ctx,
        controller: (ctx as unknown as { requirementsAlignment: RequirementsAlignmentController }).requirementsAlignment,
        settings,
        sections,
        commands,
        tools,
        failAutoTransition: () => { failPolicy = true; },
        restoreAutoTransition: () => { failPolicy = false; }
    };
}

function countByName<T extends { name: string }>(items: T[], name: string): number {
    return items.filter((item) => item.name === name).length;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

// --- 1. profile-source rollback: restore by CLEARING, not by writing a key -->
test('external-failure: a failed external transition to auto restores a profile-sourced manual snapshot (no override written)', async () => {
    const h = await mount({ mode: 'manual' });
    assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveSource, 'profile');
    assert.equal(h.controller.runtime.activeMode, 'manual');

    // Hot-edit the document to auto while the Auto policy registration throws.
    h.failAutoTransition();
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'auto' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();

    // Runtime rolled back (AlignmentRuntime property) and the persisted layer
    // was restored to the previous source: profile => override reset, so no
    // `mode:` key exists and the snapshot is again manual/profile.
    assert.equal(h.controller.runtime.activeMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveSource, 'profile');
    assert.equal(h.settings.__raw(SETTINGS_NAMESPACE), undefined, 'no override key written for a profile source');
});

// --- 2. override-source rollback: restore the previous override verbatim ----
test('external-failure: a failed external override edit restores the previous override verbatim', async () => {
    const h = await mount({ mode: 'auto' }, { [SETTINGS_NAMESPACE]: { mode: 'manual' } });
    assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveSource, 'override');
    assert.equal(h.controller.runtime.activeMode, 'manual');

    // Override manual -> auto (external hot edit), with Auto registration broken.
    h.failAutoTransition();
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'auto' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();

    assert.equal(h.controller.runtime.activeMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveSource, 'override');
    assert.deepEqual(h.settings.__raw(SETTINGS_NAMESPACE), { mode: 'manual' }, 'previous override restored verbatim');
});

// --- 3. recoverability: compensation never wedges the notification path ------
test('external-failure: after compensation a later external change succeeds — reconciliation is not stuck', async () => {
    const h = await mount({ mode: 'manual' });
    h.failAutoTransition();
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'auto' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();
    assert.equal(h.controller.runtime.activeMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveSource, 'profile');

    // Clear the sabotage: the same external change now completes normally.
    h.restoreAutoTransition();
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'auto' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();

    assert.equal(h.controller.runtime.activeMode, 'auto');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'auto');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveSource, 'override');
});

// --- 4. no duplicates / no recursion / no listener growth --------------------
test('external-failure: failure + compensation + retry leaves exactly one of each capability and a single watcher', async () => {
    const h = await mount({ mode: 'auto' });
    const names = () => ({
        policy: countByName(h.sections, 'requirements-alignment:policy'),
        baseline: countByName(h.tools, 'establish_baseline'),
        drift: countByName(h.tools, 'report_drift'),
        align: countByName(h.commands, 'align'),
        alignMigrate: countByName(h.commands, 'align-migrate')
    });
    const assertExact = () => {
        assert.deepEqual(names(), { policy: 1, baseline: 1, drift: 1, align: 1, alignMigrate: 1 });
        assert.equal(h.settings.__watcherCount(SETTINGS_NAMESPACE), 1, 'watcher set never grows');
    };

    // External manual: succeeds (no policy registration in manual).
    h.failAutoTransition();
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'manual' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();
    assert.equal(h.controller.runtime.activeMode, 'manual');
    assert.equal(names().policy, 0);

    // External auto: fails at the policy registration, compensates back to manual.
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'auto' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();
    assert.equal(h.controller.runtime.activeMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'manual');
    assert.deepEqual(h.settings.__raw(SETTINGS_NAMESPACE), { mode: 'manual' }, 'override restored');

    // External auto again, sabotage cleared: succeeds; exact-one holds everywhere.
    h.restoreAutoTransition();
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'auto' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();
    assert.equal(h.controller.runtime.activeMode, 'auto');
    assertExact();
});

// --- 5. profile-source double fault: a failed compensation write stays pending ----
//        and recovers (restore manual / profile) on the next reconciliation trigger.
test('external-failure: profile-source double fault — a failed compensation write stays pending and recovers on the next trigger', async () => {
    const h = await mount({ mode: 'manual' });
    assert.equal(h.controller.runtime.activeMode, 'manual');

    // Double fault: the Auto registration AND the first resetOverride write fail.
    h.failAutoTransition();
    h.settings.setFailWrites(true);
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'auto' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();

    // The runtime rolled back to manual; the persisted layer is still `auto`
    // because the compensation write was rejected — the currently tolerated
    // transient split-brain — but the restore intent must NOT be lost.
    assert.equal(h.controller.runtime.activeMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'auto');
    assert.deepEqual(h.settings.__raw(SETTINGS_NAMESPACE), { mode: 'auto' });
    assert.ok(h.controller.pendingCompensation !== undefined, 'compensation remains pending');
    assert.equal(h.controller.pendingCompensation?.effectiveMode, 'manual');
    assert.equal(h.controller.pendingCompensation?.effectiveSource, 'profile');

    // Persistence recovers; the next document change (returning to the profile
    // default) triggers a reconciliation that settles the pending compensation.
    h.settings.setFailWrites(false);
    h.restoreAutoTransition();
    delete h.settings.__document[SETTINGS_NAMESPACE];
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();

    assert.equal(h.controller.runtime.activeMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveSource, 'profile');
    assert.equal(h.settings.__raw(SETTINGS_NAMESPACE), undefined, 'no override key written for a profile source');
    assert.equal(h.controller.pendingCompensation, undefined, 'compensation cleared once converged');
});

// --- 6. override-source double fault: the failed setOverride compensation -------
//        stays pending and recovers the previous override verbatim.
test('external-failure: override-source double fault — a failed setOverride compensation stays pending and recovers verbatim', async () => {
    const h = await mount({ mode: 'auto' }, { [SETTINGS_NAMESPACE]: { mode: 'manual' } });
    assert.equal(h.controller.runtime.activeMode, 'manual');

    // Override manual -> auto (external), with the Auto registration AND the
    // first setOverride('manual') compensation write failing.
    h.failAutoTransition();
    h.settings.setFailWrites(true);
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'auto' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();

    assert.equal(h.controller.runtime.activeMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'auto');
    assert.ok(h.controller.pendingCompensation !== undefined, 'compensation remains pending');
    assert.equal(h.controller.pendingCompensation?.effectiveMode, 'manual');
    assert.equal(h.controller.pendingCompensation?.effectiveSource, 'override');

    // Persistence recovers; the user re-asserting `manual` triggers the next
    // reconciliation, which settles the pending override restoration.
    h.settings.setFailWrites(false);
    h.restoreAutoTransition();
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'manual' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();

    assert.equal(h.controller.runtime.activeMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveSource, 'override');
    assert.deepEqual(h.settings.__raw(SETTINGS_NAMESPACE), { mode: 'manual' }, 'previous override restored verbatim');
    assert.equal(h.controller.pendingCompensation, undefined, 'compensation cleared once converged');
});

// --- 7. recoverability: a double fault does not wedge the controller -----------
test('external-failure: recover after a double fault — a later external manual -> auto fully succeeds', async () => {
    const h = await mount({ mode: 'manual' });

    // Double fault: external auto fails at the policy registration and the
    // compensation write fails too.
    h.failAutoTransition();
    h.settings.setFailWrites(true);
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'auto' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();
    assert.equal(h.controller.runtime.activeMode, 'manual');
    assert.ok(h.controller.pendingCompensation !== undefined, 'double fault leaves the restore pending');

    // Persistence and the runtime registration both recover.
    h.settings.setFailWrites(false);
    h.restoreAutoTransition();

    // First trigger settles the pending compensation: return to the profile
    // default (delete the failed auto override -> manual / profile).
    delete h.settings.__document[SETTINGS_NAMESPACE];
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();
    assert.equal(h.controller.runtime.activeMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveSource, 'profile');
    assert.equal(h.controller.pendingCompensation, undefined, 'pending compensation settled');

    // The controller is not wedged: an external manual -> auto now completes.
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'auto' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();
    assert.equal(h.controller.runtime.activeMode, 'auto');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'auto');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveSource, 'override');
    assert.deepEqual(h.settings.__raw(SETTINGS_NAMESPACE), { mode: 'auto' });
    assert.equal(h.controller.pendingCompensation, undefined);
});

// --- 8. latest user intent: off survives a double fault ------------------------
//        The pipeline first restores the transactional previous (manual), then
//        re-applies the latest desired (off) — no lost intent, no split-brain.
test('external-failure: the latest user intent (off) survives a double fault by first restoring manual then applying off', async () => {
    const h = await mount({ mode: 'manual' });
    h.failAutoTransition();
    h.settings.setFailWrites(true);
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'auto' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();
    assert.equal(h.controller.runtime.activeMode, 'manual');
    assert.ok(h.controller.pendingCompensation !== undefined);

    // Persistence recovers; before a compensation succeeds, the user edits the
    // document to `off` — the latest intent.
    h.settings.setFailWrites(false);
    h.restoreAutoTransition();
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'off' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();

    // The reconciliation first restored the transactional previous (manual),
    // then re-applied the latest desired (off): the document ends on `off`.
    assert.equal(h.controller.runtime.activeMode, 'off');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'off');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveSource, 'override');
    assert.deepEqual(h.settings.__raw(SETTINGS_NAMESPACE), { mode: 'off' });
    assert.equal(h.controller.pendingCompensation, undefined, 'pending compensation cleared');

    // And the pipeline stays healthy afterwards.
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'manual' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();
    assert.equal(h.controller.runtime.activeMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveSource, 'override');
});

// --- 9. no busy retry: a persistently broken persistence layer gets at most ----
//        one compensation write attempt per trigger, never a retry storm.
test('external-failure: while compensation persistence keeps failing, one trigger performs exactly one compensation write (no busy loop)', async () => {
    const h = await mount({ mode: 'manual' });
    h.failAutoTransition();
    h.settings.setFailWrites(true);
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'auto' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();

    assert.equal(h.controller.runtime.activeMode, 'manual');
    assert.equal(h.settings.writeCount, 1, 'exactly one compensation write attempt for the first trigger');
    assert.ok(h.controller.pendingCompensation !== undefined, 'compensation still pending');

    // A second trigger while persistence is still broken: exactly one more
    // bounded attempt, never an unbounded retry loop.
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'off' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();
    assert.equal(h.settings.writeCount, 2, 'exactly one additional compensation write attempt for the second trigger');
    assert.equal(h.controller.runtime.activeMode, 'manual', 'runtime stays authoritative on the pending target');
    assert.ok(h.controller.pendingCompensation !== undefined, 'compensation remains pending');

    // Cleanup: restore the mock so later suites are not polluted.
    h.settings.setFailWrites(false);
});

// --- 10. no duplicates after a full double-fault cycle -------------------------
test('external-failure: after a full double-fault cycle the recovered Auto registers exactly one of each capability and one watcher', async () => {
    const h = await mount({ mode: 'manual' });
    const names = () => ({
        policy: countByName(h.sections, 'requirements-alignment:policy'),
        baseline: countByName(h.tools, 'establish_baseline'),
        drift: countByName(h.tools, 'report_drift'),
        align: countByName(h.commands, 'align'),
        alignMigrate: countByName(h.commands, 'align-migrate')
    });
    const assertExact = () => {
        assert.deepEqual(names(), { policy: 1, baseline: 1, drift: 1, align: 1, alignMigrate: 1 });
        assert.equal(h.settings.__watcherCount(SETTINGS_NAMESPACE), 1, 'watcher set never grows');
    };

    // Requested auto -> runtime failure -> compensation write failure (double fault).
    h.failAutoTransition();
    h.settings.setFailWrites(true);
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'auto' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();
    assert.equal(h.controller.runtime.activeMode, 'manual');
    assert.ok(h.controller.pendingCompensation !== undefined, 'compensation remains pending');

    // Recovery: persistence and the runtime registration settle.
    h.settings.setFailWrites(false);
    h.restoreAutoTransition();

    // Trigger 1 settles the pending compensation (back to manual / profile).
    delete h.settings.__document[SETTINGS_NAMESPACE];
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();
    assert.equal(h.controller.runtime.activeMode, 'manual');
    assert.equal(h.controller.pendingCompensation, undefined, 'pending compensation settled');

    // Trigger 2: external auto now succeeds; exactly-one holds everywhere.
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'auto' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();
    assert.equal(h.controller.runtime.activeMode, 'auto');
    assertExact();
});

test('setMode: persist failure whose runtime rollback also fails keeps pending compensation', async () => {
    const h = await mount({ mode: 'auto' });
    assert.equal(h.controller.runtime.activeMode, 'auto');

    h.settings.setFailWrites(true);
    h.failAutoTransition();
    await assert.rejects(() => h.controller.setMode('off'), /injected settings write failure/);
    assert.ok(h.controller.pendingCompensation !== undefined, 'rollback failure must park pending compensation');
    assert.equal(h.controller.pendingCompensation?.effectiveMode, 'auto');
    assert.equal(h.controller.pendingCompensation?.effectiveSource, 'profile');

    h.settings.setFailWrites(false);
    h.restoreAutoTransition();
    h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'manual' };
    h.settings.publish(SETTINGS_NAMESPACE);
    await flush();

    assert.equal(h.controller.pendingCompensation, undefined, 'later trigger settles the pending restore then applies the latest intent');
    assert.equal(h.controller.runtime.activeMode, 'manual');
    assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'manual');
});
