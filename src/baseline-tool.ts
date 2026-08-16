/**
 * The model-facing alignment tools: `establish_baseline` (silent baseline
 * recording / revision) and `report_drift` (drift candidate + user
 * re-alignment). Both are the plan-mode pattern — a plugin-owned tool over
 * the native `ctx.userQuestions` seam — so the alignment state is written
 * only by this plugin's own events and can never be confused with unrelated
 * `ask_user_question` calls.
 *
 * @module dsh-requirements-alignment/baseline-tool
 */
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions';
import {
    appendBaseline,
    appendBaselineUpdated,
    appendDecision,
    appendDrift,
    foldRequirementBaseline
} from './status.ts';
import {
    DRIFT_REASONS,
    type AlignmentDecisionKind,
    type DriftReason,
    type RequirementBaseline
} from './types.ts';

/** The drift question's stable id, echoed in the answer. */
export const DRIFT_QUESTION_ID = 'alignment-drift';

/** Default drift question options when the model supplies none. */
export const DEFAULT_DRIFT_OPTIONS = [
    {
        label: 'Approve the direction change',
        description: 'Updates the requirement baseline; the new direction is recorded and the work continues.'
    },
    {
        label: 'Stay within the current scope',
        description: 'Keeps the requirement baseline unchanged; find another approach or stop.'
    }
] as const;

/** One model-supplied question option for the drift question. */
export interface DriftOption {
    label: string;
    description?: string;
}

/** The `establish_baseline` tool's validated baseline input. */
export interface BaselineInput {
    goal?: string;
    explicitConstraints?: string[];
    mustPreserve?: string[];
    allowedScope?: string[];
    userDecisions?: string[];
    openDirectionDecisions?: string[];
}

/** Validate baseline input: arrays of strings, at least one meaningful field. */
export function validateBaselineInput(input: unknown): BaselineInput {
    if (typeof input !== 'object' || input === null) throw new Error('establish_baseline: baseline must be an object');
    const record = input as Record<string, unknown>;
    const textFields = ['goal'] as const;
    const listFields = ['explicitConstraints', 'mustPreserve', 'allowedScope', 'userDecisions', 'openDirectionDecisions'] as const;
    const out: BaselineInput = {};
    for (const key of textFields) {
        const value = record[key];
        if (value !== undefined) {
            if (typeof value !== 'string') throw new Error(`establish_baseline: baseline.${key} must be a string`);
            out[key] = value;
        }
    }
    for (const key of listFields) {
        const value = record[key];
        if (value !== undefined) {
            if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
                throw new Error(`establish_baseline: baseline.${key} must be an array of strings`);
            }
            out[key] = [...value];
        }
    }
    const hasContent = (out.goal !== undefined && out.goal.trim() !== '')
        || listFields.some((key) => (out[key]?.length ?? 0) > 0);
    if (!hasContent) throw new Error('establish_baseline: baseline must include a goal or at least one constraint/scope/decision item');
    return out;
}

/** Build a whole-value baseline from validated input, bumping the revision. */
export function buildBaseline(input: BaselineInput, current: RequirementBaseline | undefined, now: number): RequirementBaseline {
    return {
        revision: (current?.revision ?? 0) + 1,
        ...(input.goal === undefined ? {} : { goal: input.goal }),
        ...(input.explicitConstraints === undefined ? {} : { explicitConstraints: input.explicitConstraints }),
        ...(input.mustPreserve === undefined ? {} : { mustPreserve: input.mustPreserve }),
        ...(input.allowedScope === undefined ? {} : { allowedScope: input.allowedScope }),
        ...(input.userDecisions === undefined ? {} : { userDecisions: input.userDecisions }),
        ...(input.openDirectionDecisions === undefined ? {} : { openDirectionDecisions: input.openDirectionDecisions }),
        updatedAt: now
    };
}

/** Validate the model-supplied drift question options (2-3 distinct labels). */
export function validateDriftOptions(input: unknown): DriftOption[] | undefined {
    if (input === undefined) return undefined;
    if (!Array.isArray(input)) throw new Error('report_drift: options must be an array');
    if (input.length < 2 || input.length > 3) throw new Error('report_drift: options must contain 2-3 items');
    const options: DriftOption[] = [];
    for (const raw of input) {
        if (typeof raw !== 'object' || raw === null || typeof (raw as { label?: unknown }).label !== 'string') {
            throw new Error('report_drift: each option must have a string label');
        }
        const label = (raw as { label: string }).label;
        if (label.trim() === '') throw new Error('report_drift: option labels must not be blank');
        const description = (raw as { description?: unknown }).description;
        if (description !== undefined && typeof description !== 'string') throw new Error('report_drift: option descriptions must be strings');
        options.push(description === undefined ? { label } : { label, description });
    }
    if (new Set(options.map((option) => option.label)).size !== options.length) {
        throw new Error('report_drift: option labels must be distinct');
    }
    return options;
}

