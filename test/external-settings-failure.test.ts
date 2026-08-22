import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountController, mountAgent, assertAgentModeConsistent, assertAgentModeDegraded, assertSharedTopology, assertSessionTopology, assertPendingCompensation } from './helpers.ts';
import { SETTINGS_NAMESPACE } from '../src/settings-mode-store.ts';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';

/**
 * v0.4.0/v0.4.1 failure-path regressions.
 *
 * v0.4.0: capabilities live per-agent; the shared layer only feeds the
 * resolution. A per-agent registration failure inside syncAgent rolls back the
 * partials, re-registers the previous mode with FRESH disposers, and recovers
 * on the next trigger.
 *
 * v0.4.1 (mode-source / active-capability ATOMICITY): a failed capability
 * transition must ALSO compensate the PERSISTED MODE SOURCE back to its
 * previous topology - never leave the advertised effective mode claiming the
 * target while the runtime implements the previous mode. The mutation that
 * owns the switch (setMode / resetMode / setSessionMode / clearSessionOverride)
 * reports FAILURE; the command and management API never say the target is
 * active. The only advertised non-converged states are the explicit degraded
 * (capability double-failure) and pending source-compensation ones.
 */

// --- shared persistence failure: nothing moves ---------------------------------

test('external-settings-failure: a failed external settings edit keeps the shared layer and agents consistent', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-ext-fail' });
        h.settings.setFailWrites(true);
        h.settings.__document[SETTINGS_NAMESPACE] = { mode: 'off' };
        h.settings.publish(SETTINGS_NAMESPACE);
        await new Promise((resolve) => setTimeout(resolve, 10));
        h.settings.setFailWrites(false);
        const shared = h.controller.modeStore.getSnapshot().effectiveMode;
        const aEff = h.controller.effectiveModeFor(a.session).mode;
        assert.equal(aEff, shared, 'agent effective matches the shared layer');
    } finally {
        await h.dispose();
    }
});

// --- transactional switch: shared rollback + SOURCE compensation + recovery ---

test('external-settings-failure: a failed Auto re-registration rejects the switch, compensates the shared source, and recovers on the next trigger', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-reg-fail' });
        assert.ok(h.systemPrompt.sectionsFor(a.agent).some((s) => s.name === 'requirements-alignment:policy'), 'auto policy at baseline');

        // Off transition succeeds (off registers nothing). This creates a
        // shared override 'off' on top of the 'auto' profile default.
        h.systemPrompt.failSections = true;
        await h.controller.setMode('off');
        assertSharedTopology(h, true, 'off');
        assertAgentModeConsistent(h, a);

        // Switching back to Auto fails because the policy section throws.
        // The switch is ONE transaction: the shared source must go back to
        // 'off' AND the live capability must be the (rolled-back) off set.
        await assert.rejects(h.controller.setMode('auto'), /injected section registration failure/);
        assertSharedTopology(h, true, 'off', );
        assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'off', 'shared source compensated to its previous override');
        assertAgentModeConsistent(h, a);
        assert.equal(h.systemPrompt.sectionsFor(a.agent).length, 0, 'no half-registered auto policy after the failed switch');
        assert.equal(h.tools.get('establish_baseline', a.agent), undefined, 'no leaked tool after the failed auto transition');
        assert.equal(h.commands.find(a.agent, 'align'), undefined, 'no leaked /align after the failed auto transition');

        // Recovery: the next trigger (a session override) retries and succeeds.
        h.systemPrompt.failSections = false;
        await h.controller.setSessionMode(a.session, 'manual');
        assertAgentModeConsistent(h, a);
        assert.ok(h.tools.get('establish_baseline', a.agent), 'manual capability live after recovery');
        await h.controller.setSessionMode(a.session, 'auto');
        assertAgentModeConsistent(h, a);
        assert.ok(h.systemPrompt.sectionsFor(a.agent).some((s) => s.name === 'requirements-alignment:policy'), 'policy re-registered on the next trigger');
        assert.ok(h.commands.find(a.agent, 'align'));
    } finally {
        await h.dispose();
    }
});

