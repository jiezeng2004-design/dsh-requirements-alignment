/**
 * dsh-requirements-alignment: a native DeepSeek Harness plugin that acts as a
 * runtime requirement drift guard.
 *
 * While an agent executes, the plugin keeps a durable requirement baseline
 * per session (goal, explicit constraints, must-preserve behavior, allowed
 * scope, settled user decisions) in the AlignmentStateStore sidecar — the
 * official `ctx.storageDomain` KV domain — NOT in session events. Since the
 * persistence-compatibility fix, production code never appends `alignment/*`
 * events: the DSH persistence reader's generated known-event vocabulary does
 * not contain them, and an appended event makes the session unreadable to
 * every DSH build (SessionFormatUnsupportedError). New sessions created by
 * this plugin load, replay, and resume under a bare DSH reader with zero
 * alignment footprint. Auto mode (default) contributes a policy section to
 * every agent's system prompt that teaches silent drift detection and the
 * re-alignment protocol, plus two model-facing tools: `establish_baseline`
 * (silent baseline recording) and `report_drift` (drift candidate + user
 * decision). Manual mode contributes no section; the `/align` command steers
 * a compact fresh-alignment inspection into the agent. Both modes record
 * durable per-session state that survives resume, historical fork, and
 * compaction through whole-state checkpoints (`{visibleThroughSeq, state}`),
 * and `/align-migrate` repairs legacy sessions whose artifacts still carry
 * alignment/* events.
 *
 * v0.3.0 — persistent runtime mode & hot switching. The static single
 * `config.mode` becomes a three-layer model:
 *
 *   valid persisted override  ->  valid profile default  ->  auto
 *
 * The profile (`config.mode`) is the composition default layer; a user
 * override is persisted through the DSH Settings service (`settings.yaml`);
 * the effective mode is whichever layer resolves. ModeStore owns that
 * resolution, and {@link AlignmentRuntime} performs real register/dispose
 * hot transitions without ever touching `config.mode`, so auto → manual →
 * off → auto never duplicates capabilities and never restarts the profile.
 * Mode persistence and alignment state persistence (the sidecar) are
 * independent: switching modes never deletes a baseline, the sidecar, or
 * session events.
 *
 * The plugin is a plain Cordis service: every registration is an effect
 * disposer owned by this fiber, so unloading the plugin (or disabling the
 * row) restores the previous behavior.
 *
 * @module dsh-requirements-alignment
 */
import { Service } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CommandResult } from '@deepseek-ai/dsh-commands';
import { MANUAL_CHECK_MESSAGE } from './policy.ts';
import { AlignmentStateStore } from './alignment-state-store.ts';
import { migrateLegacyArtifact } from './migration.ts';
import {
    ALIGNMENT_MODES,
    validateAlignmentMode as validateMode,
    type AlignmentMode,
    type AlignmentStatus,
    type AlignmentStatusValue
} from './types.ts';
import { ModeStore, type EffectiveSource, type ModeSnapshot } from './mode-store.ts';
import { createModeStore } from './settings-mode-store.ts';
import { AlignmentRuntime } from './runtime-mode-controller.ts';

/** Alignment operation mode. */
export type { AlignmentMode };
export { ALIGNMENT_MODES };

/** Raw plugin config. */
export interface Config {
    /** Profile default: `auto` (default) contributes the policy section; `manual` only the /align command and tools; `off` nothing. A persisted override wins over this at runtime. */
    mode?: AlignmentMode;
    /** Optional deployment-owned policy text replacing the shipped one (auto mode). */
    section?: string;
}

/**
 * DSH/Schemastery Config schema for configuration structure, loading, and
 * validation. `mode` is the enum `auto` / `manual` / `off` — the profile
 * default layer. YAML stays `mode: auto|manual|off` (default `auto`). Cordis
 * validates incoming config through this schema's Standard Schema contract
 * before the plugin starts.
 */
export const ConfigSchema = Schema.object({
    mode: Schema.union(ALIGNMENT_MODES)
        .default('auto')
        .description('Profile default alignment mode. Auto contributes the policy section, tools, and /align. Manual keeps tools and /align only. Off unregisters those and keeps /align-mode so the mode can be switched live. A persisted user override wins at runtime.'),
    section: Schema.string()
        .pattern(/\S/)
        .description('Optional deployment-owned policy text replacing the shipped one (auto mode). Must be non-empty when set.')
});

