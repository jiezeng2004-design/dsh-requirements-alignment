import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import {
    RequirementsAlignmentController,
    statusText
} from '../src/index.ts';
import { POLICY_ORDER, POLICY_SECTION } from '../src/policy.ts';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';

/** A minimal live agent double with a real event log array. */
function fakeAgent() {
    const events: Array<{ type: string; data: unknown }> = [];
    const steered: unknown[] = [];
    const agent = {
        session: {
            events: events as never,
            append: (type: string, data: unknown) => {
                events.push({ type, data });
                return { type, data, seq: events.length - 1, time: 0 };
            }
        },
        steer: (message: unknown) => steered.push(message)
    };
    return { agent, events, steered };
}

/** Mount the controller with fake systemPrompt/commands services. */
async function mount(config: object) {
    const ctx = new Context();
    const sections: PromptSection[] = [];
    const commands: CommandDefinition[] = [];
    ctx.provide('systemPrompt', {
        section: (section: PromptSection) => {
            sections.push(section);
            return () => { };
        }
    });
    ctx.provide('commands', {
        register: (definition: CommandDefinition) => {
            commands.push(definition);
            return () => { };
        }
    });
    await ctx.plugin(RequirementsAlignmentController, config);
    // The controller registers its command through ctx.inject, which starts a
    // dependent fiber on a later microtask.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ctx, sections, commands };
}

test('controller: auto mode registers the policy section and the /align command', async () => {
    const { sections, commands } = await mount({ mode: 'auto' });
    assert.equal(sections.length, 1);
    assert.equal(sections[0]!.name, POLICY_SECTION);
    assert.equal(sections[0]!.order, POLICY_ORDER);
    assert.equal(commands.length, 1);
    assert.equal(commands[0]!.name, 'align');
    assert.match(commands[0]!.description, /direction/);
});

test('controller: section text renders the full policy on a fresh session and the no-repeat guard after a question round', async () => {
    const { sections } = await mount({ mode: 'auto' });
    const { agent, events } = fakeAgent();
    const text = sections[0]!.text as (context: unknown) => string;
    const fresh = text({ agent });
    assert.match(fresh, /Greenfield Alignment Gate/);
    assert.doesNotMatch(fresh, /already completed/);
    events.push({ type: 'tool/call', data: { name: 'ask_user_question', turn: 1, step: 1, callId: 'c', arguments: '{}' } });
    const aligned = text({ agent });
    assert.match(aligned, /already completed 1 alignment question round/);
});

test('controller: section renders nothing without an agent (bare assemble)', async () => {
    const { sections } = await mount({ mode: 'auto' });
    const text = sections[0]!.text as (context: unknown) => string;
    assert.equal(text({}), '');
});

test('controller: manual mode registers only the command, no section', async () => {
    const { sections, commands } = await mount({ mode: 'manual' });
    assert.equal(sections.length, 0);
    assert.equal(commands.length, 1);
    assert.equal(commands[0]!.name, 'align');
});

test('controller: off mode registers nothing', async () => {
    const { sections, commands } = await mount({ mode: 'off' });
    assert.equal(sections.length, 0);
    assert.equal(commands.length, 0);
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
    assert.match(result.text ?? '', /Requirements Alignment status: no question round yet/);
    assert.match(result.text ?? '', /Starting a direction check now/);
    // Durable manual-check event appended.
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'alignment/status');
    assert.deepEqual(events[0]!.data, { kind: 'manual-check', at: (events[0]!.data as { at: number }).at });
    assert.equal(typeof (events[0]!.data as { at: number }).at, 'number');
    // Check steered to the agent for real analysis.
    assert.equal(steered.length, 1);
    const message = steered[0] as { content: Array<{ type: string; text: string }>; source: { kind: string; plugin: string; form: string } };
    assert.match(message.content[0]!.text, /Requirements Alignment check \(manual\)/);
    assert.equal(message.source.kind, 'plugin');
    assert.equal(message.source.plugin, 'requirements-alignment');
    assert.equal(message.source.form, 'notice');
});

test('controller: /align handler reports rounds after earlier questions', async () => {
    const { commands } = await mount({ mode: 'auto' });
    const { agent, events } = fakeAgent();
    events.push({ type: 'tool/call', data: { name: 'ask_user_question', turn: 1, step: 1, callId: 'c', arguments: '{}' } });
    events.push({ type: 'alignment/status', data: { kind: 'manual-check', at: 1000 } });
    const result = await commands[0]!.handler({ agent: agent as never, rawInput: '', signal: new AbortController().signal, commandId: 'x' as never });
    assert.equal(result.kind, 'success');
    assert.match(result.text ?? '', /1 question round\(s\) completed/);
    assert.match(result.text ?? '', /last manual check at 1970-01-01T00:00:01/);
});

test('controller: handler never throws on append failure and still steers', async () => {
    const { commands } = await mount({ mode: 'auto' });
    const broken = fakeAgent();
    broken.agent.session.append = () => { throw new Error('log closed'); };
    const result = await commands[0]!.handler({ agent: broken.agent as never, rawInput: '', signal: new AbortController().signal, commandId: 'y' as never });
    assert.equal(result.kind, 'success');
    assert.equal(broken.steered.length, 1);
});

test('statusText: covers the three report states', () => {
    assert.match(statusText({ questionRounds: 0 }), /no question round yet/);
    assert.match(statusText({ questionRounds: 2, lastManualCheckAt: 5 }), /2 question round\(s\) completed/);
});