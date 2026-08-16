/**
 * The Requirements Alignment policy text and its per-session rendering.
 *
 * v0.2 positions the plugin as a runtime requirement drift guard: the policy
 * makes the agent hold a requirement baseline while it executes, detect
 * direction-level drift candidates silently, and re-align with the user only
 * when a candidate is real. Manual and off modes contribute nothing (manual
 * alignment happens through `/align`, which steers its own compact check
 * instruction).
 *
 * @module dsh-requirements-alignment/policy
 */
import type { AlignmentStatus } from './types.ts';

/** Prompt order of the alignment policy section (after plan-mode's 50). */
export const POLICY_ORDER = 60;

/** Section name, stable across sessions for request-prefix reuse. */
export const POLICY_SECTION = 'requirements-alignment:policy';

/** The auto-mode policy: runtime drift guarding, not pre-execution alignment. */
export const DEFAULT_POLICY = `## Requirements Alignment policy

You execute a task against a requirement baseline: the goal the user asked for, protected constraints, behaviors that must be preserved, and the scope you may touch. Keep long-running work aligned with that intent. Plan Mode reviews plans; this policy guards intent continuity during execution. When plan mode is active, follow its instructions - this policy applies to execution steps.

### Baseline

At task start, internalize a light baseline: goal, explicit constraints ("without changing the UI", "keep the public API"), must-preserve behavior, allowed scope, and settled user decisions.

- If the request carries explicit constraints or protected scope ("do not change X", "without changing X", "preserve X", "keep X compatible", "only change X", "do not refactor Y", "no backend changes", "keep public API unchanged", "no UI changes" - any explicit scope or preservation boundary), call establish_baseline (silent - it never asks the user) BEFORE the first substantive implementation or mutation, and pin those constraints as explicitConstraints (plus mustPreserve / allowedScope when they fit). Do not start editing until the baseline is recorded. This is not a question round: no user interaction, no full specification - just the durable boundary.
- If the request is trivial and unambiguous (a typo fix), record nothing; just do the work.
- If no baseline can be formed (greenfield or vague: a new product, undefined form / MVP scope / primary interaction), ask the user the ONE highest-priority direction question via ask_user_question, then record the baseline with establish_baseline.
- A delegated instruction such as "pick whatever makes sense" does not waive that one start question for a greenfield idea.
- Keep the baseline minimal: only what decides direction. Never build a full specification.

### Silent monitoring

Default posture: zero interruption. Never check alignment periodically, by tool-call count, by time, by tokens, or by file count. Do not ask about implementation details. The user decides direction; you decide engineering. You decide autonomously: filenames, helper placement, variable naming, map vs loop, routine refactors, formatter, lint, test placement, ordinary library use, the repository's established stack, small internal designs that do not change observable behavior, in-scope bug fixes, and necessary test additions.

### Drift detection

Stop and re-align only when an action you are about to take would materially change the requirement baseline:

- Scope expansion: doing materially more than asked (for example "optimize the result page" becoming "refactor the whole state management").
- Constraint conflict: an explicit constraint blocks the way ("do not change the API" - but the API must change to continue).
- User-visible behavior change: a decision would change product behavior, UX, defaults, or compatibility without prior authorization.
- Architecture or product-shape shift: local-to-cloud, adding a backend, authentication, multi-user, sync, a persistence-model change, a public API change, a schema change, or a migration.
- Invalidated assumption: the implementation assumed something the code now shows is false, and continuing requires a new product or architecture direction.
- User direction change: the user introduces a new direction mid-task.

### Drift protocol

A user direction change is the clearest drift candidate: when the user's own message changes the task's direction mid-task (for example "now make it work across devices" on a local-only app, or "add accounts and sync"), do NOT treat it as a fresh clarification round. Run report_drift (reason: user-direction-change) as the FIRST step, before any scoping questions with ask_user_question and before any implementation of the new direction. The tool asks the user to confirm the new direction and its scope; after the answer, call establish_baseline with the updated baseline before continuing. ask_user_question is only for the initial greenfield direction question at task start, never for direction changes.

For agent-detected drift (scope expansion, constraint conflict, behavior change, architecture shift, data-model change, compatibility change, invalidated assumption), call report_drift BEFORE taking the direction-changing action - before substantive implementation of the changed direction, never after the fact as a summary. Do not silently proceed. The tool asks the user; then:

- Approved: call establish_baseline with the updated baseline (the revision advances), then continue.
- Rejected: stay within the current baseline and adjust your approach. No baseline revision is needed.
- Other direction given: record it via establish_baseline, then continue.

When the change offers a genuine choice of directions, pass the distinct candidate directions as the report_drift options argument; the user's chosen option is a revised direction (note = the chosen option label), never a rejection. After the decision, call establish_baseline before the next substantive step - until the new baseline is recorded, the session stays in baseline-update-pending, and an interrupted run must resume with the new baseline unwritten.

Do not re-ask settled decisions; re-align only when a NEW direction-defining change appears.

### Child agents

If you are a child agent, you cannot ask the user. If continuing requires changing the baseline, do not decide: include a "Requirement drift candidate" block in your final report (or the report tool when available) with the reason, the current baseline, the required change, and the decision needed from the parent. The parent owns user interaction; never ask the user yourself.`;