/** A validated, detached config. */
export interface ResolvedConfig {
    mode: AlignmentMode;
    section?: string;
}

/**
 * Validate deployment-owned config. Missing, blank, or unknown fields fail at
 * plugin load rather than being ignored (same stance as dsh-plan-mode).
 *
 * @param config Raw plugin config.
 * @returns A detached validated config.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
    const unknown = Object.keys(config).filter((key) => key !== 'mode' && key !== 'section');
    if (unknown.length > 0) throw new Error(`RequirementsAlignmentConfig has unknown key(s) ${unknown.join(', ')} - config is { mode?, section? }`);
    const mode = config.mode ?? 'auto';
    if (mode !== 'auto' && mode !== 'manual' && mode !== 'off') throw new Error(`RequirementsAlignmentConfig mode must be 'auto', 'manual', or 'off', got ${JSON.stringify(mode)}`);
    if (config.section !== undefined) {
        if (typeof config.section !== 'string') throw new Error('RequirementsAlignmentConfig section must be a string');
        if (config.section.trim() === '') throw new Error('RequirementsAlignmentConfig section must be non-empty when provided');
    }
    return config.section === undefined ? { mode } : { mode, section: config.section };
}

/** Full-mode equality over the four fields that define a {@link ModeSnapshot}. */
function sameModeSnapshot(a: ModeSnapshot, b: ModeSnapshot): boolean {
    return a.defaultMode === b.defaultMode
        && a.overrideMode === b.overrideMode
        && a.effectiveMode === b.effectiveMode
        && a.effectiveSource === b.effectiveSource;
}

/** Human-readable status label for one folded posture. */
export function statusValueText(value: AlignmentStatusValue): string {
    switch (value) {
        case 'aligned': return 'Aligned';
        case 'drift-pending': return 'Drift pending (an open drift awaits a user decision)';
        case 'baseline-update-pending': return 'Baseline update pending (a direction change was approved; the new baseline is not recorded yet)';
        case 'unknown': return 'Unknown (no baseline recorded yet)';
    }
}

/** Capitalized mode label shown on `/align` and `/align-mode`. */
export function modeStatusLabel(mode: AlignmentMode): 'Auto' | 'Manual' | 'Off' {
    switch (mode) {
        case 'auto': return 'Auto';
        case 'manual': return 'Manual';
        case 'off': return 'Off';
    }
}

/** Where the effective mode came from, in `/align` wording. */
export function sourceStatusLabel(source: EffectiveSource): string {
    return source === 'override' ? 'runtime override' : 'profile default';
}

/**
 * Human-readable multi-line status report for the `/align` command result.
 * Reports the folded baseline state and the active mode; it never claims to
 * block execution. Mode is taken from the live effective snapshot, not the
 * fold. When `source` is given, the mode line names whether it is the profile
 * default or a runtime override.
 */
export function statusText(status: AlignmentStatus, mode?: AlignmentMode, source?: EffectiveSource): string {
    const lines = ['Requirements Alignment'];
    if (mode !== undefined) {
        const extra = source === undefined ? '' : ` (${sourceStatusLabel(source)})`;
        lines.push(`Mode: ${modeStatusLabel(mode)}${extra}`);
    }
    lines.push(`Baseline revision: ${status.revision}`);
    lines.push('', 'Goal:', status.baseline?.goal ?? '(none recorded)');
    const constraints = status.baseline?.explicitConstraints ?? [];
    lines.push('', 'Protected constraints:');
    if (constraints.length === 0) {
        lines.push('(none)');
    } else {
        lines.push(...constraints.map((item) => `- ${item}`));
    }
    lines.push('', `Drift events: ${status.driftCount}`);
    if (status.lastDrift === undefined) {
        lines.push('', 'Last drift:', '(none)');
    } else {
        lines.push('', 'Last drift:', `${status.lastDrift.reason} - ${status.lastDrift.description}`);
    }
    if (status.lastDecision === undefined) {
        lines.push('', 'Last user decision:', '(none)');
    } else {
        lines.push('', 'Last user decision:', `${status.lastDecision.decision}${status.lastDecision.note === undefined ? '' : ` (${status.lastDecision.note})`}`);
    }
    lines.push('', 'Current status:', statusValueText(status.status));
    lines.push('', `Manual checks: ${status.manualChecks}`);
    return lines.join('\n');
}

