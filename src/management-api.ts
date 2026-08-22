/**
 * Management API for the Requirements Alignment floating manager.
 *
 * Mounted on the DSH web server under /_dsh/requirements-alignment. Loopback
 * only, with Host + Origin + Content-Type + custom-header checks on every
 * mutation (CSRF defense, same recipe as dsh-chatgpt-bridge). GET endpoints
 * never mutate. The endpoints are the server half of the `shell.overlay`
 * capsule; every mutation is exercised through the SAME controller paths the
 * `/align-mode` command uses, so the widget and the command can never
 * disagree about the mode model.
 *
 *   GET      /status?sessionId=   four-layer picture + folded baseline
 *   PUT      /mode?sessionId=     { mode }  → session-scoped override
 *   DELETE   /mode?sessionId=                → clear session override
 *   PUT      /shared-mode         { mode }  → shared runtime override
 *   DELETE   /shared-mode                   → reset shared override
 *
 * A sessionId that is not a live session resolves to an error (the floating
 * manager only ever addresses the currently selected session, which is always
 * live). Session lookup goes through the controller's live-session registry
 * (`ctx.agents`) — the same layer `/align-mode` operates on.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { RequirementsAlignmentController } from './index.ts';
import { validateAlignmentMode, type AlignmentMode } from './types.ts';

/** The base path all management routes are mounted under. */
export const ROUTE_BASE = '/_dsh/requirements-alignment';
/** Distinct CSRF header so a malicious third-party page cannot forge mutations. */
export const MUTATION_HEADER = 'x-dsh-requirements-alignment';

const MAX_BODY_BYTES = 16 * 1024;

/** Minimal web-server seam (the DSH web server's `register` surface). */
export interface WebServerLike {
    register(route: {
        kind: 'exact' | 'prefix';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(body));
}

function isLoopbackRemote(req: IncomingMessage): boolean {
    const address = req.socket.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function hostAllowed(host: string | undefined): boolean {
    if (host === undefined || host === '') return false;
    const normalized = host.toLowerCase().replace(/\[([^\]]+)\]/g, '$1').replace(/:\d+$/, '');
    return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function originAllowed(origin: string | undefined): boolean {
    if (origin === undefined || origin === '') return false;
    try {
        const host = new URL(origin).hostname.toLowerCase();
        return host === '127.0.0.1' || host === 'localhost' || host === '::1';
    } catch {
        return false;
    }
}

function isMutation(method: string): boolean {
    return method === 'POST' || method === 'PUT' || method === 'DELETE';
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_BODY_BYTES) {
            throw new Error('request body too large');
        }
        chunks.push(buffer);
    }
    if (chunks.length === 0) return {};
    const text = Buffer.concat(chunks).toString('utf8');
    try {
        const parsed = JSON.parse(text);
        return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
    } catch {
        throw new Error('invalid JSON body');
    }
}

/** Resolve one session id from the query string, or undefined. */
function sessionIdOf(url: URL): SessionId | undefined {
    const value = url.searchParams.get('sessionId');
    if (value === undefined || value === null || value === '') return undefined;
    return value as SessionId;
}

/** The four-layer + baseline picture the capsule renders. */
export interface AlignmentStatusPayload {
    ok: true;
    session: {
        id: string;
        effectiveMode: 'auto' | 'manual' | 'off';
        effectiveSource: 'session' | 'override' | 'profile';
        sessionOverride: 'auto' | 'manual' | 'off' | null;
        sharedOverride: 'auto' | 'manual' | 'off' | null;
        profileDefault: 'auto' | 'manual' | 'off';
        /**
         * Present ONLY while a mode transition is not converged: the advertised
         * effectiveMode still reflects the source layers, but live capabilities
         * have not (or cannot) converge to it. pending: true means the system
         * is in an explicit degraded / pending-recovery state and the mutation
         * that caused it ALREADY RETURNED FAILURE - the target mode is never
         * claimed as active. Absent at all other times.
         */
        reconciliation?: {
            pending: true;
            kind: 'source-compensation' | 'capability-degraded';
            /** The mode the agent's capabilities actually implement now, when knowable. */
            activeCapabilityMode?: 'auto' | 'manual' | 'off';
            /** Human-readable provenance (the compensating write error / the degraded registration errors). */
            detail?: string;
        };
    };
    baseline: {
        revision: number;
        status: 'unknown' | 'aligned' | 'drift-pending' | 'baseline-update-pending';
        driftCount: number;
        manualChecks: number;
    };
}

/**
 * Create the management API for one controller instance. `register` mounts
 * the routes on the web server and returns the disposer removing them.
 */
