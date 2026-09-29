// Run in the isolated registry graph created by prepare-host-probe.mjs.
// Uses real host services and disk sidecars, without a provider or credentials.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import UserQuestions from '@deepseek-ai/dsh-user-questions';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { mountFixtureProfile } from './fixture-profile.mjs';
import { apply as scriptedAnswers } from '../src/scripted-provider.ts';

const root = await mkdtemp(join(tmpdir(), 'alignment-modern-host-'));
const require = createRequire(import.meta.url);
const host = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-session/package.json'), 'utf8')).version;
assert.equal(host, '0.1.7-rc.2', 'Acceptance requires the exact audited host version');
let savedSession;
const ctx = new Context();
try {
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry,
        SystemPrompt, ToolRuntime, CommandRuntime, UserQuestions, Storage]) await ctx.plugin(plugin);
    await ctx.plugin(storageJson, { root });
    await ctx.plugin(storageDomain, { backend: 'json' });
    await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' });
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [] });
    const profile = await mountFixtureProfile(ctx, root);
    const agent = await ctx.agentLoop.create(SessionId('modern-parent'));
    savedSession = agent.session;
    const answerer = await ctx.plugin(scriptedAnswers, { default: { custom: 'keep the approved scope' } });
    const question = { agent, questions: [{ id: 'scope', question: 'Change direction?' }] };
    const answer = await ctx.userQuestions.ask(question);
    assert.equal(answer.answers[0].custom, 'keep the approved scope');
    const controller = ctx.requirementsAlignment;
    const toolResult = await ctx.tools.execute({
        callId: ToolCallId('baseline-probe'), name: 'establish_baseline',
        arguments: { baseline: { goal: 'preserve the original scope' } },
        agent, signal: new AbortController().signal
    });
    assert.equal(controller.stateStore.getStatus(agent.session).revision, 1, JSON.stringify(toolResult));
    const drift = await ctx.tools.execute({
        callId: ToolCallId('drift-probe'), name: 'report_drift',
        arguments: { reason: 'scope-expansion', description: 'add cloud synchronization' },
        agent, signal: new AbortController().signal
    });
    assert.equal(drift.isError, false, JSON.stringify(drift));
    assert.equal(controller.stateStore.getStatus(agent.session).lastDecision?.decision, 'revise');
    await answerer.dispose();
    await assert.rejects(() => ctx.userQuestions.ask(question), /no user-questions answerer/);
    const child = ctx.sessions.fork(agent.session, undefined, SessionId('modern-child'));
    assert.equal(child.inheritedEventCount, 0);
    assert.equal('seedLength' in child.header, false);
    await controller.stateStore.initializeFork(child);
    // An empty inherited prefix predates the parent's checkpoint at seq 0.
    assert.equal(controller.stateStore.getStatus(child).revision, 0);
    assert.equal(controller.effectiveModeFor(agent.session).mode, 'auto');
    for (const mode of ['off', 'manual', 'auto']) {
        const command = await ctx.commands.execute(agent, `/align-mode session ${mode}`, [], new AbortController().signal);
        assert.equal(command?.result.kind, 'success', JSON.stringify(command));
        assert.equal(controller.effectiveModeFor(agent.session).mode, mode);
    }
    await controller.setSessionMode(agent.session, 'manual');
    await controller.setMode('manual');
    assert.equal(profile.read().runtimeMode, 'manual');
    await controller.resetMode();
    assert.equal(profile.read().runtimeMode, null);
    assert.equal(controller.modeStore.getSnapshot().effectiveMode, 'auto');
    // A reset must keep following later profile-default edits, not freeze auto.
    await ctx.settings.mutate(profile.entry.options.id, [{ op: 'set', path: ['mode'], value: 'manual' }]);
    assert.equal(controller.modeStore.getSnapshot().effectiveMode, 'manual');
    assert.equal(controller.modeStore.getSnapshot().effectiveSource, 'profile');
    await ctx.settings.mutate(profile.entry.options.id, [{ op: 'set', path: ['mode'], value: 'auto' }]);
    assert.equal(controller.modeStore.getSnapshot().effectiveMode, 'auto');
    assert.equal(profile.entry.fiber.config.section, 'Protected fixture policy');
    await controller.setMode('off');
    assert.equal(controller.modeStore.getSnapshot().effectiveMode, 'off');
    assert.equal(controller.effectiveModeFor(agent.session).mode, 'manual');
    const migration = await controller.runMigrate(agent, 'legacy-fixture');
    assert.equal(migration.kind, 'error');
    assert.match(migration.text, /immutable generations/);
    assert.equal(agent.session.snapshotEvents().some(e => e.type.startsWith('alignment/')), false);
    await ctx.sessionPersistence.flush();
    const handle = await ctx.sessionPersistence.open(agent.session.id, 'read');
    try {
        const stored = await handle.read();
        assert.equal(stored.events.some(e => e.type.startsWith('alignment/')), false);
    } finally { await handle.close(); }
} finally {
    await ctx.fiber.dispose();
}
// Fresh services, same isolated disk: sidecars and the shared setting must reload.
const restored = new Context();
try {
    for (const plugin of [LlmRuntime, SessionStore, SystemPrompt, ToolRuntime, CommandRuntime, Storage]) await restored.plugin(plugin);
    await restored.plugin(storageJson, { root });
    await restored.plugin(storageDomain, { backend: 'json' });
    await mountFixtureProfile(restored, root);
    const controller = restored.requirementsAlignment;
    assert.equal(controller.stateStore.getStatus(savedSession).revision, 1);
    assert.equal(controller.stateStore.getStatus(savedSession).lastDecision?.decision, 'revise');
    assert.equal(controller.effectiveModeFor(savedSession).mode, 'manual');
    assert.equal(controller.modeStore.getSnapshot().effectiveMode, 'off');
    console.log(JSON.stringify({ status: 'passed', host,
        checks: ['async agent creation', 'real session fork boundary zero', 'disk sidecar baseline',
            'real establish_baseline and report_drift tools', 'real session mode commands', 'question waterfall and unload',
            'real immutable-generation persistence flush/read',
            'disk sidecar and shared settings reload through fresh services',
            'migration refusal before I/O', 'no private session events'], sidecarRoot: root }));
} finally {
    await restored.fiber.dispose();
}
