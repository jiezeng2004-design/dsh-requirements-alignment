/**
 * Dogfood-only driver: executes the `/align` command against every live agent
 * at session start and records the outcome. Mounted only in disposable test
 * profiles (see `scripts/dogfood.ps1`), because the headless runner has no
 * command adapter of its own. The product plugin never mounts it.
 *
 * @module dsh-requirements-alignment/align-driver
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { foldAlignmentStatus } from './status.ts';

/** Raw driver config. */
export interface AlignDriverConfig {
    /** Absolute path of the JSONL record file appended per execution. */
    recordPath?: string;
}

/** A validated, detached config. */
export interface ResolvedAlignDriverConfig {
    recordPath?: string;
}

/** Validate driver config; unknown keys fail loud. */
export function resolveAlignDriverConfig(config: AlignDriverConfig = {}): ResolvedAlignDriverConfig {
    const unknown = Object.keys(config).filter((key) => key !== 'recordPath');
    if (unknown.length > 0) throw new Error(`AlignDriverConfig has unknown key(s) ${unknown.join(', ')} - config is { recordPath? }`);
    return config.recordPath === undefined ? {} : { recordPath: config.recordPath };
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

/**
 * Mount the driver: at every `agent/session-start`, run `/align` through the
 * real commands registry and record the outcome plus the folded status.
 *
 * @param ctx The plugin context.
 * @param config Driver configuration.
 */
export function apply(ctx: import('@deepseek-ai/cordis').Context, config: AlignDriverConfig = {}): void {
    const resolved = resolveAlignDriverConfig(config);
    ctx.on('agent/session-start', async ({ agent }) => {
        const commands = ctx.get('commands');
        if (commands === undefined) {
            record(resolved.recordPath, { executed: false, error: 'no commands service' });
            return;
        }
        try {
            const execution = await commands.execute(agent, '/align', new AbortController().signal);
            const status = foldAlignmentStatus(agent.session.events);
            record(resolved.recordPath, {
                executed: true,
                resultKind: execution?.result.kind,
                resultText: execution?.result.text,
                questionRounds: status.questionRounds,
                lastManualCheckAt: status.lastManualCheckAt,
                alignCommandRuns: agent.session.events.filter((event) => event.type === 'command/run' && event.data.name === 'align').length
            });
        } catch (error) {
            record(resolved.recordPath, { executed: false, error: String(error) });
        }
    });
}

export const name = 'align-driver';
export { apply as default };
