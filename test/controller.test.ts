import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
    RequirementsAlignmentController,
    statusText,
    statusValueText
} from '../src/index.ts';
import { POLICY_ORDER, POLICY_SECTION } from '../src/policy.ts';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';

/** A minimal live agent double with a real event log array. */
function fakeAgent() {
    const events: Array<{ seq: number; type: string; data: unknown }> = [];
    const steered: unknown[] = [];
    const agent = {
        session: {
            events: events as never,
            append: (type: string, data: unknown) => {
                events.push({ seq: events.length, type, data });
                return { type, data, seq: events.length - 1, time: 0 };
            }
        },
        steer: (message: unknown) => steered.push(message)
    };
    return { agent, events, steered };
}

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
    await ctx.plugin(RequirementsAlignmentController, config);
    // The controller registers its command through ctx.inject, which starts a
    // dependent fiber on a later microtask.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ctx, sections, commands, tools, disposers };
}

test('controller: auto mode registers the policy section, /align, and both tools', async () => {
    const { sections, commands, tools } = await mount({ mode: 'auto' });
    assert.equal(sections.length, 1);
    assert.equal(sections[0]!.name, POLICY_SECTION);
    assert.equal(sections[0]!.order, POLICY_ORDER);
    assert.equal(commands.length, 1);
    assert.equal(commands[0]!.name, 'align');
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['establish_baseline', 'report_drift']);
});

test('controller: section text renders the full policy on a fresh session and the baseline summary once recorded', async () => {
    const { sections } = await mount({ mode: 'auto' });
    const { agent, events } = fakeAgent();
    const text = sections[0]!.text as (context: unknown) => string;
    const fresh = text({ agent });
    assert.match(fresh, /Requirements Alignment policy/);
    assert.doesNotMatch(fresh, /Current requirement baseline/);
    events.push({ seq: 0, type: 'alignment/baseline', data: { baseline: { revision: 1, goal: 'Fix the form bug', explicitConstraints: ['no UI change'], updatedAt: 1 } } });
    const withBaseline = text({ agent });
    assert.match(withBaseline, /Current requirement baseline \(revision 1\):/);
    assert.match(withBaseline, /Goal: Fix the form bug/);
});

test('controller: section renders nothing without an agent (bare assemble)', async () => {
    const { sections } = await mount({ mode: 'auto' });
    const text = sections[0]!.text as (context: unknown) => string;
    assert.equal(text({}), '');
});

test('controller: manual mode registers only the command and tools, no section', async () => {
    const { sections, commands, tools } = await mount({ mode: 'manual' });
    assert.equal(sections.length, 0);
    assert.equal(commands.length, 1);
    assert.equal(commands[0]!.name, 'align');
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['establish_baseline', 'report_drift']);
});

test('controller: off mode registers nothing', async () => {
    const { sections, commands, tools } = await mount({ mode: 'off' });
    assert.equal(sections.length, 0);
    assert.equal(commands.length, 0);
    assert.equal(tools.length, 0);
});

test('controller: unload disposes every registration', async () => {
    const { sections, commands, tools, disposers } = await mount({ mode: 'auto' });
    assert.ok(disposers.length >= 4);
    for (const dispose of disposers) dispose();
    assert.equal(sections.length, 0);
    assert.equal(commands.length, 0);
    assert.equal(tools.length, 0);
});

test('controller: /align handler records the check, steers the check message, and reports status', async () => {
    const { commands } = await mount({ mode: 'auto' });
    const { agent, events, steered } = fakeAgent();
    const definition = commands[0]!;
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
    // Durable manual-check event appended.
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'alignment/manual-check');
    assert.equal(typeof (events[0]!.data as { at: number }).at, 'number');
    // Check steered to the agent for real analysis.
    assert.equal(steered.length, 1);
    const message = steered[0] as { content: Array<{ type: string; text: string }>; source: { kind: string; plugin: string; form: string } };
    assert.match(message.content[0]!.text, /Requirements Alignment check \(manual\)/);
    assert.equal(message.source.kind, 'plugin');
    assert.equal(message.source.plugin, 'requirements-alignment');
    assert.equal(message.source.form, 'notice');
});

test('controller: /align handler reports baseline revision and drift state after events', async () => {
    const { commands } = await mount({ mode: 'auto' });
    const { agent, events } = fakeAgent();
    events.push({ seq: 0, type: 'alignment/baseline', data: { baseline: { revision: 2, goal: 'Optimize the result page', explicitConstraints: ['keep API'], updatedAt: 1 } } });
    events.push({ seq: 1, type: 'alignment/drift', data: { reason: 'architecture-shift', description: 'cloud sync', at: 2 } });
    events.push({ seq: 2, type: 'alignment/decision', data: { driftSeq: 1, decision: 'approve', at: 3 } });
    events.push({ seq: 3, type: 'alignment/baseline-updated', data: { baseline: { revision: 3, goal: 'Optimize the result page', explicitConstraints: ['keep API', 'cloud sync'], updatedAt: 4 } } });
    events.push({ seq: 4, type: 'alignment/manual-check', data: { at: 5 } });
    const result = await commands[0]!.handler({ agent: agent as never, rawInput: '', signal: new AbortController().signal, commandId: 'x' as never });
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
    const { commands } = await mount({ mode: 'auto' });
    const broken = fakeAgent();
    broken.agent.session.append = () => { throw new Error('log closed'); };
    const result = await commands[0]!.handler({ agent: broken.agent as never, rawInput: '', signal: new AbortController().signal, commandId: 'y' as never });
    assert.equal(result.kind, 'success');
    assert.equal(broken.steered.length, 1);
});

test('statusText: covers revision 0 and recorded states', () => {
    const fresh = statusText({ revision: 0, driftCount: 0, status: 'unknown', manualChecks: 0 });
    assert.match(fresh, /Baseline revision: 0/);
    assert.match(fresh, /Current status:\nUnknown/);
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

test('statusValueText: labels the four postures without gate claims', () => {
    assert.equal(statusValueText('aligned'), 'Aligned');
    assert.match(statusValueText('drift-pending'), /Drift pending/);
    assert.match(statusValueText('baseline-update-pending'), /Baseline update pending/);
    assert.match(statusValueText('unknown'), /Unknown/);
});

test('controller: /align reports baseline-update-pending after approve without a new baseline', async () => {
    const { commands } = await mount({ mode: 'auto' });
    const { agent, events } = fakeAgent();
    events.push({ seq: 0, type: 'alignment/baseline', data: { baseline: { revision: 1, goal: 'Local-only app', explicitConstraints: ['no cloud'], updatedAt: 1 } } });
    events.push({ seq: 1, type: 'alignment/drift', data: { reason: 'architecture-shift', description: 'add cloud sync', at: 2 } });
    events.push({ seq: 2, type: 'alignment/decision', data: { driftSeq: 1, decision: 'approve', at: 3 } });
    const result = await commands[0]!.handler({ agent: agent as never, rawInput: '', signal: new AbortController().signal, commandId: 'z' as never });
    assert.equal(result.kind, 'success');
    const text = result.text ?? '';
    assert.match(text, /Baseline revision: 1/);
    assert.match(text, /Last user decision:\napprove/);
    assert.match(text, /Current status:\nBaseline update pending/);
});
