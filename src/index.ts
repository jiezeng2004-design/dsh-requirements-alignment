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
 * resolution.
 *
 * v0.4.0 — session-scoped mode selector. A fourth layer is added in front:
 *
 *   valid session override  ->  valid persisted runtime override
 *                            ->  valid profile default  ->  auto
 *
 * The session layer is persisted per-session (SessionModeStore sidecar) and
 * lets one session use Auto, Manual, or Off without changing the effective
 * mode of other live sessions. Alignment capabilities (the policy section,
 * both tools, `/align`, `/align-migrate`) are no longer registered at plugin
 * scope: they are registered in each agent's OWN scope (`agent.ctx`) when the
 * session starts, and the controller re-syncs an agent's capabilities when
 * its effective mode changes. Only `/align-mode` stays registered at plugin
 * scope so a live switch to Off is reversible. Mode persistence (Settings),
 * session-mode persistence (sidecar), and alignment-state persistence
 * (sidecar) are fully independent: switching or resetting any mode never
 * deletes a baseline, the sidecar, or session events.
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
import { AlignmentStateStore, type AlignmentSessionLike } from './alignment-state-store.ts';
import { SessionModeStore } from './session-mode-store.ts';
import { migrateLegacyArtifact } from './migration.ts';
import {
    ALIGNMENT_MODES,
    validateAlignmentMode as validateMode,
    type AlignmentMode,
    type AlignmentSource,
    type AlignmentStatus,
    type AlignmentStatusValue,
    type EffectiveMode
} from './types.ts';
import { ModeStore, type ModeSnapshot } from './mode-store.ts';
import { createModeStore } from './settings-mode-store.ts';
import { AlignmentRuntime } from './runtime-mode-controller.ts';
import { createManagementApi, type AlignmentStatusPayload } from './management-api.ts';

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
export function sourceStatusLabel(source: AlignmentSource): string {
    switch (source) {
        case 'session': return 'session override';
        case 'override': return 'runtime override';
        case 'profile': return 'profile default';
    }
}

/**
 * Human-readable multi-line status report for the `/align` command result.
 * Reports the folded baseline state and the calling session's effective mode;
 * it never claims to block execution. Mode is taken from the live effective
 * resolution (session -> runtime override -> profile default), not the fold.
 */
export function statusText(status: AlignmentStatus, effective?: EffectiveMode): string {
    const lines = ['Requirements Alignment'];
    if (effective !== undefined) {
        lines.push(`Mode: ${modeStatusLabel(effective.mode)} (${sourceStatusLabel(effective.source)})`);
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
 * Human-readable snapshot of the shared three-layer runtime mode (runtime
 * override -> profile default), used after a shared `/align-mode` switch.
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
 * Human-readable snapshot of the four-layer mode resolution for one session:
 * the session override, the shared runtime override, the profile default, and
 * the session's effective mode with its exact source. Used by `/align-mode`
 * (no argument, or the `session` sub-command) so a user can see exactly which
 * layer produced the current session's effective mode.
 */
export function sessionModeSnapshotText(
    effective: EffectiveMode,
    sessionOverride: AlignmentMode | undefined,
    shared: ModeSnapshot
): string {
    const session = sessionOverride === undefined ? '(none)' : modeStatusLabel(sessionOverride);
    const override = shared.overrideMode === undefined ? '(none)' : modeStatusLabel(shared.overrideMode);
    return [
        'Requirements Alignment mode',
        `Effective: ${modeStatusLabel(effective.mode)} (${sourceStatusLabel(effective.source)})`,
        `Session override: ${session}`,
        `Runtime override: ${override}`,
        `Profile default: ${modeStatusLabel(shared.defaultMode)}`
    ].join('\n');
}

/**
 * Fail-closed capability bookkeeping for one agent whose mode transition
 * could not be completed: the previous mode was torn down, the next mode's
 * registration failed, AND re-registering the previous mode failed too. Such
 * an agent has NO live alignment capability (never a Map entry — a Map entry
 * must always correspond to a live registration) and is pending
 * reconciliation: the next successful sync (any mode trigger) clears it.
 */
export interface DegradedRegistration {
    /** The mode the transition was moving to when registration failed. */
    targetMode: AlignmentMode;
    /** The mode that was live before the transition (the failed rollback target). */
    previousMode: AlignmentMode | undefined;
    /** The registration failure that aborted the transition. */
    primaryError: Error;
    /** The rollback re-registration failure, when the previous mode could not be restored. */
    rollbackError: Error | undefined;
    /** When the degradation was recorded. */
    since: number;
}

/** The exact source topology of one mode layer (shared runtime override or a
 * session override): whether an override EXISTS and, when it does, its value.
 * Presence matters: an inherited (override-less) session is compensated by
 * CLEARING - never by writing an equal-value override. */
export interface OverrideTopology {
    /** Whether the layer currently carries an override. */
    present: boolean;
    /** The override value, when present. */
    mode?: AlignmentMode;
}

/**
 * The result of reconciling one live agent's capabilities to its session's
 * effective mode. Used by the transactional mode mutations to decide whether
 * the persisted source commit can stand.
 *
 *  - unchanged / converged: the agent's capabilities now implement the
 *    effective mode - the persisted source commit can stand;
 *  - rolledback: the next-mode registration failed and the previous mode was
 *    re-registered with fresh disposers - the source MUST be compensated back;
 *  - degraded: the next-mode registration failed AND the previous-mode
 *    rollback failed too (fail-closed, pending reconciliation) - the source
 *    MUST be compensated back.
 */
export type SyncOutcome =
    | { kind: 'unchanged' }
    | { kind: 'converged'; mode: AlignmentMode }
    | { kind: 'rolledback'; targetMode: AlignmentMode; activeMode: AlignmentMode; error: Error }
    | { kind: 'degraded'; targetMode: AlignmentMode; previousMode: AlignmentMode | undefined; error: Error };

/**
 * A mode-SOURCE write that failed while compensating after a failed capability
 * transition: the runtime capabilities are (back) at the previous mode, but
 * the persisted source could not be restored to it, so the advertised
 * effective mode diverges from the active capability mode. This is the
 * explicit, never-silent pending state: exposed on the status payload,
 * retried on the next mutation, and cleared the moment the compensation write
 * lands.
 */
export interface PendingModeCompensation {
    kind: 'shared' | 'session';
    /** The session whose override is being compensated, when kind === 'session'. */
    session?: AlignmentSessionLike;
    /** The exact previous source topology being restored. */
    previousOverride: OverrideTopology;
    /** The topology the failed mutation attempted to write. */
    attemptedOverride: OverrideTopology;
    /** The write failure. */
    error: Error;
    /** When the pending compensation was recorded. */
    since: number;
}

/** The pending-compensation map key for the SHARED runtime override layer. */
const SHARED_MODE_KEY = 'shared';

/** Whether a sync outcome is converged (the persisted source commit can stand). */
function isConverged(outcome: SyncOutcome): boolean {
    return outcome.kind === 'unchanged' || outcome.kind === 'converged';
}

/** Normalize a thrown value to an Error for durable failure provenance. */
function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

/** The human-readable message of a thrown value. */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The alignment controller: owns the ModeStore (shared layer), the
 * SessionModeStore (session layer), the AlignmentStateStore sidecar, and the
 * per-agent capability lifecycle; provides the `requirementsAlignment`
 * service.
 *
 * Startup ordering: the controller opens both sidecars and adopts every
 * session as it starts — importing legacy timelines, pinning fork inheritance
 * (alignment state AND session-mode override), and registering that agent's
 * alignment capabilities per its effective mode. Runs in every mode
 * (including off), so switching modes never loses state.
 *
 * Capability model (v0.4.0): alignment capabilities live in each agent's own
 * scope. `agent/session-start` calls {@link initializeAgent}, which resolves
 * the session's effective mode (session override -> shared override -> profile
 * default -> auto) and registers the matching capabilities on `agent.ctx`.
 * `/align-mode session` changes only the calling session's override (and
 * resyncs that agent); `/align-mode` changes the shared runtime override (and
 * resyncs every agent that has no session override). An Off session has no
 * alignment capabilities at all — only `/align-mode` (globally registered)
 * remains, so it can switch itself back.
 */
