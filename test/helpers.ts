/**
 * Shared test helpers: an in-memory AlignmentStateStore and a session double
 * with the surface the store needs.
 */
import { Context } from '@deepseek-ai/cordis';
import type { SessionId, SessionHeader } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import { AlignmentStateStore, memoryAlignmentStatePort } from '../src/alignment-state-store.ts';

/** Build an open store over the in-memory (process-durable) port. */
export async function makeStore(): Promise<AlignmentStateStore> {
    const ctx = new Context();
    const store = new AlignmentStateStore(ctx, { port: memoryAlignmentStatePort() });
    await store.open();
    return store;
}

/** Session-double options (header fields the store binds on). */
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
        delete: async (key: string) => records.delete(key),
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
