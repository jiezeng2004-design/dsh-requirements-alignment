/**
 * AlignmentStateStore: the canonical, durable Requirements Alignment state.
 *
 * Architecture (the persistence-compatibility fix):
 *
 *   DSH Session log                 — official DSH events ONLY; this plugin
 *                                     never appends `alignment/*` events again.
 *   AlignmentStateStore sidecar     — whole-state checkpoints
 *                                     `{ visibleThroughSeq, state }` per
 *                                     session, stored in the official
 *                                     `ctx.storageDomain` KV domain, keyed by
 *                                     session id with lifecycle identity
 *                                     binding (id + createdAt + cwd).
 *
 * Durability contract (durable-first):
 *
 *   validate -> durable write (port.put) -> memory commit -> return success.
 *   A failed durable write leaves the in-memory view untouched and surfaces
 *   to the caller — the live view can never diverge from the medium.
 *
 * Historical fork:
 *
 *   Every mutation appends one whole-state checkpoint bound to the session
 *   log length at commit time. `stateAt(boundary)` — used for fork
 *   inheritance at the official `header.seedLength - 1` boundary — returns
 *   the last checkpoint with `visibleThroughSeq <= boundary`, so forking a
 *   parent at an OLD completed-turn boundary inherits the state that was in
 *   force then, never the parent's latest.
 *
 * Session identity:
 *
 *   A stored record is only honored when its identity (id + createdAt + cwd
 *   from the creating session's header) matches the live session's header, so
 *   a deleted session whose id is later reused can never leak stale
 *   alignment state into the new session.
 *
 * Legacy compatibility:
 *
 *   The legacy fold functions stay the compatibility layer. Sessions whose
 *   log still carries legacy `alignment/*` events are folded into the
 *   checkpoint timeline on first adoption (`importLegacyTimeline`) —
 *   idempotently, one checkpoint per legacy mutation, so historical forks of
 *   migrated sessions resolve exactly like the fold would.
 *
 * @module dsh-requirements-alignment/alignment-state-store
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId, SessionHeader } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import {
    defineDomain,
    domainTable,
    type Domain,
    type DomainFacility
} from '@deepseek-ai/dsh-storage-domain';
import { z, type ZodType } from 'zod';
import {
    EMPTY_ALIGNMENT_STATE,
    applyBaseline,
    applyDecision,
    applyDrift,
    applyManualCheck,
    foldLegacyTimeline,
    latestState,
    snapshotToStatus,
    stateAt,
    type AlignmentCheckpoint,
    type AlignmentStateSnapshot
} from './alignment-state.ts';
import {
    LEGACY_ALIGNMENT_EVENT_TYPES,
    type AlignmentDecisionKind,
    type AlignmentStatus,
    type DriftReason,
    type RequirementBaseline
} from './types.ts';

/** The identity binding of one sidecar record (the session lifecycle it belongs to). */
export interface AlignmentSessionIdentity {
    /** The session id. */
    id: string;
    /** The session's `createdAt` from its header (0 when the header is absent). */
    createdAt: number;
    /** The session's `cwd` from its header, when any. */
    cwd?: string;
}

/** Fork lineage recorded on a child record (official header lineage). */
export interface AlignmentInheritedFrom {
    /** The parent session id (`header.parentSession`). */
    parentSession: string;
    /** The inclusive parent seq the child inherited through (`header.seedLength - 1`). */
    boundarySeq: number;
    /** The official inherited prefix length (`header.seedLength`). */
    seedLength: number;
}

/** One durable sidecar record: identity + whole-state checkpoint timeline. */
export interface AlignmentSessionRecord {
    /** Sidecar schema version (this build writes 1). */
    schemaVersion: 1;
    /** The session lifecycle this state belongs to. */
    identity: AlignmentSessionIdentity;
    /** Ascending whole-state checkpoints. */
    checkpoints: AlignmentCheckpoint[];
    /** Fork lineage, when this session was forked from another. */
    inheritedFrom?: AlignmentInheritedFrom;
    /** Legacy timeline import marker ('v0.1'/'v0.2'), when imported. */
    migratedFrom?: 'v0.1' | 'v0.2';
    /** Epoch ms of the legacy timeline import. */
    migratedAt?: number;
}

