import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SessionModeStore, memorySessionModePort, entryOnlySessionModePort, type SessionModePort } from '../src/session-mode-store.ts';
import { fakeSession } from './helpers.ts';

async function makeStore(port?: SessionModePort): Promise<SessionModeStore> {
    const ctx = new Context();
    const store = new SessionModeStore(ctx, { port: port ?? memorySessionModePort() });
    await store.open();
    return store;
}

// ── identity binding ─────────────────────────────────────────────────────────

test('session-mode-store: a record from a different lifecycle identity is shadowed (id reuse cannot leak)', async () => {
    const store = await makeStore();
    // Session lifecycle A records manual.
    const a = fakeSession([], { id: 's-1', createdAt: 100, cwd: 'C:\\alpha' });
    await store.setOverride(a.session, 'manual');
    assert.equal(store.getOverride(a.session), 'manual');
    // The SAME id with a different createdAt/cwd is a different lifecycle.
    const stale = fakeSession([], { id: 's-1', createdAt: 200, cwd: 'C:\\beta' });
    assert.equal(store.getOverride(stale.session), undefined, 'stale override must not leak into the reused id');
    assert.equal(store.hasRecord(stale.session), false);
    // A matching identity resolves normally.
    const same = fakeSession([], { id: 's-1', createdAt: 100, cwd: 'C:\\alpha' });
    assert.equal(store.getOverride(same.session), 'manual');
});

test('session-mode-store: cwd participates in the identity binding', async () => {
    const store = await makeStore();
    const noCwd = fakeSession([], { id: 's-cwd', createdAt: 5 });
    await store.setOverride(noCwd.session, 'off');
    assert.equal(store.getOverride(noCwd.session), 'off');
    // Same id/createdAt but WITH a cwd is a different lifecycle.
    const withCwd = fakeSession([], { id: 's-cwd', createdAt: 5, cwd: 'C:\\x' });
    assert.equal(store.getOverride(withCwd.session), undefined);
});

// ── durable-first ────────────────────────────────────────────────────────────

test('session-mode-store: a failed durable put never commits to the in-memory view', async () => {
    const failingPort: SessionModePort = {
        persistable: true,
        loadAll: async () => new Map(),
        put: async () => { throw new Error('medium down'); },
        delete: async () => { throw new Error('medium down'); },
        dispose: async () => void 0
    };
    const store = await makeStore(failingPort);
    const { session } = fakeSession([], { id: 's-fail' });
    await assert.rejects(() => store.setOverride(session, 'manual'), /medium down/);
    assert.equal(store.getOverride(session), undefined, 'no memory commit after a failed write');
    assert.equal(store.hasRecord(session), false);
});

test('session-mode-store: setOverride validates the mode before any write', async () => {
    const store = await makeStore();
    const { session } = fakeSession([], { id: 's-invalid' });
    await assert.rejects(() => store.setOverride(session, 'banana' as never), /must be 'auto', 'manual', or 'off'/);
    assert.equal(store.getOverride(session), undefined);
});

test('session-mode-store: an entry-only port rejects setOverride but clearOverride is a no-op', async () => {
    const store = await makeStore(entryOnlySessionModePort());
    const { session } = fakeSession([], { id: 's-entry' });
    await assert.rejects(() => store.setOverride(session, 'auto'), /no storage-domain service is mounted/);
    assert.equal(store.getOverride(session), undefined);
    // Clearing nothing is harmless on a non-persisting port.
    await store.clearOverride(session);
    assert.equal(store.getOverride(session), undefined);
});

// ── set / clear / subscribe ──────────────────────────────────────────────────

test('session-mode-store: setOverride notifies observers, clearOverride notifies after removal', async () => {
    const store = await makeStore();
    const seen: string[] = [];
    store.subscribe((key) => seen.push(key));
    const { session } = fakeSession([], { id: 's-sub' });

    await store.setOverride(session, 'manual');
    assert.deepEqual(seen, ['s-sub']);
    await store.setOverride(session, 'off'); // overwrite still notifies
    assert.deepEqual(seen, ['s-sub', 's-sub']);

    await store.clearOverride(session);
    assert.deepEqual(seen, ['s-sub', 's-sub', 's-sub']);
    assert.equal(store.getOverride(session), undefined);
});

test('session-mode-store: clearOverride on a session without a record does not notify', async () => {
    const store = await makeStore();
    const seen: string[] = [];
    store.subscribe((key) => seen.push(key));
    const { session } = fakeSession([], { id: 's-none' });
    await store.clearOverride(session);
    assert.deepEqual(seen, []);
});

// ── fork inheritance ─────────────────────────────────────────────────────────

test('session-mode-store: initializeSession copies the parent override into a fork child once', async () => {
    const store = await makeStore();
    const parent = fakeSession([], { id: 'p', createdAt: 10 });
    await store.setOverride(parent.session, 'manual');
    const child = fakeSession([], { id: 'c', createdAt: 20, parentSession: 'p', seedLength: 3 });
    await store.initializeSession(child.session);
    assert.equal(store.getOverride(child.session), 'manual', 'child inherits the parent override');

    // The parent later changes: the child stays independent (one-time copy).
    await store.setOverride(parent.session, 'off');
    assert.equal(store.getOverride(child.session), 'manual', 'child is independent after the copy');
});

test('session-mode-store: initializeSession leaves a fork of an override-less parent without a record', async () => {
    const store = await makeStore();
    const child = fakeSession([], { id: 'c2', createdAt: 20, parentSession: 'p2', seedLength: 2 });
    await store.initializeSession(child.session);
    assert.equal(store.getOverride(child.session), undefined);
    assert.equal(store.hasRecord(child.session), false);
});

test('session-mode-store: initializeSession is idempotent and never overwrites an explicit override', async () => {
    const store = await makeStore();
    const parent = fakeSession([], { id: 'p3', createdAt: 10 });
    await store.setOverride(parent.session, 'manual');
    const child = fakeSession([], { id: 'c3', createdAt: 20, parentSession: 'p3', seedLength: 3 });
    await store.initializeSession(child.session);
    await store.setOverride(child.session, 'off'); // child goes independent
    await store.initializeSession(child.session); // repeated adoption
    assert.equal(store.getOverride(child.session), 'off', 'idempotent adoption keeps the explicit override');
});

// ── persistence across a store re-open (in-memory port is process-durable) ───

test('session-mode-store: a recorded override survives store recreation over the same in-memory port', async () => {
    const port = memorySessionModePort();
    const ctx1 = new Context();
    const store1 = new SessionModeStore(ctx1, { port });
    await store1.open();
    const { session } = fakeSession([], { id: 's-survive', createdAt: 7 });
    await store1.setOverride(session, 'manual');

    // Re-create the store over the SAME port (simulating an in-process reload).
    const ctx2 = new Context();
    const store2 = new SessionModeStore(ctx2, { port });
    await store2.open();
    assert.equal(store2.getOverride(session), 'manual');
});
