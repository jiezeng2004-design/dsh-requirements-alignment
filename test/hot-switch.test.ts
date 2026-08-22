import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountController, mountAgent, type ControllerHarness, type MountedAgent } from './helpers.ts';
import { SETTINGS_NAMESPACE } from '../src/settings-mode-store.ts';

/** The shared-layer effective snapshot of the controller. */
function shared(h: ControllerHarness) {
    return h.controller.modeStore.getSnapshot();
}

/** Assert one agent's registered capability set matches the expected mode. */
function assertAgentCapabilities(
    h: ControllerHarness,
    agent: MountedAgent['agent'],
    mode: 'auto' | 'manual' | 'off'
): void {
    const hasPolicy = h.systemPrompt.sectionsFor(agent).some((s) => s.name === 'requirements-alignment:policy');
    const hasTools = h.tools.get('establish_baseline', agent) !== undefined;
    const hasAlign = h.commands.find(agent, 'align') !== undefined;
    const expectedPolicy = mode === 'auto';
    const expectedTools = mode !== 'off';
    const expectedAlign = mode !== 'off';
    assert.equal(hasPolicy, expectedPolicy, `mode ${mode}: policy present=${expectedPolicy}`);
    assert.equal(hasTools, expectedTools, `mode ${mode}: tools present=${expectedTools}`);
    assert.equal(hasAlign, expectedAlign, `mode ${mode}: /align present=${expectedAlign}`);
    // /align-mode is the always-on global control command in every mode.
    assert.ok(h.commands.find(agent, 'align-mode'), `mode ${mode}: /align-mode present`);
}

// --- persisted override wins at startup --------------------------------------

test('hot-switch: a persisted override wins over the profile default at startup', async () => {
    const h = await mountController({ mode: 'auto' }, { [SETTINGS_NAMESPACE]: { mode: 'manual' } });
    try {
        assert.equal(shared(h).effectiveMode, 'manual');
        assert.equal(shared(h).effectiveSource, 'override');
        const a = await mountAgent(h, { id: 's-start' });
        assertAgentCapabilities(h, a.agent, 'manual');
    } finally {
        await h.dispose();
    }
});

// --- setMode: persist + resync -------------------------------------------------

test('hot-switch: setMode persists the shared override and resyncs agents without a session override', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const plain = await mountAgent(h, { id: 's-plain' });
        const pinned = await mountAgent(h, { id: 's-pinned' });
        await h.controller.sessionModeStore.setOverride(pinned.session, 'auto');

        const snap = await h.controller.setMode('off');
        assert.equal(snap.effectiveMode, 'off');
        assert.equal(snap.effectiveSource, 'override');
        assert.deepEqual(h.settings.__raw(SETTINGS_NAMESPACE), { mode: 'off' }, 'override persisted');
        // The plain agent follows the shared layer; the pinned agent does not.
        assertAgentCapabilities(h, plain.agent, 'off');
        assertAgentCapabilities(h, pinned.agent, 'auto');

        const snap2 = await h.controller.setMode('manual');
        assert.equal(snap2.effectiveMode, 'manual');
        assertAgentCapabilities(h, plain.agent, 'manual');
        assertAgentCapabilities(h, pinned.agent, 'auto');
    } finally {
        await h.dispose();
    }
});

// --- setMode invalid ----------------------------------------------------------

test('hot-switch: an invalid setMode is rejected without touching the shared layer or any agent', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-invalid' });
        await assert.rejects(() => h.controller.setMode('banana' as never), /must be 'auto', 'manual', or 'off'/);
        assert.equal(shared(h).effectiveMode, 'auto');
        assert.equal(h.settings.__raw(SETTINGS_NAMESPACE), undefined, 'nothing persisted');
        assertAgentCapabilities(h, a.agent, 'auto');
    } finally {
        await h.dispose();
    }
});

// --- resetMode ---------------------------------------------------------------