/** The session surface the store needs (a real `Session` or a test double). */
export interface AlignmentSessionLike {
    readonly id: SessionId;
    readonly header?: SessionHeader;
    readonly events: readonly SessionEvent[];
    readonly seq: number;
}

/** Minimal diagnostic sink (Cordis Logger is compatible). */
export interface AlignmentStateLogger {
    warn(message?: string, ...optionalParams: unknown[]): void;
}

// ── durable sidecar domain (official @deepseek-ai/dsh-storage-domain) ────────
//
// The record schemas are deliberately permissive (passthrough on nested
// payloads) so stored legacy-shaped data always survives the durable
// round-trip; the zod-inferred types are wider than the precise interfaces
// below, so the schemas are cast to `ZodType<...>` at the domain boundary —
// runtime validation is unchanged.

const requirementBaselineSchema = z.object({
    revision: z.number(),
    updatedAt: z.number()
}).passthrough();

const alignmentStateSnapshotSchema = z.object({
    baseline: requirementBaselineSchema.optional(),
    lastBaselineOrder: z.number(),
    driftCount: z.number(),
    lastDrift: z.object({
        driftSeq: z.number(),
        reason: z.string(),
        description: z.string(),
        requiredChange: z.string().optional(),
        at: z.number()
    }).passthrough().optional(),
    lastDecision: z.object({
        driftSeq: z.number(),
        decision: z.string(),
        note: z.string().optional(),
        at: z.number()
    }).passthrough().optional(),
    lastDecisionOrder: z.number(),
    manualChecks: z.number(),
    lastManualCheckAt: z.number().optional()
});

const alignmentSessionRecordSchema = z.object({
    schemaVersion: z.literal(1),
    identity: z.object({
        id: z.string(),
        createdAt: z.number(),
        cwd: z.string().optional()
    }),
    checkpoints: z.array(z.object({
        visibleThroughSeq: z.number(),
        state: alignmentStateSnapshotSchema
    })),
    inheritedFrom: z.object({
        parentSession: z.string(),
        boundarySeq: z.number(),
        seedLength: z.number()
    }).optional(),
    migratedFrom: z.union([z.literal('v0.1'), z.literal('v0.2')]).optional(),
    migratedAt: z.number().optional()
});

/**
 * The storage-domain spec owning the alignment sidecar. Name follows
 * `UNIT_NAME_RE` (lowercase start, then `[a-z0-9_]`). One table keyed by
 * session id; every record is validated by the zod schema at open and at the
 * durable write boundary.
 */
export const ALIGNMENT_STATE_DOMAIN = defineDomain({
    name: 'requirements_alignment',
    version: 1,
    tables: {
        sessions: domainTable<SessionId, AlignmentSessionRecord>(
            alignmentSessionRecordSchema as unknown as ZodType<AlignmentSessionRecord>
        )
    }
});

/** The durable medium abstraction of the store (domain-backed or in-memory). */
export interface AlignmentStatePort {
    /** Whether writes reach a durable medium (false = entry-only). */
    readonly persistable: boolean;
    /** Load every stored record. */
    loadAll(): Promise<ReadonlyMap<string, AlignmentSessionRecord>>;
    /** Durably upsert one record; resolves only after durability. */
    put(key: string, record: AlignmentSessionRecord): Promise<void>;
    /** Release port-owned resources; idempotent. */
    dispose(): Promise<void>;
}

/**
 * In-memory port: durable within one process (survives store recreation,
 * which is what unit tests and in-process reloads need), lost on process
 * exit. The explicit test/dev port.
 */
export function memoryAlignmentStatePort(): AlignmentStatePort {
    const records = new Map<string, AlignmentSessionRecord>();
    return {
        persistable: true,
        loadAll: async () => new Map(records),
        put: async (key, record) => {
            records.set(key, record);
        },
        dispose: async () => void 0
    };
}

