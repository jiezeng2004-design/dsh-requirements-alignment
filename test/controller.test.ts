import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
    RequirementsAlignmentController,
    modeSnapshotText,
    statusText,
    statusValueText
} from '../src/index.ts';
import { POLICY_ORDER, POLICY_SECTION } from '../src/policy.ts';
import { SETTINGS_NAMESPACE } from '../src/settings-mode-store.ts';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';
import { fakeSession, fakeStorageDomain } from './helpers.ts';

/** Mount the controller with fake systemPrompt/commands/tools services. */
async function mount(config: object) {
    const ctx = new Context();
    const sections: PromptSection[] = [];
    const commands: CommandDefinition[] = [];
    const tools: ToolDefinition[] = [];
    const disposers: Array<() => void> = [];
    ctx.provide('systemPrompt', {
        section: (section: PromptSection) => {
            sections.push(section);
            const disposer = () => {
                const index = sections.indexOf(section);
                if (index >= 0) sections.splice(index, 1);
            };
            disposers.push(disposer);
            return disposer;
        }
    });
    ctx.provide('commands', {
        register: (definition: CommandDefinition) => {
            commands.push(definition);
            const disposer = () => {
                const index = commands.indexOf(definition);
                if (index >= 0) commands.splice(index, 1);
            };
            disposers.push(disposer);
            return disposer;
        }
    });
    ctx.provide('tools', {
        register: (definition: ToolDefinition) => {
            tools.push(definition);
            const disposer = () => {
                const index = tools.indexOf(definition);
                if (index >= 0) tools.splice(index, 1);
            };
            disposers.push(disposer);
            return disposer;
        }
    });
    // Persistable settings so `/align-mode` / setMode can commit an override.
    const settingsDoc: Record<string, unknown> = {};
    const settingsWatchers = new Set<() => void>();
    ctx.provide('settings', {
        register(ns: string, _schema: unknown, options?: { base?: Record<string, unknown> }) {
            const base = options?.base ?? {};
            return {
                get: () => ({ ...base, ...((settingsDoc[ns] as Record<string, unknown> | undefined) ?? {}) }),
                watch: (cb: () => void) => {
                    settingsWatchers.add(cb);
                    return () => settingsWatchers.delete(cb);
                },
                update: async (patch: object) => {
                    settingsDoc[ns] = { ...((settingsDoc[ns] as Record<string, unknown> | undefined) ?? {}), ...patch };
                    for (const cb of [...settingsWatchers]) cb();
                },
                replace: async (section: object) => {
                    if (section && typeof section === 'object' && Object.keys(section).length === 0) {
                        delete settingsDoc[ns];
                    } else {
                        settingsDoc[ns] = { ...(section as Record<string, unknown>) };
                    }
                    for (const cb of [...settingsWatchers]) cb();
                }
            };
        },
        describe: () => [{
            ns: SETTINGS_NAMESPACE,
            ...(settingsDoc[SETTINGS_NAMESPACE] === undefined ? {} : { user: settingsDoc[SETTINGS_NAMESPACE] })
        }]
    });
    // The storage-domain seam: the store attaches to it (as in the web
    // profile), so alignment writes are durable within the test process.
    const storage = fakeStorageDomain();
    ctx.provide('storageDomain', storage);
    await ctx.plugin(RequirementsAlignmentController, config);
    // The controller registers its commands through ctx.inject, which starts a
    // dependent fiber on a later microtask.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const controller = (ctx as unknown as { requirementsAlignment: RequirementsAlignmentController }).requirementsAlignment;
    return { ctx, controller, sections, commands, tools, disposers };
}

/** The /align command (auto/manual registration). */
function alignCommand(commands: CommandDefinition[]): CommandDefinition {
    const found = commands.find((command) => command.name === 'align');
    assert.ok(found, '/align must be registered');
    return found;
}

test('controller: auto mode registers the policy section, both commands, and both tools', async () => {
    const { sections, commands, tools } = await mount({ mode: 'auto' });
    assert.equal(sections.length, 1);
    assert.equal(sections[0]!.name, POLICY_SECTION);
    assert.equal(sections[0]!.order, POLICY_ORDER);
    assert.deepEqual(commands.map((command) => command.name).sort(), ['align', 'align-migrate', 'align-mode']);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['establish_baseline', 'report_drift']);
});

test('controller: section text renders the full policy on a fresh session and the baseline summary once recorded', async () => {
    const { sections, controller } = await mount({ mode: 'auto' });
    const { session } = fakeSession();
    const text = sections[0]!.text as (context: unknown) => string;
    const fresh = text({ agent: { session } });
    assert.match(fresh, /Requirements Alignment policy/);
    assert.doesNotMatch(fresh, /Current requirement baseline/);
    // The summary reads the sidecar store (the canonical view), not events.
    await controller.stateStore.recordBaseline(session, {
        revision: 1,
        goal: 'Fix the form bug',
        explicitConstraints: ['no UI change'],
        updatedAt: 1
    });
    const withBaseline = text({ agent: { session } });
    assert.match(withBaseline, /Current requirement baseline \(revision 1\):/);
    assert.match(withBaseline, /Goal: Fix the form bug/);
});