// --- invalid persisted override: fail open + repair (never fails startup) ------

test('external-settings-failure: an invalid persisted mode override fails open to the profile default and is repaired', async () => {
    const h = await mountController({ mode: 'auto' }, { [SETTINGS_NAMESPACE]: { mode: 'banana' } });
    try {
        assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'auto');
        assert.equal(h.controller.modeStore.getSnapshot().effectiveSource, 'profile');
        const a = await mountAgent(h, { id: 's-invalid-doc' });
        assert.equal(h.controller.effectiveModeFor(a.session).mode, 'auto');
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(h.settings.__raw(SETTINGS_NAMESPACE), undefined, 'invalid override cleared');
    } finally {
        await h.dispose();
    }
});

// --- v0.4.1 mode-source / capability transaction matrix (A-F failure, G success) --
//
// If a mutation that persists the desired mode cannot reconcile every affected
// agent's capabilities, the mutation MUST revert the source to its previous
// topology and REPORT FAILURE. The split-brain invariant enforced here:
//   advertised effectiveMode (source) == active capability mode (runtime),
// except the two EXPLICIT non-converged states: capability-degraded (the old
// double-failure fail-loud) and pending source-compensation.

/** Invoke /align-mode against one mounted agent (mirrors controller.test.ts). */
async function runAlignMode(h: import('./helpers.ts').ControllerHarness, agent: import('./helpers.ts').MountedAgent['agent'], input: string) {
    const command = h.commands.find(agent, 'align-mode');
    assert.ok(command, '/align-mode is always registered');
    return command.handler({
        agent,
        rawInput: input,
        signal: new AbortController().signal,
        commandId: ('test-' + input) as never,
        attachments: []
    });
}

test('external-settings-failure: A — shared Manual->Auto primary failure rejects, compensates Manual source, re-registers Manual, and never says the target is active', async () => {
    const h = await mountController({ mode: 'manual' });
    try {
        const a = await mountAgent(h, { id: 's-a-manual-to-auto' });
        const key = String(a.agent.id);
        assert.ok(h.tools.get('establish_baseline', a.agent), 'manual establish_baseline at baseline');
        assert.equal(h.systemPrompt.sectionsFor(a.agent).some((s) => s.name === 'requirements-alignment:policy'), false, 'manual has no policy section at baseline');
        const manualRecord = h.controller.agentCapabilities.get(key);
        assert.ok(manualRecord);

        // Inject a policy (Auto-only) registration failure and attempt the switch.
        h.systemPrompt.failSections = true;
        await assert.rejects(h.controller.setMode('auto'), /injected section registration failure/, 'setMode must reject on capability failure');
        h.systemPrompt.failSections = false;

        // THE SPLIT-BRAIN FIX: the persisted source is compensated back to the
        // previous topology (no shared override; profile default manual), so the
        // advertised effective mode == the ACTIVE capability mode == manual.
        assertSharedTopology(h, false);
        assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'manual', 'advertised effective mode is the previous mode, never the target');
        assert.equal(h.controller.modeStore.getSnapshot().effectiveSource, 'profile');
        const rolledBack = h.controller.agentCapabilities.get(key);
        assert.ok(rolledBack, 'capability record still present after rollback');
        assert.notEqual(rolledBack, manualRecord, 'the disposed registration object is never put back into the Map');
        assert.notEqual(rolledBack!.disposers, manualRecord!.disposers, 'rollback holds a fresh disposer array, not the executed one');
        assert.equal(rolledBack!.mode, 'manual', 'rollback restored mode manual');
        assertAgentModeConsistent(h, a);
        assert.equal(h.controller.degradedAgents.size, 0, 'no degraded agents on a recoverable single failure');
        assert.equal(h.systemPrompt.sectionsFor(a.agent).some((s) => s.name === 'requirements-alignment:policy'), false, 'Auto-only policy section left no residue');
        assert.ok(h.tools.get('establish_baseline', a.agent), 'establish_baseline re-registered');
        assert.ok(h.tools.get('report_drift', a.agent), 'report_drift re-registered');
        assert.ok(h.commands.find(a.agent, 'align'), '/align re-registered');
        assert.ok(h.commands.find(a.agent, 'align-migrate'), '/align-migrate re-registered');
        for (const dispose of rolledBack!.disposers) dispose();
        assert.equal(h.tools.get('establish_baseline', a.agent), undefined, 'recorded disposers really own the establishment tool');

        // Public surface never claims the target is active: /align-mode reports
        // an error, never "Switched to Auto.".
        h.systemPrompt.failSections = true;
        const result = await runAlignMode(h, a.agent, 'auto');
        h.systemPrompt.failSections = false;
        assert.equal(result.kind, 'error', '/align-mode must report failure');
        assert.match(result.text ?? '', /Failed to switch alignment mode/);
        assert.equal((result.text ?? '').includes('Switched to Auto.'), false, '/align-mode must not claim the target is active');
    } finally {
        await h.dispose();
    }
});

