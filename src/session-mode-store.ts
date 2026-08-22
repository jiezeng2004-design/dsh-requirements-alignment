/**
 * SessionModeStore: the durable, per-session alignment-mode override.
 *
 * v0.4.0 introduces a fourth layer to the runtime mode model:
 *
 *   valid session override  ->  valid persisted runtime override
 *                            ->  valid profile default  ->  auto
 *
 * SessionModeStore owns the FIRST layer: one override per session lifecycle
 * identity (id + createdAt + cwd), persisted to its own storage-domain unit
 * (`requirements_alignment_modes`). A session without a record inherits the
 * shared layers (the ModeStore). ModeStore and SessionModeStore are
 * deliberately split: the shared layer persists through the DSH Settings
 * service, the session layer through the durable sidecar — switching one
 * never touches the other, and resetting the shared override never deletes a
 * session override (the v0.3.0 state-preservation guarantee extends to the
 * new layer).
 *
 * Identity binding (the same rule as AlignmentStateStore): a stored record is
 * only honored when its identity matches the live session's header, so a
 * deleted session whose id is later reused can never leak a stale override
 * into the new session.
 *
 * Durable-first writes (the same contract as AlignmentStateStore):
 * validate -> durable put -> memory commit; a failed durable write leaves the
 * in-memory view untouched and surfaces to the caller.
 *
 * Fork inheritance: a fork child adopts the parent's override (a one-time
 * copy) at session-start, then becomes independently changeable. A parent
 * without a record leaves the child without one (it inherits the shared
 * layers).
 *
 * @module dsh-requirements-alignment/session-mode-store
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId, SessionHeader } from '@deepseek-ai/dsh-session';
import { z, type ZodType } from 'zod';
import {
    defineDomain,
    domainTable,
    type Domain,
    type DomainFacility
} from '@deepseek-ai/dsh-storage-domain';
import type { AlignmentSessionLike } from './alignment-state-store.ts';
import { validateAlignmentMode, type AlignmentMode } from './types.ts';

/** The identity binding of one session-mode record (the session lifecycle it belongs to). */
export interface SessionModeIdentity {
    /** The session id. */
    id: string;
    /** The session's `createdAt` from its header (0 when the header is absent). */
    createdAt: number;
    /** The session's `cwd` from its header, when any. */
    cwd?: string;
}

/** One durable session-mode record: identity + the override mode. */
export interface SessionModeRecord {
    /** Sidecar schema version (this build writes 1). */
    schemaVersion: 1;
    /** The session lifecycle this override belongs to. */
    identity: SessionModeIdentity;
    /** The session-scoped mode override. */
    mode: AlignmentMode;
}

/** Minimal diagnostic sink (Cordis Logger is compatible). */
export interface SessionModeLogger {
    warn(message?: string, ...optionalParams: unknown[]): void;
}

// ── durable sidecar domain (official @deepseek-ai/dsh-storage-domain) ────────
//
// A separate unit from `requirements_alignment` so the session-mode store's
// lifecycle (open/close) never couples to the alignment-state store's.

const sessionModeRecordSchema = z.object({
    schemaVersion: z.literal(1),
    identity: z.object({
        id: z.string(),
        createdAt: z.number(),
        cwd: z.string().optional()
    }),
    mode: z.union([z.literal('auto'), z.literal('manual'), z.literal('off')])
});

/**
 * The storage-domain spec owning the session-mode sidecar. One table keyed by
 * session id; every record is validated by the zod schema at open and at the
 * durable write boundary.
 */
export const SESSION_MODE_DOMAIN = defineDomain({
    name: 'requirements_alignment_modes',
    version: 1,
    tables: {
        sessions: domainTable<SessionId, SessionModeRecord>(
            sessionModeRecordSchema as unknown as ZodType<SessionModeRecord>
        )
    }
});