test('hot-switch: resetMode drops the override and returns to the profile default', async () => {
    const h = await mountController({ mode: 'manual' }, { [SETTINGS_NAMESPACE]: { mode: 'off' } });
    try {
        const a = await mountAgent(h, { id: 's-reset' });
        assertAgentCapabilities(h, a.agent, 'off');

        const snap = await h.controller.resetMode();
        assert.equal(snap.effectiveMode, 'manual');
        assert.equal(snap.effectiveSource, 'profile');
        assertAgentCapabilities(h, a.agent, 'manual');
        assert.equal(h.settings.__raw(SETTINGS_NAMESPACE), undefined, 'override cleared');
    } finally {
        await h.dispose();
    }
});

// --- external document edit --------------------------------------------------

test('hot-switch: an external settings document edit hot-reloads and resyncs agents', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-ext' });
        assertAgentCapabilities(h, a.agent, 'auto');

        // Simulate a settings.yaml hot reload (the file provider's `publish`).
        h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'off' };
        h.settings.publish(SETTINGS_NAMESPACE);
        await new Promise((resolve) => setTimeout(resolve, 5));

        assert.equal(shared(h).effectiveMode, 'off');
        assertAgentCapabilities(h, a.agent, 'off');
    } finally {
        await h.dispose();
    }
});

// --- persistence failure -------------------------------------------------------

test('hot-switch: a persistence failure rejects setMode and leaves every agent untouched', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-fail' });
        assertAgentCapabilities(h, a.agent, 'auto');

        h.settings.setFailWrites(true);
        await assert.rejects(() => h.controller.setMode('off'), /injected settings write failure/);
        h.settings.setFailWrites(false);

        // The shared layer never moved and no agent resynced: no split-brain.
        assert.equal(shared(h).effectiveMode, 'auto');
        assertAgentCapabilities(h, a.agent, 'auto');
        assert.equal(h.settings.__raw(SETTINGS_NAMESPACE), undefined, 'nothing persisted after a failed write');

        // Recoverable: a fresh write succeeds.
        await h.controller.setMode('off');
        assertAgentCapabilities(h, a.agent, 'off');
    } finally {
        await h.dispose();
    }
});

// --- state preservation ---------------------------------------------------------

test('hot-switch: establishing a baseline then auto->manual->off->auto preserves the baseline and store state', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-preserve' });
        await h.controller.stateStore.recordBaseline(a.session, {
            revision: 1,
            goal: 'Fix the form bug',
            explicitConstraints: ['no UI change'],
            updatedAt: 1
        });
        assert.equal(h.controller.stateStore.getBaseline(a.session)?.revision, 1);

        // Walk the full switch matrix; alignment canonical state must survive.
        for (const mode of ['manual', 'off', 'auto'] as const) {
            await h.controller.setMode(mode);
            assertAgentCapabilities(h, a.agent, mode);
            assert.equal(h.controller.stateStore.getBaseline(a.session)?.revision, 1, 'baseline survives mode switch');
            assert.equal(h.controller.stateStore.getBaseline(a.session)?.goal, 'Fix the form bug');
        }
        assert.equal(shared(h).effectiveMode, 'auto');
    } finally {
        await h.dispose();
    }
});

test('hot-switch: /align-mode remains registered in Off and can switch the session back', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-modeoff' });
        const command = h.commands.find(a.agent, 'align-mode');
        assert.ok(command, '/align-mode is registered in Auto');

        const off = await command.handler({
            agent: a.agent,
            rawInput: 'session off',
            signal: new AbortController().signal,
            commandId: 'hot-mode-off' as never,
            attachments: []
        });
        assert.equal(off.kind, 'success');
        assertAgentCapabilities(h, a.agent, 'off');
        assert.ok(h.commands.find(a.agent, 'align-mode'), '/align-mode survives Off');

        const back = await command.handler({
            agent: a.agent,
            rawInput: 'session manual',
            signal: new AbortController().signal,
            commandId: 'hot-mode-back' as never,
            attachments: []
        });
        assert.equal(back.kind, 'success');
        assertAgentCapabilities(h, a.agent, 'manual');
    } finally {
        await h.dispose();
    }
});
