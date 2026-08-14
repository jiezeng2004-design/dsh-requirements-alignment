/**
 * Log folding for Requirements Alignment: derives the durable alignment
 * status of a session from its event log, so resume, fork, and compaction
 * recover the same state without a live mirror.
 *
 * @module dsh-requirements-alignment/status
 */
import type { Session } from '@deepseek-ai/dsh-session';
import {
    ASK_USER_QUESTION_TOOL,
    type AlignmentStatus,
    type AlignmentStatusEvent,
    type SessionEvent
} from './types.ts';

/**
 * Fold one session log into its alignment status. A `tool/call` naming the
 * ask-user tool counts as one question round; the last `alignment/status`
 * manual-check event wins for `lastManualCheckAt`.
 *
 * @param events The session log or any prefix of it.
 * @returns The folded status; a log with neither marker is all-zero.
 */
export function foldAlignmentStatus(events: readonly SessionEvent[]): AlignmentStatus {
    let questionRounds = 0;
    let lastManualCheckAt: number | undefined;
    for (const event of events) {
        if (event.type === 'tool/call' && event.data.name === ASK_USER_QUESTION_TOOL) {
            questionRounds++;
        } else if (event.type === 'alignment/status' && event.data.kind === 'manual-check') {
            lastManualCheckAt = event.data.at;
        }
    }
    return {
        questionRounds,
        ...(lastManualCheckAt === undefined ? {} : { lastManualCheckAt })
    };
}

/**
 * Append one manual-check snapshot to a session log. The narrow receiver type
 * keeps this usable with the real `Session` and with test doubles.
 *
 * @param session The session (or double) to append to.
 * @param at Epoch milliseconds of the check; defaults to now.
 */
export function appendManualCheck(session: {
    append(type: 'alignment/status', data: AlignmentStatusEvent): unknown;
}, at: number = Date.now()): void {
    session.append('alignment/status', { kind: 'manual-check', at });
}

export type { Session, AlignmentStatus, AlignmentStatusEvent };
