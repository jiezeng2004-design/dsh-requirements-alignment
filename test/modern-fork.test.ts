import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeSession, legacyEvent, makeStore } from './helpers.ts';

test('modern fork uses immutable inherited count rather than the growing child log', async () => {
    const store = await makeStore();
    const parent = fakeSession([], { id: 'modern-parent' });
    await store.recordBaseline(parent.session, { revision: 1, goal: 'original', updatedAt: 1 });
    for (let i = 0; i < 10; i++) parent.push(legacyEvent('tool/call', {}, i));
    await store.recordBaseline(parent.session, { revision: 2, goal: 'later', updatedAt: 2 });
    const child = fakeSession(parent.events, {
        id: 'modern-child', parentSession: 'modern-parent', seedLength: 10
    });
    // Modern property wins even if a compatibility wrapper retains an old header.
    const modern = { ...child.session, inheritedEventCount: 1 };
    await store.initializeFork(modern);
    assert.equal(store.getStatus(modern).baseline?.goal, 'original');
    const empty = { ...child.session, id: 'empty' as typeof child.session.id,
        header: { ...child.session.header, id: 'empty' as typeof child.session.id }, inheritedEventCount: 0 };
    await store.initializeFork(empty);
    assert.equal(store.getStatus(empty).revision, 0);
});
