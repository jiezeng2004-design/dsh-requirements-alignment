import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionEvents } from '../src/session-events.ts';
import { fakeSession, legacyEvent, makeStore } from './helpers.ts';

test('session history: modern API keeps its receiver and never reads the removed getter', () => {
    const rows = [legacyEvent('alignment/status', {}, 0)];
    const source = {
        rows,
        get events(): never { throw new Error('removed API'); },
        snapshotEvents() { return this.rows; }
    };
    assert.equal(sessionEvents(source), rows);
    rows.push(legacyEvent('alignment/status', {}, 1));
    assert.equal(sessionEvents(source).length, 2);
    assert.equal(sessionEvents({ events: rows }), rows);
    assert.throws(() => sessionEvents({}), /no supported session history API/);
});

test('store: snapshot-only host supports baseline, cold resume and fork inheritance', async () => {
    const store = await makeStore();
    const parent = fakeSession([], { id: 'snapshot-parent' });
    const modern = {
        id: parent.session.id,
        header: parent.session.header,
        get seq() { return parent.session.seq; },
        snapshotEvents: () => parent.events
    };
    await store.initializeSession(modern);
    await store.recordBaseline(modern, { revision: 1, goal: 'preserve direction', updatedAt: 100 });
    assert.equal(store.getStatus(modern).revision, 1);
    const child = fakeSession([], {
        id: 'snapshot-child', parentSession: modern.id, seedLength: 1
    });
    const modernChild = {
        id: child.session.id, header: child.session.header, seq: child.session.seq,
        snapshotEvents: () => child.events
    };
    await store.initializeFork(modernChild);
    assert.equal(store.getStatus(modernChild).revision, 1);
    assert.equal(store.getBaseline(modernChild)?.goal, 'preserve direction');
});
