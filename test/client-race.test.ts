/**
 * Alignment Capsule stale-session race tests (E-H).
 *
 * The pre-fix capsule polled GET /status in a refresh whose closure captured
 * currentSessionId, and the old fake-React render test implemented useEffect
 * as a no-op - so no real request ever ran and the A->B out-of-order race was
 * invisible. This file runs the production capsule against a tiny but REAL
 * hooks renderer: effects run after every commit (with dependency comparison
 * and cleanup), state updates schedule re-renders, and fetch is a controllable
 * stub so responses can be resolved out of order.
 *
 * It proves the generation-token fix: a late response from a previous session
 * is dropped, a session->no-session switch invalidates the snapshot
 * immediately (and never builds ?sessionId=undefined), session mutations
 * always target the current session, and rapid A->B->C switching only ever
 * shows C.
 *
 * The dynamic import below is only valid AFTER pnpm run build has run, so
 * this test is exercised by pnpm test (never typecheck/lint).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// ------------------------------------------------------------------- globals
// Everything must be installed BEFORE the bundle is imported: the module calls
// window.__ModuleLoader__.load at load time.
const GS = globalThis as Record<string, unknown>;
const realFetch = GS.fetch;

const docListeners = new Map<string, Set<() => void>>();
const documentStub = {
  visibilityState: 'visible',
  head: { appendChild(): void { /* no-op */ } },
  createElement(): { setAttribute(): void; appendChild(): void } {
    return { setAttribute(): void { /* no-op */ }, appendChild(): void { /* no-op */ } };
  },
  getElementById(): null {
    return null;
  },
  addEventListener(name: string, fn: () => void): void {
    let set = docListeners.get(name);
    if (set === undefined) {
      set = new Set();
      docListeners.set(name, set);
    }
    set.add(fn);
  },
  removeEventListener(name: string, fn: () => void): void {
    docListeners.get(name)?.delete(fn);
  },
};
GS.window = {
  __ModuleLoader__: {
    load(entry: { factory: (require: (id: string) => unknown) => unknown }): void {
      (GS.window as Record<string, unknown>).__dshClientExports = entry.factory((id: string): unknown => {
        if (id === 'react') return fakeReact;
        throw new Error('Unexpected client require: ' + id);
      });
    },
  },
};
GS.document = documentStub;

// The hooks above are function declarations (hoisted), so this facade may be
// published to the ModuleLoader right away — the loader's factory resolves
// require('react') to it BEFORE any component renders.
const fakeReact = { createElement, useState, useCallback, useEffect, useRef };

// The bundle is cached per URL; a query string forces a fresh execution against
// THIS window's loader regardless of which test file imported it first.
await import('../lib/client.js?client-race=' + Math.random());

interface ClientExports {
  apply: (ctx?: unknown) => unknown;
  AlignmentCapsule: (props: Record<string, unknown>) => unknown;
  modeColor: (mode: string) => string;
  dictionaries: { zh: Record<string, string>; en: Record<string, string> };
}
const clientExports = (GS.window as Record<string, unknown>).__dshClientExports as ClientExports;
const { AlignmentCapsule, dictionaries } = clientExports;
// A concrete-literal view so t('key') is string, not string | undefined.
const EN = dictionaries.en as Record<string, string>;
const t = (key: string): string => EN[key] ?? key;

// ------------------------------------------------------------- minimal React
// Hooks are real here: deps are compared, effects run after every commit with
// cleanup, setState schedules a re-render through a microtask. This is what the
// pre-fix test lacked (useEffect was a no-op), so stale async responses were
// never observable. Only the capsule uses hooks, but the renderer keys hook
// state per ELEMENT NODE (the same identity rule as the shell's reconciler).
type ElType = unknown;
type ElProps = Record<string, unknown>;
interface El {
  type: ElType;
  props: ElProps;
}
interface HookHost {
  index: number;
  values: unknown[];
  root: RootNode | null;
}
interface EffectRec {
  __effect: true;
  effect: () => unknown;
  deps: unknown[] | undefined;
  cleanup: unknown;
  changed: boolean;
}
interface RootNode {
  element: El;
  host: HookHost;
  mounted: boolean;
  dirty: boolean;
  queued: boolean;
  facts: Fact[];
}

