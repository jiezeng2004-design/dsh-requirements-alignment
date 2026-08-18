/**
 * Pure alignment domain state for Requirements Alignment: the durable
 * per-session snapshot, the whole-state checkpoint timeline that supports
 * historical fork, and the transitions that mirror the legacy fold
 * semantics exactly.
 *
 * This module is deliberately free of host-side value imports (no cordis,
 * no storage, no I/O): the same pure functions drive the legacy fold
 * compatibility layer, the durable sidecar store, and the migration import,
 * so every path derives the same AlignmentStatus.
 *
 * Checkpoint semantics:
 *
 *   { visibleThroughSeq: N, state }  — `state` is the complete alignment
 *   state in force once the session log has reached N events. Because
 *   DSH logs are append-only with contiguous seqs, "fork @ boundary B"
 *   (inclusive last inherited event seq, the official `seedLength - 1`)
 *   resolves to the LAST checkpoint with `visibleThroughSeq <= B`.
 *
 * @module dsh-requirements-alignment/alignment-state
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import {
    type AlignmentDecisionKind,
    type AlignmentStatus,
    type AlignmentStatusValue,
    type DriftReason,
    type RequirementBaseline
} from './types.ts';

/**
 * The durable per-session alignment state — one checkpoint value. Mirrors
 * every field the legacy fold derives, plus the two seq anchors the posture
 * derivation needs (`lastBaselineSeq` / `lastDecisionSeq`).
 */
export interface AlignmentStateSnapshot {
    /** The baseline in force, when any baseline was recorded. */
    baseline?: RequirementBaseline;
    /**
     * The ORDERING key of the checkpoint that recorded the current baseline
     * (`-1` when none). For legacy timelines this is the baseline event's
     * seq (events are ordered by seq); for store mutations it is a
     * per-session monotonic mutation counter. The posture derivation needs it
     * to tell "decision newer than the last baseline"
     * (baseline-update-pending) apart from "decision already recorded by a
     * newer baseline" (aligned) — the log position alone cannot order two
     * mutations recorded at the same log length.
     */
    lastBaselineOrder: number;
    /** Number of drift candidates recorded (whole log). */
    driftCount: number;
    /** The last drift candidate, when any. */
    lastDrift?: {
        /**
         * The visibleThroughSeq of the drift checkpoint — the pairing key the
         * later decision references (the durable successor of the old
         * `alignment/drift` event seq).
         */
        driftSeq: number;
        reason: DriftReason;
        description: string;
        requiredChange?: string;
        at: number;
    };
    /** The last user decision, when any. */
    lastDecision?: {
        driftSeq: number;
        decision: AlignmentDecisionKind;
        note?: string;
        at: number;
    };
    /** The ORDERING key of the checkpoint that recorded the last decision (`-1` when none). */
    lastDecisionOrder: number;
    /** Number of manual `/align` inspections (new and legacy). */
    manualChecks: number;
    /** Epoch ms of the last manual `/align` inspection, when any. */
    lastManualCheckAt?: number;
}

/** The all-zero snapshot: no baseline, no drift, no decision, no checks. */
export const EMPTY_ALIGNMENT_STATE: AlignmentStateSnapshot = {
    lastBaselineOrder: -1,
    driftCount: 0,
    lastDecisionOrder: -1,
    manualChecks: 0
};

/**
 * One whole-state checkpoint. `state` is the full alignment state that
 * became visible when the session log reached `visibleThroughSeq` events.
 */
export interface AlignmentCheckpoint {
    /** Session log length (seq boundary) at which `state` became visible. */
    visibleThroughSeq: number;
    /** The complete alignment state from that boundary on. */
    state: AlignmentStateSnapshot;
}

/** Whether a value looks like a baseline payload the fold would accept. */
function isBaselineLike(value: unknown): value is RequirementBaseline {
    return typeof value === 'object' && value !== null && typeof (value as { revision?: unknown }).revision === 'number';
}

