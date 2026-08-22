import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Agent } from '@deepseek-ai/dsh-agent';
import {
    createManagementApi,
    MUTATION_HEADER,
    ROUTE_BASE,
    type AlignmentStatusPayload,
    type WebServerLike
} from '../src/management-api.ts';
import type { AlignmentMode } from '../src/types.ts';
import { mountController, mountAgent } from './helpers.ts';

/**
 * Minimal fake controller: the management API only touches the controller
 * surface exercised by the capsule — liveAgent, alignmentStatusPayload, the
 * two mode stores, and the shared-layer setMode/resetMode. Everything else is
 * a throwing double so a test that reaches an unexpected path fails loudly.
 */
function fakeController(options: { notLive?: boolean } = {}) {
    const sessionOverrideRecord: { mode?: AlignmentMode } = {};
    const sharedOverrideRecord: { mode?: AlignmentMode } = {};
    const calls: string[] = [];
    // Faithful mini four-layer resolution: session override → shared override → profile 'auto'.
    const effective = () =>
        sessionOverrideRecord.mode ?? sharedOverrideRecord.mode ?? 'auto';
    const effectiveSource = () =>
        sessionOverrideRecord.mode !== undefined ? ('session' as const) : sharedOverrideRecord.mode !== undefined ? ('override' as const) : ('profile' as const);
    const controller = {
        calls,
        sessionOverrideRecord,
        sharedOverrideRecord,
        liveAgent: (id: string) => {
            calls.push(`liveAgent:${id}`);
            return options.notLive ? undefined : ({ id, session: { id } } as unknown as Agent);
        },
        alignmentStatusPayload: (agent: unknown) => {
            calls.push(`status:${(agent as { id: string }).id}`);
            return {
                ok: true,
                session: {
                    id: (agent as { id: string }).id,
                    effectiveMode: effective(),
                    effectiveSource: effectiveSource(),
                    sessionOverride: sessionOverrideRecord.mode ?? null,
                    sharedOverride: sharedOverrideRecord.mode ?? null,
                    profileDefault: 'auto'
                },
                baseline: { revision: 0, status: 'unknown', driftCount: 0, manualChecks: 0 }
            } satisfies AlignmentStatusPayload;
        },
        sessionModeStore: {
            setOverride: async (session: unknown, mode: AlignmentMode) => {
                calls.push(`setOverride:${(session as { id: string }).id}:${mode}`);
                sessionOverrideRecord.mode = mode;
            },
            clearOverride: async (session: unknown) => {
                calls.push(`clearOverride:${(session as { id: string }).id}`);
                delete sessionOverrideRecord.mode;
            }
        },
        setSessionMode: async (session: unknown, mode: AlignmentMode) => {
            calls.push(`setSessionMode:${(session as { id: string }).id}:${mode}`);
            sessionOverrideRecord.mode = mode;
        },
        clearSessionOverride: async (session: unknown) => {
            calls.push(`clearSessionOverride:${(session as { id: string }).id}`);
            delete sessionOverrideRecord.mode;
        },
        modeStore: {
            getSnapshot: () => ({
                defaultMode: 'auto',
                overrideMode: sharedOverrideRecord.mode,
                effectiveMode: sharedOverrideRecord.mode ?? 'auto',
                effectiveSource: sharedOverrideRecord.mode !== undefined ? 'override' : 'profile'
            })
        },
        setMode: async (mode: AlignmentMode) => {
            calls.push(`setMode:${mode}`);
            sharedOverrideRecord.mode = mode;
            return controller.modeStore.getSnapshot();
        },
        resetMode: async () => {
            calls.push('resetMode');
            delete sharedOverrideRecord.mode;
            return controller.modeStore.getSnapshot();
        }
    };
    return controller;
}

/** Capture the routes the API registers on a fake web server. */
function captureWebServer() {
    const routes: Array<{
        kind: 'exact' | 'prefix';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }> = [];
    const webServer: WebServerLike = {
        register(route) {
            routes.push(route);
            return () => {
                const i = routes.indexOf(route);
                if (i >= 0) routes.splice(i, 1);
            };
        }
    };
    return { webServer, routes };
}

/** Build a fake request, optionally reaching the router directly. */
function makeRequest(
    method: string,
    url: string,
    options: { host?: string; origin?: string; header?: string; body?: unknown } = {}
): IncomingMessage {
    // `header` is omitted by default (every mutation looks authorized); pass
    // `header: undefined` explicitly to simulate a request WITHOUT the CSRF
    // header, which must be rejected.
    const header = 'header' in options ? options.header : '1';
    const req = {
        method,
        url,
        headers: {
            host: options.host ?? '127.0.0.1:3080',
            origin: options.origin ?? 'http://127.0.0.1:3080',
            [MUTATION_HEADER]: header
        },
        socket: { remoteAddress: '127.0.0.1' }
    } as unknown as IncomingMessage;
    if (options.body !== undefined) {
        (req as unknown as { body?: string }).body = JSON.stringify(options.body);
    }
    // A minimal async iterator so `for await (const chunk of req)` works.
    (req as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> })[Symbol.asyncIterator] = () => {
        const body = (req as unknown as { body?: string }).body;
        const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')];
        let i = 0;
        return {
            next: async () => (i < chunks.length ? { done: false, value: chunks[i++]! } : { done: true, value: undefined })
        };
    };
    return req;
}