test('external-settings-failure: B — shared Auto->Manual primary failure rejects, compensates Auto source, re-registers Auto, and leaves no Manual partials', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-b-auto-to-manual' });
        const key = String(a.agent.id);
        assert.ok(h.systemPrompt.sectionsFor(a.agent).some((s) => s.name === 'requirements-alignment:policy'), 'auto policy at baseline');
        const autoRecord = h.controller.agentCapabilities.get(key);
        assert.ok(autoRecord);

        // Fail the FIRST /align command registration: manual registers its two
        // tools, then the first command registration throws.
        h.commands.failCommandsOnce = true;
        await assert.rejects(h.controller.setMode('manual'), /injected command registration failure/);

        // Source compensated to previous topology (no shared override; profile auto).
        assertSharedTopology(h, false);
        assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'auto', 'advertised effective mode is the previous mode');
        const restored = h.controller.agentCapabilities.get(key);
        assert.ok(restored, 'capability record present after Auto rollback');
        assert.notEqual(restored, autoRecord, 'fresh record — never the disposed auto object');
        assert.equal(restored!.mode, 'auto', 'rollback restored mode auto');
        assertAgentModeConsistent(h, a);
        assert.ok(h.systemPrompt.sectionsFor(a.agent).some((s) => s.name === 'requirements-alignment:policy'), 'Auto policy restored');
        const scopedTools = h.tools.scopedTools.get(a.agent) ?? [];
        const count = (name: string) => scopedTools.filter((tool) => tool.name === name).length;
        assert.equal(count('establish_baseline'), 1, 'no leaked manual establish_baseline');
        assert.equal(count('report_drift'), 1, 'no leaked manual report_drift');
        assert.equal(h.commands.scopedCommands.get(a.agent)?.filter((c) => c.name === 'align').length ?? 0, 1, 'exactly one /align');
        assert.equal(restored!.disposers.length, 1 + 2 + 2, 'rollback disposer count matches auto (1 policy + 2 tools + 2 commands)');
    } finally {
        await h.dispose();
    }
});

test('external-settings-failure: C — session inherited Auto->Manual failure leaves the session override ABSENT', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-c-inherited' });
        const key = String(a.agent.id);
        const autoRecord = h.controller.agentCapabilities.get(key);
        assert.ok(autoRecord);

        h.commands.failCommandsOnce = true;
        await assert.rejects(h.controller.setSessionMode(a.session, 'manual'), /injected command registration failure/);

        // The session had NO override before (it inherited Auto). Compensating
        // must NOT write an equal-value override: the override stays ABSENT.
        assertSessionTopology(h, a, false, undefined);
        assert.equal(h.controller.effectiveModeFor(a.session).mode, 'auto', 'session resolves to the inherited shared mode');
        assertAgentModeConsistent(h, a);
        const restored = h.controller.agentCapabilities.get(key);
        assert.ok(restored, 'capability record present after Auto rollback');
        assert.notEqual(restored, autoRecord, 'fresh record');
        assert.equal(restored!.mode, 'auto', 'rollback restored mode auto');
        assert.ok(h.systemPrompt.sectionsFor(a.agent).some((s) => s.name === 'requirements-alignment:policy'), 'Auto policy restored');
        assert.ok(h.commands.find(a.agent, 'align'), 'Auto /align restored');
    } finally {
        await h.dispose();
    }
});