/** Transition: record (or replace) the whole-value baseline with `order` as its ordering key. */
export function applyBaseline(
    state: AlignmentStateSnapshot,
    baseline: RequirementBaseline,
    order: number
): AlignmentStateSnapshot {
    return { ...state, baseline, lastBaselineOrder: order };
}

/** Transition: record one drift candidate at `visibleThroughSeq`. */
export function applyDrift(
    state: AlignmentStateSnapshot,
    data: { reason: DriftReason; description: string; requiredChange?: string; at: number },
    visibleThroughSeq: number
): AlignmentStateSnapshot {
    return {
        ...state,
        driftCount: state.driftCount + 1,
        lastDrift: {
            driftSeq: visibleThroughSeq,
            reason: data.reason,
            description: data.description,
            ...(data.requiredChange === undefined ? {} : { requiredChange: data.requiredChange }),
            at: data.at
        }
    };
}

/** Transition: record one user decision on a drift candidate with `order` as its ordering key. */
export function applyDecision(
    state: AlignmentStateSnapshot,
    data: { driftSeq: number; decision: AlignmentDecisionKind; note?: string; at: number },
    order: number
): AlignmentStateSnapshot {
    return {
        ...state,
        lastDecision: {
            driftSeq: data.driftSeq,
            decision: data.decision,
            ...(data.note === undefined ? {} : { note: data.note }),
            at: data.at
        },
        lastDecisionOrder: order
    };
}

/** Transition: record one manual `/align` inspection. */
export function applyManualCheck(state: AlignmentStateSnapshot, at: number): AlignmentStateSnapshot {
    return {
        ...state,
        manualChecks: state.manualChecks + 1,
        lastManualCheckAt: at
    };
}

/**
 * Derive the alignment posture from a snapshot — the exact rules of the
 * legacy fold, over the durable state:
 *
 * 1. The last drift has no paired decision -> `drift-pending`.
 * 2. An approve/revise decision that no baseline checkpoint has recorded yet
 *    (the decision is NEWER than the last baseline) -> `baseline-update-pending`.
 * 3. Otherwise the baseline decides `aligned` / `unknown`.
 */
export function deriveAlignmentStatus(state: AlignmentStateSnapshot): AlignmentStatusValue {
    const driftPending = state.lastDrift !== undefined
        && (state.lastDecision === undefined || state.lastDecision.driftSeq !== state.lastDrift.driftSeq);
    const updatePending = state.lastDecision !== undefined
        && (state.lastDecision.decision === 'approve' || state.lastDecision.decision === 'revise')
        && state.lastDecisionOrder > state.lastBaselineOrder;
    return driftPending
        ? 'drift-pending'
        : updatePending
            ? 'baseline-update-pending'
            : state.baseline === undefined
                ? 'unknown'
                : 'aligned';
}

/** Project a snapshot onto the public {@link AlignmentStatus} shape. */
export function snapshotToStatus(state: AlignmentStateSnapshot): AlignmentStatus {
    return {
        ...(state.baseline === undefined ? {} : { baseline: state.baseline }),
        revision: state.baseline?.revision ?? 0,
        driftCount: state.driftCount,
        ...(state.lastDrift === undefined ? {} : {
            lastDrift: {
                reason: state.lastDrift.reason,
                description: state.lastDrift.description,
                ...(state.lastDrift.requiredChange === undefined ? {} : { requiredChange: state.lastDrift.requiredChange }),
                at: state.lastDrift.at
            }
        }),
        ...(state.lastDecision === undefined ? {} : {
            lastDecision: {
                driftSeq: state.lastDecision.driftSeq,
                decision: state.lastDecision.decision,
                ...(state.lastDecision.note === undefined ? {} : { note: state.lastDecision.note }),
                at: state.lastDecision.at
            }
        }),
        status: deriveAlignmentStatus(state),
        manualChecks: state.manualChecks,
        ...(state.lastManualCheckAt === undefined ? {} : { lastManualCheckAt: state.lastManualCheckAt })
    };
}