let activeRoot: RootNode | undefined;
let currentHost: HookHost | undefined;
const hosts = new WeakMap<object, HookHost>();
const touched = new Set<HookHost>();
const roots: RootNode[] = [];

function sameDeps(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every((value, idx) => Object.is(value, b[idx]));
}

function createElement(type: ElType, props: ElProps | null | undefined, ...children: unknown[]): El {
  if (children.length > 0) {
    return { type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } };
  }
  return { type, props: props ?? {} };
}

function useState<T>(initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const host = currentHost!;
  const idx = host.index++;
  if (idx >= host.values.length) host.values.push({ __value: initial });
  const slot = host.values[idx] as { __value: T };
  const set = (value: T | ((prev: T) => T)): void => {
    const next = typeof value === 'function' ? (value as (prev: T) => T)(slot.__value) : value;
    if (Object.is(next, slot.__value)) return;
    slot.__value = next;
    if (host.root !== null) {
      host.root.dirty = true;
      schedule(host.root);
    }
  };
  return [slot.__value, set];
}

function useRef<T>(initial: T): { current: T } {
  const host = currentHost!;
  const idx = host.index++;
  if (idx >= host.values.length) host.values.push({ __ref: { current: initial } });
  return (host.values[idx] as { __ref: { current: T } }).__ref;
}

function useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: unknown[] | undefined): T {
  const host = currentHost!;
  const idx = host.index++;
  const prev = host.values[idx] as { __cb: T; deps: unknown[] | undefined } | undefined;
  if (prev !== undefined && prev.__cb !== undefined && sameDeps(prev.deps, deps)) return prev.__cb;
  host.values[idx] = { __cb: fn, deps };
  return fn;
}

function useEffect(fn: () => unknown, deps: unknown[] | undefined): void {
  const host = currentHost!;
  const idx = host.index++;
  const prev = host.values[idx] as EffectRec | undefined;
  if (prev !== undefined && prev.__effect && sameDeps(prev.deps, deps)) {
    prev.changed = false;
    return;
  }
  host.values[idx] = { __effect: true, effect: fn, deps, cleanup: prev?.cleanup, changed: true };
}

// ------------------------------------------------------------------ renderer
interface Fact {
  kind: 'text' | 'element' | 'function';
  text?: string;
  tag?: string;
  props?: ElProps;
}

function collect(element: unknown, out: Fact[]): void {
  if (element === null || element === undefined || typeof element === 'boolean') return;
  if (Array.isArray(element)) {
    for (const child of element) collect(child, out);
    return;
  }
  if (typeof element === 'string' || typeof element === 'number') {
    out.push({ kind: 'text', text: String(element) });
    return;
  }
  if (typeof element !== 'object') return;
  const el = element as El;
  if (typeof el.type === 'function') {
    let host = hosts.get(element as object);
    if (host === undefined) {
      host = { index: 0, values: [], root: activeRoot ?? null };
      hosts.set(element as object, host);
    } else {
      host.index = 0;
    }
    touched.add(host);
    const prev = currentHost;
    currentHost = host;
    try {
      collect((el.type as (p: ElProps) => unknown)(el.props ?? {}), out);
    } finally {
      currentHost = prev;
    }
    return;
  }
  out.push({ kind: 'element', tag: String(el.type), props: el.props ?? {} });
  collect(el.props?.children, out);
}

function flushEffects(): void {
  const changed: EffectRec[] = [];
  for (const host of touched) {
    for (const value of host.values) {
      const rec = value as EffectRec | undefined;
      if (rec !== undefined && rec.__effect && rec.changed) changed.push(rec);
    }
  }
  for (const rec of changed) {
    if (typeof rec.cleanup === 'function') {
      try {
        (rec.cleanup as () => void)();
      } catch {
        // a throwing cleanup must not abort the commit
      }
      rec.cleanup = undefined;
    }
  }
  for (const rec of changed) {
    try {
      const cleanup = rec.effect();
      rec.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    } catch {
      // a throwing effect must not abort the commit
    }
    rec.changed = false;
  }
}

function renderRoot(root: RootNode): void {
  if (!root.mounted) return;
  root.dirty = false;
  const prevRoot = activeRoot;
  const prevHost = currentHost;
  activeRoot = root;
  currentHost = undefined;
  touched.clear();
  const facts: Fact[] = [];
  try {
    collect(root.element, facts);
  } finally {
    currentHost = prevHost;
    activeRoot = prevRoot;
  }
  root.facts = facts;
  flushEffects();
}