/** The durable medium abstraction of the store (domain-backed or in-memory). */
export interface SessionModePort {
    /** Whether writes reach a durable medium (false = entry-only). */
    readonly persistable: boolean;
    /** Load every stored record. */
    loadAll(): Promise<ReadonlyMap<string, SessionModeRecord>>;
    /** Durably upsert one record; resolves only after durability. */
    put(key: string, record: SessionModeRecord): Promise<void>;
    /** Durably remove one record; a no-op when absent. */
    delete(key: string): Promise<void>;
    /** Release port-owned resources; idempotent. */
    dispose(): Promise<void>;
}

/** In-memory port: durable within one process, lost on process exit. */
export function memorySessionModePort(): SessionModePort {
    const records = new Map<string, SessionModeRecord>();
    return {
        persistable: true,
        loadAll: async () => new Map(records),
        put: async (key, record) => {
            records.set(key, record);
        },
        delete: async (key) => {
            records.delete(key);
        },
        dispose: async () => void 0
    };
}

/**
 * Entry-only port: reads always yield nothing and writes throw loudly. Used
 * when no storage-domain service is (or will be) mounted — a mis-composition
 * must surface as a clear persistence error, never as silent live-only state.
 */
export function entryOnlySessionModePort(): SessionModePort {
    return {
        persistable: false,
        loadAll: async () => new Map(),
        put: async () => {
            throw new Error(
                'requirements-alignment: cannot persist a session mode override: no storage-domain service is mounted '
                + '(compose @deepseek-ai/dsh-storage, @deepseek-ai/dsh-storage-json and '
                + '@deepseek-ai/dsh-storage-domain into the profile)'
            );
        },
        delete: async () => void 0,
        dispose: async () => void 0
    };
}

/** Open the official storage-domain sidecar and wrap it as a port. */
export async function createDomainSessionModePort(ctx: Context, facility: DomainFacility): Promise<SessionModePort> {
    const domain: Domain<typeof SESSION_MODE_DOMAIN> = await facility.open(SESSION_MODE_DOMAIN);
    const table = domain.table('sessions');
    return {
        persistable: true,
        loadAll: async () => {
            const map = new Map<string, SessionModeRecord>();
            for (const [key, value] of table.entries()) map.set(key, value);
            return map;
        },
        put: async (key, record) => {
            await table.put(key as SessionId, record);
        },
        delete: async (key) => {
            await table.delete(key as SessionId);
        },
        dispose: async () => {
            await domain.close();
        }
    };
}

/** The session's sidecar key (its id string). */
function sessionKey(session: AlignmentSessionLike): string {
    return String(session.id);
}

/** Build the identity binding from a session header (absent fields default). */
function identityFromHeader(header: SessionHeader | undefined): SessionModeIdentity {
    return {
        id: String(header?.id ?? ''),
        createdAt: header?.createdAt ?? 0,
        ...(header?.cwd === undefined ? {} : { cwd: header.cwd })
    };
}

/** Whether a stored identity belongs to the live session's lifecycle. */
function identityMatches(identity: SessionModeIdentity, header: SessionHeader | undefined): boolean {
    if (identity.id !== String(header?.id ?? '')) return false;
    if (identity.createdAt !== (header?.createdAt ?? 0)) return false;
    return identity.cwd === header?.cwd;
}

/** Store options. */
export interface SessionModeStoreOptions {
    /** Explicit port (tests). Defaults to entry-only + storage-domain attach. */
    port?: SessionModePort;
    /** Diagnostic sink. */
    logger?: SessionModeLogger;
}

/**
 * The per-session mode override authority: durable-first writes, fork
 * inheritance, identity binding, and change notification. Reads are
 * synchronous from the in-memory view; every write goes validate -> durable
 * put -> memory commit.
 */