/**
 * Human-readable snapshot of the three-layer runtime mode, used by
 * `/align-mode` with no argument and after a successful switch/reset.
 */
export function modeSnapshotText(snapshot: ModeSnapshot): string {
    const override = snapshot.overrideMode === undefined ? '(none)' : modeStatusLabel(snapshot.overrideMode);
    return [
        'Requirements Alignment mode',
        `Effective: ${modeStatusLabel(snapshot.effectiveMode)} (${sourceStatusLabel(snapshot.effectiveSource)})`,
        `Profile default: ${modeStatusLabel(snapshot.defaultMode)}`,
        `Runtime override: ${override}`
    ].join('\n');
}

/**
 * The alignment controller: owns the ModeStore / AlignmentRuntime wiring, the
 * AlignmentStateStore sidecar, and the `/align` + `/align-migrate` domain
 * behavior; provides the `requirementsAlignment` service.
 *
 * Startup ordering: the controller resolves the effective mode from the
 * ModeStore snapshot and applies it immediately against the startup runtime
 * (Phase 1; no change subscription yet). The ModeStore knows whether a
 * settings override already exists, so the startup snapshot already reflects
 * a persisted override when the settings service is present.
 *
 * The `/align` path deliberately reads the effective snapshot (never config):
 * it only reports a mode label when `/align` is actually registered (auto or
 * manual), and the runtime guarantees the registry stays consistent with
 * that snapshot.
 */
export class RequirementsAlignmentController extends Service {
    static inject = ['systemPrompt', 'tools'];
    /** Native Config schema (enum `mode`) for Cordis load validation. */
    static Config = ConfigSchema;

    /** Validated profile config (the default layer; not the effective mode). */
    readonly config: ResolvedConfig;
    /** The canonical alignment state store (durable sidecar + in-memory view). */
    readonly stateStore: AlignmentStateStore;
    /** The runtime mode authority (desired/effective + persisted override). */
    readonly modeStore: ModeStore;
    /** The live capability controller (actual register/dispose). */
    readonly runtime: AlignmentRuntime;
    /** Serialization guard for hot-switch reconciliation (see {@link handleModeChange}). */
    private reconciliationActive = false;
    /** The latest change that arrived while a reconciliation was still settling. */
    private pendingChange: { next: ModeSnapshot; previous: ModeSnapshot } | undefined;
    /**
     * The snapshot whose persisted mode source still awaits restoration after a
     * transition failure whose compensation write itself failed. Non-`undefined`
     * means the runtime is authoritative on this snapshot's effective mode while
     * the persisted layer has NOT yet converged to its source; the next
     * reconciliation settles it first, and it is only cleared once the live
     * snapshot actually matches it (see {@link runReconciliation}).
     */
    private _pendingCompensation?: ModeSnapshot;

    constructor(ctx: import('@deepseek-ai/cordis').Context, config: Config = {}) {
        super(ctx, 'requirementsAlignment');
        this.config = resolveConfig(config);
        this.stateStore = new AlignmentStateStore(ctx, { logger: this.ctx.logger });
        this.modeStore = createModeStore(ctx, { mode: this.config.mode }, this.ctx.logger);
        this.runtime = new AlignmentRuntime(ctx, {
            section: this.config.section,
            store: this.stateStore,
            runManual: (agent: Agent, rawInput: string) => this.runManualAlignment(agent, rawInput),
            runMigrate: (agent: Agent, rawInput: string) => this.runMigrate(agent, rawInput),
            runMode: (agent: Agent, rawInput: string) => this.runModeCommand(agent, rawInput)
        });
        this.ctx.effect(() => () => this.modeStore.dispose());
        // Apply the startup effective mode once, per the v0.2 registration
        // matrix (auto -> policy+tools+commands; manual -> tools+commands;
        // off -> nothing).
        this.runtime.applyMode(this.modeStore.getSnapshot().effectiveMode);
        // Hot switching: any change to the ModeStore snapshot (a persisted
        // override committed by this controller, or an externally edited /
        // hot-reloaded document that the settings port observes) is applied to
        // the runtime. A transition that fails mid-registration is compensated
        // here — never swallowed into a consistent-looking snapshot — so the
        // runtime, the persisted layer, and the ModeStore stay in agreement.
        this.modeStore.subscribe((next, previous) => {
            this.handleModeChange(next, previous);
        });
    }