/** Collect the JSON a fake res wrote. */
function makeResponse(): { res: ServerResponse; statusCode: () => number; body: () => unknown } {
    const out: { statusCode: number; body: unknown } = { statusCode: 0, body: undefined };
    const res = {
        set statusCode(value: number) {
            out.statusCode = value;
        },
        get statusCode() {
            return out.statusCode;
        },
        writeHead(status: number, _headers: unknown) {
            out.statusCode = status;
            return res;
        },
        end(payload?: unknown) {
            out.body = payload === undefined ? undefined : JSON.parse(String(payload));
            return res;
        },
        setHeader: () => res
    } as unknown as ServerResponse;
    return { res, statusCode: () => out.statusCode, body: () => out.body };
}

/** Drive one request through the registered prefix handler. */
async function dispatch(
    api: ReturnType<typeof createManagementApi>,
    req: IncomingMessage,
    res: ServerResponse
): Promise<void> {
    const captured = captureWebServer();
    api.register(captured.webServer);
    assert.equal(captured.routes.length, 1);
    await captured.routes[0]!.handler(req, res);
}

// --------------------------------------------------------------------- tests

test('management-api: register mounts the prefix route under the base path', () => {
    const api = createManagementApi(fakeController() as never);
    const captured = captureWebServer();
    const disposer = api.register(captured.webServer);
    assert.equal(captured.routes.length, 1);
    assert.equal(captured.routes[0]!.kind, 'prefix');
    assert.equal(captured.routes[0]!.path, ROUTE_BASE);
    disposer();
    assert.equal(captured.routes.length, 0);
});

test('management-api: GET /status resolves the four-layer payload for a live session', async () => {
    const controller = fakeController();
    controller.sharedOverrideRecord.mode = 'manual';
    const api = createManagementApi(controller as never);
    const { res, statusCode, body } = makeResponse();
    await dispatch(api, makeRequest('GET', ROUTE_BASE + '/status?sessionId=abc'), res);
    assert.equal(statusCode(), 200);
    assert.equal(controller.calls.includes('status:abc'), true);
    const payload = body() as AlignmentStatusPayload;
    // Shared override 'manual' is the effective source with nothing at session layer.
    assert.equal(payload.session.effectiveMode, 'manual');
    assert.equal(payload.session.effectiveSource, 'override');
    assert.equal(payload.session.sessionOverride, null);
    assert.equal(payload.session.sharedOverride, 'manual');
    assert.equal(payload.session.profileDefault, 'auto');
});

test('management-api: GET /status without sessionId is a 400', async () => {
    const api = createManagementApi(fakeController() as never);
    const { res, statusCode } = makeResponse();
    await dispatch(api, makeRequest('GET', ROUTE_BASE + '/status'), res);
    assert.equal(statusCode(), 400);
});

test('management-api: GET /status on a non-live session is a 404', async () => {
    const controller = fakeController({ notLive: true });
    const api = createManagementApi(controller as never);
    const { res, statusCode } = makeResponse();
    await dispatch(api, makeRequest('GET', ROUTE_BASE + '/status?sessionId=ghost'), res);
    assert.equal(statusCode(), 404);
    assert.equal(controller.calls.includes('status:ghost'), false);
});

test('management-api: PUT /mode sets the session override and returns the new status', async () => {
    const controller = fakeController();
    const api = createManagementApi(controller as never);
    const { res, statusCode, body } = makeResponse();
    await dispatch(api, makeRequest('PUT', ROUTE_BASE + '/mode?sessionId=abc', { body: { mode: 'off' } }), res);
    assert.equal(statusCode(), 200);
    assert.equal(controller.calls.includes('setSessionMode:abc:off'), true);
    assert.equal(controller.sessionOverrideRecord.mode, 'off');
    const payload = body() as AlignmentStatusPayload;
    assert.equal(payload.session.effectiveMode, 'off');
    assert.equal(payload.session.effectiveSource, 'session');
});

test('management-api: PUT /mode on a non-live session is a 404', async () => {
    const controller = fakeController({ notLive: true });
    const api = createManagementApi(controller as never);
    const { res, statusCode } = makeResponse();
    await dispatch(api, makeRequest('PUT', ROUTE_BASE + '/mode?sessionId=ghost', { body: { mode: 'off' } }), res);
    assert.equal(statusCode(), 404);
    assert.equal(controller.calls.includes('setSessionMode:ghost:off'), false);
});

test('management-api: DELETE /mode clears the session override', async () => {
    const controller = fakeController();
    controller.sessionOverrideRecord.mode = 'off';
    const api = createManagementApi(controller as never);
    const { res, statusCode } = makeResponse();
    await dispatch(api, makeRequest('DELETE', ROUTE_BASE + '/mode?sessionId=abc'), res);
    assert.equal(statusCode(), 200);
    assert.equal(controller.calls.includes('clearSessionOverride:abc'), true);
    assert.equal(controller.sessionOverrideRecord.mode, undefined);
});

