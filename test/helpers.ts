/**
 * Shared test helpers for the v0.4.0 per-agent capability model.
 *
 * The alignment capabilities are registered in each agent's OWN scope
 * (`agent.ctx`), so the fakes below MUST be real Cordis Services: cordis only
 * propagates the caller's active context to methods of a service that carries
 * the `tracker` metadata, which a plain `ctx.provide({...})` object does not.
 * These Service subclasses read `scopeOf(this.ctx)` — the calling context's
 * scope — so a registration made through a scoped context (an agent's
 * `agent.ctx`) lands in that agent's layer, exactly like the real
 * system-prompt / tools / commands services.
 */
import { Context, Service } from '@deepseek-ai/cordis';
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope';
import { agentEvents } from '@deepseek-ai/dsh-agent';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId, SessionHeader } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import type { PromptSection, AssembleContext, AssembledSection, PromptAssembly } from '@deepseek-ai/dsh-system-prompt';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { CommandDefinition, CommandDescriptor, CommandExecution, CommandInvocation } from '@deepseek-ai/dsh-commands';
import { AlignmentStateStore, memoryAlignmentStatePort } from '../src/alignment-state-store.ts';
import assert from 'node:assert/strict';

/** One scope's registration table; undefined scope = the global layer. */
function tableFor<V>(map: Map<object, V[]>, scope: object | undefined, fallback: V[]): V[] {
    if (scope === undefined) return fallback;
    let table = map.get(scope);
    if (table === undefined) {
        table = [];
        map.set(scope, table);
    }
    return table;
}

/** A disposer that removes one value from one table. */
function removeFrom<V>(table: V[], value: V): () => void {
    return () => {
        const index = table.indexOf(value);
        if (index >= 0) table.splice(index, 1);
    };
}

/** Fake `systemPrompt` service: registers sections per scope, assembles them per agent. */
export class FakeSystemPrompt extends Service {
    readonly globalSections: PromptSection[] = [];
    readonly scopedSections = new Map<object, PromptSection[]>();
    /** When true, `section()` throws — injects a per-agent registration failure. */
    failSections = false;

    constructor(ctx: Context) {
        super(ctx, 'systemPrompt');
    }

    section(section: PromptSection): () => void {
        if (this.failSections) throw new Error('injected section registration failure');
        const scope = scopeOf(this.ctx);
        const table = tableFor(this.scopedSections, scope, this.globalSections);
        table.push(section);
        return removeFrom(table, section);
    }

    /** Assemble the global sections followed by the scope's scoped shadows. */
    async assemble(context: AssembleContext & { agent?: Agent } = {}): Promise<PromptAssembly> {
        const sections: AssembledSection[] = [];
        const push = (section: PromptSection): void => {
            sections.push({
                name: section.name,
                text: typeof section.text === 'function' ? section.text(context as never) : section.text
            });
        };
        for (const section of this.globalSections) push(section);
        if (context.scope !== undefined) {
            for (const section of this.scopedSections.get(context.scope) ?? []) push(section);
        }
        return { sections, contexts: [], tools: [], variables: {} };
    }

    /** The sections one agent would see (global + its scoped shadows). */
    sectionsFor(agent: Agent): PromptSection[] {
        return [...this.globalSections, ...(this.scopedSections.get(agent) ?? [])];
    }
}

/** Fake `tools` service: registers tools per scope, resolves them per agent, executes them. */
export class FakeTools extends Service {
    readonly globalTools: ToolDefinition[] = [];
    readonly scopedTools = new Map<object, ToolDefinition[]>();
    /** When true, the next `register()` call throws exactly once, then clears — injects a mid-transition tool registration failure without poisoning the rollback. */
    failToolsOnce = false;

    constructor(ctx: Context) {
        super(ctx, 'tools');
    }

    register(definition: ToolDefinition): () => void {
        if (this.failToolsOnce) {
            this.failToolsOnce = false;
            throw new Error('injected tool registration failure');
        }
        const scope = scopeOf(this.ctx);
        const table = tableFor(this.scopedTools, scope, this.globalTools);
        table.push(definition);
        return removeFrom(table, definition);
    }