test('controller: section renders nothing without an agent (bare assemble)', async () => {
    const { sections } = await mount({ mode: 'auto' });
    const text = sections[0]!.text as (context: unknown) => string;
    assert.equal(text({}), '');
});

test('controller: manual mode registers only the commands and tools, no section', async () => {
    const { sections, commands, tools } = await mount({ mode: 'manual' });
    assert.equal(sections.length, 0);
    assert.deepEqual(commands.map((command) => command.name).sort(), ['align', 'align-migrate', 'align-mode']);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['establish_baseline', 'report_drift']);
});

test('controller: off mode registers only /align-mode', async () => {
    const { sections, commands, tools } = await mount({ mode: 'off' });
    assert.equal(sections.length, 0);
    assert.deepEqual(commands.map((command) => command.name), ['align-mode']);
    assert.equal(tools.length, 0);
});

test('controller: unload disposes every registration', async () => {
    const { sections, commands, tools, disposers } = await mount({ mode: 'auto' });
    assert.ok(disposers.length >= 6);
    for (const dispose of disposers) dispose();
    assert.equal(sections.length, 0);
    assert.equal(commands.length, 0);
    assert.equal(tools.length, 0);
});

test('controller: /align handler records the check in the store, steers the check message, and reports status', async () => {
    const { commands, controller } = await mount({ mode: 'auto' });
    const { session, events, push } = fakeSession();
    const agent = { session, steer: () => { } };
    const steered: unknown[] = [];
    (agent as { steer: (m: unknown) => void }).steer = (message: unknown) => steered.push(message);
    const definition = alignCommand(commands);
    const result = await definition.handler({
        agent: agent as never,
        rawInput: '',
        signal: new AbortController().signal,
        commandId: 'test-id' as never
    });
    assert.equal(result.kind, 'success');
    assert.match(result.text ?? '', /Requirements Alignment/);
    assert.match(result.text ?? '', /Baseline revision: 0/);
    assert.match(result.text ?? '', /Current status:\nUnknown/);
    // The manual check lands in the sidecar store, never in session events.
    assert.equal(events.length, 0);
    assert.equal(controller.stateStore.getStatus(session).manualChecks, 1);
    // Check steered to the agent for real analysis.
    assert.equal(steered.length, 1);
    const message = steered[0] as { content: Array<{ type: string; text: string }>; source: { kind: string; plugin: string; form: string } };
    assert.match(message.content[0]!.text, /Requirements Alignment check \(manual\)/);
    assert.match(message.content[0]!.text, /durable sidecar state/);
    assert.match(message.content[0]!.text, /Baseline revision: 0/);
    assert.match(message.content[0]!.text, /Mode: Auto \(profile default\)/);
    assert.equal(message.source.kind, 'plugin');
    assert.equal(message.source.plugin, 'requirements-alignment');
    assert.equal(message.source.form, 'notice');
    void push;
});

test('controller: /align handler reports baseline revision and drift state after store records', async () => {
    const { commands, controller } = await mount({ mode: 'auto' });
    const { session } = fakeSession();
    await controller.stateStore.recordBaseline(session, {
        revision: 2,
        goal: 'Optimize the result page',
        explicitConstraints: ['keep API'],
        updatedAt: 1
    });
    const { driftSeq } = await controller.stateStore.recordDrift(session, {
        reason: 'architecture-shift',
        description: 'cloud sync',
        at: 2
    });
    await controller.stateStore.recordDecision(session, { driftSeq, decision: 'approve', at: 3 });
    await controller.stateStore.recordBaseline(session, {
        revision: 3,
        goal: 'Optimize the result page',
        explicitConstraints: ['keep API', 'cloud sync'],
        updatedAt: 4
    });
    await controller.stateStore.recordManualCheck(session, 5);
    const agent = { session, steer: () => { } };
    const result = await alignCommand(commands).handler({ agent: agent as never, rawInput: '', signal: new AbortController().signal, commandId: 'x' as never });
    assert.equal(result.kind, 'success');
    const text = result.text ?? '';
    assert.match(text, /Baseline revision: 3/);
    assert.match(text, /Goal:\nOptimize the result page/);
    assert.match(text, /Protected constraints:\n- keep API/);
    assert.match(text, /Drift events: 1/);
    assert.match(text, /Last drift:\narchitecture-shift - cloud sync/);
    assert.match(text, /Last user decision:\napprove/);
    assert.match(text, /Current status:\nAligned/);
    assert.match(text, /Manual checks: 1/);
});