export class SessionModeStore {
    private readonly ctx: Context;
    private port: SessionModePort;
    private readonly logger: SessionModeLogger | undefined;
    private openPromise: Promise<void> | undefined;
    private disposed = false;
    /** Authoritative in-memory view: session id -> override record. */
    private readonly records = new Map<string, SessionModeRecord>();
    /** Change observers (the controller's resync path), keyed by session key. */
    private readonly listeners = new Set<(key: string) => void>();
    /** Per-session write chains: mutations of one session never interleave. */
    private readonly writeChains = new Map<string, Promise<unknown>>();
    private readonly disposeEffect: () => void;

    constructor(ctx: Context, options: SessionModeStoreOptions = {}) {
        this.ctx = ctx;
        this.logger = options.logger;
        this.port = options.port ?? entryOnlySessionModePort();
        // Close the sidecar domain with the plugin fiber.
        this.disposeEffect = ctx.effect(() => () => {
            this.disposed = true;
            for (const chain of this.writeChains.values()) void chain.catch(() => { });
            this.writeChains.clear();
            this.records.clear();
            this.listeners.clear();
            void this.port.dispose().catch(() => { });
        });
    }

    /** Whether writes currently reach a durable medium. */
    get persistable(): boolean {
        return this.port.persistable;
    }

    /** The open/attach completion (resolves when the initial port is settled). */
    get ready(): Promise<void> {
        return this.openPromise ?? Promise.resolve();
    }

    /**
     * Open the store: when `ctx.storageDomain` is already mounted, open the
     * sidecar domain and load every record before resolving; otherwise stay
     * entry-only and attach via `ctx.inject` the moment the service appears.
     * Idempotent. Called from the plugin's awaited `[Service.init]`, so by the
     * time any session exists the durable view is loaded.
     */
    open(): Promise<void> {
        if (this.openPromise === undefined) {
            this.openPromise = this.openCore();
        }
        return this.openPromise;
    }

    private async openCore(): Promise<void> {
        const facility = this.ctx.get('storageDomain');
        if (facility !== undefined) {
            await this.attachDomain(facility);
            return;
        }
        // No domain facility mounted (yet): load whatever the current port
        // holds, then upgrade the moment the official service appears.
        await this.loadFromPort();
        this.ctx.inject(['storageDomain'], (sctx) => {
            void this.attachDomain(sctx.storageDomain);
        });
    }

    /** Load every record from the current port into the in-memory view. */
    private async loadFromPort(): Promise<void> {
        const loaded = await this.port.loadAll();
        this.records.clear();
        for (const [key, record] of loaded) this.records.set(key, record);
    }

    /** Swap in the durable port once the domain opens; errors degrade loudly. */
    private async attachDomain(facility: DomainFacility): Promise<void> {
        if (this.disposed) return;
        try {
            const durable = await createDomainSessionModePort(this.ctx, facility);
            if (this.disposed) {
                await durable.dispose().catch(() => { });
                return;
            }
            this.port = durable;
            await this.loadFromPort();
        } catch (error) {
            this.logger?.warn(
                'requirements-alignment: failed to open the session-mode sidecar; session mode overrides are not durable: %o',
                error
            );
        }
    }

    // ── reads (synchronous, authoritative in-memory view) ────────────────────

    /**
     * The session-scoped mode override in force for one session, when any.
     * Identity-bound: a record from a different lifecycle (a reused session id)
     * is shadowed and never returned.
     */
    getOverride(session: AlignmentSessionLike): AlignmentMode | undefined {
        const record = this.lookupRecord(sessionKey(session), session);
        return record?.mode;
    }

    /** Whether one session carries a session-scoped override record. */
    hasRecord(session: AlignmentSessionLike): boolean {
        return this.lookupRecord(sessionKey(session), session) !== undefined;
    }

    // ── mutations (durable-first) ────────────────────────────────────────────

