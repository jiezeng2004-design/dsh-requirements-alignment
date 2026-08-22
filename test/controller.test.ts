import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    modeSnapshotText,
    sessionModeSnapshotText,
    statusText,
    statusValueText
} from '../src/index.ts';
import { POLICY_ORDER, POLICY_SECTION } from '../src/policy.ts';
import { mountController, mountAgent, type ControllerHarness, type MountedAgent } from './helpers.ts';

/** The `/align` command definition resolved for one agent (auto/manual only). */
function alignCommand(h: ControllerHarness, agent: MountedAgent['agent']) {
    const found = h.commands.find(agent, 'align');
    assert.ok(found, '/align must be registered for this agent');
    return found;
}

/** Invoke `/align-mode` against one mounted agent. */
async function runAlignMode(h: ControllerHarness, agent: MountedAgent['agent'], input: string) {
    const command = h.commands.find(agent, 'align-mode');
    assert.ok(command, '/align-mode is always registered');
    return command.handler({
        agent,
        rawInput: input,
        signal: new AbortController().signal,
        commandId: `test-${input}` as never,
        attachments: []
    });
}

test('controller: an auto agent registers the policy section, both commands, and both tools in its own scope', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const { agent } = await mountAgent(h, { id: 's-auto' });
        const sections = h.systemPrompt.sectionsFor(agent);
        assert.equal(sections.length, 1);
        assert.equal(sections[0]!.name, POLICY_SECTION);
        assert.equal(sections[0]!.order, POLICY_ORDER);
        assert.ok(h.commands.find(agent, 'align'), '/align present');
        assert.ok(h.commands.find(agent, 'align-migrate'), '/align-migrate present');
        assert.ok(h.commands.find(agent, 'align-mode'), '/align-mode present (global control)');
        assert.ok(h.tools.get('establish_baseline', agent), 'establish_baseline present');
        assert.ok(h.tools.get('report_drift', agent), 'report_drift present');
        // A different agent has its OWN disjoint capability set.
        const other = await mountAgent(h, { id: 's-other' });
        assert.notEqual(h.systemPrompt.sectionsFor(other.agent), sections, 'agents hold disjoint scoped sections');
    } finally {
        await h.dispose();
    }
});

test('controller: section text renders the full policy on a fresh session and the baseline summary once recorded', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-text' });
        const assembly = await h.systemPrompt.assemble({ scope: a.agent, agent: a.agent } as never);
        const section = assembly.sections.find((s) => s.name === POLICY_SECTION);
        assert.ok(section, 'policy section assembled');
        assert.match(section!.text, /Requirements Alignment policy/);
        assert.doesNotMatch(section!.text, /Current requirement baseline/);

        // The summary reads the sidecar store (the canonical view), not events.
        await h.controller.stateStore.recordBaseline(a.session, {
            revision: 1,
            goal: 'Fix the form bug',
            explicitConstraints: ['no UI change'],
            updatedAt: 1
        });
        const after = await h.systemPrompt.assemble({ scope: a.agent, agent: a.agent } as never);
        const sectionAfter = after.sections.find((s) => s.name === POLICY_SECTION);
        assert.match(sectionAfter!.text, /Current requirement baseline \(revision 1\):/);
        assert.match(sectionAfter!.text, /Goal: Fix the form bug/);
    } finally {
        await h.dispose();
    }
});

test('controller: section renders nothing without an agent (bare assemble)', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const { agent } = await mountAgent(h, { id: 's-bare' });
        const assembly = await h.systemPrompt.assemble({});
        // A bare assemble has no scope: only global sections render. The policy
        // is scoped per-agent, so it must NOT leak into a bare assemble.
        assert.equal(assembly.sections.find((s) => s.name === POLICY_SECTION), undefined);
        void agent;
    } finally {
        await h.dispose();
    }
});