export class RequirementsAlignmentController extends Service {
    static inject = ['systemPrompt', 'tools'];
    /** Native Config schema (enum `mode`) for Cordis load validation. */
    static Config = ConfigSchema;

    /** Validated profile config (the default layer; not the effective mode). */
    readonly config: ResolvedConfig;
    /** The canonical alignment state store (durable sidecar + in-memory view). */
    readonly stateStore: AlignmentStateStore;
    /** The session-mode override store (durable sidecar, per-session). */
    readonly sessionModeStore: SessionModeStore;
    /** The shared runtime mode authority (desired/effective + persisted override). */
    readonly modeStore: ModeStore;
    /** The per-agent capability registrar (registers on `agent.ctx`). */
    readonly runtime: AlignmentRuntime;
    /**
     * Live agents and the capability set currently registered in their scope:
     * agent id -> { the mode those capabilities implement, their disposers }.
     *
     * INVARIANT: every entry corresponds to a capability set that is live at
     * this instant — entries are created only from the disposers of a
     * successful registration and are never reused after those disposers
     * executed. Observable for tests and the management surface; treat as
     * read-only.
     */
    readonly agentCapabilities = new Map<string, { mode: AlignmentMode; disposers: Array<() => void> }>();
    /**
     * Agents whose capability transition failed closed: agent id -> the failed
     * transition (target mode, previous mode, primary + rollback error
     * provenance). These agents have NO live alignment capability — they never
     * appear in {@link agentCapabilities} — and the next successful sync
     * clears the marker (pending reconciliation).
     */
    readonly degradedAgents = new Map<string, DegradedRegistration>();
    /**
     * Pending mode-SOURCE compensation writes (v0.4.1 atomicity): a persisted
     * source write failed while compensating after a failed capability
     * transition. Keyed by SHARED_MODE_KEY for the shared runtime override or
     * by the session key for a session override. The next mutation retries
     * these; the entry is deleted the moment the compensation write lands. A
     * pending entry means the advertised effective mode may NOT yet match the
     * active capability mode - the state is exposed, never silent.
     */
    readonly pendingSourceCompensation = new Map<string, PendingModeCompensation>();
    /** Nesting depth of an in-progress mode mutation owning the reconcile. */
    private exclusiveReconcile = 0;
    /** A shared-layer subscription fired while a mutation owned the reconcile. */
    private deferredSharedReconcile = false;
    /** Session-key subscription fires deferred while a mutation owned the reconcile. */
    private deferredSessionKeys: string[] = [];
    /** The `/align-mode` registration (the always-on plugin-scope control command). */
    private modeCommandDisposer: (() => void) | undefined;