test('external-settings-failure: D — session explicit Off->Manual failure restores the exact Off override', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-d-explicit-off' });
        await h.controller.setSessionMode(a.session, 'off');
        assertSessionTopology(h, a, true, 'off');
        assertAgentModeConsistent(h, a);
        assert.equal(h.systemPrompt.sectionsFor(a.agent).length, 0, 'off has no alignment capabilities');

        h.commands.failCommandsOnce = true;
        await assert.rejects(h.controller.setSessionMode(a.session, 'manual'), /injected command registration failure/);

        // The explicit previous override is restored to its EXACT value, never
        // cleared and never replaced.
        assertSessionTopology(h, a, true, 'off');
        assert.equal(h.controller.effectiveModeFor(a.session).mode, 'off', 'session resolves to the restored override');
        assertAgentModeConsistent(h, a);
        assert.equal(h.systemPrompt.sectionsFor(a.agent).length, 0, 'still the off capability set');
    } finally {
        await h.dispose();
    }
});

test('external-settings-failure: E — a failed source compensation write is pending, exposed honestly, and retried to convergence', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-e-comp-pending' });
        const key = String(a.agent.id);
        // Establish a previous shared override 'manual' (the topology the
        // failed mutation must restore). This is setOverride call #1.
        await h.controller.setMode('manual');
        assertSharedTopology(h, true, 'manual');
        assertAgentModeConsistent(h, a);

        // Inject a ONE-SHOT failure on the COMPENSATION write only. The stub is
        // installed AFTER the baseline setMode('manual'), so within the failing
        // setMode('auto'): the target persist is call #1 and the compensation
        // restore is call #2 - throw exactly on the compensation write.
        const originalSetOverride = h.controller.modeStore.setOverride.bind(h.controller.modeStore);
        let calls = 0;
        (h.controller.modeStore as unknown as { setOverride(mode: 'auto' | 'manual' | 'off'): Promise<unknown> }).setOverride = async (mode) => {
            calls += 1;
            if (calls === 2) throw new Error('injected source compensation write failure');
            return originalSetOverride(mode);
        };

        h.systemPrompt.failSections = true;
        await assert.rejects(h.controller.setMode('auto'), /injected source compensation write failure/);
        h.systemPrompt.failSections = false;

        // The source could NOT be compensated (its write failed), so the system
        // is in an EXPLICIT pending source-compensation state: never silent.
        assertSharedTopology(h, true, 'auto', );
        assert.equal(h.controller.agentCapabilities.get(key)?.mode, 'manual', 'active capability rolled back to manual');
        assertPendingCompensation(h, 'shared', true);
        const status = h.controller.alignmentStatusPayload(a.agent);
        assert.equal(status.session.reconciliation?.pending, true);
        assert.equal(status.session.reconciliation?.kind, 'source-compensation');
        assert.equal(status.session.reconciliation?.activeCapabilityMode, 'manual', 'the user is told the ACTUAL active capability mode');
        assert.equal(h.controller.degradedAgents.size, 0, 'a single failure with pending source compensation is not capability-degraded');

        // Retry: the next mutation first replays the pending compensation, then
        // converges. Source Manual, active Manual, pending cleared.
        await h.controller.setMode('manual');
        assertPendingCompensation(h, 'shared', false);
        assertSharedTopology(h, true, 'manual');
        assertAgentModeConsistent(h, a);
        const after = h.controller.alignmentStatusPayload(a.agent);
        assert.equal(after.session.reconciliation, undefined, 'converged: no reconciliation marker');
    } finally {
        await h.dispose();
    }
});