    /**
     * Persist a session-scoped override. Validated before any write; a port
     * without a durable medium rejects. After the write, observers are notified
     * (the controller resyncs that session's agent).
     */
    async setOverride(session: AlignmentSessionLike, mode: AlignmentMode): Promise<void> {
        validateAlignmentMode(mode);
        const key = sessionKey(session);
        await this.enqueue(key, async () => {
            const record: SessionModeRecord = {
                schemaVersion: 1,
                identity: identityFromHeader(session.header),
                mode
            };
            await this.port.put(key, record); // durable first
            this.records.set(key, record); // memory commit
        });
        this.notify(key);
    }

    /**
     * Remove the session-scoped override; the session returns to the shared
     * layers. A no-op when no record exists. Observers are notified after a
     * successful clear.
     */
    async clearOverride(session: AlignmentSessionLike): Promise<void> {
        const key = sessionKey(session);
        const cleared = await this.enqueue(key, async () => {
            const record = this.lookupRecord(key, session);
            if (record === undefined) return false;
            await this.port.delete(key); // durable first
            this.records.delete(key); // memory commit
            return true;
        });
        if (cleared) this.notify(key);
    }

    // ── adoption / migration ─────────────────────────────────────────────────

    /**
     * Adopt one session into the store: a fork child inherits the parent's
     * override (one-time copy) when the parent has one, and the change
     * notifies observers so the controller can re-sync the child's agent to
     * the inherited mode. Idempotent — a session with a record is left
     * untouched, and a fresh session without a parent record creates nothing
     * (it inherits the shared layers).
     */
    async initializeSession(session: AlignmentSessionLike): Promise<void> {
        const key = sessionKey(session);
        const inherited = await this.enqueue(key, async () => {
            if (this.records.has(key)) return false;
            const derived = this.derivedRecord(session);
            if (derived === undefined) return false;
            await this.port.put(key, derived);
            this.records.set(key, derived);
            return true;
        });
        if (inherited) this.notify(key);
    }

    /** Adopt a fork child specifically (same idempotent path). */
    initializeFork(session: AlignmentSessionLike): Promise<void> {
        return this.initializeSession(session);
    }

    // ── subscription ─────────────────────────────────────────────────────────

    /**
     * Observe session-mode changes (a set or clear committed). The listener
     * receives the session key of the affected session, so the controller can
     * resync exactly that agent. Returns a disposer; no initial callback fires.
     */
    subscribe(listener: (key: string) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    // ── internals ────────────────────────────────────────────────────────────

    /** Serialize one session's store operations (adoption + mutations). */
    private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
        const previous = this.writeChains.get(key) ?? Promise.resolve();
        const next = previous.then(task, task);
        this.writeChains.set(key, next.catch(() => { }));
        return next;
    }

    private notify(key: string): void {
        if (this.disposed) return;
        for (const listener of [...this.listeners]) {
            try {
                listener(key);
            } catch (error) {
                this.logger?.warn('requirements-alignment: session-mode change listener failed: %o', error);
            }
        }
    }

    /** The record in force for a session, with identity binding. */
    private lookupRecord(key: string, session: AlignmentSessionLike): SessionModeRecord | undefined {
        const record = this.records.get(key);
        if (record === undefined) return undefined;
        if (identityMatches(record.identity, session.header)) return record;
        // Stale record left by a previous lifecycle reusing this id: SHADOW it
        // (never honor it for the new lifecycle). The record is kept so a later
        // read by the ORIGINAL lifecycle still resolves; the new lifecycle's
        // next mutation overwrites it with the new identity.
        return undefined;
    }

    /**
     * The record that SHOULD exist for a session before any explicit mutation:
     * a fork child inherits the parent's override; fresh sessions have nothing
     * to materialize.
     */
    private derivedRecord(session: AlignmentSessionLike): SessionModeRecord | undefined {
        const header = session.header;
        if (header?.parentSession === undefined) return undefined;
        const parentRecord = this.records.get(String(header.parentSession));
        if (parentRecord === undefined) return undefined;
        return {
            schemaVersion: 1,
            identity: identityFromHeader(header),
            mode: parentRecord.mode
        };
    }
}

export default SessionModeStore;
