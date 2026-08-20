import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModeStore, entryModeStorePort, type ModeStorePort, type ModeStoreRead } from '../src/mode-store.ts';
import type { AlignmentMode } from '../src/types.ts';

/**
 * In-memory ModeStorePort with the same two-layer semantics as the DSH
 * Settings service: a `base` layer (never stored) plus a `user` layer holding
 * the override; `userHasMode` tracks whether the raw user section currently
 * carries a `mode` field; `watch` fires on any documented mutation. This is
 * the test double for the shipping settings-backed port, so the pure store
 * logic is exercised without a live settings service.
 */
function memoryPort(initialUser: Record<string, unknown> = {}): {
    port: ModeStorePort;
    setUser: (section: Record<string, unknown>) => void;
    userSection: () => Record<string, unknown>;
} {
    let user = { ...initialUser };
    let callback: (() => void) | undefined;
    const port: ModeStorePort = {
        persistable: true,
        read: (): ModeStoreRead => ({
            resolvedMode: 'mode' in user ? (user.mode as unknown) : undefined,
            userHasMode: 'mode' in user
        }),
        writeOverride: async (mode: AlignmentMode) => {
            user = { ...user, mode };
            callback?.();
        },
        clearOverride: async () => {
            user = { ...user };
            delete user.mode;
            callback?.();
        },
        watch: (cb: () => void) => {
            callback = cb;
            return () => {
                if (callback === cb) callback = undefined;
            };
        },
        dispose: () => void 0
    };
    return {
        port,
        setUser: (section: Record<string, unknown>) => {
            user = { ...section };
            callback?.();
        },
        userSection: () => ({ ...user })
    };
}

// --- Case 1: profile=auto, no override -> auto / profile --------------------
test('mode-store: profile auto with no override resolves auto / profile', () => {
    const { port } = memoryPort();
    const store = new ModeStore(port, 'auto');
    const snap = store.getSnapshot();
    assert.equal(snap.defaultMode, 'auto');
    assert.equal(snap.overrideMode, undefined);
    assert.equal(snap.effectiveMode, 'auto');
    assert.equal(snap.effectiveSource, 'profile');
    store.dispose();
});

// --- Case 2: override=manual -> manual / override ---------------------------
test('mode-store: a valid persisted override beats the profile default', () => {
    const { port } = memoryPort({ mode: 'manual' });
    const store = new ModeStore(port, 'auto');
    const snap = store.getSnapshot();
    assert.equal(snap.effectiveMode, 'manual');
    assert.equal(snap.effectiveSource, 'override');
    assert.equal(snap.overrideMode, 'manual');
    store.dispose();
});

// --- Case 3: profile=manual, override=off -> off / override -----------------
test('mode-store: override=off beats profile=manual', () => {
    const { port } = memoryPort({ mode: 'off' });
    const store = new ModeStore(port, 'manual');
    const snap = store.getSnapshot();
    assert.equal(snap.effectiveMode, 'off');
    assert.equal(snap.effectiveSource, 'override');
    store.dispose();
});

// --- Case 4: reset restores the profile default -----------------------------
test('mode-store: resetOverride drops the override and restores the profile default', async () => {
    const { port } = memoryPort({ mode: 'off' });
    const store = new ModeStore(port, 'manual');
    const seen: Array<{ mode: AlignmentMode; source: string }> = [];
    store.subscribe((next) => seen.push({ mode: next.effectiveMode, source: next.effectiveSource }));
    assert.equal(store.getSnapshot().effectiveMode, 'off');
    await store.resetOverride();
    const snap = store.getSnapshot();
    assert.equal(snap.effectiveMode, 'manual');
    assert.equal(snap.effectiveSource, 'profile');
    assert.equal(snap.overrideMode, undefined);
    assert.deepEqual(seen, [{ mode: 'manual', source: 'profile' }]);
    store.dispose();
});

// --- Case 5: no explicit profile mode -> auto -------------------------------
test('mode-store: absent profile mode defaults effective to auto', () => {
    const { port } = memoryPort();
    const store = new ModeStore(port, 'auto');
    assert.equal(store.getSnapshot().effectiveMode, 'auto');
    store.dispose();
});

