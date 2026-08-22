import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountController, mountAgent, type ControllerHarness, type MountedAgent } from './helpers.ts';
import { POLICY_SECTION } from '../src/policy.ts';
import { SETTINGS_NAMESPACE } from '../src/settings-mode-store.ts';

/** Invoke `/align-mode` (any input) against one mounted agent through the real registered definition. */
async function runAlignMode(h: ControllerHarness, agent: MountedAgent['agent'], input: string) {
    const command = h.commands.find(agent, 'align-mode');
    assert.ok(command, '/align-mode is always registered (global control group)');
    return command.handler({
        agent,
        rawInput: input,
        signal: new AbortController().signal,
        commandId: `test-${input}` as never,
        attachments: []
    });
}

/** The policy section text one agent's assembled system prompt would show. */
async function policyTextOf(h: ControllerHarness, agent: MountedAgent['agent']): Promise<string | undefined> {
    const assembly = await h.systemPrompt.assemble({ scope: agent, agent } as never);
    return assembly.sections.find((section) => section.name === POLICY_SECTION)?.text;
}

// ── effective mode resolution (session -> runtime override -> profile) ───────

test('session-mode: effectiveModeFor resolves session override first, then the shared snapshot', () => {
    // (controller-level resolution is exercised through mounted agents below)
});

test('session-mode: a session override wins over the shared runtime override and profile default', async () => {
    // Shared default manual, persisted override auto, session override off.
    const h = await mountController(
        { mode: 'manual' },
        { [SETTINGS_NAMESPACE]: { mode: 'auto' } }
    );
    try {
        const a = await mountAgent(h, { id: 's-override' });
        // No session override yet: shared auto wins (effective = auto, override).
        assert.deepEqual(h.controller.effectiveModeFor(a.session), { mode: 'auto', source: 'override' });

        await h.controller.sessionModeStore.setOverride(a.session, 'off');
        assert.deepEqual(h.controller.effectiveModeFor(a.session), { mode: 'off', source: 'session' });

        await h.controller.sessionModeStore.clearOverride(a.session);
        assert.deepEqual(h.controller.effectiveModeFor(a.session), { mode: 'auto', source: 'override' });
    } finally {
        await h.dispose();
    }
});

// ── per-agent capability registration ────────────────────────────────────────

test('session-mode: an auto agent registers the policy section, both tools, /align and /align-migrate in ITS OWN scope', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const { agent } = await mountAgent(h, { id: 's-auto' });
        assert.ok(await policyTextOf(h, agent), 'policy section present in the agent assembly');
        const text = await policyTextOf(h, agent);
        assert.match(text!, /Requirements Alignment policy/);
        assert.ok(h.tools.get('establish_baseline', agent), 'establish_baseline scoped to the agent');
        assert.ok(h.tools.get('report_drift', agent), 'report_drift scoped to the agent');
        assert.ok(h.commands.find(agent, 'align'), '/align scoped to the agent');
        assert.ok(h.commands.find(agent, 'align-migrate'), '/align-migrate scoped to the agent');
        assert.ok(h.commands.find(agent, 'align-mode'), '/align-mode is the global control command');
    } finally {
        await h.dispose();
    }
});

test('session-mode: a manual agent registers tools and commands but no policy section', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const { agent } = await mountAgent(h, { id: 's-manual' });
        await h.controller.sessionModeStore.setOverride(agent.session, 'manual');
        // setOverride notifies -> the controller resyncs the agent.
        assert.equal(await policyTextOf(h, agent), undefined, 'no policy section in manual');
        assert.ok(h.tools.get('establish_baseline', agent), 'tools remain in manual');
        assert.ok(h.commands.find(agent, 'align'), '/align remains in manual');
    } finally {
        await h.dispose();
    }
});

test('session-mode: an off agent registers NOTHING alignment — no policy, no tools, no /align', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const { agent } = await mountAgent(h, { id: 's-off' });
        await h.controller.sessionModeStore.setOverride(agent.session, 'off');
        assert.equal(await policyTextOf(h, agent), undefined, 'no policy section in off');
        assert.equal(h.tools.get('establish_baseline', agent), undefined, 'no establish_baseline in off');
        assert.equal(h.tools.get('report_drift', agent), undefined, 'no report_drift in off');
        assert.equal(h.commands.find(agent, 'align'), undefined, 'no /align in off');
        assert.equal(h.commands.find(agent, 'align-migrate'), undefined, 'no /align-migrate in off');
        // The control command survives Off.
        assert.ok(h.commands.find(agent, 'align-mode'), '/align-mode survives off');
    } finally {
        await h.dispose();
    }
});