    constructor(ctx: import('@deepseek-ai/cordis').Context, config: Config = {}) {
        super(ctx, 'requirementsAlignment');
        this.config = resolveConfig(config);
        this.stateStore = new AlignmentStateStore(ctx, { logger: this.ctx.logger });
        this.sessionModeStore = new SessionModeStore(ctx, { logger: this.ctx.logger });
        this.modeStore = createModeStore(ctx, { mode: this.config.mode }, this.ctx.logger);
        this.runtime = new AlignmentRuntime(ctx, {
            section: this.config.section,
            store: this.stateStore,
            runManual: (agent: Agent, rawInput: string) => this.runManualAlignment(agent, rawInput),
            runMigrate: (agent: Agent, rawInput: string) => this.runMigrate(agent, rawInput)
        });
        // Unloading the plugin disposes the shared mode store AND explicitly
        // unwinds every per-agent capability set (they live on each agent's own
        // scope, which survives the plugin fiber; the controller owns them).
        this.ctx.effect(() => () => {
            this.modeStore.dispose();
            this.modeCommandDisposer?.();
            for (const record of this.agentCapabilities.values()) {
                for (const dispose of record.disposers) dispose();
            }
            this.agentCapabilities.clear();
        });
        // `/align-mode` is ALWAYS registered at plugin scope (the control
        // group): an Off session keeps it so a live switch to Off is reversible
        // without editing settings.yaml.
        this.registerModeCommand();
        // Shared-layer changes resync every agent that has no session override;
        // while a mode mutation owns the reconcile (exclusive), the change is
        // deferred and the mutation itself drives the sync exactly once.
        this.modeStore.subscribe(() => this.onSharedModeChange());
        // Session-override changes resync exactly the affected session's agent.
        this.sessionModeStore.subscribe((key) => this.onSessionModeChange(key));
    }

    /**
     * The effective mode of one session: the session override when one exists,
     * otherwise the shared resolution (persisted override -> profile default).
     * Every per-agent capability decision reads this.
     */
    effectiveModeFor(session: AlignmentSessionLike): EffectiveMode {
        const sessionOverride = this.sessionModeStore.getOverride(session);
        if (sessionOverride !== undefined) return { mode: sessionOverride, source: 'session' };
        const snap = this.modeStore.getSnapshot();
        return { mode: snap.effectiveMode, source: snap.effectiveSource };
    }

    /**
     * Resolve one session id to its live agent (the management API's session
     * handle; the floating manager only addresses currently-selected sessions,
     * which are always live). `undefined` when the session is not live.
     */
    liveAgent(sessionId: SessionId): Agent | undefined {
        const agents = this.ctx.get('agents');
        return agents?.get(sessionId);
    }

    /**
     * The four-layer + folded-baseline picture the floating manager renders.
     * The exact payload contract of `GET /_dsh/requirements-alignment/status`.
     */
    alignmentStatusPayload(agent: Agent): AlignmentStatusPayload {
        const session = agent.session;
        const key = String(agent.id);
        const effective = this.effectiveModeFor(session);
        const shared = this.modeStore.getSnapshot();
        const status = this.stateStore.getStatus(session);
        // v0.4.1 atomicity: while a transition is NOT converged the payload
        // exposes the reconciliation honestly instead of pretending the
        // advertised effective mode is the live capability mode.
        const capability = this.agentCapabilities.get(key);
        const degraded = this.degradedAgents.get(key);
        let reconciliation: AlignmentStatusPayload['session']['reconciliation'] | undefined;
        if (degraded !== undefined) {
            reconciliation = {
                pending: true,
                kind: 'capability-degraded',
                activeCapabilityMode: degraded.previousMode,
                detail: 'capability transition failed: ' + errorMessage(degraded.primaryError)
                    + (degraded.rollbackError !== undefined ? '; re-registering the previous mode also failed: ' + errorMessage(degraded.rollbackError) : '')
            };
        } else {
            const pending = effective.source === 'session'
                ? this.pendingSourceCompensation.get(key)
                : this.pendingSourceCompensation.get(SHARED_MODE_KEY);
            if (pending !== undefined) {
                reconciliation = {
                    pending: true,
                    kind: 'source-compensation',
                    activeCapabilityMode: capability?.mode,
                    detail: 'the mode source could not be reverted after a failed transition (' + errorMessage(pending.error) + '); pending reconciliation'
                };
            } else if (capability !== undefined && capability.mode !== effective.mode) {
                // Defensive honesty: never advertise a mode the runtime does
                // not implement. This branch must be unreachable in practice.
                reconciliation = {
                    pending: true,
                    kind: 'capability-degraded',
                    activeCapabilityMode: capability.mode,
                    detail: 'the advertised effective mode diverges from the active capability mode'
                };
            }
        }
        return {
            ok: true,
            session: {
                id: String(session.id),
                effectiveMode: effective.mode,
                effectiveSource: effective.source,
                sessionOverride: this.sessionModeStore.getOverride(session) ?? null,
                sharedOverride: shared.overrideMode ?? null,
                profileDefault: shared.defaultMode,
                ...(reconciliation === undefined ? {} : { reconciliation })
            },
            baseline: {
                revision: status.revision,
                status: status.status,
                driftCount: status.driftCount,
                manualChecks: status.manualChecks
            }
        };
    }

