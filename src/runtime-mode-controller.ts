/**
 * AlignmentRuntime: the runtime capability controller for Requirements
 * Alignment. Owns the real registration lifecycle of every DSH contribution
 * the plugin can make, so mode transitions are actual register/dispose
 * operations — never a `config.mode = next` shortcut.
 *
 * Capability groups (the v0.3.0 public matrix):
 *
 *   automatic   = the policy system-prompt section
 *   interactive = `establish_baseline`, `report_drift`, `/align`, `/align-migrate`
 *   control     = `/align-mode` (always registered while the plugin is loaded)
 *
 *   Auto:   automatic = active,  interactive = active,  control = active
 *   Manual: automatic = inactive, interactive = active,  control = active
 *   Off:    automatic = inactive, interactive = inactive, control = active
 *
 * `/align-mode` stays registered in Off so a live switch to Off is not a
 * one-way door: the user can switch back without editing `settings.yaml`.
 *
 * Transitions dispose the outgoing group's registrations and register the
 * incoming group's, idempotently: applying the same mode is a no-op, and a
 * repeated transition sequence never leaves duplicates (registries reject
 * duplicate names loudly — policy section, tool names, command names — so
 * the runtime guarantees exactly-one by construction).
 *
 * Failure safety: `applyMode` is fully synchronous. On a registration
 * failure it disposes any partially-registered capabilities, restores the
 * previous mode's registrations (best effort), and rethrows; if the
 * restoration itself fails the runtime reports `activeMode === null` rather
 * than pretending a half-registered mode is active. The persisted desired
 * mode is only committed by the caller after a successful transition.
 *
 * Ownership: every registration is a Cordis effect on the plugin (or its
 * dependent) fiber — `systemPrompt.section`, `tools.register`, and
 * `commands.register` all return the exact effect disposer and are
 * auto-disposed when the plugin unloads. Disposing one of these disposers
 * manually is idempotent, so the fiber teardown and the runtime never fight.
 * Disposers are task-cancellation-free: a transition only changes what the
 * next discovery/invocation sees, never in-flight tool calls or commands.
 *
 * Canonical alignment state goes through the {@link AlignmentStateStore}
 * sidecar, never session events: the policy section renders the store's
 * per-session status, and the model-facing tools are registered against the
 * store. Baseline/event state is untouched by any transition — switching
 * modes never deletes a baseline, the sidecar, or session events; the store
 * is the same instance across every mode.
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

/** Commands service surface the runtime needs (structural; matches `ctx.commands`). */
export interface CommandServiceLike {
    register(definition: CommandDefinition): () => void;
}

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
    /** The `/align-mode` command body (always registered; owned by the controller). */
    runMode: (agent: Agent, rawInput: string) => CommandResult | Promise<CommandResult>;
}

/**
 * The runtime capability controller: applies an {@link AlignmentMode} to the
 * live registries with full transition semantics.
 */
export class AlignmentRuntime {
    private mode: AlignmentMode | null = null;
    private readonly ctx: Context;
    private readonly section: string | undefined;
    private readonly store: AlignmentStateStore;
    private readonly runManual: (agent: Agent, rawInput: string) => CommandResult | Promise<CommandResult>;
    private readonly runMigrate: (agent: Agent, rawInput: string) => CommandResult | Promise<CommandResult>;
    private readonly runMode: (agent: Agent, rawInput: string) => CommandResult | Promise<CommandResult>;

    /** Non-command registrations (policy + tools), in registration order. */
    private registrations: Array<() => void> = [];
    /** The live interactive command registrations (`/align`, `/align-migrate`). */
    private commandDisposers: Array<() => void> = [];
    /** The always-on `/align-mode` registration. */
    private modeCommandDisposer: (() => void) | undefined;
    /** The commands service, once available. */
    private commandService: CommandServiceLike | undefined;
    /** Whether the current mode wants the interactive commands (auto or manual). */
    private commandWanted = false;

    constructor(ctx: Context, options: AlignmentRuntimeOptions) {
        this.ctx = ctx;
        this.section = options.section;
        this.store = options.store;
        this.runManual = options.runManual;
        this.runMigrate = options.runMigrate;
        this.runMode = options.runMode;
        this.ctx.inject(['commands'], (sctx) => {
            this.commandService = sctx.commands;
            // The inject fiber re-runs when the commands service (re)appears;
            // those re-entries have already disposed the previous fiber's
            // registrations, so drop stale disposer handles and re-sync.
            this.modeCommandDisposer = undefined;
            this.commandDisposers = [];
            this.syncCommands();
        });
    }