test('external-settings-failure: F — rollback secondary failure fails loud into degraded, while the source is compensated', async () => {
    const h = await mountController({ mode: 'manual' });
    try {
        const a = await mountAgent(h, { id: 's-f-double-fail' });
        const key = String(a.agent.id);
        assert.ok(h.tools.get('establish_baseline', a.agent), 'manual tool at baseline');

        h.systemPrompt.failSections = true;
        h.tools.failToolsOnce = true;
        const logs: Array<{ type: string; args: unknown[] }> = [];
        const logger = h.ctx.logger as { exporter?: (exporter: { export(m: { type: string; args: unknown[] }): void }) => unknown } | undefined;
        if (logger !== undefined && typeof logger.exporter === 'function') {
            logger.exporter({ export: (m) => logs.push({ type: m.type, args: m.args }) });
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        await assert.rejects(h.controller.setMode('auto'), /injected section registration failure/);

        // Source compensated: the shared override is gone (profile default manual).
        assertSharedTopology(h, false);
        assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'manual', 'source compensated to previous');
        // No dead capability bookkeeping, explicit degraded marker with provenance.
        assert.equal(h.controller.agentCapabilities.get(key), undefined, 'no dead registration bookkeeping in the Map');
        const degraded = h.controller.degradedAgents.get(key);
        assert.ok(degraded, 'double failure is recorded as pending reconciliation');
        assert.equal(degraded!.targetMode, 'auto');
        assert.equal(degraded!.previousMode, 'manual');
        assert.equal(degraded!.primaryError.message, 'injected section registration failure');
        assert.equal(degraded!.rollbackError!.message, 'injected tool registration failure');
        assertAgentModeDegraded(h, a);
        const status = h.controller.alignmentStatusPayload(a.agent);
        assert.equal(status.session.reconciliation?.kind, 'capability-degraded');
        assert.equal(status.session.reconciliation?.activeCapabilityMode, 'manual', 'the user is told the actual (previous) active mode');
        assert.equal(h.systemPrompt.sectionsFor(a.agent).length, 0, 'no policy section after double failure');
        assert.equal(h.tools.get('establish_baseline', a.agent), undefined, 'no tool after double failure');

        const errorArgs = logs.filter((entry) => entry.type === 'error').map((entry) => entry.args);
        const errorText = errorArgs.map((args) => args.map((arg) => String(arg)).join(' ')).join('\n');
        assert.ok(errorText.length > 0, 'an error-level log was emitted for the double failure');
        assert.match(errorText, /injected section registration failure/, 'primary failure named in the error log');
        assert.match(errorText, /injected tool registration failure/, 'rollback failure named in the error log');

        // Reconciliation: the next trigger retries and succeeds, clearing the marker.
        h.systemPrompt.failSections = false;
        await h.controller.setSessionMode(a.session, 'manual');
        assertAgentModeConsistent(h, a);
        assert.ok(h.controller.agentCapabilities.get(key), 'reconciled: a live Map entry is restored');
        assert.equal(h.controller.degradedAgents.get(key), undefined, 'degradation cleared after recovery');
        assert.ok(h.tools.get('establish_baseline', a.agent));
        assert.ok(h.tools.get('report_drift', a.agent));
        assert.ok(h.commands.find(a.agent, 'align'));
        assert.ok(h.commands.find(a.agent, 'align-migrate'));
    } finally {
        await h.dispose();
    }
});