    /**
     * Awaited plugin startup hook (Cordis `Service.init`): opens both sidecar
     * domains (durable records land in memory before any session can exist)
     * and adopts every session as it starts — importing legacy timelines,
     * pinning fork inheritance, and registering the agent's alignment
     * capabilities per its effective mode. Runs in every mode (including off),
     * so switching modes never loses state. Mounts the management API for the
     * floating Web manager when a web server is present.
     */
    async [Service.init](): Promise<void> {
        await this.stateStore.open();
        await this.sessionModeStore.open();
        // The management API (/_dsh/requirements-alignment) powers the
        // shell.overlay capsule in the Web client. Optional service: profiles
        // without a web server (headless) never mount it.
        this.ctx.inject(['webServer'], (webCtx) => {
            if (webCtx.webServer === undefined) return () => {};
            const api = createManagementApi(this);
            return api.register(webCtx.webServer);
        });
        // Register the agent's capabilities at `agent/created` (BEFORE
        // `agent/session-start`): the agent is fully configured and its scoped
        // context is live, and `agent/session-start` observers (the dogfood
        // driver) can then read the already-registered capabilities regardless
        // of listener dispatch order.
        this.ctx.on('agent/created', (payload: { agent: Agent }) => {
            this.syncAgent(payload.agent);
        });
        // `agent/session-start` adopts the durable sidecars: pin fork
        // inheritance (alignment state AND session-mode override). A
        // fork-inherited session override notifies the SessionModeStore
        // subscription, which re-syncs the child to the inherited mode.
        this.ctx.on('agent/session-start', (payload: { agent: Agent }) => {
            void this.initializeSessionState(payload.agent).catch((error: unknown) => {
                this.ctx.logger?.warn('requirements-alignment: failed to initialize alignment state for a session: %o', error);
            });
        });
        this.ctx.on('agent/disposed', (payload: { agent: Agent }) => {
            // agent.ctx unwinds its registrations on disposal; just drop the
            // bookkeeping (manual disposal of the disposers is idempotent too).
            this.agentCapabilities.delete(String(payload.agent.id));
            this.degradedAgents.delete(String(payload.agent.id));
        });
    }

    /**
     * Adopt one session's durable sidecars: pin fork inheritance (alignment
     * state + session-mode override). The agent's capabilities were already
     * registered at `agent/created`; a fork-inherited override re-syncs them
     * through the SessionModeStore subscription. Idempotent — repeated
     * adoption never duplicates state or capabilities.
     */
    private async initializeSessionState(agent: Agent): Promise<void> {
        await this.sessionModeStore.initializeSession(agent.session);
        await this.stateStore.initializeSession(agent.session);
    }

    /**
     * Align one live agent's registered capabilities with its session's
     * effective mode. A no-op when the mode is unchanged. The transition is
     * transactional:
     *
     *   1. the outgoing registrations are disposed (each disposer is a
     *      synchronous, idempotent scope-table removal that never throws —
     *      proven by the runtime tests);
     *   2. the incoming mode is registered on the agent's own scope;
     *   3. only a successful registration is committed to the Map;
     *   4. a failed registration rolls back by RE-REGISTERING the previous
     *      mode with fresh disposers — the disposed record is never put back
     *      (its disposers already ran, so it would be dead bookkeeping);
     *   5. if the rollback re-registration fails too, the agent fails closed:
     *      the Map records nothing and the degradation is marked explicitly
     *      (pending reconciliation), never silently papered over.
     *
     * Invariant: an `agentCapabilities` entry ALWAYS corresponds to a live
     * capability set.
     */
    private syncAgent(agent: Agent): SyncOutcome {
        const key = String(agent.id);
        const effective = this.effectiveModeFor(agent.session);
        const existing = this.agentCapabilities.get(key);
        if (existing !== undefined && existing.mode === effective.mode) return { kind: 'unchanged' };
        // Teardown the outgoing registrations first. Disposers are
        // synchronous table removals that never throw, so the Map never
        // points at a torn-down record; `agent.ctx` also unwinds everything
        // on agent disposal, and these disposers are idempotent, so the two
        // never fight.
        for (const dispose of existing?.disposers ?? []) dispose();
        let disposers: Array<() => void>;
        try {
            disposers = this.runtime.registerForAgent(agent, effective.mode);
        } catch (primaryError) {
            // The next mode failed AFTER the previous one was torn down.
            if (existing === undefined) {
                // Fresh agent with no previous mode: nothing to restore. The
                // agent simply has no alignment capabilities (fail-closed)
                // and any later trigger retries the registration.
                this.agentCapabilities.delete(key);
                this.degradedAgents.set(key, {
                    targetMode: effective.mode,
                    previousMode: undefined,
                    primaryError: asError(primaryError),
                    rollbackError: undefined,
                    since: Date.now()
                });
                this.ctx.logger?.warn(
                    'requirements-alignment: failed to register capabilities for session %s in mode %s (%s); the session has no alignment capabilities and retries on the next trigger',
                    key,
                    effective.mode,
                    errorMessage(primaryError)
                );
                return { kind: 'degraded', targetMode: effective.mode, previousMode: undefined, error: asError(primaryError) };
            }
            // Roll back by RE-REGISTERING the previous mode. Never put the
            // disposed `existing` record back: its disposers already ran, so
            // it does not describe anything live.
            let rollbackDisposers: Array<() => void>;
            try {
                rollbackDisposers = this.runtime.registerForAgent(agent, existing.mode);
            } catch (rollbackError) {
                this.failLoudDoubleFailure(key, existing.mode, effective.mode, primaryError, rollbackError);
                return { kind: 'degraded', targetMode: effective.mode, previousMode: existing.mode, error: asError(primaryError) };
            }
            this.agentCapabilities.set(key, { mode: existing.mode, disposers: rollbackDisposers });
            this.ctx.logger?.warn(
                'requirements-alignment: failed to register capabilities for session %s in mode %s (%s); re-registered previous mode %s with fresh disposers',
                key,
                effective.mode,
                errorMessage(primaryError),
                existing.mode
            );
            return { kind: 'rolledback', targetMode: effective.mode, activeMode: existing.mode, error: asError(primaryError) };
        }
        // Commit the successful registration (and clear any pending
        // degradation — reconciliation succeeded).
        this.agentCapabilities.set(key, { mode: effective.mode, disposers });
        this.degradedAgents.delete(key);
        return { kind: 'converged', mode: effective.mode };
    }