// ── two-session isolation ────────────────────────────────────────────────────

test('session-mode: changing Session A never changes Session B or the shared runtime override', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-A' });
        const b = await mountAgent(h, { id: 's-B' });

        // Both start in the shared auto.
        assert.deepEqual(h.controller.effectiveModeFor(a.session), { mode: 'auto', source: 'profile' });
        assert.deepEqual(h.controller.effectiveModeFor(b.session), { mode: 'auto', source: 'profile' });
        assert.ok(await policyTextOf(h, a.agent), 'A has policy');
        assert.ok(await policyTextOf(h, b.agent), 'B has policy');

        // Switch ONLY session A to manual.
        const r = await runAlignMode(h, a.agent, 'session manual');
        assert.equal(r.kind, 'success');
        assert.match(r.text ?? '', /Session mode switched to Manual/);
        assert.match(r.text ?? '', /Session override: Manual/);

        // A is manual, B is untouched, the shared layer is untouched.
        assert.deepEqual(h.controller.effectiveModeFor(a.session), { mode: 'manual', source: 'session' });
        assert.deepEqual(h.controller.effectiveModeFor(b.session), { mode: 'auto', source: 'profile' });
        assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'auto', 'shared runtime override unchanged');
        assert.equal(h.settings.__raw(SETTINGS_NAMESPACE), undefined, 'nothing persisted to the shared settings');
        assert.equal(await policyTextOf(h, a.agent), undefined, 'A lost the policy section');
        assert.ok(await policyTextOf(h, b.agent), 'B keeps the policy section');
        assert.ok(h.commands.find(a.agent, 'align'), 'A keeps /align in manual');
        assert.ok(h.commands.find(b.agent, 'align'), 'B keeps /align in auto');

        // A's session reset reveals the shared layer and never touches B.
        const reset = await runAlignMode(h, a.agent, 'session reset');
        assert.equal(reset.kind, 'success');
        assert.match(reset.text ?? '', /Session override: \(none\)/);
        assert.deepEqual(h.controller.effectiveModeFor(a.session), { mode: 'auto', source: 'profile' });
        assert.deepEqual(h.controller.effectiveModeFor(b.session), { mode: 'auto', source: 'profile' });
        assert.ok(await policyTextOf(h, a.agent), 'A regained the policy section after reset');
        assert.ok(await policyTextOf(h, b.agent), 'B is untouched by A\'s reset');
    } finally {
        await h.dispose();
    }
});

test('session-mode: two live sessions can hold different effective modes with zero leakage', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-x' });
        const b = await mountAgent(h, { id: 's-y' });
        await h.controller.sessionModeStore.setOverride(a.session, 'off');
        await h.controller.sessionModeStore.setOverride(b.session, 'manual');

        assert.deepEqual(h.controller.effectiveModeFor(a.session), { mode: 'off', source: 'session' });
        assert.deepEqual(h.controller.effectiveModeFor(b.session), { mode: 'manual', source: 'session' });
        assert.equal(h.controller.effectiveModeFor((await mountAgent(h, { id: 's-z' })).session).mode, 'auto', 'a third session stays on the shared layer');

        // A is fully inert; B keeps tools + commands; /align-mode works from Off.
        assert.equal(h.commands.find(a.agent, 'align'), undefined);
        assert.ok(h.commands.find(b.agent, 'align'));
        const fromOff = await runAlignMode(h, a.agent, 'session auto');
        assert.equal(fromOff.kind, 'success');
        assert.deepEqual(h.controller.effectiveModeFor(a.session), { mode: 'auto', source: 'session' });
        // B is unaffected by A's switch back.
        assert.deepEqual(h.controller.effectiveModeFor(b.session), { mode: 'manual', source: 'session' });
    } finally {
        await h.dispose();
    }
});

// ── shared-layer changes resync only agents without a session override ───────

test('session-mode: a shared setMode resyncs agents without an override but leaves overridden agents untouched', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const plain = await mountAgent(h, { id: 's-plain' });
        const pinned = await mountAgent(h, { id: 's-pinned' });
        await h.controller.sessionModeStore.setOverride(pinned.session, 'auto'); // pinned to auto

        // Shared -> off.
        await h.controller.setMode('off');
        assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'off');
        // Plain agent (no override) follows the shared layer.
        assert.deepEqual(h.controller.effectiveModeFor(plain.session), { mode: 'off', source: 'override' });
        assert.equal(await policyTextOf(h, plain.agent), undefined, 'plain agent lost the policy');
        assert.equal(h.commands.find(plain.agent, 'align'), undefined, 'plain agent lost /align');
        // Pinned agent keeps its session override.
        assert.deepEqual(h.controller.effectiveModeFor(pinned.session), { mode: 'auto', source: 'session' });
        assert.ok(await policyTextOf(h, pinned.agent), 'pinned agent keeps the policy');
        assert.ok(h.commands.find(pinned.agent, 'align'), 'pinned agent keeps /align');

        // Shared -> manual: the plain agent gains tools/commands, still no policy.
        await h.controller.setMode('manual');
        assert.equal(await policyTextOf(h, plain.agent), undefined);
        assert.ok(h.commands.find(plain.agent, 'align'), 'plain agent regained /align in manual');
        assert.ok(h.tools.get('establish_baseline', plain.agent), 'plain agent regained tools in manual');
    } finally {
        await h.dispose();
    }
});

