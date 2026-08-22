/**
 * Pure types of the requirements-alignment domain: the requirement baseline,
 * the drift taxonomy, the legacy session events this plugin USED to append
 * (kept for persisted-session read compatibility), and the folded alignment
 * status view. Free of host-side value imports, so host consumers and tests
 * share it.
 *
 * Design rules (matching DSH session-event conventions):
 * - Since the persistence-compatibility fix, canonical alignment state lives
 *   in the AlignmentStateStore sidecar (`src/alignment-state-store.ts`), NOT
 *   in session events. The `alignment/*` event types below exist only so
 *   legacy v0.1/v0.2 logs fold and migrate; production code never appends
 *   them (the DSH persistence reader's generated known-event vocabulary does
 *   not contain them, and an appended event would make the session unreadable
 *   to every DSH build).
 * - Baseline events were whole-value snapshots: the payload carried the
 *   complete post-change baseline (revision included), never a delta. The
 *   last baseline event won. The sidecar checkpoints keep the same rule.
 * - `tool/call` records — including `ask_user_question` — are NOT alignment
 *   state: other plugins, plan mode, and ordinary agent questions must never
 *   pollute the alignment fold.
 *
 * @module dsh-requirements-alignment/types
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';

/**
 * Runtime alignment operation mode: `auto` contributes the policy section,
 * tools, and `/align`; `manual` keeps tools and `/align` only; `off`
 * unregisters those capabilities but keeps `/align-mode` so the user can
 * switch back.
 */
export type AlignmentMode = 'auto' | 'manual' | 'off';

/** Legal mode names, used by the configuration schema and validation. */
export const ALIGNMENT_MODES = ['auto', 'manual', 'off'] as const;

/** Narrow an unknown value to an {@link AlignmentMode}. */
export function isAlignmentMode(value: unknown): value is AlignmentMode {
    return value === 'auto' || value === 'manual' || value === 'off';
}

/**
 * Validate an unknown mode, returning it narrowed. Throws on anything that is
 * not a legal {@link AlignmentMode} — the single validation used by config
 * resolution, ModeStore writes, and runtime transitions.
 */
export function validateAlignmentMode(value: unknown): AlignmentMode {
    if (!isAlignmentMode(value)) {
        throw new Error(`requirements-alignment mode must be 'auto', 'manual', or 'off', got ${JSON.stringify(value)}`);
    }
    return value;
}

/**
 * Where the effective alignment mode of one session came from. v0.4.0 adds the
 * `session` layer (a session-scoped override) in front of the v0.3.0 shared
 * layers (`override` = persisted runtime override, `profile` = profile default).
 */
export type AlignmentSource = 'session' | 'override' | 'profile';

/**
 * The resolved effective mode of one session and the layer that produced it.
 * `effectiveModeFor(session)` on the controller returns this; every per-agent
 * capability decision reads this shape.
 */
export interface EffectiveMode {
    /** The mode in force for the session. */
    mode: AlignmentMode;
    /** Which layer produced `mode`. */
    source: AlignmentSource;
}

/**
 * Finite drift taxonomy. A drift candidate is a direction-level change, not a
 * code-quality issue; see the policy text for what must never trigger it.
 */
export type DriftReason =
    | 'scope-expansion'
    | 'constraint-conflict'
    | 'behavior-change'
    | 'architecture-shift'
    | 'data-model-change'
    | 'compatibility-change'
    | 'assumption-invalidated'
    | 'user-direction-change';

/** All supported drift reasons, for argument validation and status display. */
export const DRIFT_REASONS: readonly DriftReason[] = [
    'scope-expansion',
    'constraint-conflict',
    'behavior-change',
    'architecture-shift',
    'data-model-change',
    'compatibility-change',
    'assumption-invalidated',
    'user-direction-change'
];

/**
 * The requirement baseline of one task: what the user asked for and what the
 * execution must preserve. Deliberately minimal — only what decides task
 * direction, never a full specification.
 */
export interface RequirementBaseline {
    /** 1-based baseline revision; the fold reports 0 when none is recorded (implicit baseline). */
    revision: number;
    /** The task the user asked for, in one line. */
    goal?: string;
    /** Hard boundaries ("do not change the UI", "keep the public API"). */
    explicitConstraints?: string[];
    /** Behaviors/data formats the execution must preserve. */
    mustPreserve?: string[];
    /** What the execution may touch. */
    allowedScope?: string[];
    /** Settled user decisions that shape the direction. */
    userDecisions?: string[];
    /** Direction items still awaiting a user decision. */
    openDirectionDecisions?: string[];
    /** Epoch milliseconds when this baseline was recorded. */
    updatedAt: number;
}

/** What the user decided on one drift candidate. */
export type AlignmentDecisionKind = 'approve' | 'reject' | 'revise';

/** The durable session events this plugin appends. */
export interface BaselineEvent {
    /** Whole-value baseline after the change. */
    baseline: RequirementBaseline;
}

export interface DriftEvent {
    /** Why this is a drift candidate (finite taxonomy). */
    reason: DriftReason;
    /** What the agent intends to do that would change the direction. */
    description: string;
    /** What the baseline would need to become, when known. */
    requiredChange?: string;
    /** Epoch milliseconds when the candidate was recorded. */
    at: number;
}