/** The validated `report_drift` arguments. */
export interface DriftArgs {
    reason: DriftReason;
    description: string;
    requiredChange?: string;
    options?: DriftOption[];
}

/**
 * Validate all `report_drift` arguments before any durable event is written.
 * The tool schema already constrains the happy path; this defensive check
 * guarantees that anything invalid fails with zero session pollution.
 */
export function validateDriftArgs(input: unknown): DriftArgs {
    if (typeof input !== 'object' || input === null) throw new Error('report_drift: arguments must be an object');
    const record = input as Record<string, unknown>;
    const reason = record.reason;
    if (typeof reason !== 'string' || !(DRIFT_REASONS as readonly string[]).includes(reason)) {
        throw new Error(`report_drift: reason must be one of ${DRIFT_REASONS.join(', ')}`);
    }
    const description = record.description;
    if (typeof description !== 'string' || description.trim() === '') {
        throw new Error('report_drift: description must be a non-empty string');
    }
    const requiredChange = record.requiredChange;
    if (requiredChange !== undefined && typeof requiredChange !== 'string') {
        throw new Error('report_drift: requiredChange must be a string when provided');
    }
    const options = validateDriftOptions(record.options);
    return {
        reason: reason as DriftReason,
        description,
        ...(requiredChange === undefined ? {} : { requiredChange }),
        ...(options === undefined ? {} : { options })
    };
}

/**
 * Present the model-supplied direction options PLUS the two defaults
 * (deduplicated by label). Whatever the model offers, the user always has
 * the exact approve / stay-within-scope options, so a "stay" intent can
 * never be trapped inside a model-rewritten label and mis-recorded as a
 * revised direction.
 */
export function withDefaultOptions(options: DriftOption[]): DriftOption[] {
    const labels = new Set(options.map((option) => option.label));
    const defaults = DEFAULT_DRIFT_OPTIONS.filter((option) => !labels.has(option.label));
    return [...options, ...defaults];
}

/** The model-facing question for one drift candidate. */
export interface DriftQuestion {
    id: string;
    header: string;
    question: string;
    detail: string;
    options: DriftOption[];
}

/** Build the drift question shown to the user. */
export function buildDriftQuestion(reason: DriftReason, description: string, requiredChange: string | undefined, options: DriftOption[]): DriftQuestion {
    return {
        id: DRIFT_QUESTION_ID,
        header: 'Requirement drift',
        question: `This action would change the task direction: ${description} (reason: ${reason}). How should I proceed?`,
        detail: requiredChange === undefined ? '' : `Required baseline change: ${requiredChange}`,
        options
    };
}

/**
 * Map one user answer to a decision.
 *
 * Semantics:
 * - non-empty free text (`custom`) -> `revise`, note = the user's own words;
 * - a selected default option -> `approve` / `reject` by exact label;
 * - a selected **model-supplied** option (a concrete alternative direction)
 *   -> `revise`, note = the selected option's label — a chosen alternative
 *   is a direction change, never a rejection;
 * - anything that cannot be interpreted reliably (no selection, several
 *   selections, or a label that matches no presented option) throws: fail
 *   loud is better than silently mis-recording the decision as `reject`.
 *
 * @param selected The option labels the user selected.
 * @param custom Free-form "other" answer, when any.
 * @param presented The options the question actually showed (defaults when
 *   the model supplied none).
 * @returns The mapped decision and optional note.
 */
export function mapDriftAnswer(
    selected: readonly string[],
    custom: string | undefined,
    presented: readonly DriftOption[] = DEFAULT_DRIFT_OPTIONS
): { decision: AlignmentDecisionKind; note?: string } {
    if (custom !== undefined && custom.trim() !== '') return { decision: 'revise', note: custom.trim() };
    if (selected.length === 0) {
        throw new Error('report_drift: the drift question was answered without a selection — the user decision cannot be inferred; run report_drift again');
    }
    if (selected.length > 1) {
        throw new Error('report_drift: multiple options were selected — a drift decision needs exactly one direction; run report_drift again');
    }
    const label = selected[0]!;
    if (label === DEFAULT_DRIFT_OPTIONS[0].label) return { decision: 'approve' };
    if (label === DEFAULT_DRIFT_OPTIONS[1].label) return { decision: 'reject' };
    const customOption = presented.find((option) => option.label === label);
    if (customOption !== undefined) return { decision: 'revise', note: customOption.label };
    throw new Error(`report_drift: the selected answer "${label}" is not one of the presented options — the user decision cannot be inferred; run report_drift again with the correct options`);
}