    /**
     * Test/observability probe for the double-fault recovery state: the snapshot
     * whose persisted mode source is still awaiting restoration, or `undefined`
     * when the last reconciliation converged the ModeStore and the runtime.
     */
    get pendingCompensation(): ModeSnapshot | undefined {
        return this._pendingCompensation;
    }

    /**
     * Reconcile a ModeStore change against the runtime, serialized.
     *
     * The runtime transition runs first. On success nothing else is needed. On
     * failure {@link AlignmentRuntime.applyMode} has already disposed partials
     * and restored the previous registrations; this handler then restores the
     * persisted user layer to the source the previous snapshot came from and
     * lets the compensation's own notification re-commit the previous snapshot
     * as the notified state — so a failed transition is never permanently
     * committed as success (no `{ effective: auto, runtime: manual }`
     * split-brain).
     *
     * Double-fault safety (v0.3.0): if the compensation write itself fails, the
     * rollback intent is kept in {@link _pendingCompensation} instead of being
     * dropped. While it is set, the runtime stays authoritative on that
     * snapshot's effective mode and the very next reconciliation — any
     * settings/document update — settles it first (restore the persisted
     * source, verify the live snapshot actually converged, clear) before any
     * newer desired transition runs. Settling is bounded: each trigger performs
     * at most one compensation write, and a failed write does not notify, so a
     * persistently broken persistence layer simply parks the pending state
     * until the next external trigger — no busy loop.
     *
     * Serialization: while a reconciliation (and any failed compensation) is
     * settling, an arriving change is coalesced into a single pending item and
     * applied when the current one finishes. That keeps the compensation from
     * recursively re-entering the failure path, so there is no oscillation, no
     * duplicate registrations, and no listener growth.
     */
    private handleModeChange(next: ModeSnapshot, previous: ModeSnapshot): void {
        if (this.reconciliationActive) {
            // Keep only the latest desired state; it applies after the current
            // reconciliation finishes.
            this.pendingChange = { next, previous };
            return;
        }
        this.reconciliationActive = true;
        void this.runReconciliation(next, previous);
    }

    private async runReconciliation(next: ModeSnapshot, previous: ModeSnapshot): Promise<void> {
        try {
            if (this._pendingCompensation !== undefined) {
                // A transition already failed AND its compensation write failed:
                // the runtime is on the pending target, but the persisted layer
                // (and the ModeStore snapshot) still read the failed desired.
                // Settle that before attempting anything newer.
                const target = this._pendingCompensation;
                if (!(await this.restorePendingCompensation())) {
                    // Persistence is still unavailable. The runtime stays on the
                    // pending target, this latest change is held, and the next
                    // trigger retries. `restorePendingCompensation` logged the
                    // failure — one bounded attempt per trigger, no retry loop.
                    return;
                }
                // The settle rewrote the document to the pending target, which may
                // have clobbered a newer user change. Re-assert the latest desired
                // source first (a no-op when the document already reflects it),
                // then apply it to the runtime.
                try {
                    await this.applyDesiredSource(next);
                } catch (error) {
                    this._pendingCompensation = target;
                    this.ctx.logger?.warn(
                        'requirements-alignment: failed to re-persist the latest desired mode %s (%s) after compensation settled (%s); the restore remains pending',
                        next.effectiveMode,
                        next.effectiveSource,
                        error instanceof Error ? error.message : String(error)
                    );
                    return;
                }
                try {
                    this.runtime.applyMode(next.effectiveMode);
                } catch (error) {
                    // Even a settled rollback can meet a transition failure on the
                    // latest desired; fall back to the pending target
                    // transactionally, exactly like the primary path below.
                    this._pendingCompensation = target;
                    this.ctx.logger?.warn(
                        'requirements-alignment: applying latest desired mode %s failed (%s) after compensation settled; restoring %s (%s)',
                        next.effectiveMode,
                        error instanceof Error ? error.message : String(error),
                        target.effectiveMode,
                        target.effectiveSource
                    );
                    await this.compensateAndVerify(target);
                }
                return;
            }

            try {
                this.runtime.applyMode(next.effectiveMode);
            } catch (error) {
                this.ctx.logger?.warn(
                    'requirements-alignment: applying effective mode %s failed (%s); restoring previous %s (%s)',
                    next.effectiveMode,
                    error instanceof Error ? error.message : String(error),
                    previous.effectiveMode,
                    previous.effectiveSource
                );
                await this.compensateAndVerify(previous);
            }
        } finally {
            this.reconciliationActive = false;
            const pending = this.pendingChange;
            this.pendingChange = undefined;
            if (pending !== undefined) {
                this.handleModeChange(pending.next, pending.previous);
            }
        }
    }

