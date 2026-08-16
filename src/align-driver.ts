/**
 * Dogfood-only driver: runs `/align` against every top-level agent at session
 * start, records per-session alignment snapshots (at start and at every
 * turn/end), and can inject a synthetic `ask_user_question` tool call to prove
 * question isolation. Mounted only in disposable test profiles (see
 * `scripts/dogfood.ps1`), because the headless runner has no command adapter
 * of its own. The product plugin never mounts it.
 *
 * @module dsh-requirements-alignment/align-driver
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CallId } from '@deepseek-ai/dsh-llm';
import { assembleContextFor } from '@deepseek-ai/dsh-agent';
import { POLICY_SECTION } from './policy.ts';
import { foldAlignmentStatus } from './status.ts';

/** Raw driver config. */
export interface AlignDriverConfig {
    /** Absolute path of the JSONL record file appended per execution. */
    recordPath?: string;
    /**
     * Run `/align` through the real commands registry at session start (dogfood
     * cases 6-7). Snapshots are recorded regardless.
     */
    runAlign?: boolean;
    /**
     * Append one synthetic `ask_user_question` tool call to every top-level
     * session before `/align`, to verify that unrelated questions never
     * pollute alignment state (dogfood case 5).
     */
    injectAskUserCall?: boolean;
    /**
     * Record a snapshot at the first non-read-only tool call, to prove the
     * baseline was established before any mutation (dogfood case 3).
     */
    snapshotFirstMutation?: boolean;
    /**
     * Halt the process right after the first `alignment/decision` event is
     * appended, so an interrupted session's durable log can be folded at the
     * decision point (dogfood case 11, phase A). The snapshot is recorded and
     * the persistence batch is given time to flush before exit.
     */
    haltAtDecision?: boolean;
    /**
     * Assemble the REAL system prompt for the session at start (through the
     * systemPrompt service) and record whether the
     * `requirements-alignment:policy` section is present in the assembled
     * section registry, plus the head of its resolved text. Deterministic
     * proof that the policy section is live — used by the packed smoke
     * (dogfood-only; the product plugin never mounts the driver).
     */
    verifyPolicySection?: boolean;
}

/** A validated, detached config. */
export interface ResolvedAlignDriverConfig {
    recordPath?: string;
    runAlign?: boolean;
    injectAskUserCall?: boolean;
    snapshotFirstMutation?: boolean;
    haltAtDecision?: boolean;
    verifyPolicySection?: boolean;
}

/** Validate driver config; unknown keys fail loud. */
export function resolveAlignDriverConfig(config: AlignDriverConfig = {}): ResolvedAlignDriverConfig {
    const unknown = Object.keys(config).filter((key) => key !== 'recordPath' && key !== 'runAlign' && key !== 'injectAskUserCall' && key !== 'snapshotFirstMutation' && key !== 'haltAtDecision' && key !== 'verifyPolicySection');
    if (unknown.length > 0) throw new Error(`AlignDriverConfig has unknown key(s) ${unknown.join(', ')} - config is { recordPath?, runAlign?, injectAskUserCall?, snapshotFirstMutation?, haltAtDecision?, verifyPolicySection? }`);
    for (const key of ['runAlign', 'injectAskUserCall', 'snapshotFirstMutation', 'haltAtDecision', 'verifyPolicySection'] as const) {
        const value = config[key];
        if (value !== undefined && typeof value !== 'boolean') throw new Error(`AlignDriverConfig ${key} must be a boolean`);
    }
    return {
        ...(config.recordPath === undefined ? {} : { recordPath: config.recordPath }),
        ...(config.runAlign === undefined ? {} : { runAlign: config.runAlign }),
        ...(config.injectAskUserCall === undefined ? {} : { injectAskUserCall: config.injectAskUserCall }),
        ...(config.snapshotFirstMutation === undefined ? {} : { snapshotFirstMutation: config.snapshotFirstMutation }),
        ...(config.haltAtDecision === undefined ? {} : { haltAtDecision: config.haltAtDecision }),
        ...(config.verifyPolicySection === undefined ? {} : { verifyPolicySection: config.verifyPolicySection })
    };
}

/** Append one JSONL record without crashing the run on I/O failure. */
function record(recordPath: string | undefined, line: unknown): void {
    if (recordPath === undefined) return;
    try {
        mkdirSync(dirname(recordPath), { recursive: true });
        appendFileSync(recordPath, JSON.stringify(line) + '\n', 'utf8');
    } catch {
        // Recording is best-effort for assertions; never break the loop.
    }
}

