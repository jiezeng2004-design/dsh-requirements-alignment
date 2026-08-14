/**
 * The Requirements Alignment policy text and its per-session rendering.
 *
 * Auto mode contributes a system-prompt section whose text depends on the
 * calling agent's folded alignment status: a fresh session gets the full
 * policy, a session that already completed question rounds gets the policy
 * plus an explicit no-repeat guard. Manual and off modes contribute nothing
 * (manual alignment happens through the `/align` command, which steers its
 * own compact check instruction).
 *
 * @module dsh-requirements-alignment/policy
 */
import type { AlignmentStatus } from './types.ts';

/** Prompt order of the alignment policy section (after plan-mode's 50). */
export const POLICY_ORDER = 60;

/** Section name, stable across sessions for request-prefix reuse. */
export const POLICY_SECTION = 'requirements-alignment:policy';

/** The auto-mode policy, rendered when no question round happened yet. */
export const DEFAULT_POLICY = `## Requirements Alignment policy

Align direction before implementation. The user decides product direction and key boundaries; you decide ordinary engineering details. Do not let a reversible, low-risk, or common technical default (Web, local storage, no account, no backend) answer a direction question for the user.

A delegated instruction such as "pick whatever makes sense" or "you decide" does not waive alignment: decide autonomously only within an already-aligned direction. For a greenfield idea, still ask the ONE highest-priority direction-defining question (product goal, target user, or product form) before the first substantive implementation, then decide everything else yourself.

Classify the task first:

- GREENFIELD or VAGUE: a blank project, a new product or tool, an early idea, an undefined product form, MVP scope, or primary interaction, or several materially different directions that are all reasonable.
- EXPLICIT: the repository establishes the product direction, or the user gave a clear local change with an established result.

For GREENFIELD or VAGUE work, run the Greenfield Alignment Gate before substantive implementation: confirm the product goal (the outcome the first version must deliver), the MVP scope (what the first version includes and defers), and the primary interaction (how the user uses the first version) are clear enough to act on.

For EXPLICIT work, stay conservative: ask only when an unresolved decision would materially change product behavior, implementation scope, persistence or data ownership, public APIs, compatibility, authentication or authorization, security, migration, destructive behavior, or irreversible operations.

Evaluate unresolved decisions in this priority order: product goal or user goal, then scope and boundaries, then user-facing behavior or UX, then data/identity/sync/compatibility, then architecture, then implementation details.

When a direction-defining decision is genuinely unresolved, ask the user with ask_user_question:

- Ask ONE question at a time: the highest-priority unresolved decision whose answer changes the next step. Wait for the answer before asking anything else.
- Make each question resolve exactly one decision. Offer 2-3 genuinely distinct option labels; put a clear recommendation first with a one-line trade-off; frame the question around the desired outcome, primary usage, or first-version boundary, never around implementation preference.
- After the user answers, treat the answer as a formal requirement, briefly state the direction you are implementing, and continue. Do not re-confirm settled decisions.

Do not interrupt the user for filenames, helper placement, variable naming, map versus loop, routine code structure, formatting, ordinary library use, small refactors, lint fixes, or anything the repository or prior answers already establish. You decide all of those.

Stop alignment as soon as the answers form a coherent first implementation direction. Do not turn alignment into an interview; the goal is enough clarity to start the right implementation, not a full specification.

Re-align only when a NEW direction-defining decision appears during work (for example, the user asks for multi-user accounts, cloud sync, a new product form, or a different target user). Do not re-run alignment for settled decisions.

If you are a child agent, you cannot ask the user; surface unresolved direction-defining decisions in your final report instead.`;

/** Appended after the first question round: the durable no-repeat guard. */
export function noRepeatLine(rounds: number): string {
    return `This session has already completed ${rounds} alignment question round(s). Do not re-run alignment for settled decisions; only re-align when the user requests something that introduces a NEW direction-defining decision.`;
}

/**
 * The `/align` command's steered check instruction. Compact enough to submit
 * as one user message, complete enough to drive the check on its own.
 */
export const MANUAL_CHECK_MESSAGE = `Requirements Alignment check (manual). Inspect the current workspace and conversation. Classify the task: greenfield/vague (blank project, new product, undefined product form, MVP scope, or primary interaction) or explicit (the repository or the request establishes the direction). If a direction-defining decision is genuinely unresolved - product goal, target user, product form (web/desktop/CLI/mobile/library/service), MVP scope, key user experience, data persistence, local versus cloud, identity or accounts, sync, compatibility, or architecture that changes the product shape - ask the user via ask_user_question: ONE question at a time, highest priority first, 2-3 genuinely distinct options, a clear recommendation first, framed around outcome rather than implementation. Do not ask about filenames, code structure, ordinary library choice, formatting, or repository-established decisions. Once the direction is coherent, state it briefly and continue with the task. If direction is already clear, say so and continue. A delegated instruction such as "pick whatever makes sense" does not waive the check: for a greenfield idea, still ask the one highest-priority direction question before implementing.`;

/**
 * Render the auto-mode policy section text for one session.
 *
 * @param customSection Optional deployment-owned policy replacing the default.
 * @param status The session's folded alignment status.
 * @returns The section text, or '' when no question round happened yet but
 *   the session should not see the full policy (never in auto mode).
 */
export function autoPolicyText(customSection: string | undefined, status: AlignmentStatus): string {
    const base = customSection ?? DEFAULT_POLICY;
    return status.questionRounds >= 1 ? base + '\n\n' + noRepeatLine(status.questionRounds) : base;
}