    /**
     * Restore the persisted layer to `target` after a transition failure and
     * keep the pending compensation in force until the live snapshot actually
     * converges to it. The rollback target is recorded BEFORE the compensation
     * write so the restore intent survives a synchronous throw, and it is only
     * cleared once the persisted layer really matches.
     */
    private async compensateAndVerify(target: ModeSnapshot): Promise<void> {
        this._pendingCompensation = target;
        try {
            await this.compensateModeSource(target);
            if (sameModeSnapshot(this.modeStore.getSnapshot(), target)) {
                this._pendingCompensation = undefined;
                this.ctx.logger?.info(
                    'requirements-alignment: mode source restored to %s (%s) after a failed transition',
                    target.effectiveMode,
                    target.effectiveSource
                );
            }
        } catch (compensationError: unknown) {
            // The runtime was already rolled back; keep the compensation failure
            // visible and distinct from the transition failure, and park the
            // pending state so a later trigger retries the restore.
            this.ctx.logger?.warn(
                'requirements-alignment: failed to restore the persisted mode source after a failed transition (%s); compensation for %s (%s) remains pending',
                compensationError instanceof Error ? compensationError.message : String(compensationError),
                target.effectiveMode,
                target.effectiveSource
            );
        }
    }

    /**
     * Complete a pending compensation whose write previously failed: restore the
     * persisted source to the pending target and confirm the live snapshot
     * converged before clearing it.
     *
     * @returns `true` when the pending compensation settled (source restored and
     *   snapshot confirmed); `false` while it remains pending (persistence down).
     */
    private async restorePendingCompensation(): Promise<boolean> {
        const target = this._pendingCompensation;
        if (target === undefined) return true;
        try {
            await this.compensateModeSource(target);
            try {
                this.runtime.applyMode(target.effectiveMode);
            } catch (runtimeError) {
                this.ctx.logger?.warn(
                    'requirements-alignment: pending mode compensation restored the persisted source to %s (%s) but the runtime could not follow (%s); retaining it until the next trigger',
                    target.effectiveMode,
                    target.effectiveSource,
                    runtimeError instanceof Error ? runtimeError.message : String(runtimeError)
                );
                return false;
            }
            if (sameModeSnapshot(this.modeStore.getSnapshot(), target)) {
                this._pendingCompensation = undefined;
                this.ctx.logger?.info(
                    'requirements-alignment: pending mode compensation settled; persisted source restored to %s (%s)',
                    target.effectiveMode,
                    target.effectiveSource
                );
                return true;
            }
            // The write landed but the live snapshot does not yet mirror the
            // target; keep it pending — the next trigger re-checks.
            return false;
        } catch (error) {
            this.ctx.logger?.warn(
                'requirements-alignment: pending mode compensation for %s (%s) could not be completed (%s); retaining it until the next trigger',
                target.effectiveMode,
                target.effectiveSource,
                error instanceof Error ? error.message : String(error)
            );
            return false;
        }
    }

    /**
     * Re-assert `desired` as the persisted source when the document no longer
     * reflects it (a pending-compensation restore rewrote it). A no-op when the
     * live snapshot already matches `desired`.
     */
    private async applyDesiredSource(desired: ModeSnapshot): Promise<void> {
        const current = this.modeStore.getSnapshot();
        if (sameModeSnapshot(current, desired)) return;
        if (desired.effectiveSource === 'override' && desired.overrideMode !== undefined) {
            await this.modeStore.setOverride(desired.overrideMode);
        } else {
            await this.modeStore.resetOverride();
        }
    }