    /**
     * Fail-loud handling of a capability transition whose next-mode
     * registration AND its previous-mode rollback re-registration both
     * failed. The agent ends with NO live alignment capability: the Map
     * records nothing (a Map entry must always correspond to a live
     * registration), and the double failure is recorded explicitly with both
     * error provenance so recovery is observable. Any later sync trigger
     * retries and, on success, clears the marker.
     */
    private failLoudDoubleFailure(
        key: string,
        previousMode: AlignmentMode,
        targetMode: AlignmentMode,
        primaryError: unknown,
        rollbackError: unknown
    ): void {
        this.agentCapabilities.delete(key);
        this.degradedAgents.set(key, {
            targetMode,
            previousMode,
            primaryError: asError(primaryError),
            rollbackError: asError(rollbackError),
            since: Date.now()
        });
        this.ctx.logger?.error(
            'requirements-alignment: capability transition for session %s from %s to %s failed AND re-registering %s failed too (%s / %s); the session now has NO live alignment capabilities and is pending reconciliation',
            key,
            previousMode,
            targetMode,
            previousMode,
            errorMessage(primaryError),
            errorMessage(rollbackError)
        );
    }

    /**
     * The container-owned reconcile for every agent that has NO session
     * override, plus every fail-closed (degraded) agent. Returns one outcome
     * per affected live agent. The mode mutations call this DIRECTLY (while
     * owning the reconcile exclusively); the shared-layer subscription defers
     * to them via {@link onSharedModeChange}.
     */
    private reconcileSharedAgents(): SyncOutcome[] {
        const agents = this.ctx.get('agents');
        if (agents === undefined) return [];
        // Retry both live registrations AND fail-closed (degraded) agents: a
        // degraded agent has no Map entry, so iterating the Map alone would
        // never reconcile it. Any further shared-layer change is its recovery
        // window.
        const keys = new Set<string>([...this.agentCapabilities.keys(), ...this.degradedAgents.keys()]);
        const outcomes: SyncOutcome[] = [];
        for (const key of keys) {
            const agent = agents.get(key as SessionId);
            if (agent === undefined) continue;
            if (this.sessionModeStore.hasRecord(agent.session)) continue;
            outcomes.push(this.syncAgent(agent));
        }
        return outcomes;
    }

    /** Re-sync exactly one session's agent; no-op when the session is not live. */
    private syncAgentFor(key: string): SyncOutcome {
        const agents = this.ctx.get('agents');
        const agent = agents?.get(key as SessionId);
        if (agent === undefined) return { kind: 'unchanged' };
        return this.syncAgent(agent);
    }

    /**
     * Subscription handler for SHARED-layer changes (a mode mutation's own
     * persist, or an external settings edit). While a mutation owns the
     * reconcile the event is deferred and the mutation drives the sync;
     * otherwise the shared reconcile runs now.
     */
    private onSharedModeChange(): void {
        if (this.exclusiveReconcile > 0) {
            this.deferredSharedReconcile = true;
            return;
        }
        this.reconcileSharedAgents();
    }

    /**
     * Subscription handler for SESSION-override changes (a mutation's own
     * persist, or an external session edit). Deferred while a mutation owns
     * the reconcile, as with {@link onSharedModeChange}.
     */
    private onSessionModeChange(key: string): void {
        if (this.exclusiveReconcile > 0) {
            this.deferredSessionKeys.push(key);
            return;
        }
        this.syncAgentFor(key);
    }

    /** If events were deferred to the owning mutation, apply them now. */
    private flushDeferred(): void {
        if (this.deferredSharedReconcile) {
            this.deferredSharedReconcile = false;
            this.reconcileSharedAgents();
        }
        if (this.deferredSessionKeys.length > 0) {
            const keys = this.deferredSessionKeys;
            this.deferredSessionKeys = [];
            for (const k of keys) this.syncAgentFor(k);
        }
    }

    /** Drop deferred reconcile events without applying them (failed mutation). */
    private discardDeferred(): void {
        this.deferredSharedReconcile = false;
        this.deferredSessionKeys.length = 0;
    }

    /** Enter/exit the exclusive reconcile window owned by a mode mutation. */
    private enterExclusive(): void {
        this.exclusiveReconcile += 1;
    }
    private exitExclusive(): void {
        this.exclusiveReconcile -= 1;
    }

    /** The current topology of the SHARED runtime override layer. */
    private sharedTopology(): OverrideTopology {
        const snap = this.modeStore.getSnapshot();
        return snap.overrideMode === undefined ? { present: false } : { present: true, mode: snap.overrideMode };
    }

    /** The current topology of one session's override layer. */
    private sessionTopology(session: AlignmentSessionLike): OverrideTopology {
        const mode = this.sessionModeStore.getOverride(session);
        return mode === undefined ? { present: false } : { present: true, mode };
    }

    /**
     * Compensate the SHARED source back to its previous topology after a
     * failed capability transition. On write failure the compensation stays
     * pending (explicit, exposed, retried on the next mutation) instead of
     * reverting silently.
     */
    private async compensateSharedSource(previous: OverrideTopology, attempted: OverrideTopology): Promise<void> {
        try {
            if (previous.present && previous.mode !== undefined) {
                await this.modeStore.setOverride(previous.mode);
            } else {
                await this.modeStore.resetOverride();
            }
            this.pendingSourceCompensation.delete(SHARED_MODE_KEY);
        } catch (error) {
            this.pendingSourceCompensation.set(SHARED_MODE_KEY, {
                kind: 'shared',
                previousOverride: previous,
                attemptedOverride: attempted,
                error: asError(error),
                since: Date.now()
            });
            this.ctx.logger?.error(
                'requirements-alignment: failed to compensate the shared mode source after a failed transition (%s); the shared mode is PENDING reconciliation - the next mode change retries it',
                errorMessage(error)
            );
        }
    }