/**
 * Entry-only port: reads always yield nothing and writes throw loudly. Used
 * when no storage-domain service is (or will be) mounted — a mis-composition
 * must surface as a clear persistence error, never as silent live-only state
 * (the durable-first contract).
 */
export function entryOnlyAlignmentStatePort(): AlignmentStatePort {
    return {
        persistable: false,
        loadAll: async () => new Map(),
        put: async () => {
            throw new Error(
                'requirements-alignment: cannot persist alignment state: no storage-domain service is mounted '
                + '(compose @deepseek-ai/dsh-storage, @deepseek-ai/dsh-storage-json and '
                + '@deepseek-ai/dsh-storage-domain into the profile)'
            );
        },
        dispose: async () => void 0
    };
}

/**
 * Open the official storage-domain sidecar and wrap it as a port. The domain
 * layer itself is durable-first (backend write resolves before its in-memory
 * state mutates), which is exactly the write ordering the store requires.
 */
export async function createDomainAlignmentStatePort(ctx: Context, facility: DomainFacility): Promise<AlignmentStatePort> {
    const domain: Domain<typeof ALIGNMENT_STATE_DOMAIN> = await facility.open(ALIGNMENT_STATE_DOMAIN);
    const table = domain.table('sessions');
    return {
        persistable: true,
        loadAll: async () => {
            const map = new Map<string, AlignmentSessionRecord>();
            for (const [key, value] of table.entries()) map.set(key, value);
            return map;
        },
        put: async (key, record) => {
            await table.put(key as SessionId, record);
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

/** The session's current log length, from the official `seq` when present. */
function sessionSeq(session: AlignmentSessionLike): number {
    return typeof session.seq === 'number' ? session.seq : session.events.length;
}

/** Build the identity binding from a session header (absent fields default). */
function identityFromHeader(header: SessionHeader | undefined): AlignmentSessionIdentity {
    return {
        id: String(header?.id ?? ''),
        createdAt: header?.createdAt ?? 0,
        ...(header?.cwd === undefined ? {} : { cwd: header.cwd })
    };
}

/** Whether a stored identity belongs to the live session's lifecycle. */
function identityMatches(identity: AlignmentSessionIdentity, header: SessionHeader | undefined): boolean {
    if (identity.id !== String(header?.id ?? '')) return false;
    if (identity.createdAt !== (header?.createdAt ?? 0)) return false;
    return identity.cwd === header?.cwd;
}

/** Whether the log carries any legacy alignment event this plugin owns. */
function hasLegacyAlignmentEvent(events: readonly SessionEvent[]): boolean {
    return events.some((event) => LEGACY_ALIGNMENT_EVENT_TYPES.has(event.type));
}

/** Which legacy vocabulary a log uses ('v0.1' wins on overlap), or undefined. */
function legacyVersionOf(events: readonly SessionEvent[]): 'v0.1' | 'v0.2' | undefined {
    if (events.some((event) => event.type === 'alignment/status')) return 'v0.1';
    if (events.some((event) => LEGACY_ALIGNMENT_EVENT_TYPES.has(event.type))) return 'v0.2';
    return undefined;
}

/** Store options. */
export interface AlignmentStateStoreOptions {
    /** Explicit port (tests). Defaults to entry-only + storage-domain attach. */
    port?: AlignmentStatePort;
    /** Diagnostic sink. */
    logger?: AlignmentStateLogger;
}

/**
 * The canonical alignment state authority: per-session in-memory view,
 * durable-first mutations, fork inheritance, legacy import. Reads are
 * synchronous from the in-memory view (hot paths never touch the medium);
 * every write goes validate -> durable put -> memory commit.
 */
export class AlignmentStateStore {
    private readonly ctx: Context;
    private port: AlignmentStatePort;
    private readonly logger: AlignmentStateLogger | undefined;
    private openPromise: Promise<void> | undefined;
    private disposed = false;
    /** Authoritative in-memory view: session id -> sidecar record. */
    private readonly records = new Map<string, AlignmentSessionRecord>();
    /**
     * Derived public status per session (the sync read path), bound to the
     * lifecycle identity (id + createdAt + cwd) that produced it, so a session
     * id reused by a different lifecycle can never hit a stale cached status.
     * A cache entry is only a hit when its identity matches the live session's
     * header under the same rule the record lookup uses (`identityMatches`).
     */
    private readonly statusCache = new Map<string, { identity: AlignmentSessionIdentity; status: AlignmentStatus }>();
    /** Per-session write chains: mutations of one session never interleave. */
    private readonly writeChains = new Map<string, Promise<unknown>>();
    private readonly disposeEffect: () => void;

    constructor(ctx: Context, options: AlignmentStateStoreOptions = {}) {
        this.ctx = ctx;
        this.logger = options.logger;
        this.port = options.port ?? entryOnlyAlignmentStatePort();
        // Close the sidecar domain with the plugin fiber.
        this.disposeEffect = ctx.effect(() => () => {
            this.disposed = true;
            for (const chain of this.writeChains.values()) void chain.catch(() => { });
            this.writeChains.clear();
            this.statusCache.clear();
            this.records.clear();
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
     * Open the store: when `ctx.storageDomain` is already mounted (the
     * shipped web profile), open the sidecar domain and load every record
     * before resolving; otherwise stay entry-only and attach via `ctx.inject`
     * the moment the service appears. Idempotent. Called from the plugin's
     * awaited `[Service.init]`, so by the time any session exists the durable
     * view is loaded.
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
        // holds (an explicit in-memory port, or nothing for entry-only), then
        // upgrade the moment the official service appears.
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
        this.statusCache.clear();
    }

    /** Swap in the durable port once the domain opens; errors degrade loudly. */
    private async attachDomain(facility: DomainFacility): Promise<void> {
        if (this.disposed) return;
        try {
            const durable = await createDomainAlignmentStatePort(this.ctx, facility);
            if (this.disposed) {
                await durable.dispose().catch(() => { });
                return;
            }
            this.port = durable;
            await this.loadFromPort();
        } catch (error) {
            this.logger?.warn(
                'requirements-alignment: failed to open the storage-domain sidecar; alignment state is not durable: %o',
                error
            );
        }
    }

    // ── reads (synchronous, authoritative in-memory view) ────────────────────

    /**
     * The folded alignment status of one session. Synchronous: reads the
     * in-memory view; resolves sidecar records, fork lineage, and legacy
     * folds without touching the medium.
     */
    getStatus(session: AlignmentSessionLike): AlignmentStatus {
        const key = sessionKey(session);
        const cached = this.statusCache.get(key);
        // The cache is bound to the lifecycle identity that produced it: a
        // cached status only counts as a hit when it belongs to the SAME
        // `{ id, createdAt, cwd }` lifecycle as the live session. A different
        // identity — a stale session id reused by a new lifecycle — must
        // miss and re-derive from the record / lineage / fold paths.
        if (cached !== undefined && identityMatches(cached.identity, session.header)) return cached.status;
        const identity = identityFromHeader(session.header);
        const status = snapshotToStatus(this.currentSnapshot(key, session));
        this.statusCache.set(key, { identity, status });
        return status;
    }

    /** The baseline in force for one session, when any. */
    getBaseline(session: AlignmentSessionLike): RequirementBaseline | undefined {
        return this.currentSnapshot(sessionKey(session), session).baseline;
    }

    /**
     * The alignment status in force at a historical log boundary (e.g. a
     * fork's `seedLength - 1`). The historical-fork verification surface.
     */
    getStatusAtBoundary(session: AlignmentSessionLike, boundary: number): AlignmentStatus {
        const record = this.lookupRecord(sessionKey(session), session);
        if (record !== undefined) return snapshotToStatus(stateAt(record.checkpoints, boundary));
        const derived = this.derivedBaseRecord(session);
        if (derived !== undefined) return snapshotToStatus(stateAt(derived.checkpoints, boundary));
        return snapshotToStatus(EMPTY_ALIGNMENT_STATE);
    }

    // ── mutations (durable-first) ────────────────────────────────────────────

    /** Record (or replace) the whole-value baseline at the current log length. */
    async recordBaseline(session: AlignmentSessionLike, baseline: RequirementBaseline): Promise<void> {
        await this.mutate(session, (_current, _at, order) => applyBaseline(_current, baseline, order));
    }

    /**
     * Record one drift candidate at the current log length and return its
     * pairing key (the checkpoint's `visibleThroughSeq`), which the later
     * decision must reference.
     */
    async recordDrift(
        session: AlignmentSessionLike,
        data: { reason: DriftReason; description: string; requiredChange?: string; at: number }
    ): Promise<{ driftSeq: number }> {
        const driftSeq = await this.mutate(session, (current, at) => applyDrift(current, data, at));
        return { driftSeq };
    }

    /** Record one user decision on a drift candidate at the current log length. */
    async recordDecision(
        session: AlignmentSessionLike,
        data: { driftSeq: number; decision: AlignmentDecisionKind; note?: string; at: number }
    ): Promise<void> {
        await this.mutate(session, (current, _at, order) => applyDecision(current, data, order));
    }

    /** Record one manual `/align` inspection at the current log length. */
    async recordManualCheck(session: AlignmentSessionLike, at: number = Date.now()): Promise<void> {
        await this.mutate(session, (current) => applyManualCheck(current, at));
    }

    // ── adoption / migration ─────────────────────────────────────────────────

    /**
     * Adopt one session into the store: materialize the sidecar record for
     * fork children (pin the inherited state at the official `seedLength - 1`
     * boundary) and for legacy sessions (import the folded timeline).
     * Idempotent — a session with a record is left untouched, so repeated
     * adoption never duplicates state or doubles counters. Fresh new-style
     * sessions create no record until their first mutation.
     */
    async initializeSession(session: AlignmentSessionLike): Promise<void> {
        await this.enqueue(sessionKey(session), async () => {
            if (this.records.has(sessionKey(session))) return;
            const derived = this.derivedBaseRecord(session);
            if (derived === undefined) return;
            await this.port.put(sessionKey(session), derived);
            this.records.set(sessionKey(session), derived);
            this.statusCache.delete(sessionKey(session));
        });
    }

    /** Adopt a fork child specifically (same idempotent path). */
    initializeFork(session: AlignmentSessionLike): Promise<void> {
        return this.initializeSession(session);
    }

    /**
     * Explicitly import a legacy session's alignment timeline into the
     * sidecar (fold -> one checkpoint per legacy mutation). Idempotent.
     */
    async importLegacyTimeline(session: AlignmentSessionLike): Promise<void> {
        await this.enqueue(sessionKey(session), async () => {
            if (this.records.has(sessionKey(session))) return;
            const derived = this.derivedBaseRecord(session);
            if (derived === undefined || derived.checkpoints.length === 0) return;
            await this.port.put(sessionKey(session), derived);
            this.records.set(sessionKey(session), derived);
            this.statusCache.delete(sessionKey(session));
        });
    }

    // ── internals ────────────────────────────────────────────────────────────

    /** Serialize one session's store operations (adoption + mutations). */
    private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
        const previous = this.writeChains.get(key) ?? Promise.resolve();
        const next = previous.then(task, task);
        this.writeChains.set(key, next.catch(() => { }));
        return next;
    }

    /**
     * One durable-first mutation: derive -> durable put -> memory commit.
     * The commit boundary is the session's official log length at mutation
     * time (inside the per-session write chain, so it never races other
     * store operations for the same session); the ORDERING key handed to the
     * transition is a per-session monotonic mutation counter, so two
     * mutations recorded at the same log length still order correctly.
     *
     * @returns the commit boundary (`visibleThroughSeq` of the new checkpoint).
     */
    private async mutate(
        session: AlignmentSessionLike,
        transition: (current: AlignmentStateSnapshot, at: number, order: number) => AlignmentStateSnapshot
    ): Promise<number> {
        const key = sessionKey(session);
        let commitAt = -1;
        await this.enqueue(key, async () => {
            const at = sessionSeq(session);
            commitAt = at;
            const current = this.currentSnapshot(key, session);
            const order = Math.max(current.lastBaselineOrder, current.lastDecisionOrder) + 1;
            const next = transition(current, at, order);
            const base = this.baseRecordFor(key, session);
            const record: AlignmentSessionRecord = {
                ...base,
                identity: identityFromHeader(session.header),
                checkpoints: [...base.checkpoints, { visibleThroughSeq: at, state: next }]
            };
            await this.port.put(key, record); // durable first
            this.records.set(key, record); // memory commit
            this.statusCache.delete(key);
        });
        return commitAt;
    }

    /** The record in force for a session, with identity binding. */
    private lookupRecord(key: string, session: AlignmentSessionLike): AlignmentSessionRecord | undefined {
        const record = this.records.get(key);
        if (record === undefined) return undefined;
        if (identityMatches(record.identity, session.header)) return record;
        // Stale record left by a previous lifecycle reusing this id: shadow it;
        // the next mutation overwrites it with the new session's identity.
        this.records.delete(key);
        this.statusCache.delete(key);
        return undefined;
    }

    /** The current snapshot for a session (record -> lineage -> legacy fold -> empty). */
    private currentSnapshot(key: string, session: AlignmentSessionLike): AlignmentStateSnapshot {
        const record = this.lookupRecord(key, session);
        if (record !== undefined) return latestState(record.checkpoints);
        const derived = this.derivedBaseRecord(session);
        if (derived !== undefined) return latestState(derived.checkpoints);
        return EMPTY_ALIGNMENT_STATE;
    }

    /** The record base for a session: existing record, or derived, or fresh. */
    private baseRecordFor(key: string, session: AlignmentSessionLike): AlignmentSessionRecord {
        const existing = this.lookupRecord(key, session);
        if (existing !== undefined) return existing;
        const derived = this.derivedBaseRecord(session);
        if (derived !== undefined) return derived;
        return {
            schemaVersion: 1,
            identity: identityFromHeader(session.header),
            checkpoints: []
        };
    }

    /**
     * Derive the record that SHOULD exist for a session before any mutation:
     * fork children inherit the parent's state at the official
     * `seedLength - 1` boundary; legacy sessions fold their timeline;
     * fresh new-style sessions have nothing to materialize.
     */
    private derivedBaseRecord(session: AlignmentSessionLike): AlignmentSessionRecord | undefined {
        const header = session.header;
        if (header?.parentSession !== undefined) {
            const boundary = header.seedLength !== undefined
                ? header.seedLength - 1
                : Math.max(0, session.events.length - 1);
            const inherited = this.resolveParentState(String(header.parentSession), boundary, session.events);
            const version = legacyVersionOf(session.events);
            return {
                schemaVersion: 1,
                identity: identityFromHeader(header),
                checkpoints: [{ visibleThroughSeq: 0, state: inherited }],
                ...(header.seedLength === undefined ? {} : {
                    inheritedFrom: {
                        parentSession: String(header.parentSession),
                        boundarySeq: boundary,
                        seedLength: header.seedLength
                    }
                }),
                ...(version === undefined ? {} : { migratedFrom: version, migratedAt: Date.now() })
            };
        }
        if (hasLegacyAlignmentEvent(session.events)) {
            const version = legacyVersionOf(session.events);
            return {
                schemaVersion: 1,
                identity: identityFromHeader(header),
                checkpoints: foldLegacyTimeline(session.events),
                ...(version === undefined ? {} : { migratedFrom: version, migratedAt: Date.now() })
            };
        }
        return undefined;
    }

    /**
     * The parent's alignment state at a boundary: the parent's sidecar record
     * when one exists, otherwise the child's own seed prefix folded through
     * the legacy compatibility layer (a legacy parent — or a parent that was
     * never adopted — has no record, and the child's seed IS the parent's
     * prefix, so the fold is exact).
     */
    private resolveParentState(
        parentId: string,
        boundary: number,
        childEvents: readonly SessionEvent[]
    ): AlignmentStateSnapshot {
        const parentRecord = this.records.get(parentId);
        if (parentRecord !== undefined) {
            return stateAt(parentRecord.checkpoints, boundary);
        }
        return latestState(foldLegacyTimeline(childEvents.slice(0, boundary + 1)));
    }
}

export default AlignmentStateStore;
