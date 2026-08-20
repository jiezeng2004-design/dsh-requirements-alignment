import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';
import { AlignmentRuntime } from '../src/runtime-mode-controller.ts';
import { AlignmentStateStore, memoryAlignmentStatePort } from '../src/alignment-state-store.ts';
import type { AlignmentMode } from '../src/types.ts';

/**
 * A registry double with the same observable contract as the DSH registries:
 * a name-addressed collection whose `register` returns an effect disposer and
 * which REJECTS a duplicate name (the real systemPrompt/tools/commands all
 * do), so any duplicate-capability bug surfaces as a throw rather than a
 * silent double-registration. Disposers remove the entry idempotently.
 */
function nameRegistry<T extends { name: string }>(log: Array<{ op: 'add' | 'remove'; name: string }>) {
    const entries: T[] = [];
    return {
        entries,
        register(entry: T): () => void {
            if (entries.some((existing) => existing.name === entry.name)) {
                throw new Error(`duplicate registration for "${entry.name}" (the real registry rejects this)`);
            }
            entries.push(entry);
            log.push({ op: 'add', name: entry.name });
            return () => {
                const index = entries.findIndex((existing) => existing.name === entry.name);
                if (index >= 0) entries.splice(index, 1);
                log.push({ op: 'remove', name: entry.name });
            };
        }
    };
}

/** Assemble a Context pre-loaded with fake systemPrompt/tools/commands services. */
function harness() {
    const ctx = new Context();
    const operationLog: Array<{ op: 'add' | 'remove'; name: string }> = [];
    const services = {
        sections: nameRegistry<PromptSection>(operationLog),
        tools: nameRegistry<ToolDefinition>(operationLog),
        commands: nameRegistry<CommandDefinition>(operationLog)
    };
    // The service objects the runtime reads via ctx.<name> (traceable proxies).
    // The register methods use only closure state (no `this`), so passing them
    // by reference is safe, and mutating `provided.tools.register` is seen by
    // the runtime for failure-injection.
    const provided = {
        systemPrompt: { section: (entry: PromptSection) => services.sections.register(entry) },
        tools: { register: (entry: ToolDefinition) => services.tools.register(entry) },
        commands: { register: (entry: CommandDefinition) => services.commands.register(entry) }
    };
    ctx.provide('systemPrompt', provided.systemPrompt);
    ctx.provide('tools', provided.tools);
    ctx.provide('commands', provided.commands);
    // The runtime registers tools against the canonical sidecar store — never
    // session events — so the harness carries an in-memory store.
    const store = new AlignmentStateStore(ctx, { port: memoryAlignmentStatePort() });
    const runManual = () => ({ kind: 'success' as const, text: 'ok' });
    const runMigrate = () => ({ kind: 'success' as const, text: 'migrated' });
    const runMode = () => ({ kind: 'success' as const, text: 'mode' });
    const runtime = new AlignmentRuntime(ctx, { store, runManual, runMigrate, runMode });
    return { ctx, runtime, services, operationLog, provided, store };
}

function expectedNames(mode: AlignmentMode): string[] {
    switch (mode) {
        case 'auto': return ['policy:requirements-alignment:policy', 'tool:establish_baseline', 'tool:report_drift', 'cmd:align', 'cmd:align-migrate', 'cmd:align-mode'];
        case 'manual': return ['tool:establish_baseline', 'tool:report_drift', 'cmd:align', 'cmd:align-migrate', 'cmd:align-mode'];
        case 'off': return ['cmd:align-mode'];
    }
}

function activeNames(h: ReturnType<typeof harness>): string[] {
    return [
        ...h.services.sections.entries.map((s) => `policy:${s.name}`),
        ...h.services.tools.entries.map((t) => `tool:${t.name}`),
        ...h.services.commands.entries.map((c) => `cmd:${c.name}`)
    ];
}

/** Assert the current active capability set equals exactly the expected set for `mode`. */
function assertActive(h: ReturnType<typeof harness>, mode: AlignmentMode) {
    assert.deepEqual(activeNames(h).sort(), expectedNames(mode).sort());
    assert.equal(h.runtime.activeMode, mode);
}