test('controller: handler never throws on append failure and still steers', async () => {
    const { commands, controller, ctx } = await mount({ mode: 'auto' });
    // Sabotage the durable medium AFTER the store attached: the /align
    // handler must log the failed manual-check record and still steer.
    const storage = (ctx as unknown as { storageDomain: ReturnType<typeof fakeStorageDomain> }).storageDomain;
    await storage.__close();
    const { session } = fakeSession();
    const steered: unknown[] = [];
    const agent = { session, steer: (message: unknown) => steered.push(message) };
    const result = await alignCommand(commands).handler({ agent: agent as never, rawInput: '', signal: new AbortController().signal, commandId: 'y' as never });
    assert.equal(result.kind, 'success');
    assert.equal(steered.length, 1);
    assert.equal(controller.stateStore.getStatus(session).manualChecks, 0, 'failed record must not commit memory state');
});

test('statusText: covers revision 0 and recorded states', () => {
    const fresh = statusText({ revision: 0, driftCount: 0, status: 'unknown', manualChecks: 0 });
    assert.match(fresh, /Baseline revision: 0/);
    assert.match(fresh, /Current status:\nUnknown/);
    assert.doesNotMatch(fresh, /Mode:/);
    const recorded = statusText({
        revision: 2,
        baseline: { revision: 2, goal: 'g', explicitConstraints: ['c'], updatedAt: 1 },
        driftCount: 1,
        lastDrift: { reason: 'scope-expansion', description: 'd', at: 2 },
        lastDecision: { driftSeq: 1, decision: 'reject', at: 3 },
        status: 'aligned',
        manualChecks: 1,
        lastManualCheckAt: 4
    });
    assert.match(recorded, /Baseline revision: 2/);
    assert.match(recorded, /Current status:\nAligned/);
    assert.match(recorded, /Manual checks: 1/);
});

test('statusText: includes Mode: Auto or Mode: Manual from live config, not the fold', () => {
    const status = { revision: 0, driftCount: 0, status: 'unknown' as const, manualChecks: 0 };
    const auto = statusText(status, 'auto');
    const manual = statusText(status, 'manual');
    assert.match(auto, /^Requirements Alignment\nMode: Auto\nBaseline revision: 0/m);
    assert.match(manual, /^Requirements Alignment\nMode: Manual\nBaseline revision: 0/m);
    assert.doesNotMatch(auto, /Mode: Manual/);
    assert.doesNotMatch(manual, /Mode: Auto/);
    const autoOverride = statusText(status, 'auto', 'override');
    const manualProfile = statusText(status, 'manual', 'profile');
    assert.match(autoOverride, /Mode: Auto \(runtime override\)/);
    assert.match(manualProfile, /Mode: Manual \(profile default\)/);
});

test('statusValueText: labels the four postures without gate claims', () => {
    assert.equal(statusValueText('aligned'), 'Aligned');
    assert.match(statusValueText('drift-pending'), /Drift pending/);
    assert.match(statusValueText('baseline-update-pending'), /Baseline update pending/);
    assert.match(statusValueText('unknown'), /Unknown/);
});

test('controller: public registration contract — Auto / Manual / Off', async () => {
    const matrix = [
        { mode: 'auto' as const, policy: true, tools: true, align: true, modeLine: 'Mode: Auto' },
        { mode: 'manual' as const, policy: false, tools: true, align: true, modeLine: 'Mode: Manual' },
        { mode: 'off' as const, policy: false, tools: false, align: false, modeLine: undefined }
    ];
    for (const row of matrix) {
        const { sections, commands, tools } = await mount({ mode: row.mode });
        assert.equal(sections.length > 0, row.policy, `${row.mode}: policy section`);
        if (row.policy) {
            assert.equal(sections[0]!.name, POLICY_SECTION);
            assert.equal(sections[0]!.order, POLICY_ORDER);
        }
        assert.equal(tools.length > 0, row.tools, `${row.mode}: alignment tools`);
        if (row.tools) {
            assert.deepEqual(tools.map((tool) => tool.name).sort(), ['establish_baseline', 'report_drift']);
        }
        assert.ok(commands.some((command) => command.name === 'align-mode'), `${row.mode}: /align-mode is always registered`);
        assert.equal(commands.some((command) => command.name === 'align'), row.align, `${row.mode}: /align`);
        if (row.align) {
            const { session } = fakeSession();
            const result = await alignCommand(commands).handler({
                agent: { session, steer: () => { } } as never,
                rawInput: '',
                signal: new AbortController().signal,
                commandId: `contract-${row.mode}` as never
            });
            assert.equal(result.kind, 'success');
            assert.match(result.text ?? '', /Requirements Alignment/);
            assert.match(result.text ?? '', new RegExp(row.modeLine!));
            assert.doesNotMatch(result.text ?? '', /Mode: Off/);
        } else {
            assert.deepEqual(commands.map((command) => command.name), ['align-mode']);
            assert.equal(sections.length, 0);
            assert.equal(tools.length, 0);
        }
    }
});