// --- Case 6: override survives re-init (persistence round-trip) -------------
test('mode-store: the override survives a store re-init (persisted layer)', () => {
    const { port, userSection } = memoryPort();
    const storeA = new ModeStore(port, 'auto');
    void storeA.setOverride('manual');
    // The memory port's writeOverride mutates user synchronously.
    assert.equal(userSection().mode, 'manual');
    storeA.dispose();

    // A freshly-created store over the same underlying layer sees the override.
    const { port: portB } = memoryPort({ mode: userSection().mode as AlignmentMode });
    const storeB = new ModeStore(portB, 'auto');
    assert.equal(storeB.getSnapshot().effectiveMode, 'manual');
    assert.equal(storeB.getSnapshot().effectiveSource, 'override');
    storeB.dispose();
});

// --- Case 7: invalid stored override must not fail startup ------------------
test('mode-store: an invalid stored override does not fail startup; falls back and repairs once', async () => {
    const { port, userSection } = memoryPort({ mode: 'banana' });
    const warnings: unknown[] = [];
    const store = new ModeStore(port, 'auto', { warn: (...args: unknown[]) => warnings.push(args) });
    const snap = store.getSnapshot();
    // Startup neither throws nor reports the junk mode as effective.
    assert.equal(snap.effectiveMode, 'auto');
    assert.equal(snap.effectiveSource, 'profile');
    assert.equal(snap.overrideMode, undefined);
    // The one-shot repair clears the invalid document (idempotent).
    assert.equal(userSection().mode, undefined);
    // A second read does not rewrite anything.
    store.getSnapshot();
    assert.equal(userSection().mode, undefined);
    assert.ok(warnings.length >= 1);
    store.dispose();
});

test('mode-store: a later invalid override is repaired after the first repair settles', async () => {
    const { port, setUser, userSection } = memoryPort({ mode: 'banana' });
    const store = new ModeStore(port, 'auto', { warn: () => { } });
    assert.equal(userSection().mode, undefined);
    // Let the in-flight repair clear the one-shot flag.
    await Promise.resolve();
    await Promise.resolve();
    setUser({ mode: 'potato' });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(userSection().mode, undefined, 'a new invalid override must be repaired too');
    assert.equal(store.getSnapshot().effectiveMode, 'auto');
    store.dispose();
});

// --- Case 8: change subscription fires only on real change ------------------
test('mode-store: subscribe fires with next/previous on change and nothing on same value', async () => {
    const { port, setUser } = memoryPort();
    const store = new ModeStore(port, 'manual');
    const seen: Array<{ next: string; prev: string }> = [];
    store.subscribe((next, previous) => seen.push({ next: next.effectiveMode, prev: previous.effectiveMode }));

    // Change override to off -> notify manual -> off.
    setUser({ mode: 'off' });
    assert.deepEqual(seen, [{ next: 'off', prev: 'manual' }]);

    // Change to the same effective value via an equal override: no notify
    // (off override vs off override are equal resolved snapshots).
    const before = seen.length;
    setUser({ mode: 'off' });
    assert.equal(seen.length, before);
    store.dispose();
});

// --- dispatch helper used by the controller-backed tests --------------------
test('mode-store: setOverride persists a valid mode and rejects an invalid one without writing', async () => {
    const { port, userSection } = memoryPort();
    const store = new ModeStore(port, 'auto');
    await store.setOverride('manual');
    assert.equal(store.getSnapshot().effectiveMode, 'manual');
    assert.equal(userSection().mode, 'manual');

    // Invalid mode: rejected before any write.
    await assert.rejects(async () => {
        await store.setOverride('banana' as AlignmentMode);
    }, /must be 'auto', 'manual', or 'off'/);
    assert.equal(userSection().mode, 'manual');
    store.dispose();
});

// --- Case 9 (headless/no-settings): entry-only port never persists ----------
test('mode-store: entry-only port reports profile mode, is not persistable, and rejects writes', async () => {
    const port = entryModeStorePort('manual');
    const store = new ModeStore(port, 'manual');
    assert.equal(store.getSnapshot().effectiveMode, 'manual');
    assert.equal(store.getSnapshot().effectiveSource, 'profile');
    assert.equal(port.persistable, false);
    await assert.rejects(() => store.setOverride('auto'), /no settings service is mounted/);
    assert.equal(store.getSnapshot().effectiveMode, 'manual');
    store.dispose();
});