// ── fork inheritance ─────────────────────────────────────────────────────────

test('session-mode: a fork child inherits the parent session override, then becomes independently changeable', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const parent = await mountAgent(h, { id: 's-parent' });
        await h.controller.sessionModeStore.setOverride(parent.session, 'manual');

        // The child's seed length is the parent's log length (a real fork).
        const child = await mountAgent(h, { id: 's-child', parentSession: 's-parent', seedLength: parent.session.seq });
        assert.deepEqual(h.controller.effectiveModeFor(child.session), { mode: 'manual', source: 'session' }, 'child inherits the parent override');
        assert.equal(await policyTextOf(h, child.agent), undefined, 'inherited manual: no policy');
        assert.ok(h.tools.get('establish_baseline', child.agent), 'inherited manual: tools present');

        // The child changes independently; the parent never moves.
        await h.controller.sessionModeStore.setOverride(child.session, 'off');
        assert.deepEqual(h.controller.effectiveModeFor(child.session), { mode: 'off', source: 'session' });
        assert.deepEqual(h.controller.effectiveModeFor(parent.session), { mode: 'manual', source: 'session' });

        // A fork of a parent WITHOUT an override inherits nothing (shared layer).
        const bare = await mountAgent(h, { id: 's-bare' });
        const grandchild = await mountAgent(h, { id: 's-grand', parentSession: 's-bare', seedLength: bare.session.seq });
        assert.deepEqual(h.controller.effectiveModeFor(grandchild.session), { mode: 'auto', source: 'profile' });
    } finally {
        await h.dispose();
    }
});

// ── /align-mode snapshot ─────────────────────────────────────────────────────

test('session-mode: /align-mode with no argument prints the four-layer snapshot with the exact source', async () => {
    const h = await mountController({ mode: 'manual' }, { [SETTINGS_NAMESPACE]: { mode: 'auto' } });
    try {
        const a = await mountAgent(h, { id: 's-snap' });
        await h.controller.sessionModeStore.setOverride(a.session, 'off');
        const result = await runAlignMode(h, a.agent, '');
        assert.equal(result.kind, 'success');
        const text = result.text ?? '';
        assert.match(text, /Effective: Off \(session override\)/);
        assert.match(text, /Session override: Off/);
        assert.match(text, /Runtime override: Auto/);
        assert.match(text, /Profile default: Manual/);
    } finally {
        await h.dispose();
    }
});

// ── durability: a session override is durable-first and survives a store clear ─

test('session-mode: setting and clearing a session override writes to and removes from the durable sidecar', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-durable' });
        await h.controller.sessionModeStore.setOverride(a.session, 'manual');
        assert.equal(h.controller.sessionModeStore.getOverride(a.session), 'manual');
        const recordKey = String(a.session.id);
        const stored = h.storage.__records.get(recordKey) as { identity: { id: string }; mode: string };
        assert.ok(stored, 'a sidecar record was written');
        assert.equal(stored.mode, 'manual');
        assert.equal(stored.identity.id, 's-durable');

        await h.controller.sessionModeStore.clearOverride(a.session);
        assert.equal(h.controller.sessionModeStore.getOverride(a.session), undefined);
        assert.equal(h.storage.__records.get(recordKey), undefined, 'the record was removed');
    } finally {
        await h.dispose();
    }
});

// ── policy text renders the durable baseline summary for the calling agent ───

test('session-mode: an auto agent\'s policy section renders the baseline summary from the durable store', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-summary' });
        await h.controller.stateStore.recordBaseline(a.session, {
            revision: 1,
            goal: 'Fix the form bug',
            explicitConstraints: ['no UI change'],
            updatedAt: 1
        });
        const text = await policyTextOf(h, a.agent);
        assert.match(text!, /Current requirement baseline \(revision 1\):/);
        assert.match(text!, /Goal: Fix the form bug/);
    } finally {
        await h.dispose();
    }
});