/**
 * Render the durable baseline summary shown to the model at every assembly.
 * Folded from the session log, so resume, fork, and compaction feed the same
 * state back. Renders present fields only; an open drift is called out so a
 * resumed session can finish the interrupted protocol.
 *
 * @param status The session's folded alignment status.
 * @returns The summary block, or '' when nothing direction-relevant is recorded.
 */
export function baselineSummary(status: AlignmentStatus): string {
    const lines: string[] = [];
    const baseline = status.baseline;
    if (baseline !== undefined) {
        lines.push(`Current requirement baseline (revision ${baseline.revision}):`);
        if (baseline.goal !== undefined) lines.push(`- Goal: ${baseline.goal}`);
        if (baseline.explicitConstraints !== undefined && baseline.explicitConstraints.length > 0) {
            lines.push('- Explicit constraints:');
            for (const constraint of baseline.explicitConstraints) lines.push(`  - ${constraint}`);
        }
        if (baseline.mustPreserve !== undefined && baseline.mustPreserve.length > 0) {
            lines.push('- Must preserve:');
            for (const item of baseline.mustPreserve) lines.push(`  - ${item}`);
        }
        if (baseline.allowedScope !== undefined && baseline.allowedScope.length > 0) {
            lines.push('- Allowed scope:');
            for (const item of baseline.allowedScope) lines.push(`  - ${item}`);
        }
        if (baseline.userDecisions !== undefined && baseline.userDecisions.length > 0) {
            lines.push('- Settled user decisions:');
            for (const item of baseline.userDecisions) lines.push(`  - ${item}`);
        }
        if (baseline.openDirectionDecisions !== undefined && baseline.openDirectionDecisions.length > 0) {
            lines.push('- Open direction decisions:');
            for (const item of baseline.openDirectionDecisions) lines.push(`  - ${item}`);
        }
    } else if (status.driftCount > 0) {
        lines.push('Current requirement baseline: implicit (none recorded yet).');
    }
    if (status.lastDrift !== undefined) {
        lines.push(`Last drift: ${status.lastDrift.reason} - ${status.lastDrift.description}${status.lastDrift.requiredChange === undefined ? '' : ` (required change: ${status.lastDrift.requiredChange})`}`);
    }
    if (status.lastDecision !== undefined) {
        lines.push(`Last user decision: ${status.lastDecision.decision}${status.lastDecision.note === undefined ? '' : ` - ${status.lastDecision.note}`}`);
    }
    if (status.status === 'drift-pending' && status.lastDrift !== undefined) {
        lines.push('Open drift: the last drift candidate still awaits a user decision. Run the drift protocol (report_drift) before the next direction-changing step.');
    }
    if (status.status === 'baseline-update-pending') {
        const lastDecision = status.lastDecision;
        const chosen = lastDecision === undefined
            ? 'the user approved or revised a direction'
            : lastDecision.decision === 'approve'
                ? 'the user approved the direction change'
                : `the user chose a new direction${lastDecision.note === undefined ? '' : `: ${lastDecision.note}`}`;
        lines.push(`Baseline update pending: ${chosen}, but the new baseline is not recorded yet. Call establish_baseline with the updated baseline BEFORE the next substantive step.`);
    }
    return lines.join('\n');
}

/**
 * The `/align` command's steered check instruction. Compact enough to submit
 * as one user message, complete enough to drive the check on its own. It
 * inspects alignment; it never blocks execution and never replaces plan mode.
 */
export const MANUAL_CHECK_MESSAGE = `Requirements Alignment check (manual). Fold the current requirement baseline from the session log - goal, explicit constraints, must-preserve behavior, allowed scope, and settled user decisions. Inspect the current workspace and conversation, then decide whether the work in progress still matches the baseline. If an action you are about to take (or already took) would materially change the direction - scope expansion, constraint conflict, user-visible behavior change, architecture or product-shape shift, invalidated assumption, or a user direction change - run the drift protocol: call report_drift and follow the user's decision. Otherwise state briefly that the task is still aligned and continue. This check never blocks execution and never replaces plan mode.`;

/**
 * Render the auto-mode policy section text for one session: the policy plus
 * the durable baseline summary when anything direction-relevant is recorded.
 *
 * @param customSection Optional deployment-owned policy replacing the default.
 * @param status The session's folded alignment status.
 * @returns The section text.
 */
export function autoPolicyText(customSection: string | undefined, status: AlignmentStatus): string {
    const base = customSection ?? DEFAULT_POLICY;
    if (status.baseline === undefined && status.driftCount === 0) return base;
    return base + '\n\n' + baselineSummary(status);
}
