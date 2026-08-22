/**
 * AlignmentRuntime: the per-agent capability registrar for Requirements
 * Alignment. Since v0.4.0, alignment capabilities are registered in each
 * agent's OWN scope (`agent.ctx`), never at plugin scope — the plugin scope
 * only registers the always-on `/align-mode` control command (owned by the
 * controller). This is the v0.3.0 global register/dispose model retired:
 *
 *   v0.3.0: applyMode(mode) registered/unregistered ONE global capability set.
 *   v0.4.0: registerForAgent(agent, mode) returns that agent's scoped
 *           registrations; the controller owns the lifecycle (session-start,
 *           mode-change resync, disposal) and the per-session effective mode.
 *
 * Capability matrix per agent effective mode:
 *
 *   automatic   = the policy system-prompt section
 *   interactive = `establish_baseline`, `report_drift`, `/align`, `/align-migrate`
 *
 *   Auto:   automatic + interactive
 *   Manual: interactive
 *   Off:    (nothing — the agent has no policy section, no alignment tools,
 *           and no `/align`; only the globally-registered `/align-mode`
 *           remains, so the user can switch this session back without editing
 *           settings.yaml)
 *
 * Every registration is made through `agent.ctx`, the agent-scoped Cordis
 * context: its contributions are agent-local, unwind on disposal, and reject
 * registration afterward. A scoped tool/section/command shadows the global
 * layer for that agent only, so two live sessions with different effective
 * modes hold disjoint capability sets with no leakage. `/align-mode` is not
 * here: it is always registered at plugin scope by the controller so it stays
 * usable from an Off session.
 *
 * Failure safety: `registerForAgent` is fully synchronous and returns the
 * exact disposers. If a registration throws mid-way, the partials collected
 * so far are unwound inside `registerForAgent` before the error surfaces —
 * the caller sees either a complete live registration or no registration at
 * all, never a half-registered capability set. The controller then restores
 * the previous mode by RE-REGISTERING it (fresh disposers), never by
 * resurrecting an executed registration.
 *
 * Canonical alignment state goes through the {@link AlignmentStateStore}
 * sidecar, never session events: the policy section renders the store's
 * per-session status, and the model-facing tools are registered against the
 * store. Baseline/event state is untouched by any mode transition — switching
 * modes never deletes a baseline, the sidecar, or session events.
 *
 * @module dsh-requirements-alignment/runtime-mode-controller
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands';
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt';
import { registerEstablishBaseline, registerReportDrift } from './baseline-tool.ts';
import { POLICY_ORDER, POLICY_SECTION, autoPolicyText } from './policy.ts';
import type { AlignmentStateStore } from './alignment-state-store.ts';
import type { AlignmentMode } from './types.ts';

/** The assembly context the policy section reads (bare assemble has no agent). */
export type AlignmentAssemblyContext = AssembleContext & { agent?: Agent };

/** Options for constructing an {@link AlignmentRuntime}. */
export interface AlignmentRuntimeOptions {
    /** Deployment-owned policy text replacing the shipped default (auto mode). */
    section?: string;
    /** The canonical alignment state store (durable sidecar) the runtime reads and registers against. */
    store: AlignmentStateStore;
    /** The `/align` command body (owned by the controller, not the runtime). */
    runManual: (agent: Agent, rawInput: string) => CommandResult | Promise<CommandResult>;
    /** The `/align-migrate` command body (legacy-artifact repair; auto/manual only). */
    runMigrate: (agent: Agent, rawInput: string) => CommandResult | Promise<CommandResult>;
}

/**
 * The per-agent capability registrar: registers one agent's alignment
 * capabilities in that agent's own scope for one effective mode.
 */
export class AlignmentRuntime {
    private readonly section: string | undefined;
    private readonly store: AlignmentStateStore;
    private readonly runManual: (agent: Agent, rawInput: string) => CommandResult | Promise<CommandResult>;
    private readonly runMigrate: (agent: Agent, rawInput: string) => CommandResult | Promise<CommandResult>;

    constructor(_ctx: Context, options: AlignmentRuntimeOptions) {
        this.section = options.section;
        this.store = options.store;
        this.runManual = options.runManual;
        this.runMigrate = options.runMigrate;
    }

    /**
     * Register one agent's capabilities for `mode` in that agent's own scope.
     * Synchronous: returns the exact effect disposers. Callers own the
     * disposal (the controller), and `agent.ctx` also unwinds everything on
     * agent disposal — disposing these disposers manually is idempotent, so
     * the two never fight.
     */
    registerForAgent(agent: Agent, mode: AlignmentMode): Array<() => void> {
        const disposers: Array<() => void> = [];
        try {
            if (mode === 'auto') {
                disposers.push(this.registerPolicy(agent));
                disposers.push(...this.registerTools(agent));
            } else if (mode === 'manual') {
                disposers.push(...this.registerTools(agent));
            }
            // 'off' registers nothing: the agent has no policy, no tools, no
            // /align. `/align-mode` is global (controller-owned) and survives.
            if (mode !== 'off') {
                disposers.push(...this.registerCommands(agent));
            }
            return disposers;
        } catch (error) {
            // A mid-registration failure must never leave a half-registered
            // capability set visible: unwind the partials collected so far
            // (each disposer is a synchronous, idempotent scope-table removal
            // that never throws), then surface the error so the controller can
            // roll the previous mode back. The caller therefore sees either a
            // complete live registration or no registration at all.
            for (const dispose of disposers) dispose();
            throw error;
        }
    }

    private registerPolicy(agent: Agent): () => void {
        const systemPrompt = agent.ctx.get('systemPrompt');
        if (systemPrompt === undefined) return () => void 0;
        return systemPrompt.section({
            name: POLICY_SECTION,
            order: POLICY_ORDER,
            text: (context: AlignmentAssemblyContext) => {
                const caller = context.agent;
                if (caller === undefined) return '';
                // The canonical alignment view: the durable sidecar, never the
                // session-event fold (persistence-compatibility fix).
                return autoPolicyText(this.section, this.store.getStatus(caller.session));
            }
        });
    }

    private registerTools(agent: Agent): Array<() => void> {
        const tools = agent.ctx.get('tools');
        if (tools === undefined) return [];
        return [
            registerEstablishBaseline(agent.ctx, this.store),
            registerReportDrift(agent.ctx, this.store)
        ];
    }

    private registerCommands(agent: Agent): Array<() => void> {
        const commands = agent.ctx.get('commands');
        if (commands === undefined) return [];
        const definitions: CommandDefinition[] = [
            {
                name: 'align',
                description: 'Check whether the current execution still matches the requirement baseline',
                handler: ({ agent: caller, rawInput }) => this.runManual(caller, rawInput)
            },
            {
                name: 'align-migrate',
                description: 'Migrate a legacy session artifact: mark the plugin\'s old alignment/* events ignorable so any DSH build can open it (explicit, gated, idempotent)',
                handler: ({ agent: caller, rawInput }) => this.runMigrate(caller, rawInput)
            }
        ];
        // Register incrementally: a failure mid-way must NOT leave the
        // commands already registered live. Unwind the collected disposers
        // (each is a synchronous, idempotent scope-table removal that never
        // throws) before the error surfaces, so the caller sees either the
        // full command set or none at all — never a half-registered set.
        const disposers: Array<() => void> = [];
        try {
            for (const definition of definitions) {
                disposers.push(commands.register(definition));
            }
            return disposers;
        } catch (error) {
            for (const dispose of disposers) dispose();
            throw error;
        }
    }
}

export default AlignmentRuntime;