/** One folded status snapshot, JSON-safe for the record file. */
function snapshot(agent: import('@deepseek-ai/dsh-agent').Agent, phase: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const status = foldAlignmentStatus(agent.session.events);
    return {
        phase,
        sessionId: String(agent.session.id),
        revision: status.revision,
        driftCount: status.driftCount,
        status: status.status,
        baselineRecorded: status.baseline !== undefined,
        ...(status.baseline === undefined ? {} : {
            baselineConstraints: status.baseline.explicitConstraints ?? []
        }),
        ...(status.lastDrift === undefined ? {} : {
            lastDrift: {
                reason: status.lastDrift.reason,
                description: status.lastDrift.description,
                ...(status.lastDrift.requiredChange === undefined ? {} : { requiredChange: status.lastDrift.requiredChange })
            }
        }),
        ...(status.lastDecision === undefined ? {} : {
            lastDecision: { decision: status.lastDecision.decision, note: status.lastDecision.note }
        }),
        manualChecks: status.manualChecks,
        lastManualCheckAt: status.lastManualCheckAt,
        ...extra
    };
}

/** Tool names that never mutate the workspace (first-mutation snapshot). */
const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep', 'web_search', 'skill', 'ask_user_question', 'establish_baseline', 'report_drift']);

/**
 * Mount the driver: at every `agent/session-start`, record an initial
 * snapshot; optionally inject the isolation probe; for top-level agents run
 * `/align` through the real commands registry; and record a snapshot at every
 * `turn/end` of every session.
 *
 * @param ctx The plugin context.
 * @param config Driver configuration.
 */
export function apply(ctx: import('@deepseek-ai/cordis').Context, config: AlignDriverConfig = {}): void {
    const resolved = resolveAlignDriverConfig(config);
    ctx.on('agent/session-start', async ({ agent }) => {
        record(resolved.recordPath, snapshot(agent, 'start'));
        if (resolved.injectAskUserCall === true) {
            try {
                agent.session.append('tool/call', {
                    turn: 999999,
                    step: 999999,
                    callId: CallId('alignment-isolation-probe'),
                    name: 'ask_user_question',
                    arguments: '{"questions":[]}'
                });
                record(resolved.recordPath, {
                    phase: 'inject',
                    injected: true,
                    toolCalls: agent.session.events.filter((event) => event.type === 'tool/call').length
                });
            } catch (error) {
                record(resolved.recordPath, { phase: 'inject', injected: false, error: String(error) });
            }
        }
        if (agent.session.header.origin === 'subagent') return;
        if (resolved.runAlign === true) {
            const commands = ctx.get('commands');
            if (commands === undefined) {
                record(resolved.recordPath, { phase: 'align', executed: false, error: 'no commands service' });
            } else {
                try {
                    const execution = await commands.execute(agent, '/align', new AbortController().signal);
                    record(resolved.recordPath, {
                        phase: 'align',
                        executed: true,
                        resultKind: execution?.result.kind,
                        resultText: execution?.result.text,
                        alignCommandRuns: agent.session.events.filter((event) => event.type === 'command/run' && event.data.name === 'align').length,
                        manualCheckEvents: agent.session.events.filter((event) => event.type === 'alignment/manual-check').length
                    });
                } catch (error) {
                    record(resolved.recordPath, { phase: 'align', executed: false, error: String(error) });
                }
            }
        }
        if (resolved.verifyPolicySection === true) {
            // Deterministic policy-presence proof: assemble the real system
            // prompt for this session and inspect the section registry.
            try {
                const systemPrompt = ctx.get('systemPrompt');
                if (systemPrompt === undefined) {
                    record(resolved.recordPath, { phase: 'policy', executed: false, error: 'no systemPrompt service' });
                } else {
                    const assembly = await systemPrompt.assemble(assembleContextFor(agent));
                    const section = assembly.sections.find((entry) => entry.name === POLICY_SECTION);
                    record(resolved.recordPath, {
                        phase: 'policy',
                        executed: true,
                        present: section !== undefined,
                        ...(section === undefined ? {} : { sectionName: section.name, textHead: section.text.slice(0, 160) })
                    });
                }
            } catch (error) {
                record(resolved.recordPath, { phase: 'policy', executed: false, error: String(error) });
            }
        }
    });
    let firstMutationRecorded = false;
    ctx.on('session/event', (session, event) => {
        const agents = ctx.get('agents');
        const agent = agents?.get(session.id);
        if (agent === undefined) return;
        if (event.type === 'turn/end') {
            record(resolved.recordPath, snapshot(agent, 'turn-end'));
        }
        if (resolved.snapshotFirstMutation === true && !firstMutationRecorded && event.type === 'tool/call'
            && typeof event.data.name === 'string' && !READ_ONLY_TOOLS.has(event.data.name)) {
            firstMutationRecorded = true;
            record(resolved.recordPath, snapshot(agent, 'first-mutation', { toolName: event.data.name }));
        }
        if (resolved.haltAtDecision === true && event.type === 'alignment/decision') {
            record(resolved.recordPath, snapshot(agent, 'halted-after-decision'));
            // Let the JSONL persistence batch (<= 200 ms) flush before exit so
            // the durable log contains the decision event.
            setTimeout(() => process.exit(0), 1500);
        }
    });
}

export const name = 'align-driver';
export { apply as default };