function schedule(root: RootNode): void {
  if (!root.mounted || root.queued) return;
  root.queued = true;
  queueMicrotask(() => {
    root.queued = false;
    if (root.mounted && root.dirty) renderRoot(root);
  });
}

function mount(element: El): RootNode {
  const host: HookHost = { index: 0, values: [], root: null };
  const root: RootNode = { element, host, mounted: true, dirty: false, queued: false, facts: [] };
  host.root = root;
  hosts.set(element, host); // collect must REUSE this host so unmount finds its effect cleanups
  roots.push(root);
  renderRoot(root);
  return root;
}

function unmount(root: RootNode): void {
  if (!root.mounted) return;
  root.mounted = false;
  for (const value of root.host.values) {
    const rec = value as EffectRec | undefined;
    if (rec !== undefined && rec.__effect && typeof rec.cleanup === 'function') {
      try {
        (rec.cleanup as () => void)();
      } catch {
        // ignore
      }
      rec.cleanup = undefined;
    }
  }
  const at = roots.indexOf(root);
  if (at >= 0) roots.splice(at, 1);
}

// ------------------------------------------------------------------- fetch
interface FetchCall {
  url: string;
  method: string;
  body: string | undefined;
  prompt: Promise<{ json: () => Promise<unknown> }>;
  resolve: (response: { json: () => Promise<unknown> }) => void;
}

let fetchImpl: (url: string, options?: { method?: string; body?: string }) => Promise<{ json: () => Promise<unknown> }> = () =>
  Promise.reject(new Error('no fetch stub installed'));
GS.fetch = ((url: string, options?: { method?: string; body?: string }) => fetchImpl(url, options)) as never;

function makeRecorder(): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  fetchImpl = (url: string, options?: { method?: string; body?: string }): Promise<{ json: () => Promise<unknown> }> => {
    const rec: FetchCall = { url: String(url), method: options?.method ?? 'GET', body: options?.body, prompt: undefined!, resolve: undefined! };
    rec.prompt = new Promise<{ json: () => Promise<unknown> }>((resolve) => {
      rec.resolve = resolve;
    });
    calls.push(rec);
    return rec.prompt;
  };
  return { calls };
}

