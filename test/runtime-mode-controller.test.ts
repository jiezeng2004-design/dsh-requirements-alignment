import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { AlignmentRuntime } from '../src/runtime-mode-controller.ts';
import { AlignmentStateStore, memoryAlignmentStatePort } from '../src/alignment-state-store.ts';
import {
    FakeSystemPrompt,
    FakeTools,
    FakeCommands,
    fakeSession,
    fakeAgent,
    scopedAgentContext
} from './helpers.ts';
import type { AlignmentMode } from '../src/types.ts';
import { POLICY_SECTION } from '../src/policy.ts';

/** The agent scope registration counts for one mode (what registerForAgent returns). */
function expectedDisposerCount(mode: AlignmentMode): number {
    switch (mode) {
        case 'auto': return 5; // policy section + 2 tools + 2 commands
        case 'manual': return 4; // 2 tools + 2 commands
        case 'off': return 0;
    }
}

async function harness() {
    const ctx = new Context();
    const systemPrompt = new FakeSystemPrompt(ctx);
    const tools = new FakeTools(ctx);
    const commands = new FakeCommands(ctx);
    const store = new AlignmentStateStore(ctx, { port: memoryAlignmentStatePort() });
    await store.open();
    const runtime = new AlignmentRuntime(ctx, {
        store,
        runManual: () => ({ kind: 'success' as const, text: 'ok' }),
        runMigrate: () => ({ kind: 'success' as const, text: 'migrated' })
    });
    // One live agent whose OWN scope receives the registrations.
    const { session } = fakeSession([], { id: 's-agent' });
    const agent = fakeAgent(session, new Context());
    const scope = scopedAgentContext(ctx, agent);
    (agent as { ctx: Context }).ctx = scope.ctx;
    return { ctx, runtime, systemPrompt, tools, commands, store, agent, session, scope };
}

function assertAgentCapabilities(
    h: Awaited<ReturnType<typeof harness>>,
    mode: AlignmentMode
): void {
    const hasPolicy = h.systemPrompt.sectionsFor(h.agent).some((s) => s.name === POLICY_SECTION);
    const hasTools = h.tools.get('establish_baseline', h.agent) !== undefined
        && h.tools.get('report_drift', h.agent) !== undefined;
    const hasAlign = h.commands.find(h.agent, 'align') !== undefined
        && h.commands.find(h.agent, 'align-migrate') !== undefined;
    assert.equal(hasPolicy, mode === 'auto', `${mode}: policy present=${mode === 'auto'}`);
    assert.equal(hasTools, mode !== 'off', `${mode}: tools present=${mode !== 'off'}`);
    assert.equal(hasAlign, mode !== 'off', `${mode}: commands present=${mode !== 'off'}`);
    // /align-mode is NOT the runtime's job: the controller owns it at plugin scope.
    assert.equal(h.commands.find(h.agent, 'align-mode'), undefined, 'the runtime never registers /align-mode');
}

test('runtime: registerForAgent returns the exact per-mode disposer set in the agent\'s own scope', async () => {
    const h = await harness();
    try {
        for (const mode of ['auto', 'manual', 'off'] as const) {
            const disposers = h.runtime.registerForAgent(h.agent, mode);
            assert.equal(disposers.length, expectedDisposerCount(mode), `disposer count for ${mode}`);
            assertAgentCapabilities(h, mode);
            // The capability set is scoped to THIS agent only.
            assert.equal(h.systemPrompt.globalSections.length, 0, 'no global policy leak');
            assert.equal(h.tools.globalTools.length, 0, 'no global tool leak');
            // Clean up for the next mode.
            for (const dispose of disposers) dispose();
        }
    } finally {
        await h.scope.dispose();
    }
});

test('runtime: disposing the returned disposers unwinds exactly that capability set, idempotently', async () => {
    const h = await harness();
    try {
        const disposers = h.runtime.registerForAgent(h.agent, 'auto');
        assertAgentCapabilities(h, 'auto');

        for (const dispose of disposers) dispose();
        assertAgentCapabilities(h, 'off');

        // Idempotent: disposing again is a no-op.
        for (const dispose of disposers) dispose();
        assertAgentCapabilities(h, 'off');
    } finally {
        await h.scope.dispose();
    }
});

test('runtime: two agents hold disjoint capability sets (an auto agent and an off agent)', async () => {
    const h = await harness();
    try {
        const auto = h.runtime.registerForAgent(h.agent, 'auto');
        const otherSession = fakeSession([], { id: 's-other' });
        const otherAgent = fakeAgent(otherSession.session, new Context());
        const otherScope = scopedAgentContext(h.ctx, otherAgent);
        (otherAgent as { ctx: Context }).ctx = otherScope.ctx;
        const off = h.runtime.registerForAgent(otherAgent, 'off');

        // The auto agent has the full set; the off agent has nothing.
        assertAgentCapabilities(h, 'auto');
        assert.equal(h.systemPrompt.sectionsFor(otherAgent).length, 0);
        assert.equal(h.tools.get('establish_baseline', otherAgent), undefined);
        assert.equal(h.commands.find(otherAgent, 'align'), undefined);

        for (const dispose of [...auto, ...off]) dispose();
        await otherScope.dispose();
    } finally {
        await h.scope.dispose();
    }
});

test('runtime: the auto policy section renders the policy text for the calling agent', async () => {
    const h = await harness();
    try {
        h.runtime.registerForAgent(h.agent, 'auto');
        const assembly = await h.systemPrompt.assemble({ scope: h.agent, agent: h.agent } as never);
        const section = assembly.sections.find((s) => s.name === POLICY_SECTION);
        assert.ok(section, 'policy section assembled');
        assert.match(section!.text, /Requirements Alignment policy/);
    } finally {
        await h.scope.dispose();
    }
});

test('runtime: a registration failure surfaces from registerForAgent so the controller can roll back', async () => {
    const h = await harness();
    try {
        h.systemPrompt.failSections = true;
        assert.throws(
            () => h.runtime.registerForAgent(h.agent, 'auto'),
            /injected section registration failure/
        );
        // No partial capability is visible: registerForAgent throws synchronously
        // before returning any disposers, so nothing was left half-registered.
        assert.equal(h.systemPrompt.sectionsFor(h.agent).length, 0);
        assert.equal(h.tools.get('establish_baseline', h.agent), undefined);

        h.systemPrompt.failSections = false;
        const disposers = h.runtime.registerForAgent(h.agent, 'auto');
        assertAgentCapabilities(h, 'auto');
        for (const dispose of disposers) dispose();
    } finally {
        await h.scope.dispose();
    }
});