    /**
     * Restore the persisted settings user layer to the source that produced
     * `previous`, preserving the profile-default vs runtime-override
     * distinction: a `profile`-sourced previous resets the override (no
     * `mode:` key is written), an `override`-sourced previous rewrites exactly
     * its {@link ModeSnapshot.overrideMode}.
     */
    private async compensateModeSource(previous: ModeSnapshot): Promise<void> {
        if (previous.effectiveSource === 'override' && previous.overrideMode !== undefined) {
            await this.modeStore.setOverride(previous.overrideMode);
        } else {
            await this.modeStore.resetOverride();
        }
    }

    /**
     * Awaited plugin startup hook (Cordis `Service.init`): opens the
     * alignment sidecar domain (durable records land in memory before any
     * session can exist) and adopts every session as it starts — importing
     * legacy timelines and pinning fork inheritance idempotently. Runs in
     * every mode (including off), so switching modes never loses state.
     */
    async [Service.init](): Promise<void> {
        await this.stateStore.open();
        this.ctx.on('agent/session-start', (payload: { agent: Agent }) => {
            void this.stateStore.initializeSession(payload.agent.session).catch((error: unknown) => {
                this.ctx.logger?.warn('requirements-alignment: failed to initialize alignment state for a session: %o', error);
            });
        });
    }

    /**
     * Request a mode transition and make it durable. Ordering is
     * validate -> transition -> persist:
     *
     *   1. The desired mode is validated (and rejected before any effect).
     *   2. The runtime transitions now. If it throws, nothing is persisted and
     *      no notification fires — the effective mode is unchanged.
     *   3. Only after a successful transition is the override committed to the
     *      settings layer. If that commit fails, the runtime is compensated
     *      back to the previous mode before the error propagates.
     *
     * The commit then triggers the change subscription, which re-applies the
     * same mode to the runtime — an idempotent no-op that keeps the registry
     * and the persisted document consistent.
     *
     * @param mode The desired mode.
     * @returns The resulting snapshot, when the transition and persist succeeded.
     * @throws On an invalid mode, a failed transition, or a failed persistence
     *   (with the runtime compensated back to the prior mode).
     */
    async setMode(mode: AlignmentMode): Promise<ModeSnapshot> {
        validateMode(mode);
        const previous = this.modeStore.getSnapshot();
        // 2) Transition first; a failure leaves the registry untouched and
        //    persists nothing.
        this.runtime.applyMode(mode);
        // 3) Commit the override; compensate on failure.
        try {
            await this.modeStore.setOverride(mode);
        } catch (error) {
            // Persistence did not commit: the document still reflects `previous`.
            // Restore the runtime to match. If that also fails, keep a pending
            // compensation so the next reconciliation re-applies `previous`.
            try {
                this.runtime.applyMode(previous.effectiveMode);
            } catch (rollbackError) {
                this._pendingCompensation = previous;
                this.ctx.logger?.warn(
                    'requirements-alignment: failed to restore runtime mode %s after a persistence failure (%s); compensation for %s (%s) remains pending',
                    previous.effectiveMode,
                    rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                    previous.effectiveMode,
                    previous.effectiveSource
                );
            }
            throw error;
        }
        return this.modeStore.getSnapshot();
    }

    /**
     * Drop the persisted override and return to the profile default. Like
     * {@link setMode}, the runtime transition happens before the persistence
     * reset, and a failed reset compensates the runtime back.
     *
     * @returns The resulting snapshot (effective source `profile`).
     * @throws On a failed runtime transition or a failed persistence reset.
     */
    async resetMode(): Promise<ModeSnapshot> {
        const previous = this.modeStore.getSnapshot();
        const next = previous.defaultMode;
        this.runtime.applyMode(next);
        try {
            await this.modeStore.resetOverride();
        } catch (error) {
            try {
                this.runtime.applyMode(previous.effectiveMode);
            } catch (rollbackError) {
                this._pendingCompensation = previous;
                this.ctx.logger?.warn(
                    'requirements-alignment: failed to restore runtime mode %s after a reset persistence failure (%s); compensation for %s (%s) remains pending',
                    previous.effectiveMode,
                    rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                    previous.effectiveMode,
                    previous.effectiveSource
                );
            }
            throw error;
        }
        return this.modeStore.getSnapshot();
    }