    /** Resolve one tool for a scope (the agent), falling back to the global layer. */
    get(name: string, scope?: object): ToolDefinition | undefined {
        if (scope !== undefined) {
            const scoped = this.scopedTools.get(scope)?.find((tool) => tool.name === name);
            if (scoped !== undefined) return scoped;
        }
        return this.globalTools.find((tool) => tool.name === name);
    }

    /** The tools one agent would see. */
    toolsFor(agent: Agent): ToolDefinition[] {
        const scoped = this.scopedTools.get(agent) ?? [];
        const global = this.globalTools.filter((tool) => !scoped.some((s) => s.name === tool.name));
        return [...global, ...scoped];
    }

    /** Execute one tool against the calling agent, mirroring the real pipeline surface. */
    async execute(exec: {
        callId: unknown;
        name: string;
        arguments: unknown;
        agent?: Agent;
        signal?: AbortSignal;
    }): Promise<{ isError: boolean; error?: unknown; content: unknown[] }> {
        const definition = this.get(exec.name, exec.agent);
        if (definition === undefined) {
            return { isError: true, error: `unknown tool ${exec.name}`, content: [] };
        }
        const runContext = { agent: exec.agent, signal: exec.signal } as never;
        try {
            const value = await definition.execute?.(exec.arguments, runContext);
            const content = definition.output?.render?.(exec.arguments as never, value as never) ?? [];
            return { isError: false, content };
        } catch (error) {
            return { isError: true, error, content: [] };
        }
    }
}

/** Fake `commands` service: registers commands per scope, resolves them per agent, executes them. */
export class FakeCommands extends Service {
    readonly globalCommands: CommandDefinition[] = [];
    readonly scopedCommands = new Map<object, CommandDefinition[]>();
    /** Every executed command (agent, name, result) for assertions. */
    readonly executions: Array<{ agent: Agent; name: string; result: { kind: string; text?: string } }> = [];
    /** When true, the next `register()` call throws exactly once, then clears — injects a mid-transition command registration failure without poisoning the rollback. */
    failCommandsOnce = false;

    constructor(ctx: Context) {
        super(ctx, 'commands');
    }

    register(definition: CommandDefinition): () => void {
        if (this.failCommandsOnce) {
            this.failCommandsOnce = false;
            throw new Error('injected command registration failure');
        }
        const scope = scopeOf(this.ctx);
        const table = tableFor(this.scopedCommands, scope, this.globalCommands);
        table.push(definition);
        return removeFrom(table, definition);
    }

    /** Resolve one command for an agent (its scoped shadow wins over global). */
    find(agent: Agent, name: string): CommandDefinition | undefined {
        const scoped = this.scopedCommands.get(agent)?.find((command) => command.name === name);
        if (scoped !== undefined) return scoped;
        return this.globalCommands.find((command) => command.name === name);
    }

    /** The commands one agent would see. */
    list(agent: Agent): CommandDescriptor[] {
        const scoped = this.scopedCommands.get(agent) ?? [];
        const all = [...scoped, ...this.globalCommands.filter((c) => !scoped.some((s) => s.name === c.name))];
        return all.map((command) => ({ name: command.name, description: command.description })) as CommandDescriptor[];
    }