export interface DecisionEvent {
    /** The `seq` of the `alignment/drift` event this decision answers. */
    driftSeq: number;
    /** The user's verdict on the drift candidate. */
    decision: AlignmentDecisionKind;
    /** Free-form user note (custom answer), when any. */
    note?: string;
    /** Epoch milliseconds when the decision was recorded. */
    at: number;
}

/** A manual `/align` inspection. */
export interface ManualCheckEvent {
    /** Epoch milliseconds when the check was run. */
    at: number;
}

/** Legacy v0.1 manual-check snapshot, read for backwards compatibility only. */
export interface LegacyStatusEvent {
    kind: 'manual-check';
    at: number;
}

declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        // ─────────────────────────────────────────────────────────────────────
        // LEGACY PERSISTED-SESSION READ COMPATIBILITY ONLY.
        //
        // These declarations exist so old session logs (v0.1/v0.2) fold
        // correctly through the legacy compatibility layer
        // (`foldAlignmentStatus` / `foldLegacyTimeline`) and so the migration
        // tooling can recognize the legacy vocabulary.
        //
        // They are NOT a runtime registration: DSH's persistence reader
        // builds its known-event vocabulary from the generated
        // `KNOWN_SESSION_EVENT_TYPES` set, which does NOT contain these
        // types. Appending one of these events to a live session makes the
        // log unreadable to every DSH build (SessionFormatUnsupportedError).
        // Production code MUST NOT append alignment/* events anymore —
        // canonical alignment state lives in the AlignmentStateStore
        // sidecar. `SessionEventMap` augmentation = TypeScript-only; it is
        // NEVER runtime registration.
        // ─────────────────────────────────────────────────────────────────────
        /**
         * The initial requirement baseline was recorded (revision >= 1). The
         * last baseline event wins; log-only, never model surface.
         *
         * @deprecated legacy persisted-session read compatibility only — the
         *   store records baselines through AlignmentStateStore, never here.
         */
        'alignment/baseline': BaselineEvent;
        /**
         * The baseline was revised after a user decision: whole-value replace,
         * revision increments. Log-only, never model surface.
         *
         * @deprecated legacy persisted-session read compatibility only.
         */
        'alignment/baseline-updated': BaselineEvent;
        /**
         * A drift candidate was detected. Appended before any user interaction,
         * so the candidate is durable even when the question fails or is
         * cancelled. Log-only, never model surface.
         *
         * @deprecated legacy persisted-session read compatibility only.
         */
        'alignment/drift': DriftEvent;
        /**
         * The user's decision on one drift candidate, paired with the drift
         * event by its seq. Log-only, never model surface.
         *
         * @deprecated legacy persisted-session read compatibility only.
         */
        'alignment/decision': DecisionEvent;
        /**
         * A manual `/align` inspection ran. Log-only, never model surface.
         *
         * @deprecated legacy persisted-session read compatibility only.
         */
        'alignment/manual-check': ManualCheckEvent;
        /**
         * Legacy v0.1 manual-check snapshot. Kept declared so old session logs
         * fold correctly; this plugin no longer writes it.
         * @deprecated v0.1 format — new writes use `alignment/manual-check`.
         */
        'alignment/status': LegacyStatusEvent;
    }
}

/**
 * The exact legacy alignment event vocabulary this plugin owns — the ONLY
 * types the migration tooling may ever touch. Everything else in a session
 * log is foreign and must remain byte-identical.
 */
export const LEGACY_ALIGNMENT_EVENT_TYPES: ReadonlySet<string> = new Set([
    'alignment/status',
    'alignment/baseline',
    'alignment/baseline-updated',
    'alignment/drift',
    'alignment/decision',
    'alignment/manual-check'
]);

/** Whether an event type belongs to the legacy alignment vocabulary. */
export function isLegacyAlignmentEventType(type: string): boolean {
    return LEGACY_ALIGNMENT_EVENT_TYPES.has(type);
}

/**
 * Overall alignment posture of one session, folded from its event log.
 * `baseline-update-pending` is the durability state between an approved /
 * revised direction and the baseline event that records it: a session
 * interrupted or crashed in that window must NOT fold to `aligned` against
 * the stale baseline.
 */
export type AlignmentStatusValue = 'unknown' | 'aligned' | 'drift-pending' | 'baseline-update-pending';

/** Folded alignment view of one session log (seed history included). */
export interface AlignmentStatus {
    /** The current baseline, when any baseline event exists. */
    baseline?: RequirementBaseline;
    /** `baseline?.revision ?? 0` — 0 means "no baseline recorded yet". */
    revision: number;
    /** Number of `alignment/drift` events in the whole log. */
    driftCount: number;
    /** The last recorded drift candidate, when any. */
    lastDrift?: {
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
    /**
     * `unknown` — no baseline recorded (implicit baseline held by the model);
     * `aligned` — the last drift is settled and, when the decision was
     * approve/revise, a newer baseline event recorded the new direction;
     * `drift-pending` — the last drift awaits a user decision (the soft form
     * of the future `alignment/pending` guard state);
     * `baseline-update-pending` — the user approved or revised a direction
     * (or the equivalent custom answer was recorded) but no
     * `alignment/baseline` / `alignment/baseline-updated` event followed the
     * decision yet. The stale baseline is still in force; the fold must not
     * report `aligned` while the new baseline is unwritten.
     */
    status: AlignmentStatusValue;
    /** Number of manual `/align` inspections (new and legacy events). */
    manualChecks: number;
    /** Epoch ms of the last manual `/align` inspection, when any. */
    lastManualCheckAt?: number;
}

export type { SessionEvent };