    /**
     * Compensate a SESSION source back to its previous topology after a failed
     * capability transition, with the same pending-on-write-failure semantics
     * as {@link compensateSharedSource}. Presence semantics: an inherited
     * (override-less) session is compensated by CLEARING, never by writing an
     * equal-value override.
     */
    private async compensateSessionSource(session: AlignmentSessionLike, previous: OverrideTopology, attempted: OverrideTopology): Promise<void> {
        const key = String(session.id);
        try {
            if (previous.present && previous.mode !== undefined) {
                await this.sessionModeStore.setOverride(session, previous.mode);
            } else {
                await this.sessionModeStore.clearOverride(session);
            }
            this.pendingSourceCompensation.delete(key);
        } catch (error) {
            this.pendingSourceCompensation.set(key, {
                kind: 'session',
                session,
                previousOverride: previous,
                attemptedOverride: attempted,
                error: asError(error),
                since: Date.now()
            });
            this.ctx.logger?.error(
                'requirements-alignment: failed to compensate the session mode source for session %s after a failed transition (%s); the session override is PENDING reconciliation - the next mode change retries it',
                key,
                errorMessage(error)
            );
        }
    }

    /**
     * Replay every pending source compensation (restore the previous source
     * topology). The restoring write itself notifies, so a successful replay
     * converges the capability side. A replay that fails stays pending; the
     * mutation proceeds regardless (the caller's explicit request is the
     * latest intent and a successful commit clears the stale pending entry).
     */
    private async retryPendingCompensations(): Promise<void> {
        for (const [key, pending] of [...this.pendingSourceCompensation]) {
            try {
                if (pending.kind === 'shared') {
                    if (pending.previousOverride.present && pending.previousOverride.mode !== undefined) {
                        await this.modeStore.setOverride(pending.previousOverride.mode);
                    } else {
                        await this.modeStore.resetOverride();
                    }
                    this.pendingSourceCompensation.delete(key);
                    this.ctx.logger?.warn('requirements-alignment: replayed the pending shared source compensation (restored the previous shared override)');
                } else if (pending.session !== undefined) {
                    if (pending.previousOverride.present && pending.previousOverride.mode !== undefined) {
                        await this.sessionModeStore.setOverride(pending.session, pending.previousOverride.mode);
                    } else {
                        await this.sessionModeStore.clearOverride(pending.session);
                    }
                    this.pendingSourceCompensation.delete(key);
                    this.ctx.logger?.warn('requirements-alignment: replayed the pending session source compensation for session %s', key);
                }
            } catch (error) {
                this.ctx.logger?.error('requirements-alignment: retrying the pending source compensation for %s failed (%s); it stays pending', key, errorMessage(error));
            }
        }
    }

    /** Whether every reconcile outcome is converged. */
    private allConverged(outcomes: SyncOutcome[]): boolean {
        return outcomes.every((outcome) => isConverged(outcome));
    }

    /**
     * The human-readable failure surfaced by a mode mutation that could not
     * reconcile every affected agent: names each failing agent's error and
     * whether the source was reverted or is pending compensation.
     */
    private transactionError(action: string, outcomes: SyncOutcome[], pending: PendingModeCompensation | undefined): Error {
        const parts: string[] = [];
        for (const outcome of outcomes) {
            if (outcome.kind === 'rolledback') {
                parts.push('a capability registration failed (' + errorMessage(outcome.error) + '); the previous mode was re-registered');
            } else if (outcome.kind === 'degraded') {
                parts.push('a capability registration failed (' + errorMessage(outcome.error) + ') AND re-registering the previous mode failed too - the affected session is pending reconciliation');
            }
        }
        let text = 'requirements-alignment: ' + action + ' failed: ' + (parts.length > 0 ? parts.join('; ') : 'capability reconciliation failed');
        if (pending !== undefined) {
            text += '; the mode source could NOT be reverted to its previous value (' + errorMessage(pending.error) + ') and is PENDING reconciliation - the next mode change retries the compensation';
        } else {
            text += '; the mode was reverted to its previous value';
        }
        return new Error(text);
    }

    /**
     * Register `/align-mode` at plugin scope (always available, including Off).
     * The control group is the only plugin-scope alignment contribution in
     * v0.4.0 — everything else is per-agent.
     */
    private registerModeCommand(): void {
        this.ctx.inject(['commands'], (sctx) => {
            // Keep the disposer so the controller's own dispose is explicit;
            // the inject fiber teardown also calls it (idempotent).
            this.modeCommandDisposer = sctx.commands.register({
                name: 'align-mode',
                description: 'Show or change the alignment mode. No argument prints this session\'s four-layer snapshot; auto|manual|off|reset change the shared runtime layer; session [auto|manual|off|reset] change only the current session.',
                input: { hint: '[auto | manual | off | reset | session [auto|manual|off|reset]]' },
                handler: ({ agent, rawInput }) => this.runModeCommand(agent, rawInput)
            });
        });
    }