    /** The mode whose capabilities are actually registered, or `null` after a failed transition. */
    get activeMode(): AlignmentMode | null {
        return this.mode;
    }

    /**
     * Transition to `mode`. Idempotent for the same mode; disposes the
     * outgoing capabilities and registers the incoming ones. Synchronous, so
     * no observer can see a half-transitioned registry.
     */
    applyMode(mode: AlignmentMode): void {
        if (mode === this.mode) return;
        const previous = this.mode;
        this.disposeAll();
        this.commandWanted = mode !== 'off';
        try {
            this.registerFor(mode);
            this.syncCommands();
            this.mode = mode;
        } catch (error) {
            this.disposeAll();
            // Restore the whole previous state, including the command intent:
            // it must reflect the restored mode, or a failed Off->Auto would
            // leave the commands registered while the active mode is Off —
            // exactly the half-registered state this controller forbids.
            this.commandWanted = previous !== null && previous !== 'off';
            try {
                this.registerFor(previous);
                this.syncCommands();
                this.mode = previous;
            } catch (rollbackError) {
                this.mode = null;
                const aggError = new AggregateError(
                    [error, rollbackError],
                    'requirements-alignment: mode transition failed and the previous mode could not be restored'
                );
                throw aggError;
            }
            throw error;
        }
    }

    private registerFor(mode: AlignmentMode | null): void {
        if (mode === null) return;
        if (mode === 'auto') {
            this.registerPolicy();
            this.registerTools();
        } else if (mode === 'manual') {
            this.registerTools();
        }
        // 'off' registers no automatic or interactive capabilities. `/align-mode`
        // is the control group and stays registered via syncCommands().
    }

    private registerPolicy(): void {
        this.registrations.push(this.ctx.systemPrompt.section({
            name: POLICY_SECTION,
            order: POLICY_ORDER,
            text: (context: AlignmentAssemblyContext) => {
                const agent = context.agent;
                if (agent === undefined) return '';
                // The canonical alignment view: the durable sidecar, never the
                // session-event fold (persistence-compatibility fix).
                return autoPolicyText(this.section, this.store.getStatus(agent.session));
            }
        }));
    }

    private registerTools(): void {
        this.registrations.push(registerEstablishBaseline(this.ctx, this.store));
        this.registrations.push(registerReportDrift(this.ctx, this.store));
    }

    /** Register control + (when wanted) interactive commands. */
    private syncCommands(): void {
        this.syncModeCommand();
        if (!this.commandWanted) return;
        if (this.commandDisposers.length > 0) return;
        const service = this.commandService;
        if (service === undefined) return; // commands service not mounted yet; the inject callback re-syncs
        this.commandDisposers = [
            service.register({
                name: 'align',
                description: 'Check whether the current execution still matches the requirement baseline',
                handler: ({ agent, rawInput }) => this.runManual(agent, rawInput)
            }),
            service.register({
                name: 'align-migrate',
                description: 'Migrate a legacy session artifact: mark the plugin\'s old alignment/* events ignorable so any DSH build can open it (explicit, gated, idempotent)',
                handler: ({ agent, rawInput }) => this.runMigrate(agent, rawInput)
            })
        ];
    }

    /** Register `/align-mode` once; it survives Off so the user can switch back. */
    private syncModeCommand(): void {
        if (this.modeCommandDisposer !== undefined) return;
        const service = this.commandService;
        if (service === undefined) return;
        this.modeCommandDisposer = service.register({
            name: 'align-mode',
            description: 'Show or change the runtime alignment mode (auto, manual, off, or reset to the profile default)',
            input: { hint: 'auto | manual | off | reset' },
            handler: ({ agent, rawInput }) => this.runMode(agent, rawInput)
        });
    }

    /** Dispose automatic + interactive capabilities; `/align-mode` stays. Idempotent. */
    private disposeAll(): void {
        for (const dispose of this.registrations.splice(0)) dispose();
        for (const dispose of this.commandDisposers.splice(0)) dispose();
    }
}

export default AlignmentRuntime;
