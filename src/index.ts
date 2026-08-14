/**
 * dsh-requirements-alignment: a native DeepSeek Harness plugin that aligns
 * unclear product direction before implementation.
 *
 * Auto mode (default) contributes an always-on alignment policy section to
 * every agent's system prompt and relies on the native `ask_user_question`
 * tool for questions. Manual mode contributes no section; the `/align`
 * command steers a compact check instruction into the agent. Both modes
 * record durable per-session state through `alignment/status` events and
 * fold `ask_user_question` tool calls, which powers the no-repeat guard and
 * the `/align` status report.
 *
 * The plugin is a plain Cordis service: every registration is an effect
 * disposer owned by this fiber, so unloading the plugin (or disabling the
 * row) restores the previous behavior.
 *
 * @module dsh-requirements-alignment
 */
import { Service } from '@deepseek-ai/cordis';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt';
import type { Agent } from '@deepseek-ai/dsh-agent';
import {
    MANUAL_CHECK_MESSAGE,
    POLICY_ORDER,
    POLICY_SECTION,
    autoPolicyText
} from './policy.ts';
import { appendManualCheck, foldAlignmentStatus } from './status.ts';
import type { AlignmentStatus } from './types.ts';

/** Alignment operation mode. */
export type AlignmentMode = 'auto' | 'manual' | 'off';

/** Raw plugin config. */
export interface Config {
    /** `auto` (default) contributes the policy section; `manual` only the /align command; `off` nothing. */
    mode?: AlignmentMode;
    /** Optional deployment-owned policy text replacing the shipped one (auto mode). */
    section?: string;
}

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

/** Human-readable one-line status for the /align command result. */
export function statusText(status: AlignmentStatus): string {
    const rounds = status.questionRounds;
    const manual = status.lastManualCheckAt === undefined
        ? 'no manual check yet'
        : `last manual check at ${new Date(status.lastManualCheckAt).toISOString()}`;
    if (rounds === 0) {
        return `Requirements Alignment status: no question round yet (${manual}). Starting a direction check now.`;
    }
    return `Requirements Alignment status: ${rounds} question round(s) completed (${manual}). Direction was aligned; starting a fresh check in case a new direction-defining decision appeared.`;
}

/**
 * The alignment controller: policy section (auto), /align command, and
 * durable per-session state. Provides the `requirementsAlignment` service.
 */
export class RequirementsAlignmentController extends Service {
    static inject = ['systemPrompt'];

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

        ctx.inject(['commands'], (commandCtx) => {
            const definition: CommandDefinition = {
                name: 'align',
                description: 'Check whether the current task has unresolved product direction and align it',
                handler: ({ agent, rawInput }) => this.runManualAlignment(agent, rawInput)
            };
            commandCtx.commands.register(definition);
        });
    }

    /**
     * Run one manual alignment request: record the check, report the folded
     * status, and hand the actual direction check to the agent as a steered
     * user message. Never blocks and never takes over the workflow.
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
        return { kind: 'success' as const, text: statusText(status) };
    }
}

export default RequirementsAlignmentController;