    /**
     * Run one manual alignment inspection: record the check in the sidecar,
     * report the folded status, and hand a fresh alignment check to the agent
     * as a steered user message. Never blocks and never takes over the
     * workflow. A failed manual-check record (e.g. no durable medium) is
     * logged and never prevents the inspection itself from running.
     *
     * @param agent The receiving agent.
     * @param _rawInput Unused (bare command); reserved for future arguments.
     * @returns The command result rendered by the dispatching UI.
     */
    async runManualAlignment(agent: Agent, _rawInput: string): Promise<CommandResult> {
        const status = this.stateStore.getStatus(agent.session);
        const session: Session = agent.session;
        try {
            await this.stateStore.recordManualCheck(session);
        } catch (error) {
            this.ctx.logger?.warn('requirements-alignment: failed to record manual check: %o', error);
        }
        const snap = this.modeStore.getSnapshot();
        const report = statusText(status, snap.effectiveMode, snap.effectiveSource);
        agent.steer(createUserMessage({
            content: [{ type: 'text', text: `${MANUAL_CHECK_MESSAGE}\n\n${report}` }],
            source: {
                kind: 'plugin',
                plugin: 'requirements-alignment',
                form: 'notice',
                summary: 'Requirements Alignment check started'
            }
        }));
        return { kind: 'success' as const, text: report };
    }

    /**
     * `/align-mode` body: report the three-layer snapshot, switch the runtime
     * override (`auto` / `manual` / `off`), or `reset` to the profile default.
     * Always registered, including in Off, so a live switch to Off is reversible.
     */
    async runModeCommand(_agent: Agent, rawInput: string): Promise<CommandResult> {
        const token = rawInput.trim().toLowerCase();
        if (token === '') {
            return { kind: 'success' as const, text: modeSnapshotText(this.modeStore.getSnapshot()) };
        }
        if (token === 'reset') {
            try {
                const snap = await this.resetMode();
                return { kind: 'success' as const, text: `Reset to the profile default.\n${modeSnapshotText(snap)}` };
            } catch (error) {
                return {
                    kind: 'error' as const,
                    text: `Failed to reset alignment mode: ${error instanceof Error ? error.message : String(error)}`
                };
            }
        }
        if (token === 'auto' || token === 'manual' || token === 'off') {
            try {
                const snap = await this.setMode(token);
                return {
                    kind: 'success' as const,
                    text: `Switched to ${modeStatusLabel(token)}.\n${modeSnapshotText(snap)}`
                };
            } catch (error) {
                return {
                    kind: 'error' as const,
                    text: `Failed to switch alignment mode: ${error instanceof Error ? error.message : String(error)}`
                };
            }
        }
        return {
            kind: 'error' as const,
            text: 'Usage: /align-mode [auto | manual | off | reset]\n'
                + modeSnapshotText(this.modeStore.getSnapshot())
        };
    }

    /**
     * The `/align-migrate` command body: run the explicit, gated legacy
     * artifact migration for one stored session. The session id comes from
     * the command input; without one, the calling agent's own session id is
     * used. Errors (live writer, missing artifact, any failed safety gate)
     * are reported as command errors and never touch the artifact.
     *
     * @param agent The receiving agent (whose session id is the default target).
     * @param rawInput The command input (a session id, when given).
     * @returns The command result rendered by the dispatching UI.
     */
    async runMigrate(agent: Agent, rawInput: string): Promise<CommandResult> {
        const persistence = this.ctx.get('sessionPersistence');
        if (persistence === undefined) {
            return { kind: 'error' as const, text: 'No session persistence service is mounted; cannot migrate stored sessions.' };
        }
        const target = rawInput.trim();
        const id = target === '' ? String(agent.session.id) : target;
        try {
            const report = await migrateLegacyArtifact(SessionId(id), {
                persistence,
                sessions: this.ctx.get('sessions')
            });
            if (!report.migrated) {
                return {
                    kind: 'success' as const,
                    text: `Session ${report.id}: nothing to repair — no unmarked legacy alignment events. Artifact unchanged.`
                };
            }
            return {
                kind: 'success' as const,
                text: `Session ${report.id} migrated: ${report.repairedEvents} legacy alignment event(s) marked ignorable.`
                    + `\nOriginal SHA-256: ${report.originalSha256}`
                    + `\nBackup: ${report.backupPath ?? '(none)'}`
                    + `\nThe session can now be opened by any DSH build.`
            };
        } catch (error) {
            return {
                kind: 'error' as const,
                text: `Migration failed for ${id}: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
}

export default RequirementsAlignmentController;