    /**
     * Run one manual alignment inspection: record the check in the sidecar,
     * report the folded status (with the calling session's effective mode),
     * and hand a fresh alignment check to the agent as a steered user message.
     * Never blocks and never takes over the workflow. A failed manual-check
     * record (e.g. no durable medium) is logged and never prevents the
     * inspection itself from running.
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
        const report = statusText(status, this.effectiveModeFor(session));
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
     * `/align-mode` body: report the calling session's four-layer snapshot,
     * switch the SHARED runtime override (`auto` / `manual` / `off`), `reset`
     * it to the profile default, or operate on the SESSION override only via
     * the `session` sub-command. Always registered, including in Off.
     */
    async runModeCommand(agent: Agent, rawInput: string): Promise<CommandResult> {
        const token = rawInput.trim().toLowerCase();
        if (token === '') {
            return { kind: 'success' as const, text: this.sessionModeSnapshotText(agent) };
        }
        if (token === 'session') {
            return { kind: 'success' as const, text: this.sessionModeSnapshotText(agent) };
        }
        if (token.startsWith('session ')) {
            return this.runSessionModeCommand(agent, token.slice('session '.length).trim());
        }
        if (token === 'reset') {
            try {
                await this.resetMode();
                return { kind: 'success' as const, text: `Reset to the profile default.\n${this.sessionModeSnapshotText(agent)}` };
            } catch (error) {
                return {
                    kind: 'error' as const,
                    text: `Failed to reset alignment mode: ${error instanceof Error ? error.message : String(error)}`
                };
            }
        }
        if (token === 'auto' || token === 'manual' || token === 'off') {
            try {
                await this.setMode(token);
                return {
                    kind: 'success' as const,
                    text: `Switched to ${modeStatusLabel(token)}.\n${this.sessionModeSnapshotText(agent)}`
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
            text: 'Usage: /align-mode [auto | manual | off | reset | session [auto|manual|off|reset]]\n'
                + this.sessionModeSnapshotText(agent)
        };
    }

    /**
     * `/align-mode session` body: report the calling session's four-layer
     * snapshot, set a SESSION-scoped override (`auto` / `manual` / `off`), or
     * `reset` it (the session returns to the shared layers). Only the calling
     * session is affected — other live sessions and the shared runtime
     * override never move. Works from an Off session (`/align-mode` is
     * globally registered).
     */
    async runSessionModeCommand(agent: Agent, arg: string): Promise<CommandResult> {
        const token = arg.trim().toLowerCase();
        if (token === '') {
            return { kind: 'success' as const, text: this.sessionModeSnapshotText(agent) };
        }
        if (token === 'reset') {
            try {
                await this.clearSessionOverride(agent.session);
                return {
                    kind: 'success' as const,
                    text: `Reset the session mode to the shared layers.\n${this.sessionModeSnapshotText(agent)}`
                };
            } catch (error) {
                return {
                    kind: 'error' as const,
                    text: `Failed to reset the session mode: ${error instanceof Error ? error.message : String(error)}`
                };
            }
        }
        if (token === 'auto' || token === 'manual' || token === 'off') {
            try {
                await this.setSessionMode(agent.session, token);
                return {
                    kind: 'success' as const,
                    text: `Session mode switched to ${modeStatusLabel(token)}.\n${this.sessionModeSnapshotText(agent)}`
                };
            } catch (error) {
                return {
                    kind: 'error' as const,
                    text: `Failed to switch the session mode: ${error instanceof Error ? error.message : String(error)}`
                };
            }
        }
        return {
            kind: 'error' as const,
            text: 'Usage: /align-mode session [auto | manual | off | reset]\n'
                + this.sessionModeSnapshotText(agent)
        };
    }

    /**
     * The four-layer snapshot text for one agent's session.
     */
    private sessionModeSnapshotText(agent: Agent): string {
        const text = sessionModeSnapshotText(
            this.effectiveModeFor(agent.session),
            this.sessionModeStore.getOverride(agent.session),
            this.modeStore.getSnapshot()
        );
        // Honest exposure at the command surface too: while a transition is
        // NOT converged the snapshot states it explicitly, and the user is
        // told the ACTUAL active capability mode - never a silent claim that
        // the advertised effective mode is live.
        const key = String(agent.id);
        const degraded = this.degradedAgents.get(key);
        if (degraded !== undefined) {
            return text + '\n(reconciliation pending: capability transition failed and the previous mode could not be re-registered; no alignment capabilities are live for this session)';
        }
        const effective = this.effectiveModeFor(agent.session);
        const pending = effective.source === 'session'
            ? this.pendingSourceCompensation.get(key)
            : this.pendingSourceCompensation.get(SHARED_MODE_KEY);
        if (pending !== undefined) {
            const active = this.agentCapabilities.get(key);
            return text + '\n(reconciliation pending: the mode source could not be reverted; the ACTUAL active capability mode is ' + (active === undefined ? 'none' : active.mode) + ')';
        }
        return text;
    }

    /**
     * Change the SHARED runtime override and make it durable — ONE transaction
     * with the capability layer (v0.4.1 atomicity):
     *
     *   1. replay any pending source compensation (restore the previous source);
     *   2. capture the previous shared topology;
     *   3. persist the target override (a failed persist throws, nothing moves);
     *   4. reconcile every agent without a session override against the target;
     *   5. if EVERY affected agent converges, the commit stands and any stale
     *      pending compensation is cleared;
     *   6. if ANY agent could not converge, the persisted source is compensated
     *      back to its previous topology (never left claiming the target) and
     *      the mutation THROWS — the caller (command / management API) reports
     *      failure, never a fake `switched to <target>`.
     *
     * A compensation write that fails to land is recorded as PENDING (exposed
     * on the status payload, retried on the next mutation) instead of leaving a
     * silent split-brain.
     *
     * @param mode The desired shared mode.
     * @returns The resulting snapshot.
     * @throws On an invalid mode, a failed persistence write, or a failed
     *   capability transition (after compensating the source back).
     */
    async setMode(mode: AlignmentMode): Promise<ModeSnapshot> {
        validateMode(mode);
        this.enterExclusive();
        let persistError: unknown;
        let outcomes: SyncOutcome[] = [];
        let compensated = false;
        try {
            await this.retryPendingCompensations();
            const previous = this.sharedTopology();
            try {
                await this.modeStore.setOverride(mode);
            } catch (error) {
                persistError = error;
            }
            if (persistError === undefined) outcomes = this.reconcileSharedAgents();
            if (persistError === undefined && !this.allConverged(outcomes)) {
                await this.compensateSharedSource(previous, { present: true, mode });
                compensated = true;
            }
        } finally {
            this.exitExclusive();
        }
        if (persistError !== undefined) {
            this.discardDeferred();
            throw persistError;
        }
        if (compensated) {
            this.discardDeferred();
            const pending = this.pendingSourceCompensation.get(SHARED_MODE_KEY);
            throw this.transactionError('mode switch to ' + mode, outcomes, pending);
        }
        this.pendingSourceCompensation.delete(SHARED_MODE_KEY);
        this.flushDeferred();
        return this.modeStore.getSnapshot();
    }

    /**
     * Drop the shared persisted override and return to the profile default —
     * ONE transaction with the capability layer, exactly like {@link setMode}:
     * capture the previous shared topology, persist the reset, reconcile every
     * agent without a session override, and compensate the source back (or
     * record a pending compensation) when an agent could not converge. Throws
     * on failure so the caller never claims the reset succeeded.
     *
     * @returns The resulting snapshot (effective source `profile`).
     * @throws On a failed persistence reset or a failed capability transition
     *   (after compensating the source back).
     */
    async resetMode(): Promise<ModeSnapshot> {
        this.enterExclusive();
        let persistError: unknown;
        let outcomes: SyncOutcome[] = [];
        let compensated = false;
        try {
            await this.retryPendingCompensations();
            const previous = this.sharedTopology();
            try {
                await this.modeStore.resetOverride();
            } catch (error) {
                persistError = error;
            }
            if (persistError === undefined) outcomes = this.reconcileSharedAgents();
            if (persistError === undefined && !this.allConverged(outcomes)) {
                await this.compensateSharedSource(previous, { present: false });
                compensated = true;
            }
        } finally {
            this.exitExclusive();
        }
        if (persistError !== undefined) {
            this.discardDeferred();
            throw persistError;
        }
        if (compensated) {
            this.discardDeferred();
            const pending = this.pendingSourceCompensation.get(SHARED_MODE_KEY);
            throw this.transactionError('resetting the shared mode', outcomes, pending);
        }
        this.pendingSourceCompensation.delete(SHARED_MODE_KEY);
        this.flushDeferred();
        return this.modeStore.getSnapshot();
    }

    /**
     * Set a SESSION-scoped override — ONE transaction with the capability
     * layer, mirroring {@link setMode}: persist the override, reconcile exactly
     * the affected session's agent, and on a failed transition compensate the
     * session source back to its previous topology with presence semantics (an
     * inherited session is compensated by CLEARING, never by an equal-value
     * override). Throws on failure so the command / management API reports it.
     *
     * @param session The session to change (only its agent is affected).
     * @param mode The desired session mode.
     * @throws On an invalid mode, a failed persist, or a failed capability
     *   transition (after compensating the session source back).
     */
    async setSessionMode(session: AlignmentSessionLike, mode: AlignmentMode): Promise<void> {
        validateMode(mode);
        const key = String(session.id);
        this.enterExclusive();
        let persistError: unknown;
        let outcome: SyncOutcome = { kind: 'unchanged' };
        let compensated = false;
        try {
            await this.retryPendingCompensations();
            const previous = this.sessionTopology(session);
            try {
                await this.sessionModeStore.setOverride(session, mode);
            } catch (error) {
                persistError = error;
            }
            if (persistError === undefined) outcome = this.syncAgentFor(key);
            if (persistError === undefined && !isConverged(outcome)) {
                await this.compensateSessionSource(session, previous, { present: true, mode });
                compensated = true;
            }
        } finally {
            this.exitExclusive();
        }
        if (persistError !== undefined) {
            this.discardDeferred();
            throw persistError;
        }
        if (compensated) {
            this.discardDeferred();
            const pending = this.pendingSourceCompensation.get(key);
            throw this.transactionError('mode switch to ' + mode + ' for session ' + key, [outcome], pending);
        }
        this.pendingSourceCompensation.delete(key);
        this.flushDeferred();
    }

    /**
     * Clear a SESSION-scoped override (the session returns to the shared
     * layers) — ONE transaction with the capability layer, like
     * {@link setSessionMode}. Throws on failure (after compensating the
     * session source back), so the command / management API never claims the
     * reset succeeded when the agent could not converge.
     *
     * @param session The session to change.
     * @throws On a failed persist or a failed capability transition (after
     *   compensating the session source back).
     */
    async clearSessionOverride(session: AlignmentSessionLike): Promise<void> {
        const key = String(session.id);
        this.enterExclusive();
        let persistError: unknown;
        let outcome: SyncOutcome = { kind: 'unchanged' };
        let compensated = false;
        try {
            await this.retryPendingCompensations();
            const previous = this.sessionTopology(session);
            try {
                await this.sessionModeStore.clearOverride(session);
            } catch (error) {
                persistError = error;
            }
            if (persistError === undefined) outcome = this.syncAgentFor(key);
            if (persistError === undefined && !isConverged(outcome)) {
                await this.compensateSessionSource(session, previous, { present: false });
                compensated = true;
            }
        } finally {
            this.exitExclusive();
        }
        if (persistError !== undefined) {
            this.discardDeferred();
            throw persistError;
        }
        if (compensated) {
            this.discardDeferred();
            const pending = this.pendingSourceCompensation.get(key);
            throw this.transactionError('resetting the session mode for session ' + key, [outcome], pending);
        }
        this.pendingSourceCompensation.delete(key);
        this.flushDeferred();
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