/**
 * Resolve the state in force at a log boundary: the LAST checkpoint whose
 * `visibleThroughSeq <= boundary`. Checkpoints must be ordered ascending;
 * an empty timeline yields the all-zero state.
 *
 * @param checkpoints The whole-state checkpoint timeline (ascending).
 * @param boundary The inclusive boundary seq (e.g. a fork's `seedLength - 1`).
 * @returns The state in force at that boundary.
 */
export function stateAt(checkpoints: readonly AlignmentCheckpoint[], boundary: number): AlignmentStateSnapshot {
    let result = EMPTY_ALIGNMENT_STATE;
    for (const checkpoint of checkpoints) {
        if (checkpoint.visibleThroughSeq <= boundary) {
            result = checkpoint.state;
        } else {
            break;
        }
    }
    return result;
}

/** The constant empty public status (no baseline, nothing recorded). */
export const EMPTY_ALIGNMENT_STATUS: AlignmentStatus = {
    revision: 0,
    driftCount: 0,
    status: 'unknown',
    manualChecks: 0
};

/**
 * Fold a session log into the legacy checkpoint timeline: one checkpoint per
 * legacy alignment state mutation, `visibleThroughSeq = event.seq`, exactly
 * mirroring {@link foldAlignmentStatus} — including the defensive baseline
 * shape check and the v0.1 `alignment/status` manual-check counting, so an
 * imported timeline and the legacy fold always agree (migration Test K).
 *
 * @param events The session log (or any prefix of it).
 * @returns The ascending checkpoint timeline; empty when the log has no
 *   alignment events.
 */
export function foldLegacyTimeline(events: readonly SessionEvent[]): AlignmentCheckpoint[] {
    const checkpoints: AlignmentCheckpoint[] = [];
    let state = EMPTY_ALIGNMENT_STATE;
    for (const event of events) {
        switch (event.type) {
            case 'alignment/baseline':
            case 'alignment/baseline-updated': {
                const candidate = event.data.baseline;
                if (isBaselineLike(candidate)) {
                    state = applyBaseline(state, candidate, event.seq);
                    checkpoints.push({ visibleThroughSeq: event.seq, state });
                }
                break;
            }
            case 'alignment/drift': {
                const data = event.data;
                state = applyDrift(state, {
                    reason: data.reason,
                    description: data.description,
                    ...(data.requiredChange === undefined ? {} : { requiredChange: data.requiredChange }),
                    at: data.at
                }, event.seq);
                checkpoints.push({ visibleThroughSeq: event.seq, state });
                break;
            }
            case 'alignment/decision': {
                const data = event.data;
                state = applyDecision(state, {
                    driftSeq: data.driftSeq,
                    decision: data.decision,
                    ...(data.note === undefined ? {} : { note: data.note }),
                    at: data.at
                }, event.seq);
                checkpoints.push({ visibleThroughSeq: event.seq, state });
                break;
            }
            case 'alignment/manual-check': {
                state = applyManualCheck(state, event.data.at);
                checkpoints.push({ visibleThroughSeq: event.seq, state });
                break;
            }
            case 'alignment/status': {
                // Legacy v0.1 manual-check snapshots.
                if (event.data.kind === 'manual-check') {
                    state = applyManualCheck(state, event.data.at);
                    checkpoints.push({ visibleThroughSeq: event.seq, state });
                }
                break;
            }
            default:
                break;
        }
    }
    return checkpoints;
}

/** The last snapshot of a timeline (the state at the log head), or the empty state. */
export function latestState(checkpoints: readonly AlignmentCheckpoint[]): AlignmentStateSnapshot {
    return checkpoints.length === 0 ? EMPTY_ALIGNMENT_STATE : checkpoints[checkpoints.length - 1]!.state;
}

export type { AlignmentDecisionKind, AlignmentStatus, AlignmentStatusValue, DriftReason, RequirementBaseline };