test('external-settings-failure: G — successful transitions through the transactional methods stay converged', async () => {
    const h = await mountController({ mode: 'manual' });
    try {
        const a = await mountAgent(h, { id: 's-g-success' });
        const key = String(a.agent.id);
        const hasPolicy = () => h.systemPrompt.sectionsFor(a.agent).some((s) => s.name === 'requirements-alignment:policy');
        const hasTools = () => h.tools.get('establish_baseline', a.agent) !== undefined;
        const hasAlign = () => h.commands.find(a.agent, 'align') !== undefined;
        const expectConverged = (mode: 'auto' | 'manual' | 'off') => {
            assert.equal(h.controller.agentCapabilities.get(key)?.mode, mode, 'Map record mode');
            assertAgentModeConsistent(h, a);
            switch (mode) {
                case 'auto': assert.ok(hasPolicy() && hasTools() && hasAlign(), 'auto full set'); break;
                case 'manual': assert.equal(hasPolicy(), false); assert.ok(hasTools() && hasAlign(), 'manual set'); break;
                case 'off': assert.equal(hasPolicy() && hasTools() && hasAlign(), false, 'off has nothing'); break;
            }
            assert.equal(h.controller.degradedAgents.size, 0, 'no degraded agents');
            assert.equal(h.controller.pendingSourceCompensation.size, 0, 'no pending source compensation');
        };

        await h.controller.setMode('auto');
        assertSharedTopology(h, true, 'auto');
        expectConverged('auto');
        await h.controller.setMode('off');
        assertSharedTopology(h, true, 'off');
        expectConverged('off');
        await h.controller.resetMode();
        assertSharedTopology(h, false);
        assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'manual', 'reset returns to the profile default');
        expectConverged('manual');
        await h.controller.setSessionMode(a.session, 'auto');
        assertSessionTopology(h, a, true, 'auto');
        expectConverged('auto');
        await h.controller.clearSessionOverride(a.session);
        assertSessionTopology(h, a, false);
        expectConverged('manual');
        const finalStatus = h.controller.alignmentStatusPayload(a.agent);
        assert.equal(finalStatus.session.effectiveSource, 'profile');
        assert.equal(finalStatus.session.reconciliation, undefined);
    } finally {
        await h.dispose();
    }
});

// --- partial-registration leak: a SECOND command failure must unwind the FIRST ---

test('external-settings-failure: H — a failed SECOND command registration disposes the FIRST command, leaving no half-registered set', async () => {
    const h = await mountController({ mode: 'auto' });
    try {
        const a = await mountAgent(h, { id: 's-h-second-command-fail' });
        const key = String(a.agent.id);
        assert.ok(h.commands.find(a.agent, 'align'), 'auto /align at baseline');
        assert.ok(h.commands.find(a.agent, 'align-migrate'), 'auto /align-migrate at baseline');
        assert.ok(h.controller.agentCapabilities.get(key), 'auto capability record at baseline');

        // Inject a failure on the SECOND commands.register call: /align
        // registers successfully first, /align-migrate then throws. The
        // successful /align disposer must be unwound — a plain map() over the
        // definitions would silently leak it into the agent scope.
        const registerService = h.commands as unknown as {
            register(definition: CommandDefinition): () => void;
        };
        const originalRegister = registerService.register;
        let commandCalls = 0;
        registerService.register = function (this: unknown, definition: CommandDefinition): () => void {
            commandCalls += 1;
            if (commandCalls === 2) throw new Error('injected second command registration failure');
            return originalRegister.call(this, definition);
        };

        await assert.rejects(h.controller.setMode('manual'), /injected second command registration failure/);

        // The switch is ONE transaction: the shared source returns to its
        // previous topology (no override; profile auto) and the active
        // capability set is the rolled-back auto set — with exactly one /align
        // and one /align-migrate, never a leaked first command.
        assertSharedTopology(h, false);
        assert.equal(h.controller.modeStore.getSnapshot().effectiveMode, 'auto', 'advertised effective mode is the previous mode');
        const restored = h.controller.agentCapabilities.get(key);
        assert.ok(restored, 'capability record present after Auto rollback');
        assert.equal(restored!.mode, 'auto', 'rollback restored mode auto');
        assert.equal(restored!.disposers.length, 1 + 2 + 2, 'rollback disposer count matches auto (1 policy + 2 tools + 2 commands)');
        assertAgentModeConsistent(h, a);
        assert.equal(h.controller.degradedAgents.size, 0, 'no degraded agents on a recoverable single failure');
        const scoped = h.commands.scopedCommands.get(a.agent) ?? [];
        assert.equal(scoped.filter((c) => c.name === 'align').length, 1, 'the first command was disposed when the second registration failed — no leaked /align');
        assert.equal(scoped.filter((c) => c.name === 'align-migrate').length, 1, 'exactly one /align-migrate after the rollback');
        assert.ok(h.systemPrompt.sectionsFor(a.agent).some((s) => s.name === 'requirements-alignment:policy'), 'Auto policy restored');
        assert.ok(h.tools.get('establish_baseline', a.agent), 'Auto tools restored');
    } finally {
        await h.dispose();
    }
});