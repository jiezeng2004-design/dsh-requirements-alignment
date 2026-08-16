/**
 * dsh-requirements-alignment: a native DeepSeek Harness plugin that acts as a
 * runtime requirement drift guard.
 *
 * While an agent executes, the plugin keeps a durable requirement baseline
 * per session (goal, explicit constraints, must-preserve behavior, allowed
 * scope, settled user decisions) folded from dedicated `alignment/*` session
 * events. Auto mode (default) contributes a policy section to every agent's
 * system prompt that teaches silent drift detection and the re-alignment
 * protocol, plus two model-facing tools: `establish_baseline` (silent
 * baseline recording) and `report_drift` (drift candidate + user decision).
 * Manual mode contributes no section; the `/align` command steers a compact
 * fresh-alignment inspection into the agent. Both modes record durable
 * per-session state that survives resume, fork, and compaction (pure folds
 * over the log — no live mirror).
 *
 * The plugin is a plain Cordis service: every registration is an effect
 * disposer owned by this fiber, so unloading the plugin (or disabling the
 * row) restores the previous behavior.
 *
 * @module dsh-requirements-alignment
 */
import { Service } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { registerEstablishBaseline, registerReportDrift } from './baseline-tool.ts';
import {
    MANUAL_CHECK_MESSAGE,
    POLICY_ORDER,
    POLICY_SECTION,
    autoPolicyText
} from './policy.ts';
import { appendManualCheck, foldAlignmentStatus } from './status.ts';
import type { AlignmentStatus, AlignmentStatusValue } from './types.ts';

/** Alignment operation mode. */
export type AlignmentMode = 'auto' | 'manual' | 'off';

/** Legal mode names used by the configuration schema and load validation. YAML stays `mode: auto|manual|off`. */
export const ALIGNMENT_MODES = ['auto', 'manual', 'off'] as const;

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

/** The assembly context this plugin reads. */
type AlignmentAssemblyContext = AssembleContext & { agent?: Agent };

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

/**
 * The alignment controller: policy section (auto), /align command, and the
 * two model-facing tools (auto + manual). Provides the `requirementsAlignment`
 * service.
 */
export class RequirementsAlignmentController extends Service {
    static inject = ['systemPrompt', 'tools'];
    /** Native Config schema (enum `mode`) for Cordis load validation. */
    static Config = ConfigSchema;

    /** Validated deployment-owned config. */
    readonly config: ResolvedConfig;

    constructor(ctx: import('@deepseek-ai/cordis').Context, config: Config = {}) {
        super(ctx, 'requirementsAlignment');
        this.config = resolveConfig(config);
        if (this.config.mode === 'off') return;

        if (this.config.mode === 'auto') {
            ctx.systemPrompt.section({
                name: POLICY_SECTION,
                order: POLICY_ORDER,
                text: (context: AlignmentAssemblyContext) => {
                    const agent = context.agent;
                    if (agent === undefined) return '';
                    return autoPolicyText(this.config.section, foldAlignmentStatus(agent.session.events));
                }
            });
        }

        // The tools are inert unless the model calls them; registering them in
        // manual mode lets the /align steered check drive the same protocol.
        registerEstablishBaseline(ctx);
        registerReportDrift(ctx);

        ctx.inject(['commands'], (commandCtx) => {
            const definition: CommandDefinition = {
                name: 'align',
                description: 'Check whether the current execution still matches the requirement baseline',
                handler: ({ agent, rawInput }) => this.runManualAlignment(agent, rawInput)
            };
            commandCtx.commands.register(definition);
        });
    }

    /**
     * Run one manual alignment inspection: record the check, report the folded
     * status, and hand a fresh alignment check to the agent as a steered user
     * message. Never blocks and never takes over the workflow.
     *
     * @param agent The receiving agent.
     * @param _rawInput Unused (bare command); reserved for future arguments.
     * @returns The command result rendered by the dispatching UI.
     */
    runManualAlignment(agent: Agent, _rawInput: string) {
        const status = foldAlignmentStatus(agent.session.events);
        const session: Session = agent.session;
        try {
            appendManualCheck(session);
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
}

export default RequirementsAlignmentController;