    /** Parse and execute a slash command line against an agent (no model dispatch). */
    async execute(agent: Agent, line: string, signal: AbortSignal): Promise<CommandExecution | undefined> {
        const trimmed = line.replace(/^\//, '').trim();
        const match = /^([a-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
        if (match === null) return undefined;
        const name = match[1]!;
        const rawInput = match[2] ?? '';
        const definition = this.find(agent, name);
        if (definition === undefined) return undefined;
        const invocation: CommandInvocation = {
            commandId: `fake-${name}` as never,
            agent,
            rawInput,
            signal,
            attachments: []
        };
        const result = await definition.handler(invocation);
        this.executions.push({ agent, name, result });
        return { commandId: invocation.commandId, result } as CommandExecution;
    }
}

/** A scope minted for one agent: its scoped context plus the exact disposer. */
export function scopedAgentContext(rootCtx: Context, key: object): { ctx: Context; dispose: () => Promise<void> } {
    const scope = createScope(rootCtx, key);
    return { ctx: scope.ctx, dispose: () => scope.dispose() };
}

/** Emit `agent/session-start` through the fused agent dispatcher (scope-carrier correct). */
export function emitSessionStart(ctx: Context, agent: Agent, source: string = 'startup'): void {
    agentEvents(ctx, agent).emit('agent/session-start', { source } as never);
}

/** Emit `agent/created` through the fused agent dispatcher. */
export function emitAgentCreated(ctx: Context, agent: Agent): void {
    agentEvents(ctx, agent).emit('agent/created', { agent } as never);
}

/** Emit `agent/disposed` through the fused agent dispatcher. */
export function emitAgentDisposed(ctx: Context, agent: Agent): void {
    agentEvents(ctx, agent).emit('agent/disposed', { agent } as never);
}

/** A minimal fake live agent with a real session double and a scoped context. */
export function fakeAgent(session: ReturnType<typeof fakeSession>['session'], ctx: Context, extra: Record<string, unknown> = {}): Agent {
    return {
        id: session.id,
        session,
        ctx,
        steer: () => { },
        ...extra
    } as unknown as Agent;
}

// ── reused session / store / settings / storage doubles ──────────────────────

/** Build an open store over the in-memory (process-durable) port. */
export async function makeStore(): Promise<AlignmentStateStore> {
    const ctx = new Context();
    const store = new AlignmentStateStore(ctx, { port: memoryAlignmentStatePort() });
    await store.open();
    return store;
}

/** Session-double options (header fields the stores bind on). */
export interface FakeSessionOptions {
    id?: string;
    createdAt?: number;
    cwd?: string;
    parentSession?: string;
    seedLength?: number;
    header?: Partial<SessionHeader> & Record<string, unknown>;
}

/**
 * A session double with a real header/events/seq surface. `seq` follows the
 * events array, so pushing events simulates log growth exactly like a real
 * append-only session.
 */
export function fakeSession(events: readonly SessionEvent[] = [], options: FakeSessionOptions = {}) {
    const list: SessionEvent[] = [...events];
    const id = (options.id ?? `session-${Math.random().toString(36).slice(2, 10)}`) as SessionId;
    const header: SessionHeader = {
        version: 0,
        id,
        createdAt: options.createdAt ?? 1000,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession as SessionId }),
        ...(options.seedLength === undefined ? {} : { seedLength: options.seedLength }),
        ...(options.header ?? {}),
        delegationDepth: 0
    };
    const session = {
        id,
        header,
        events: list,
        get seq(): number {
            return list.length;
        }
    };
    return { session, events: list, push: (event: SessionEvent) => list.push(event) };
}

/** A minimal legacy alignment event factory (type/data/seq). */
export function legacyEvent(type: string, data: unknown, seq: number): SessionEvent {
    return { seq, time: 1000 + seq, type, data } as unknown as SessionEvent;
}

/**
 * A minimal in-memory storage-domain facility double with the observable
 * surface the store's attach path uses (`open -> domain.table -> entries/put
 * -> close`). The REAL domain (backend-validated, durable-first) is exercised
 * by the persistence regression tests; this double only lets controller tests
 * run the store's attach/load/write path without a filesystem backend.
 */
export function fakeStorageDomain() {
    const records = new Map<string, unknown>();
    let closed = false;
    const table = {
        get: (key: string) => records.get(key),
        entries: () => records.entries(),
        keys: () => records.keys(),
        size: 0,
        put: async (key: string, value: unknown) => {
            if (closed) throw new Error('domain closed');
            records.set(key, value);
        },
        delete: async (key: string) => {
            records.delete(key);
        },
        update: async (key: string, fn: (current: unknown) => unknown) => {
            const next = fn(records.get(key));
            records.set(key, next);
            return next;
        }
    };
    const domain = {
        name: 'requirements_alignment',
        table: () => table,
        close: async () => {
            closed = true;
        }
    };
    return {
        open: async () => domain,
        get: () => undefined,
        closeAll: async () => void 0,
        __records: records,
        /** Simulate a closed/unavailable medium so writes reject. */
        __close: async () => {
            closed = true;
        }
    };
}

/** A minimal live-agent registry double (the surface the controller resync needs). */
export class FakeAgentRegistry extends Service {
    private readonly agents = new Map<string, Agent>();