test('controller: unload disposes every registration including scoped ones', async () => {
    const h = await mountController({ mode: 'auto' });
    const { agent } = await mountAgent(h, { id: 's-unload' });
    assert.ok(h.systemPrompt.sectionsFor(agent).length >= 1);
    assert.ok(h.commands.find(agent, 'align'));
    // Unload the controller fiber: every registration (global /align-mode and
    // per-agent capabilities) must unwind.
    await (h.ctx as unknown as { fiber?: { dispose(): Promise<void> } }).fiber?.dispose().catch(() => { });
    assert.equal(h.systemPrompt.sectionsFor(agent).length, 0, 'scoped sections unwind with the plugin fiber');
    assert.equal(h.commands.find(agent, 'align'), undefined, 'scoped /align unwinds');
    assert.equal(h.commands.find(agent, 'align-mode'), undefined, 'global /align-mode unwinds');
});

test('controller: /align handler records the check in the store, steers the check message, and reports status', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-align' });
        const steered: unknown[] = [];
        (a.agent as { steer: (m: unknown) => void }).steer = (message: unknown) => steered.push(message);
        const result = await alignCommand(h, a.agent).handler({
            agent: a.agent,
            rawInput: '',
            signal: new AbortController().signal,
            commandId: 'test-align' as never,
            attachments: []
        });
        assert.equal(result.kind, 'success');
        assert.match(result.text ?? '', /Requirements Alignment/);
        assert.match(result.text ?? '', /Baseline revision: 0/);
        assert.match(result.text ?? '', /Current status:\nUnknown/);
        // The manual check lands in the sidecar store, never in session events.
        assert.equal(a.session.events.length, 0);
        assert.equal(h.controller.stateStore.getStatus(a.session).manualChecks, 1);
        // Check steered to the agent for real analysis.
        assert.equal(steered.length, 1);
        const message = steered[0] as { content: Array<{ type: string; text: string }>; source: { kind: string; plugin: string; form: string } };
        assert.match(message.content[0]!.text, /Requirements Alignment check \(manual\)/);
        assert.match(message.content[0]!.text, /durable sidecar state/);
        assert.match(message.content[0]!.text, /Mode: Auto \(profile default\)/);
        assert.equal(message.source.kind, 'plugin');
        assert.equal(message.source.plugin, 'requirements-alignment');
        assert.equal(message.source.form, 'notice');
    } finally {
        await h.dispose();
    }
});

test('controller: /align reports the session effective mode source (session override wins)', async () => {
    const h = await mountController({ mode: 'manual' }, {});
    try {
        const a = await mountAgent(h, { id: 's-mode-src' });
        await h.controller.sessionModeStore.setOverride(a.session, 'auto');
        const result = await alignCommand(h, a.agent).handler({
            agent: a.agent,
            rawInput: '',
            signal: new AbortController().signal,
            commandId: 'test-mode' as never,
            attachments: []
        });
        assert.equal(result.kind, 'success');
        assert.match(result.text ?? '', /Mode: Auto \(session override\)/);
    } finally {
        await h.dispose();
    }
});

test('controller: /align handler reports baseline revision and drift state after store records', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-state' });
        await h.controller.stateStore.recordBaseline(a.session, {
            revision: 2,
            goal: 'Optimize the result page',
            explicitConstraints: ['keep API'],
            updatedAt: 1
        });
        const { driftSeq } = await h.controller.stateStore.recordDrift(a.session, {
            reason: 'architecture-shift',
            description: 'cloud sync',
            at: 2
        });
        await h.controller.stateStore.recordDecision(a.session, { driftSeq, decision: 'approve', at: 3 });
        await h.controller.stateStore.recordBaseline(a.session, {
            revision: 3,
            goal: 'Optimize the result page',
            explicitConstraints: ['keep API', 'cloud sync'],
            updatedAt: 4
        });
        await h.controller.stateStore.recordManualCheck(a.session, 5);
        const result = await alignCommand(h, a.agent).handler({
            agent: a.agent,
            rawInput: '',
            signal: new AbortController().signal,
            commandId: 'test-state' as never,
            attachments: []
        });
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
    } finally {
        await h.dispose();
    }
});

test('controller: handler never throws on append failure and still steers', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-append' });
        await h.storage.__close(); // sabotage the durable medium AFTER attach
        const steered: unknown[] = [];
        (a.agent as { steer: (m: unknown) => void }).steer = (message: unknown) => steered.push(message);
        const result = await alignCommand(h, a.agent).handler({
            agent: a.agent,
            rawInput: '',
            signal: new AbortController().signal,
            commandId: 'test-append' as never,
            attachments: []
        });
        assert.equal(result.kind, 'success');
        assert.equal(steered.length, 1);
        assert.equal(h.controller.stateStore.getStatus(a.session).manualChecks, 0, 'failed record must not commit memory state');
    } finally {
        await h.dispose();
    }
});

