import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import { appendManualCheck, foldAlignmentStatus } from '../src/status.ts';

function toolCall(name: string): SessionEvent {
    return {
        seq: 0,
        time: 0,
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'call-1', name, arguments: '{}' }
    } as unknown as SessionEvent;
}

function manualCheck(at: number): SessionEvent {
    return {
        seq: 0,
        time: 0,
        type: 'alignment/status',
        data: { kind: 'manual-check', at }
    } as unknown as SessionEvent;
}

test('status: empty log folds to zero rounds and no manual check', () => {
    assert.deepEqual(foldAlignmentStatus([]), { questionRounds: 0 });
});

test('status: counts ask_user_question tool calls as question rounds', () => {
    const events = [toolCall('ask_user_question'), toolCall('read'), toolCall('ask_user_question')];
    assert.deepEqual(foldAlignmentStatus(events), { questionRounds: 2 });
});

test('status: other tool calls never count', () => {
    assert.deepEqual(foldAlignmentStatus([toolCall('bash'), toolCall('edit')]), { questionRounds: 0 });
});

test('status: last manual check wins', () => {
    const events = [manualCheck(100), manualCheck(200), toolCall('ask_user_question')];
    assert.deepEqual(foldAlignmentStatus(events), { questionRounds: 1, lastManualCheckAt: 200 });
});

test('status: seed history counts (resume/compaction recover state)', () => {
    const seed = [toolCall('ask_user_question')];
    const resumed = [...seed, toolCall('read'), toolCall('ask_user_question')];
    assert.deepEqual(foldAlignmentStatus(resumed), { questionRounds: 2 });
});

test('status: appendManualCheck appends a manual-check event', () => {
    const events: SessionEvent[] = [];
    const session = { append: (type: string, data: unknown) => {
        events.push({ seq: events.length, time: 0, type, data } as unknown as SessionEvent);
        return events[events.length - 1]!;
    } };
    appendManualCheck(session, 1234);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'alignment/status');
    assert.deepEqual(events[0]!.data, { kind: 'manual-check', at: 1234 });
});
