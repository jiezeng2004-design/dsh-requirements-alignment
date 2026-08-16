/**
 * Log folding for Requirements Alignment: derives the durable alignment state
 * of a session from its event log, so resume, fork, and compaction recover
 * the same state without a live mirror. Pure functions only — no service
 * access, no live state.
 *
 * Compatibility: v0.1 sessions carry `alignment/status` manual-check events
 * and arbitrary `tool/call` records (including `ask_user_question`). The fold
 * counts the former as manual checks and ignores the latter entirely, so old
 * logs fold to a safe all-zero-ish state instead of crashing.
 *
 * @module dsh-requirements-alignment/status
 */
import type { Session } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import {
    type AlignmentDecisionKind,
    type AlignmentStatus,
    type AlignmentStatusValue,
    type BaselineEvent,
    type DecisionEvent,
    type DriftEvent,
    type DriftReason,
    type ManualCheckEvent,
    type RequirementBaseline
} from './types.ts';

/** A minimal receiver the append helpers can write to (real Session or test double). */
export interface AlignmentLog {
    append(type: 'alignment/baseline', data: BaselineEvent): SessionEvent<'alignment/baseline'>;
    append(type: 'alignment/baseline-updated', data: BaselineEvent): SessionEvent<'alignment/baseline-updated'>;
    append(type: 'alignment/drift', data: DriftEvent): SessionEvent<'alignment/drift'>;
    append(type: 'alignment/decision', data: DecisionEvent): SessionEvent<'alignment/decision'>;
    append(type: 'alignment/manual-check', data: ManualCheckEvent): SessionEvent<'alignment/manual-check'>;
}

/**
 * Fold the current requirement baseline. The last baseline event wins
 * (whole-value replace, like `plan/mode`); events whose payload is not a
 * baseline-shaped object are ignored defensively.
 *
 * @param events The session log or any prefix of it.
 * @returns The baseline in force, or `undefined` when none is recorded.
 */
export function foldRequirementBaseline(events: readonly SessionEvent[]): RequirementBaseline | undefined {
    let baseline: RequirementBaseline | undefined;
    for (const event of events) {
        if (event.type === 'alignment/baseline' || event.type === 'alignment/baseline-updated') {
            const candidate = event.data.baseline;
            if (typeof candidate === 'object' && candidate !== null && typeof candidate.revision === 'number') {
                baseline = candidate;
            }
        }
    }
    return baseline;
}

/**
 * Fold one session log into its alignment status: baseline, revision, drift
 * events, last drift, last decision, manual checks, and the derived posture.
 * `tool/call` events never participate, so unrelated `ask_user_question`
 * calls (plan mode, other plugins, ordinary agent questions) cannot pollute
 * alignment state.
 *
 * @param events The session log or any prefix of it.
 * @returns The folded status; a log with no alignment events is all-zero.
 */
export function foldAlignmentStatus(events: readonly SessionEvent[]): AlignmentStatus {
    let baseline: RequirementBaseline | undefined;
    let lastBaselineSeq = -1;
    let driftCount = 0;
    let lastDriftSeq = -1;
    let lastDrift: AlignmentStatus['lastDrift'];
    let lastDecisionSeq = -1;
    let lastDecision: AlignmentStatus['lastDecision'];
    let manualChecks = 0;
    let lastManualCheckAt: number | undefined;
    for (const event of events) {
        switch (event.type) {
            case 'alignment/baseline':
            case 'alignment/baseline-updated': {
                const candidate = event.data.baseline;
                if (typeof candidate === 'object' && candidate !== null && typeof candidate.revision === 'number') {
                    baseline = candidate;
                    lastBaselineSeq = event.seq;
                }
                break;
            }
            case 'alignment/drift': {
                driftCount++;
                lastDriftSeq = event.seq;
                lastDrift = {
                    reason: event.data.reason,
                    description: event.data.description,
                    ...(event.data.requiredChange === undefined ? {} : { requiredChange: event.data.requiredChange }),
                    at: event.data.at
                };
                break;
            }
            case 'alignment/decision': {
                lastDecisionSeq = event.seq;
                lastDecision = {
                    driftSeq: event.data.driftSeq,
                    decision: event.data.decision,
                    ...(event.data.note === undefined ? {} : { note: event.data.note }),
                    at: event.data.at
                };
                break;
            }
            case 'alignment/manual-check': {
                manualChecks++;
                lastManualCheckAt = event.data.at;
                break;
            }
            case 'alignment/status': {
                // Legacy v0.1 manual-check snapshots.
                if (event.data.kind === 'manual-check') {
                    manualChecks++;
                    lastManualCheckAt = event.data.at;
                }
                break;
            }
            default:
                break;
        }
    }
    // Pure derivation over the log only — no live mirror, no process state —
    // so resume, fork, and compaction replay the same posture.
    // 1. The last drift has no paired decision -> an open drift.
    const driftPending = lastDriftSeq >= 0 && (lastDecision === undefined || lastDecision.driftSeq !== lastDriftSeq);
    // 2. An approve/revise decision (or custom direction) that no baseline
    //    event has recorded yet -> the new baseline is unwritten.
    const updatePending = lastDecision !== undefined
        && (lastDecision.decision === 'approve' || lastDecision.decision === 'revise')
        && lastDecisionSeq > lastBaselineSeq;
    const status: AlignmentStatusValue = driftPending
        ? 'drift-pending'
        : updatePending
            ? 'baseline-update-pending'
            : baseline === undefined
                ? 'unknown'
                : 'aligned';
    return {
        ...(baseline === undefined ? {} : { baseline }),
        revision: baseline?.revision ?? 0,
        driftCount,
        ...(lastDrift === undefined ? {} : { lastDrift }),
        ...(lastDecision === undefined ? {} : { lastDecision }),
        status,
        manualChecks,
        ...(lastManualCheckAt === undefined ? {} : { lastManualCheckAt })
    };
}

/** Append the initial baseline (revision >= 1). */
export function appendBaseline(session: AlignmentLog, baseline: RequirementBaseline): void {
    session.append('alignment/baseline', { baseline });
}

/** Append a revised baseline (whole-value replace, revision increments). */
export function appendBaselineUpdated(session: AlignmentLog, baseline: RequirementBaseline): void {
    session.append('alignment/baseline-updated', { baseline });
}

/**
 * Append one drift candidate and return the logged event, so the caller can
 * pair the later decision by `event.seq`.
 */
export function appendDrift(session: AlignmentLog, data: DriftEvent): SessionEvent<'alignment/drift'> {
    return session.append('alignment/drift', data);
}

/** Append one user decision on a drift candidate. */
export function appendDecision(session: AlignmentLog, data: DecisionEvent): void {
    session.append('alignment/decision', data);
}

/**
 * Append one manual `/align` inspection.
 *
 * @param session The session (or double) to append to.
 * @param at Epoch milliseconds of the check; defaults to now.
 */
export function appendManualCheck(session: AlignmentLog, at: number = Date.now()): void {
    session.append('alignment/manual-check', { at });
}

export type { Session, AlignmentStatus, AlignmentDecisionKind, DriftReason, RequirementBaseline };
