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
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands';
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt';
import { MANUAL_CHECK_MESSAGE, POLICY_ORDER, POLICY_SECTION, autoPolicyText } from './policy.ts';
import { AlignmentStateStore } from './alignment-state-store.ts';
import { migrateLegacyArtifact } from './migration.ts';
import { registerEstablishBaseline, registerReportDrift } from './baseline-tool.ts';
import {
    ALIGNMENT_MODES,
    type AlignmentMode,
    type AlignmentStatus,
    type AlignmentStatusValue
} from './types.ts';

/** Alignment operation mode. */
export type { AlignmentMode };
export { ALIGNMENT_MODES };

/** Raw plugin config. */
export interface Config {
    /** `auto` (default) contributes the policy section; `manual` only the /align command and tools; `off` nothing. */
    mode?: AlignmentMode;
    /** Optional deployment-owned policy text replacing the shipped one (auto mode). */
    section?: string;
}

/**
 * DSH/Schemastery Config schema for configuration structure, loading, and
 * validation. `mode` is the enum `auto` / `manual` / `off`. YAML stays
 * `mode: auto|manual|off` (default `auto`). Cordis validates incoming config
 * through this schema's Standard Schema contract before the plugin starts.
 */
export const ConfigSchema = Schema.object({
    mode: Schema.union(ALIGNMENT_MODES)
        .default('auto')
        .description('How alignment runs. Auto contributes the policy section, tools, and /align. Manual keeps tools and /align only. Off registers nothing.'),
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

/** Capitalized mode label shown on `/align` (auto and manual only). */
export function modeStatusLabel(mode: Exclude<AlignmentMode, 'off'>): 'Auto' | 'Manual' {
    return mode === 'auto' ? 'Auto' : 'Manual';
}

/**
 * Human-readable multi-line status report for the `/align` command result.
 * Reports the folded baseline state and the active mode; it never claims to
 * block execution. Mode is taken from the live plugin config, not the fold.
 */
export function statusText(status: AlignmentStatus, mode?: Exclude<AlignmentMode, 'off'>): string {
    const lines = ['Requirements Alignment'];
    if (mode !== undefined) lines.push(`Mode: ${modeStatusLabel(mode)}`);
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

/** The assembly context this plugin reads. */
type AlignmentAssemblyContext = AssembleContext & { agent?: Agent };

/**
 * The alignment controller: policy section (auto), the `/align` and
 * `/align-migrate` commands, and the two model-facing tools (auto + manual).
 * Provides the `requirementsAlignment` service, whose `stateStore` is the
 * canonical alignment state (the durable sidecar) read by the dogfood align
 * driver and by this controller's own `/align` path.
 */
export class RequirementsAlignmentController extends Service {
    static inject = ['systemPrompt', 'tools'];
    /** Native Config schema (enum `mode`) for Cordis load validation. */
    static Config = ConfigSchema;

    /** Validated deployment-owned config. */
    readonly config: ResolvedConfig;
    /** The canonical alignment state store (durable sidecar + in-memory view). */
    readonly stateStore: AlignmentStateStore;

    constructor(ctx: import('@deepseek-ai/cordis').Context, config: Config = {}) {
        super(ctx, 'requirementsAlignment');
        this.config = resolveConfig(config);
        this.stateStore = new AlignmentStateStore(ctx, { logger: this.ctx.logger });
        if (this.config.mode === 'off') return;

        if (this.config.mode === 'auto') {
            ctx.systemPrompt.section({
                name: POLICY_SECTION,
                order: POLICY_ORDER,
                text: (context: AlignmentAssemblyContext) => {
                    const agent = context.agent;
                    if (agent === undefined) return '';
                    // The authoritative in-memory view of the sidecar store —
                    // the hot path never touches the medium.
                    return autoPolicyText(this.config.section, this.stateStore.getStatus(agent.session));
                }
            });
        }

        // The tools are inert unless the model calls them; registering them in
        // manual mode lets the /align steered check drive the same protocol.
        registerEstablishBaseline(ctx, this.stateStore);
        registerReportDrift(ctx, this.stateStore);

        ctx.inject(['commands'], (commandCtx) => {
            const alignDefinition: CommandDefinition = {
                name: 'align',
                description: 'Check whether the current execution still matches the requirement baseline',
                handler: ({ agent, rawInput }) => this.runManualAlignment(agent, rawInput)
            };
            const migrateDefinition: CommandDefinition = {
                name: 'align-migrate',
                description: 'Migrate a legacy session artifact: mark the plugin\'s old alignment/* events ignorable so any DSH build can open it (explicit, gated, idempotent)',
                handler: ({ agent, rawInput }) => this.runMigrate(agent, rawInput)
            };
            commandCtx.commands.register(alignDefinition);
            commandCtx.commands.register(migrateDefinition);
        });
    }

    /**
     * Awaited plugin startup hook (Cordis `Service.init`): opens the
     * alignment sidecar domain (durable records land in memory before any
     * session can exist) and adopts every session as it starts — importing
     * legacy timelines and pinning fork inheritance idempotently.
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
        agent.steer(createUserMessage({
            content: [{ type: 'text', text: MANUAL_CHECK_MESSAGE }],
            source: {
                kind: 'plugin',
                plugin: 'requirements-alignment',
                form: 'notice',
                summary: 'Requirements Alignment check started'
            }
        }));
        const mode = this.config.mode === 'off' ? undefined : this.config.mode;
        return { kind: 'success' as const, text: statusText(status, mode) };
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