/** The `establish_baseline` tool: silent, never asks the user. */
export function registerEstablishBaseline(ctx: import('@deepseek-ai/cordis').Context): void {
    ctx.tools.register(defineTool({
        name: 'establish_baseline',
        description: 'Record the requirement baseline of the current task (goal, explicit constraints, must-preserve behavior, allowed scope, settled user decisions). Silent: it never asks the user. Call it once when the task carries direction-relevant constraints or after the user settles a direction decision; the baseline revision advances on every call.',
        parameters: {
            baseline: {
                type: 'object',
                required: true,
                description: 'The whole requirement baseline; omitted fields are dropped. Keep it minimal - only what decides direction.',
                additionalProperties: false,
                properties: {
                    goal: { type: 'string', description: 'The task the user asked for, in one line.' },
                    explicitConstraints: { type: 'array', items: { type: 'string' }, description: 'Hard boundaries, e.g. "do not change the UI", "keep the public API".' },
                    mustPreserve: { type: 'array', items: { type: 'string' }, description: 'Behaviors or data formats the execution must preserve.' },
                    allowedScope: { type: 'array', items: { type: 'string' }, description: 'What the execution may touch.' },
                    userDecisions: { type: 'array', items: { type: 'string' }, description: 'Settled user decisions that shape the direction.' },
                    openDirectionDecisions: { type: 'array', items: { type: 'string' }, description: 'Direction items still awaiting a user decision.' }
                }
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: { revision: { type: 'integer', required: true } }
            },
            render: (_args, value) => [{
                type: 'text',
                text: `Requirement baseline recorded (revision ${value.revision}). Continue within this baseline.`
            }]
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const agent = requireCallingAgent(exec, 'establish_baseline');
            const input = validateBaselineInput(args.baseline);
            const session = agent.session;
            const current = foldRequirementBaseline(session.events);
            const baseline = buildBaseline(input, current, Date.now());
            if (current === undefined) {
                appendBaseline(session, baseline);
            } else {
                appendBaselineUpdated(session, baseline);
            }
            return { revision: baseline.revision };
        }
    }));
}