test('controller: /align-mode switches the shared layer and /align-mode session switches only the session', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-switch' });

        // Shared layer -> off.
        const off = await runAlignMode(h, a.agent, 'off');
        assert.equal(off.kind, 'success');
        assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'off');
        assert.match(off.text ?? '', /Session override: \(none\)/);
        assert.match(off.text ?? '', /Effective: Off \(runtime override\)/);

        // Session override -> auto (the session escapes the shared Off).
        const sessionAuto = await runAlignMode(h, a.agent, 'session auto');
        assert.equal(sessionAuto.kind, 'success');
        assert.deepEqual(h.controller.effectiveModeFor(a.session), { mode: 'auto', source: 'session' });
        assert.ok(h.commands.find(a.agent, 'align'), '/align restored via the session override');

        // Session reset reveals the shared Off again.
        const reset = await runAlignMode(h, a.agent, 'session reset');
        assert.equal(reset.kind, 'success');
        assert.deepEqual(h.controller.effectiveModeFor(a.session), { mode: 'off', source: 'override' });
        assert.equal(h.commands.find(a.agent, 'align'), undefined, '/align gone again under the shared Off');

        // Shared reset returns to the profile default.
        const sharedReset = await runAlignMode(h, a.agent, 'reset');
        assert.equal(sharedReset.kind, 'success');
        assert.deepEqual(h.controller.effectiveModeFor(a.session), { mode: 'auto', source: 'profile' });
        assert.ok(h.commands.find(a.agent, 'align'), '/align back under the profile default');
    } finally {
        await h.dispose();
    }
});

test('controller: /align-mode with an invalid token is an error', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const { agent } = await mountAgent(h, { id: 's-bad' });
        const bad = await runAlignMode(h, agent, 'banana');
        assert.equal(bad.kind, 'error');
        assert.match(bad.text ?? '', /Usage: \/align-mode/);
        const badSession = await runAlignMode(h, agent, 'session banana');
        assert.equal(badSession.kind, 'error');
        assert.match(badSession.text ?? '', /Usage: \/align-mode session/);
    } finally {
        await h.dispose();
    }
});

// ── pure text helpers ────────────────────────────────────────────────────────

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

test('statusText: includes the effective mode and its exact source from the live resolution', () => {
    const status = { revision: 0, driftCount: 0, status: 'unknown' as const, manualChecks: 0 };
    const auto = statusText(status, { mode: 'auto', source: 'profile' });
    const manualOverride = statusText(status, { mode: 'manual', source: 'override' });
    const offSession = statusText(status, { mode: 'off', source: 'session' });
    assert.match(auto, /^Requirements Alignment\nMode: Auto \(profile default\)\nBaseline revision: 0/m);
    assert.match(manualOverride, /Mode: Manual \(runtime override\)/);
    assert.match(offSession, /Mode: Off \(session override\)/);
    assert.doesNotMatch(auto, /Mode: Manual/);
});

test('statusValueText: labels the four postures without gate claims', () => {
    assert.equal(statusValueText('aligned'), 'Aligned');
    assert.match(statusValueText('drift-pending'), /Drift pending/);
    assert.match(statusValueText('baseline-update-pending'), /Baseline update pending/);
    assert.match(statusValueText('unknown'), /Unknown/);
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

test('sessionModeSnapshotText: names the session, runtime, and profile layers plus the exact effective source', () => {
    const text = sessionModeSnapshotText(
        { mode: 'off', source: 'session' },
        'off',
        { defaultMode: 'manual', overrideMode: 'auto', effectiveMode: 'auto', effectiveSource: 'override' }
    );
    assert.match(text, /Effective: Off \(session override\)/);
    assert.match(text, /Session override: Off/);
    assert.match(text, /Runtime override: Auto/);
    assert.match(text, /Profile default: Manual/);
});