    constructor(ctx: Context) {
        super(ctx, 'agents');
    }

    register(agent: Agent): void {
        this.agents.set(String(agent.id), agent);
    }

    unregister(id: SessionId): void {
        this.agents.delete(String(id));
    }

    get(id: SessionId): Agent | undefined {
        return this.agents.get(String(id));
    }

    list(): Agent[] {
        return [...this.agents.values()];
    }
}

/** The DSH Settings fake surface this plugin's port uses. */
export interface SettingsFake {
    provider: unknown;
    setFailWrites(value: boolean): void;
    publish(ns: string): void;
    __document: Record<string, unknown>;
    __raw(ns: string): unknown;
}

/** A fake DSH settings provider with the same observable two-layer semantics as the real service. */
export function fakeSettings(ctx: Context, initialDocument: Record<string, unknown> = {}): SettingsFake {
    const document: Record<string, unknown> = { ...initialDocument };
    let failWrites = false;
    interface Registration {
        ns: string;
        base: Record<string, unknown> | undefined;
        watchers: Set<(value: unknown, prev: unknown) => void>;
    }
    const registrations = new Map<string, Registration>();
    const resolvedValues = new Map<string, unknown>();

    function resolve(ns: string, section: unknown): unknown {
        const reg = registrations.get(ns);
        const base = reg?.base ?? {};
        if (section !== undefined && typeof section === 'object' && !Array.isArray(section)) {
            return { ...base, ...(section as Record<string, unknown>) };
        }
        return { ...base };
    }

    function publishRawChange(ns: string): void {
        resolvedValues.set(ns, resolve(ns, document[ns]));
        (ctx as unknown as { emit(name: string, ...args: unknown[]): unknown }).emit('settings/document-updated', ns);
    }
    function notify(ns: string, next: unknown, prev: unknown): void {
        for (const cb of [...(registrations.get(ns)?.watchers ?? [])]) {
            try { cb(next, prev); } catch { /* contained */ }
        }
    }

    const provider = {
        register<T>(ns: string, _schema: unknown, options?: { base?: Partial<T> }): {
            get: () => T;
            watch: (cb: (next: T, prev: T) => void) => () => void;
            update: (patch: object) => Promise<void>;
            replace: (section: object) => Promise<void>;
        } {
            const reg: Registration = {
                ns,
                base: options?.base as Record<string, unknown> | undefined,
                watchers: new Set()
            };
            registrations.set(ns, reg);
            resolvedValues.set(ns, resolve(ns, document[ns]));
            const persist = async (): Promise<void> => {
                if (failWrites) throw new Error('injected settings write failure');
            };
            return {
                get: () => resolvedValues.get(ns) as T,
                watch: (cb) => {
                    reg.watchers.add(cb as unknown as (value: unknown, prev: unknown) => void);
                    return () => reg.watchers.delete(cb as unknown as (value: unknown, prev: unknown) => void);
                },
                update: async (patch: object) => {
                    await persist();
                    const current = (document[ns] ?? {}) as Record<string, unknown>;
                    const next = { ...current, ...(patch as Record<string, unknown>) };
                    const prev = resolvedValues.get(ns);
                    document[ns] = next;
                    resolvedValues.set(ns, resolve(ns, next));
                    publishRawChange(ns);
                    notify(ns, resolvedValues.get(ns), prev);
                },
                replace: async (section: object) => {
                    await persist();
                    const prev = resolvedValues.get(ns);
                    if (section && typeof section === 'object' && Object.keys(section).length === 0) {
                        delete document[ns];
                    } else {
                        document[ns] = { ...(section as Record<string, unknown>) };
                    }
                    resolvedValues.set(ns, resolve(ns, document[ns]));
                    publishRawChange(ns);
                    notify(ns, resolvedValues.get(ns), prev);
                }
            };
        },
        describe(): Array<{ ns: string; user?: unknown }> {
            const out: Array<{ ns: string; user?: unknown }> = [];
            for (const ns of registrations.keys()) {
                const desc: { ns: string; user?: unknown } = { ns };
                if (document[ns] !== undefined) desc.user = document[ns];
                out.push(desc);
            }
            return out;
        }
    };

    return {
        provider,
        setFailWrites: (value: boolean) => { failWrites = value; },
        publish: (ns: string) => publishRawChange(ns),
        __document: document,
        __raw: (ns: string) => document[ns]
    };
}

/** The full controller harness: real Cordis services + fakes for the seams the controller uses. */
export interface ControllerHarness {
    ctx: Context;
    controller: import('../src/index.ts').RequirementsAlignmentController;
    systemPrompt: FakeSystemPrompt;
    tools: FakeTools;
    commands: FakeCommands;
    agents: FakeAgentRegistry;
    settings: SettingsFake;
    storage: ReturnType<typeof fakeStorageDomain>;
    /** Dispose the scope fibers and the root context. */
    dispose(): Promise<void>;
}

/**
 * Mount the controller with the real systemPrompt/tools/commands Service
 * fakes, a persistable settings fake, the storage-domain seam, and a live
 * agent registry. Every alignment capability then registers per-agent, and
 * tests assert per-agent via {@link mountAgent}.
 */
export async function mountController(
    config: Record<string, unknown> = {},
    settingsInitial: Record<string, unknown> = {}
): Promise<ControllerHarness> {
    const ctx = new Context();
    const systemPrompt = new FakeSystemPrompt(ctx);
    const tools = new FakeTools(ctx);
    const commands = new FakeCommands(ctx);
    const agents = new FakeAgentRegistry(ctx);
    const settings = fakeSettings(ctx, settingsInitial);
    ctx.provide('settings', settings.provider);
    const storage = fakeStorageDomain();
    ctx.provide('storageDomain', storage);
    await ctx.plugin((await import('../src/index.ts')).RequirementsAlignmentController, config);
    // The controller registers /align-mode through ctx.inject (a microtask).
    await new Promise((resolve) => setTimeout(resolve, 20));
    const controller = (ctx as unknown as { requirementsAlignment: import('../src/index.ts').RequirementsAlignmentController }).requirementsAlignment;
    return {
        ctx,
        controller,
        systemPrompt,
        tools,
        commands,
        agents,
        settings,
        storage,
        dispose: async () => {
            await (ctx as unknown as { fiber?: { dispose(): Promise<void> } }).fiber?.dispose().catch(() => { });
        }
    };
}

/** One mounted agent: a fake session, its scoped context, and the live Agent handle. */
export interface MountedAgent {
    agent: Agent;
    session: ReturnType<typeof fakeSession>['session'];
    /** The agent's scoped context (where per-agent capabilities land). */
    scope: { ctx: Context; dispose(): Promise<void> };
}

/**
 * Mount one fake live agent into a harness: create the session double, mint
 * the agent's scoped context (the AGENT OBJECT is the scope key, exactly like
 * dsh-agent-loop's `createScope(loopCtx, this)`), register it in the fake
 * agent registry, and emit `agent/session-start` so the controller initializes
 * it and registers its per-agent capabilities.
 */
export async function mountAgent(
    h: ControllerHarness,
    options: FakeSessionOptions = {}
): Promise<MountedAgent> {
    const { session } = fakeSession([], options);
    // The agent object is minted FIRST and doubles as its scope key (the real
    // agent-loop does `createScope(loopCtx, this)` with `this` = the agent).
    const agent = fakeAgent(session, new Context());
    const scope = scopedAgentContext(h.ctx, agent);
    (agent as { ctx: Context }).ctx = scope.ctx;
    h.agents.register(agent);
    // `agent/created` registers the agent's capabilities (the controller syncs
    // there); `agent/session-start` adopts the durable sidecars.
    emitAgentCreated(h.ctx, agent);
    emitSessionStart(h.ctx, agent);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { agent, session, scope };
}

// ------------------------------------------------------------------ v0.4.1
// mode-source / capability atomicity helpers (v0.4.1 P0 round).
// ------------------------------------------------------------------

/**
 * The stable-state invariant: the ADVERTISED effective mode equals the LIVE
 * capability mode for the agent. A failure here means a mode switch silently
 * diverged (split-brain: the source says one mode, the runtime implements
 * another) - exactly the v0.4.1 P0 this round fixes. Also asserts that the
 * agent is NOT degraded (a degraded agent must use assertAgentModeDegraded).
 */
export function assertAgentModeConsistent(h: ControllerHarness, a: MountedAgent): void {
    const key = String(a.agent.id);
    const capability = h.controller.agentCapabilities.get(key);
    assert.ok(capability, 'capability record must exist for ' + key + ' (agent is not degraded)');
    const capabilityMode = capability!.mode;
    const status = h.controller.alignmentStatusPayload(a.agent);
    assert.equal(status.session.effectiveMode, capabilityMode,
        'status.effectiveMode (' + status.session.effectiveMode + ') == active capability mode (' + capabilityMode + ') for ' + key);
    const effective = h.controller.effectiveModeFor(a.session).mode;
    assert.equal(effective, capabilityMode, 'effectiveModeFor (' + effective + ') == active capability mode (' + capabilityMode + ')');
    assert.equal(h.controller.degradedAgents.has(key), false, 'agent ' + key + ' is not degraded');
}

/**
 * A failed-closed agent (capability double-failure): NO capability entry, an
 * explicit degraded marker, and the status payload exposes the degradation.
 * The degradation itself is the honest advertised state - never a claim that
 * the target mode is active.
 */
export function assertAgentModeDegraded(h: ControllerHarness, a: MountedAgent): void {
    const key = String(a.agent.id);
    assert.equal(h.controller.agentCapabilities.has(key), false, 'degraded agent ' + key + ' has no capability entry');
    const degraded = h.controller.degradedAgents.get(key);
    assert.ok(degraded, 'agent ' + key + ' is marked degraded');
    const status = h.controller.alignmentStatusPayload(a.agent);
    assert.equal(status.session.reconciliation !== undefined, true, 'status exposes the degraded state for ' + key);
    if (status.session.reconciliation !== undefined) {
        assert.equal(status.session.reconciliation.pending, true);
        assert.equal(status.session.reconciliation.kind, 'capability-degraded');
        assert.equal(status.session.reconciliation.activeCapabilityMode, degraded!.previousMode,
            'status exposes the actual (previous) active capability mode while degraded');
    }
}

/** Assert the SHARED (runtime-override) source topology - presence + value. */
export function assertSharedTopology(h: ControllerHarness, present: boolean, mode?: 'auto' | 'manual' | 'off'): void {
    const snap = h.controller.modeStore.getSnapshot();
    assert.equal(snap.overrideMode !== undefined, present, 'shared override present=' + present);
    if (present) assert.equal(snap.overrideMode, mode, 'shared override value');
}

/** Assert the SESSION source topology - presence + value (presence semantics). */
export function assertSessionTopology(h: ControllerHarness, a: MountedAgent, present: boolean, mode?: 'auto' | 'manual' | 'off'): void {
    const rec = h.controller.sessionModeStore.getOverride(a.session);
    assert.equal(rec !== undefined, present, 'session override present=' + present);
    if (present) assert.equal(rec, mode, 'session override value');
}

/** Assert a pending source compensation for a scope is present/absent. */
export function assertPendingCompensation(h: ControllerHarness, scopeKey: string, present: boolean): void {
    assert.equal(h.controller.pendingSourceCompensation.has(scopeKey), present,
        'pending source compensation present=' + present + ' for ' + scopeKey);
}