export function createManagementApi(controller: RequirementsAlignmentController): {
    register(webServer: WebServerLike): () => void;
} {
    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        // Loopback enforcement: the API is same-origin with the DSH web UI and
        // must never be reachable from a non-loopback source.
        if (!isLoopbackRemote(req)) {
            sendJson(res, 403, { ok: false, error: 'forbidden' });
            return;
        }

        let url: URL;
        try {
            url = new URL(req.url ?? '/', 'http://127.0.0.1');
        } catch {
            sendJson(res, 400, { ok: false, error: 'bad request' });
            return;
        }
        const method = req.method ?? 'GET';
        const path = url.pathname;

        // ── mutation guard ────────────────────────────────────────────────────
        if (isMutation(method)) {
            if (!hostAllowed(req.headers.host)) {
                sendJson(res, 403, { ok: false, error: 'bad-origin' });
                return;
            }
            if (!originAllowed(req.headers.origin)) {
                sendJson(res, 403, { ok: false, error: 'bad-origin' });
                return;
            }
            if (req.headers[MUTATION_HEADER] !== '1') {
                sendJson(res, 403, { ok: false, error: 'forbidden' });
                return;
            }
        }

        // ── read endpoints ────────────────────────────────────────────────────
        if (path === ROUTE_BASE + '/status' && method === 'GET') {
            const sessionId = sessionIdOf(url);
            if (sessionId === undefined) {
                sendJson(res, 400, { ok: false, error: 'sessionId is required' });
                return;
            }
            const agent = controller.liveAgent(sessionId);
            if (agent === undefined) {
                sendJson(res, 404, { ok: false, error: 'session not live' });
                return;
            }
            const payload = controller.alignmentStatusPayload(agent);
            sendJson(res, 200, payload);
            return;
        }

        // ── session-scoped mutations ──────────────────────────────────────────
        if (path === ROUTE_BASE + '/mode' && method === 'PUT') {
            const sessionId = sessionIdOf(url);
            if (sessionId === undefined) {
                sendJson(res, 400, { ok: false, error: 'sessionId is required' });
                return;
            }
            const agent = controller.liveAgent(sessionId);
            if (agent === undefined) {
                sendJson(res, 404, { ok: false, error: 'session not live' });
                return;
            }
            let body: Record<string, unknown>;
            try {
                body = await readBody(req);
            } catch (error) {
                sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'bad body' });
                return;
            }
            let mode: AlignmentMode;
            try {
                mode = validateAlignmentMode(body.mode);
            } catch (error) {
                sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'invalid mode' });
                return;
            }
            try {
                await controller.setSessionMode(agent.session, mode);
                sendJson(res, 200, controller.alignmentStatusPayload(agent));
            } catch (error) {
                sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'failed to set session mode' });
            }
            return;
        }

        if (path === ROUTE_BASE + '/mode' && method === 'DELETE') {
            const sessionId = sessionIdOf(url);
            if (sessionId === undefined) {
                sendJson(res, 400, { ok: false, error: 'sessionId is required' });
                return;
            }
            const agent = controller.liveAgent(sessionId);
            if (agent === undefined) {
                sendJson(res, 404, { ok: false, error: 'session not live' });
                return;
            }
            try {
                await controller.clearSessionOverride(agent.session);
                sendJson(res, 200, controller.alignmentStatusPayload(agent));
            } catch (error) {
                sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'failed to reset session mode' });
            }
            return;
        }

        // ── shared (runtime) mutations ────────────────────────────────────────
        if (path === ROUTE_BASE + '/shared-mode' && method === 'PUT') {
            let body: Record<string, unknown>;
            try {
                body = await readBody(req);
            } catch (error) {
                sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'bad body' });
                return;
            }
            let mode: AlignmentMode;
            try {
                mode = validateAlignmentMode(body.mode);
            } catch (error) {
                sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'invalid mode' });
                return;
            }
            try {
                await controller.setMode(mode);
                sendJson(res, 200, { ok: true, snapshot: controller.modeStore.getSnapshot() });
            } catch (error) {
                sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'failed to set shared mode' });
            }
            return;
        }

        if (path === ROUTE_BASE + '/shared-mode' && method === 'DELETE') {
            try {
                await controller.resetMode();
                sendJson(res, 200, { ok: true, snapshot: controller.modeStore.getSnapshot() });
            } catch (error) {
                sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'failed to reset shared mode' });
            }
            return;
        }

        sendJson(res, 404, { ok: false, error: 'not found' });
    };

    return {
        register(webServer: WebServerLike): () => void {
            return webServer.register({ kind: 'prefix', path: ROUTE_BASE, handler: handle });
        }
    };
}