function statusPayload(sessionId: string, effectiveMode: string): Record<string, unknown> {
  return {
    ok: true,
    session: {
      id: sessionId,
      effectiveMode,
      effectiveSource: 'session',
      sessionOverride: effectiveMode,
      sharedOverride: null,
      profileDefault: 'auto',
    },
    baseline: { revision: 0, status: 'unknown', driftCount: 0, manualChecks: 0 },
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ------------------------------------------------------------------- helpers
function makeUseSessions(): { set(id: string | undefined): void; fn(selector: (s: { current?: string } | undefined) => string | undefined): string | undefined } {
  let current: string | undefined = undefined;
  return {
    set(id: string | undefined): void {
      current = id;
    },
    fn(selector: (s: { current?: string } | undefined) => string | undefined): string | undefined {
      // The capsule calls useSessions(selector); we hand it the live session
      // envelope (or undefined) exactly like the shell's hook.
      return selector(current === undefined ? undefined : { current });
    },
  };
}

function texts(facts: Fact[]): string[] {
  return facts.filter((fact) => fact.kind === 'text').map((fact) => fact.text ?? '');
}

function capsuleLabel(root: RootNode): string {
  // The capsule button is the FIRST child of the root, so while collapsed its
  // label is the first text fact.
  return texts(root.facts)[0] ?? '';
}

interface ButtonLike {
  text: string;
  props: ElProps;
}
function buttons(facts: Fact[]): ButtonLike[] {
  return facts
    .filter((fact) => fact.kind === 'element' && fact.tag === 'button')
    .map((fact) => ({ text: typeof fact.props!.children === 'string' ? fact.props!.children : '', props: fact.props! }));
}

// --------------------------------------------------------------------- tests
test('client-race: effects really run — mount issues a status request for the current session without any manual refresh', async () => {
  const rec = makeRecorder();
  const sess = makeUseSessions();
  sess.set('session-A');
  const root = mount(createElement(AlignmentCapsule, { t, useSessions: sess.fn }));
  try {
    await tick();
    assert.equal(rec.calls.length, 1, 'the poll effect must issue exactly one status request on mount');
    assert.ok(rec.calls[0]!.url.includes('sessionId=session-A'), 'the request targets the mounted session');

    rec.calls[0]!.resolve({ json: async () => statusPayload('session-A', 'manual') });
    await tick();
    assert.equal(capsuleLabel(root), 'Manual', 'the resolved snapshot renders through the real effect path');
  } finally {
    unmount(root);
  }
});

test('client-race: E — A -> B with out-of-order responses only ever shows the current session', async () => {
  const rec = makeRecorder();
  const sess = makeUseSessions();
  sess.set('session-A');
  const root = mount(createElement(AlignmentCapsule, { t, useSessions: sess.fn }));
  try {
    await tick();
    assert.equal(rec.calls.length, 1, 'mount requests A');
    assert.ok(rec.calls[0]!.url.includes('sessionId=session-A'));

    // Switch A -> B while A is still in flight.
    sess.set('session-B');
    renderRoot(root);
    await tick();
    assert.equal(rec.calls.length, 2, 'switching to B issues a B request');
    assert.ok(rec.calls[1]!.url.includes('sessionId=session-B'));
    assert.equal(capsuleLabel(root), 'Off', 'after the switch the old snapshot is invalidated (loading state, never A)');

    // B resolves first.
    rec.calls[1]!.resolve({ json: async () => statusPayload('session-B', 'manual') });
    await tick();
    assert.equal(capsuleLabel(root), 'Manual', 'B renders');

    // The old A response lands late — it must be dropped, not rendered.
    rec.calls[0]!.resolve({ json: async () => statusPayload('session-A', 'off') });
    await tick();
    assert.equal(capsuleLabel(root), 'Manual', 'stale A response is dropped — the UI stays on B');
    assert.equal(texts(root.facts).some((item) => item === 'Off'), false, 'A state (Off) never leaks in');
  } finally {
    unmount(root);
  }
});

test('client-race: F — A -> no-session clears the snapshot, disables session actions, and never requests sessionId=undefined', async () => {
  const rec = makeRecorder();
  const sess = makeUseSessions();
  sess.set('session-A');
  const root = mount(createElement(AlignmentCapsule, { t, useSessions: sess.fn }));
  try {
    await tick();
    rec.calls[0]!.resolve({ json: async () => statusPayload('session-A', 'manual') });
    await tick();
    assert.equal(capsuleLabel(root), 'Manual', 'A snapshot is shown before the switch');

    // A -> no session.
    sess.set(undefined);
    renderRoot(root);
    await tick();
    assert.notEqual(capsuleLabel(root), 'Manual', 'A snapshot disappears on session removal');
    assert.equal(rec.calls.some((call) => call.url.includes('sessionId=undefined')), false, 'no sessionId=undefined request');

    // Expand: session-scoped buttons are disabled, shared buttons are not.
    const capButton = buttons(root.facts)[0]!;
    (capButton.props.onClick as () => void)();
    renderRoot(root);
    await tick();
    const modeButtons = buttons(root.facts).filter((button) => ['Auto', 'Manual', 'Off'].includes(button.text));
    assert.ok(modeButtons.length >= 6, 'both scope groups render their mode buttons');
    assert.equal(modeButtons.some((button) => button.props.disabled === true), true, 'session-scoped buttons are disabled without a session');
    assert.equal(modeButtons.some((button) => button.props.disabled === undefined || button.props.disabled === false), true, 'shared buttons stay enabled');

    // Even if a disabled session button's handler were invoked, no session/dead-id
    // mutation may be constructed.
    const before = rec.calls.length;
    (modeButtons[0]!.props.onClick as () => void)();
    await tick();
    assert.equal(rec.calls.length, before, 'no session mutation is constructed without a session');

    // The shared scope remains genuinely usable without a session.
    const sharedAuto = modeButtons.find((button) => button.text === 'Auto' && button.props.disabled !== true);
    assert.ok(sharedAuto, 'a shared Auto button is enabled');
    (sharedAuto!.props.onClick as () => void)();
    await tick();
    const put = rec.calls.filter((call) => call.method === 'PUT');
    assert.equal(put.some((call) => call.url.includes('/shared-mode')), true, 'shared mutation targets /shared-mode');
    assert.equal(put.some((call) => call.url.includes('/mode?')), false, 'no session /mode mutation built without a session');
  } finally {
    unmount(root);
  }
});

test('client-race: G — with an old A request pending, a mutation targets the current session B', async () => {
  const rec = makeRecorder();
  const sess = makeUseSessions();
  sess.set('session-A');
  const root = mount(createElement(AlignmentCapsule, { t, useSessions: sess.fn }));
  try {
    await tick(); // A status request pending (never resolved until the end)
    sess.set('session-B');
    renderRoot(root);
    await tick(); // B status request
    assert.ok(rec.calls[1]!.url.includes('sessionId=session-B'));
    assert.notEqual(capsuleLabel(root), 'Manual', 'no stale A state is rendered under B control');

    // Expand and press the SESSION Auto button while A is still pending.
    const capButton = buttons(root.facts)[0]!;
    (capButton.props.onClick as () => void)();
    renderRoot(root);
    await tick();
    const sessionAuto = buttons(root.facts).find((button) => button.text === 'Auto' && button.props.disabled !== true);
    assert.ok(sessionAuto, 'session Auto button present and enabled');
    (sessionAuto!.props.onClick as () => void)();
    await tick();

    // The mutation must target B — never A, never an undefined id.
    const mutation = rec.calls.find((call) => call.method === 'PUT');
    assert.ok(mutation, 'a mutation request was issued');
    assert.ok(mutation!.url.includes('sessionId=session-B'), 'mutation targets the CURRENT session B');
    assert.equal(mutation!.url.includes('sessionId=session-A'), false, 'mutation never targets the stale session A');

    // Let the mutation resolve, then the post-mutation refresh resolves for B.
    mutation!.resolve({ json: async () => ({ ok: true }) });
    await tick();
    const statusCalls = rec.calls.filter((call) => call.method === 'GET');
    const lastStatus = statusCalls[statusCalls.length - 1]!;
    assert.ok(lastStatus.url.includes('sessionId=session-B'), 'post-mutation refresh targets B');
    lastStatus.resolve({ json: async () => statusPayload('session-B', 'manual') });
    await tick();
    assert.equal(capsuleLabel(root), 'Manual', 'the UI shows B after the mutation cycle');

    // The long-pending A response finally arrives late — still dropped.
    rec.calls[0]!.resolve({ json: async () => statusPayload('session-A', 'off') });
    await tick();
    assert.equal(capsuleLabel(root), 'Manual', 'late A response cannot overwrite B');
  } finally {
    unmount(root);
  }
});

test('client-race: H — rapid A -> B -> C resolves out of order but only C is ever shown', async () => {
  const rec = makeRecorder();
  const sess = makeUseSessions();
  sess.set('session-A');
  const root = mount(createElement(AlignmentCapsule, { t, useSessions: sess.fn }));
  try {
    await tick(); // A in flight
    sess.set('session-B');
    renderRoot(root);
    await tick(); // B in flight
    sess.set('session-C');
    renderRoot(root);
    await tick(); // C in flight

    assert.equal(rec.calls.length, 3, 'three status requests across A, B, C');
    assert.equal(capsuleLabel(root), 'Off', 'loading state after the rapid switch (never A or B)');

    // Resolve out of order: C, then A, then B.
    rec.calls[2]!.resolve({ json: async () => statusPayload('session-C', 'auto') });
    await tick();
    assert.equal(capsuleLabel(root), 'Auto', 'C renders first');

    rec.calls[0]!.resolve({ json: async () => statusPayload('session-A', 'off') });
    await tick();
    assert.equal(capsuleLabel(root), 'Auto', 'late A is dropped');

    rec.calls[1]!.resolve({ json: async () => statusPayload('session-B', 'manual') });
    await tick();
    assert.equal(capsuleLabel(root), 'Auto', 'late B is dropped — only C is ever shown');
    assert.equal(texts(root.facts).some((item) => item === 'Manual'), false, 'B state never leaks in');
  } finally {
    unmount(root);
  }
});

// ------------------------------------------------------------------- cleanup
after(() => {
  for (const root of [...roots]) unmount(root);
  delete GS.window;
  delete GS.document;
  GS.fetch = realFetch;
});