/** Wait for the /align inject fiber to attach the commands service. */
async function settle(h: ReturnType<typeof harness>) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    void h;
}

test('runtime: every cross-mode transition lands on exactly the intended capability set', async () => {
    const h = harness();
    await settle(h);

    // Start off (nothing), then walk all six cross-mode transitions.
    h.runtime.applyMode('off');
    assertActive(h, 'off');

    h.runtime.applyMode('auto'); // Off -> Auto
    assertActive(h, 'auto');

    h.runtime.applyMode('manual'); // Auto -> Manual
    assertActive(h, 'manual');

    h.runtime.applyMode('auto'); // Manual -> Auto
    assertActive(h, 'auto');

    h.runtime.applyMode('off'); // Auto -> Off
    assertActive(h, 'off');

    h.runtime.applyMode('manual'); // Off -> Manual
    assertActive(h, 'manual');

    h.runtime.applyMode('off'); // Manual -> Off
    assertActive(h, 'off');
});

test('runtime: Auto->Manual->Auto->Manual->Off->Auto leaves no duplicates and an exact registry', async () => {
    const h = harness();
    await settle(h);
    const sequence: AlignmentMode[] = ['auto', 'manual', 'auto', 'manual', 'off', 'auto'];
    for (const mode of sequence) {
        h.runtime.applyMode(mode);
        assertActive(h, mode);
    }
    // Final: auto with exactly the auto capabilities, no duplicates. The
    // duplicate-throwing registry would already have failed any duplicate.
    assertActive(h, 'auto');
});

test('runtime: applying the same mode is an idempotent no-op', async () => {
    const h = harness();
    await settle(h);
    h.runtime.applyMode('auto');
    assertActive(h, 'auto');
    const before = h.operationLog.length;
    h.runtime.applyMode('auto'); // no-op
    assertActive(h, 'auto');
    assert.equal(h.operationLog.length, before, 'no registrations or disposals for a same-mode no-op');
});

test('runtime: a first-start registration failure leaves only the always-on control command', async () => {
    const h = harness();
    await settle(h);

    const originalSection = h.provided.systemPrompt.section;
    let failNext = true;
    h.provided.systemPrompt.section = (entry: PromptSection): (() => void) => {
        if (failNext) throw new Error('injected first-start registration failure for the policy section');
        return originalSection(entry);
    };

    assert.throws(
        () => h.runtime.applyMode('auto'),
        /injected first-start registration failure/
    );
    assert.equal(h.runtime.activeMode, null);
    assert.deepEqual(activeNames(h), ['cmd:align-mode']);

    failNext = false;
    h.runtime.applyMode('auto');
    assertActive(h, 'auto');
});

test('runtime: a registration failure disposes partials, restores the previous mode, and stays recoverable', async () => {
    const h = harness();
    await settle(h);
    h.runtime.applyMode('off'); // start from nothing
    assertActive(h, 'off');

    // Sabotage the policy-section registration (auto-only) so the OFF->AUTO
    // transition fails at its first registration, before any partial exists.
    const originalSection = h.provided.systemPrompt.section;
    let failNext = true;
    h.provided.systemPrompt.section = (entry: PromptSection): (() => void) => {
        if (failNext) throw new Error('injected registration failure for the policy section');
        return originalSection(entry);
    };

    // OFF -> AUTO: policy registration throws. The runtime must dispose any
    // partial (none here), restore the previous (off) mode — which registers
    // nothing and therefore cannot be broken by the sabotage — and report the
    // restore succeeded (activeMode back to 'off'), never a fake/half state.
    let threw: unknown;
    try {
        h.runtime.applyMode('auto');
    } catch (error) {
        threw = error;
    }
    assert.ok(threw, 'transition failure must propagate');
    assertActive(h, 'off');

    // Recoverable: clear the sabotage and the same transition now succeeds.
    failNext = false;
    h.runtime.applyMode('auto');
    assertActive(h, 'auto');
    void originalSection;
});