test('controller: /align reports baseline-update-pending after approve without a new baseline', async () => {
    const { commands, controller } = await mount({ mode: 'auto' });
    const { session } = fakeSession();
    await controller.stateStore.recordBaseline(session, {
        revision: 1,
        goal: 'Local-only app',
        explicitConstraints: ['no cloud'],
        updatedAt: 1
    });
    const { driftSeq } = await controller.stateStore.recordDrift(session, {
        reason: 'architecture-shift',
        description: 'add cloud sync',
        at: 2
    });
    await controller.stateStore.recordDecision(session, { driftSeq, decision: 'approve', at: 3 });
    const result = await alignCommand(commands).handler({
        agent: { session, steer: () => { } } as never,
        rawInput: '',
        signal: new AbortController().signal,
        commandId: 'z' as never
    });
    assert.equal(result.kind, 'success');
    const text = result.text ?? '';
    assert.match(text, /Baseline revision: 1/);
    assert.match(text, /Last user decision:\napprove/);
    assert.match(text, /Current status:\nBaseline update pending/);
});

function modeCommand(commands: CommandDefinition[]): CommandDefinition {
    const found = commands.find((command) => command.name === 'align-mode');
    assert.ok(found, '/align-mode must be registered');
    return found;
}

test('controller: /align-mode with no args reports the three-layer snapshot', async () => {
    const { commands } = await mount({ mode: 'auto' });
    const { session } = fakeSession();
    const result = await modeCommand(commands).handler({
        agent: { session, steer: () => { } } as never,
        rawInput: '',
        signal: new AbortController().signal,
        commandId: 'mode-status' as never
    });
    assert.equal(result.kind, 'success');
    assert.match(result.text ?? '', /Effective: Auto \(profile default\)/);
    assert.match(result.text ?? '', /Profile default: Auto/);
    assert.match(result.text ?? '', /Runtime override: \(none\)/);
});

test('controller: /align-mode switches Off and back, including while Off', async () => {
    const { commands, controller } = await mount({ mode: 'auto' });
    const { session } = fakeSession();
    const invoke = async (input: string) => modeCommand(commands).handler({
        agent: { session, steer: () => { } } as never,
        rawInput: input,
        signal: new AbortController().signal,
        commandId: `mode-${input || 'status'}` as never
    });

    const off = await invoke('off');
    assert.equal(off.kind, 'success');
    assert.equal(controller.runtime.activeMode, 'off');
    assert.match(off.text ?? '', /Switched to Off/);
    assert.match(off.text ?? '', /Effective: Off \(runtime override\)/);
    assert.equal(commands.some((command) => command.name === 'align'), false, '/align unregistered in Off');
    assert.ok(commands.some((command) => command.name === 'align-mode'), '/align-mode survives Off');

    const back = await invoke('auto');
    assert.equal(back.kind, 'success');
    assert.equal(controller.runtime.activeMode, 'auto');
    assert.match(back.text ?? '', /Switched to Auto/);
    assert.ok(commands.some((command) => command.name === 'align'), '/align returns with Auto');
});

test('controller: /align-mode reset drops the override; invalid input is an error', async () => {
    const { commands, controller } = await mount({ mode: 'manual' });
    const { session } = fakeSession();
    await controller.setMode('off');
    const reset = await modeCommand(commands).handler({
        agent: { session, steer: () => { } } as never,
        rawInput: 'reset',
        signal: new AbortController().signal,
        commandId: 'mode-reset' as never
    });
    assert.equal(reset.kind, 'success');
    assert.equal(controller.runtime.activeMode, 'manual');
    assert.equal(controller.modeStore.getSnapshot().effectiveSource, 'profile');
    assert.match(reset.text ?? '', /Reset to the profile default/);

    const bad = await modeCommand(commands).handler({
        agent: { session, steer: () => { } } as never,
        rawInput: 'banana',
        signal: new AbortController().signal,
        commandId: 'mode-bad' as never
    });
    assert.equal(bad.kind, 'error');
    assert.match(bad.text ?? '', /Usage: \/align-mode/);
});

test('modeSnapshotText: names profile vs override layers', () => {
    assert.match(modeSnapshotText({
        defaultMode: 'auto',
        effectiveMode: 'auto',
        effectiveSource: 'profile'
    }), /Runtime override: \(none\)/);
    assert.match(modeSnapshotText({
        defaultMode: 'auto',
        overrideMode: 'manual',
        effectiveMode: 'manual',
        effectiveSource: 'override'
    }), /Effective: Manual \(runtime override\)/);
});
