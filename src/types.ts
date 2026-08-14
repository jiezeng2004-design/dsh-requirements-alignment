/**
 * Pure types of the requirements-alignment domain: the durable session event
 * this plugin appends, the folded alignment status view, and the one
 * model-facing tool whose calls count as alignment question rounds.
 * Free of host-side value imports, so host consumers and tests share it.
 *
 * @module dsh-requirements-alignment/types
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';

/**
 * The model-facing tool whose calls this plugin counts as one alignment
 * question round. The shipped `@deepseek-ai/dsh-tool-ask-user` registers this
 * exact name; a deployment that renames the tool changes this constant.
 */
export const ASK_USER_QUESTION_TOOL = 'ask_user_question';

/** One durable alignment snapshot appended by this plugin. */
export interface AlignmentStatusEvent {
    /** What triggered the snapshot. */
    kind: 'manual-check';
    /** Epoch milliseconds when the snapshot was taken. */
    at: number;
}

declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /**
         * A manual `/align` request was executed for this session. Log-only,
         * never model surface; folded with `tool/call` records of
         * `ask_user_question` into the session's alignment status.
         */
        'alignment/status': AlignmentStatusEvent;
    }
}

/** Folded alignment view of one session log (seed history included). */
export interface AlignmentStatus {
    /** `ask_user_question` tool calls in the whole log, seed included. */
    questionRounds: number;
    /** Epoch ms of the last manual `/align` check, when any. */
    lastManualCheckAt?: number;
}

export type { SessionEvent };