/** The `report_drift` tool: record a drift candidate, ask the user, record the decision. */
export function registerReportDrift(ctx: import('@deepseek-ai/cordis').Context): void {
    ctx.tools.register(defineTool({
        name: 'report_drift',
        description: 'Report that continuing the task would materially change the requirement baseline (scope expansion, constraint conflict, user-visible behavior change, architecture shift, data-model change, compatibility change, invalidated assumption, or user direction change). Records the candidate, asks the user for the decision, and records it. Call it BEFORE taking the direction-changing action - never silently proceed. When the change offers a genuine choice of directions, pass the distinct candidates as options: the user\'s chosen option records as a revised direction (note = the chosen option label), never a rejection. The approve / stay-within-scope options are always offered alongside, so the user can always approve or reject explicitly.',
        parameters: {
            reason: {
                type: 'string',
                enum: DRIFT_REASONS,
                required: true,
                description: 'Why this is a drift candidate.'
            },
            description: {
                type: 'string',
                required: true,
                description: 'What you intend to do that would change the task direction.'
            },
            requiredChange: {
                type: 'string',
                description: 'What the requirement baseline would need to become, when known.'
            },
            options: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        label: { type: 'string', required: true },
                        description: { type: 'string' }
                    }
                },
                description: 'Optional 2-3 genuinely distinct direction options for the user; defaults to approve / stay within scope.'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    decision: {
                        type: 'string',
                        enum: ['approve', 'reject', 'revise'],
                        required: true
                    },
                    note: {
                        type: 'string',
                        description: 'The user\'s exact choice: the free-form answer or the selected option label (revise).'
                    },
                    requiredChange: {
                        type: 'string',
                        description: 'The required baseline change the drift candidate carried, echoed back.'
                    }
                }
            },
            render: (args, value) => [{
                type: 'text',
                text: renderDriftOutcome(value.decision, value.note, (args as { requiredChange?: string }).requiredChange)
            }]
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const agent = requireCallingAgent(exec, 'report_drift');
            // Validate every argument BEFORE any durable write: an input error
            // discoverable here must never pollute the session log.
            const validated = validateDriftArgs(args);
            const session = agent.session;
            // Validate the interaction prerequisites before appending the
            // drift candidate: without a question channel the tool must fail
            // with a clean log, not a stranded drift event.
            const interaction = ctx.get('userQuestions');
            if (interaction === undefined) throw new Error('no user-questions channel is available to re-align the requirement baseline; ask the user to run /align instead');
            const presented = withDefaultOptions(validated.options ?? [...DEFAULT_DRIFT_OPTIONS]);
            const now = Date.now();
            const drift = appendDrift(session, {
                reason: validated.reason,
                description: validated.description,
                ...(validated.requiredChange === undefined ? {} : { requiredChange: validated.requiredChange }),
                at: now
            });
            const question = buildDriftQuestion(validated.reason, validated.description, validated.requiredChange, presented);
            let answer;
            try {
                answer = await interaction.ask({
                    questions: [{
                        id: question.id,
                        header: question.header,
                        question: question.question,
                        ...(question.detail === '' ? {} : { detail: question.detail }),
                        options: question.options
                    }],
                    agent,
                    signal: exec.signal
                });
            } catch (error) {
                if (error instanceof UserQuestionError && error.code === 'DELEGATED_CALLER') {
                    throw new Error('You are a child agent and cannot ask the user. Include a "Requirement drift candidate" block in your final report (reason, current baseline, required change, decision needed) so the parent can decide.', { cause: error });
                }
                if (error instanceof UserQuestionError && error.code === 'CALLER_NOT_LIVE') {
                    throw new Error('The calling agent is not the live root; report the drift candidate to the parent instead of asking the user.', { cause: error });
                }
                if (error instanceof UserQuestionError && error.code === 'ASK_CANCELLED') {
                    throw new Error('The user dismissed the drift question; stop here and wait for their message before proceeding.', { cause: error });
                }
                throw error;
            }
            const item = answer.answers.find((entry) => entry.id === DRIFT_QUESTION_ID);
            // Fail loud on an uninterpretable answer; never silently reject.
            const mapped = mapDriftAnswer(item?.selected ?? [], item?.custom, presented);
            appendDecision(session, {
                driftSeq: drift.seq,
                decision: mapped.decision,
                ...(mapped.note === undefined ? {} : { note: mapped.note }),
                at: Date.now()
            });
            return {
                decision: mapped.decision,
                ...(mapped.note === undefined ? {} : { note: mapped.note }),
                ...(validated.requiredChange === undefined ? {} : { requiredChange: validated.requiredChange })
            };
        }
    }));
}

/** Require a calling agent; the tools are inert outside an agent turn. */
function requireCallingAgent(exec: ToolRunContext, tool: string): Agent {
    if (exec.agent === undefined) throw new Error(`${tool} requires a calling agent (no session to record into)`);
    return exec.agent;
}

/**
 * The model-facing outcome text for one recorded decision. The exact user
 * choice (note) and the drift's required change are fed back verbatim, so
 * the agent never has to re-ask which direction the user picked.
 *
 * @param decision The recorded verdict.
 * @param note The user's exact choice (free-form answer or selected option
 *   label), when any — normally present for `revise`.
 * @param requiredChange The baseline change the drift candidate required,
 *   when any (echoed for `approve`/`revise`).
 * @returns The outcome text.
 */
export function renderDriftOutcome(decision: AlignmentDecisionKind, note?: string, requiredChange?: string): string {
    const required = requiredChange === undefined ? '' : ` Required baseline change: ${requiredChange}.`;
    switch (decision) {
        case 'approve':
            return `The user approved the direction change. Call establish_baseline with the updated baseline (goal, constraints, scope reflecting the new direction) before continuing.${required}`;
        case 'reject':
            return 'The user chose to stay within the current requirement baseline. Do not make the change; adjust your approach to remain within the existing scope and constraints.';
        case 'revise':
            if (note !== undefined && note !== '') {
                return `The user chose the direction "${note}". Call establish_baseline with the updated baseline reflecting that direction before continuing.${required}`;
            }
            return `The user provided a new direction. Call establish_baseline with the updated baseline reflecting that direction before continuing.${required}`;
    }
}