test('management-api: PUT /shared-mode persists through setMode and returns the snapshot', async () => {
    const controller = fakeController();
    const api = createManagementApi(controller as never);
    const { res, statusCode, body } = makeResponse();
    await dispatch(api, makeRequest('PUT', ROUTE_BASE + '/shared-mode', { body: { mode: 'manual' } }), res);
    assert.equal(statusCode(), 200);
    assert.equal(controller.calls.includes('setMode:manual'), true);
    assert.equal(controller.sharedOverrideRecord.mode, 'manual');
    assert.equal((body() as { snapshot: { effectiveMode: string } }).snapshot.effectiveMode, 'manual');
});

test('management-api: DELETE /shared-mode resets the shared override', async () => {
    const controller = fakeController();
    controller.sharedOverrideRecord.mode = 'manual';
    const api = createManagementApi(controller as never);
    const { res, statusCode } = makeResponse();
    await dispatch(api, makeRequest('DELETE', ROUTE_BASE + '/shared-mode'), res);
    assert.equal(statusCode(), 200);
    assert.equal(controller.calls.includes('resetMode'), true);
    assert.equal(controller.sharedOverrideRecord.mode, undefined);
});

test('management-api: an invalid mode is rejected with a 400 and no write', async () => {
    const controller = fakeController();
    const api = createManagementApi(controller as never);
    const { res, statusCode } = makeResponse();
    await dispatch(api, makeRequest('PUT', ROUTE_BASE + '/shared-mode', { body: { mode: 'nonsense' } }), res);
    assert.equal(statusCode(), 400);
    assert.equal(controller.calls.includes('setMode:nonsense'), false);
});

test('management-api: a mutation without the CSRF header is rejected', async () => {
    const controller = fakeController();
    const api = createManagementApi(controller as never);
    const { res, statusCode } = makeResponse();
    await dispatch(api, makeRequest('PUT', ROUTE_BASE + '/shared-mode', { body: { mode: 'manual' }, header: undefined }), res);
    assert.equal(statusCode(), 403);
    assert.equal(controller.calls.includes('setMode:manual'), false);
});

test('management-api: a mutation from a non-loopback origin is rejected', async () => {
    const controller = fakeController();
    const api = createManagementApi(controller as never);
    const { res, statusCode } = makeResponse();
    await dispatch(api, makeRequest('PUT', ROUTE_BASE + '/shared-mode', {
        body: { mode: 'manual' },
        origin: 'http://evil.example.com'
    }), res);
    assert.equal(statusCode(), 403);
    assert.equal(controller.calls.includes('setMode:manual'), false);
});

test('management-api: a mutation from a non-loopback remote is rejected', async () => {
    const controller = fakeController();
    const api = createManagementApi(controller as never);
    const { res, statusCode } = makeResponse();
    const req = makeRequest('PUT', ROUTE_BASE + '/shared-mode', { body: { mode: 'manual' } });
    (req.socket as { remoteAddress: string }).remoteAddress = '203.0.113.9';
    await dispatch(api, req, res);
    assert.equal(statusCode(), 403);
    assert.equal(controller.calls.includes('setMode:manual'), false);
});

test('management-api: unknown route returns 404', async () => {
    const controller = fakeController();
    const api = createManagementApi(controller as never);
    const { res, statusCode } = makeResponse();
    await dispatch(api, makeRequest('GET', ROUTE_BASE + '/nope'), res);
    assert.equal(statusCode(), 404);
});
test('management-api: a failed capability transition returns 500, never a fake target-active 200', async () => {
    const h = await mountController({ mode: 'manual' });
    try {
        const a = await mountAgent(h, { id: 's-api-mut-fail' });
        const api = createManagementApi(h.controller as never);
        h.systemPrompt.failSections = true;
        const { res, statusCode, body } = makeResponse();
        await dispatch(api, makeRequest('PUT', ROUTE_BASE + '/shared-mode', { body: { mode: 'auto' } }), res);
        assert.equal(statusCode(), 500, 'a capability failure must not return a target-active 200');
        const errBody = body() as { ok: false; error: string };
        assert.equal(errBody.ok, false);
        assert.match(errBody.error, /injected section registration failure/);
        
        // The source was compensated back; a following GET shows the REAL state.
        h.systemPrompt.failSections = false;
        const { res: res2, statusCode: status2, body: body2 } = makeResponse();
        await dispatch(api, makeRequest('GET', ROUTE_BASE + '/status?sessionId=s-api-mut-fail'), res2);
        assert.equal(status2(), 200);
        const st = body2() as AlignmentStatusPayload;
        assert.equal(st.session.effectiveMode, 'manual', 'advertised effective mode is the compensated previous mode');
        assert.equal(h.controller.agentCapabilities.get(String(a.agent.id))?.mode, 'manual', 'active capability matches');
    } finally {
        await h.dispose();
    }
});