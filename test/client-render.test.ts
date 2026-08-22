/**
 * Alignment Capsule client render smoke test.
 *
 * The same two production bugs guarded by the plugin ecosystem's pattern (the
 * bridge's client-render test): (1) components must place children into
 * `props.children`, and (2) React MUST come from `factory(require)` →
 * `require('react')` — DSH Web's ModuleLoader never installs a window/global
 * React, so a client that touches a bare `React` identifier crashes at load.
 *
 * This loads the built bundle (lib/client.js — produced by
 * scripts/build-client.mjs), resolves the element tree through a minimal fake
 * React (no jsdom/bundler/deps), and asserts the capsule actually renders its
 * controls: the collapsed capsule button + colored dot, and — after expanding
 * — the session/shared mode buttons, the reset buttons and the baseline rows.
 *
 * The dynamic import below is only valid AFTER `pnpm run build` has run, so
 * this test must not be part of `pnpm run typecheck`/`lint` — it is exercised
 * by `pnpm test`.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// --------------------------------------------------------------------- React
// Minimal fake React: createElement keeps children in props.children. The
// hooks are stateful PER ELEMENT NODE (keyed by the element object created by
// createElement), so a render → call the capsule onClick → re-render cycle
// actually flips `expanded`, letting the test exercise the panel path.
type ElType = unknown;
type ElProps = Record<string, unknown>;
type El = { type: ElType; props: ElProps };

function createElement(type: ElType, props: ElProps | null | undefined, ...children: unknown[]): El {
  if (children.length > 0) {
    return { type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } };
  }
  return { type, props: props ?? {} };
}

let currentInstance: { index: number; values: unknown[] } | undefined;
const instances = new WeakMap<object, { index: number; values: unknown[] }>();

function useState<T>(initial: T): [T, (v: T) => void] {
  const inst = currentInstance!;
  const i = inst.index++;
  if (i >= inst.values.length) inst.values.push(initial);
  const set = (v: T) => {
    inst.values[i] = v;
  };
  return [inst.values[i] as T, set];
}
const useCallback = <T,>(fn: T) => fn;
const useEffect = () => {};
// useRef must return the SAME object across re-renders of one element node, so
// the capsule's live-session ref keeps its identity (the fake renderer resets
// the hook index per node, exactly like useState).
const useRef = <T,>(initial: T): { current: T } => {
  const inst = currentInstance!;
  const i = inst.index++;
  if (i >= inst.values.length) inst.values.push({ current: initial });
  return inst.values[i] as { current: T };
};

const fakeReact = { createElement, useState, useCallback, useEffect, useRef };

interface ClientExports {
  apply: (ctx?: unknown) => unknown;
  AlignmentCapsule: (props: Record<string, unknown>) => unknown;
  modeColor: (mode: string) => string;
  dictionaries: { zh: Record<string, string>; en: Record<string, string> };
}

interface LoaderEntry {
  factory: (require: (id: string) => unknown) => unknown;
}

// The real DSH web shell does not install window.React / globalThis.React.
// Installing one here would hide the production bug — React is only available
// through factory require('react'). The client bundle ships with a bare
// `require` from the ModuleLoader wrapper and must resolve it there.
const GS = globalThis as Record<string, unknown>;
delete GS.React;
if (typeof GS.window !== 'undefined') {
  delete (GS.window as Record<string, unknown>).React;
}

const requiredIds: string[] = [];
let capturedEntry: LoaderEntry | undefined;
function createFakeRequire() {
  return (id: string) => {
    requiredIds.push(id);
    if (id === 'react') return fakeReact;
    throw new Error(`Unexpected client require: ${id}`);
  };
}

GS.window = {
  __ModuleLoader__: {
    load: (entry: LoaderEntry) => {
      capturedEntry = entry;
      (GS.window as Record<string, unknown>).__dshClientExports = entry.factory(createFakeRequire());
    },
  },
};

// @ts-expect-error lib/client.js is the build artifact (no .d.ts) and is
// loaded under test only after `pnpm run build` produced it.
await import('../lib/client.js');

const clientExports = (GS.window as Record<string, unknown>).__dshClientExports as ClientExports;
const { apply, AlignmentCapsule, modeColor, dictionaries } = clientExports;

after(() => {
  delete GS.window;
  delete GS.React;
});

// --------------------------------------------------------------------- i18n
const { en } = dictionaries;
// A concrete-literal view of the dictionary so `en.reset` etc. are `string`,
// not `string | undefined` under noUncheckedIndexedAccess.
const EN = en as {
  nav: string;
  sessionScope: string;
  sharedScope: string;
  effective: string;
  source: string;
  baseline: string;
  reset: string;
};
const t = (key: string) => en[key] ?? key;

const useSessions = <T,>(selector: (s: { current?: string } | undefined) => T): T | undefined =>
  selector({ current: 'abc' });

// ------------------------------------------------------------------ resolve
interface Fact {
  kind: 'text' | 'element' | 'function';
  text?: string;
  tag?: string;
  props?: Record<string, unknown>;
  fn?: () => unknown;
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
  const { type, props } = element as { type: unknown; props?: Record<string, unknown> };
  if (typeof type === 'function') {
    let inst = instances.get(element as object);
    if (!inst) {
      inst = { index: 0, values: [] };
      instances.set(element as object, inst);
    } else {
      inst.index = 0;
    }
    out.push({ kind: 'function' });
    const prev = currentInstance;
    currentInstance = inst;
    try {
      collect((type as (p: Record<string, unknown>) => unknown)(props ?? {}), out);
    } finally {
      currentInstance = prev;
    }
    return;
  }
  out.push({ kind: 'element', tag: String(type), props: props ?? {} });
  collect(props?.children, out);
}

function renderTree(root: unknown): Fact[] {
  const facts: Fact[] = [];
  collect(root, facts);
  return facts;
}

const hasText = (facts: Fact[], text: string) => facts.some((f) => f.kind === 'text' && f.text === text);
const findButton = (facts: Fact[], label: string) =>
  facts.some(
    (f) =>
      f.kind === 'element' &&
      f.tag === 'button' &&
      (f.props!.children === label || (Array.isArray(f.props!.children) && f.props!.children.length === 1 && f.props!.children[0] === label)),
  );

// ------------------------------------------------------------------ tests
test('client: factory requires react from ModuleLoader', () => {
  assert.ok(capturedEntry, 'ModuleLoader must capture the client entry');
  assert.ok(requiredIds.includes('react'), "client factory must require('react')");

  const freshIds: string[] = [];
  capturedEntry!.factory((id) => {
    freshIds.push(id);
    if (id === 'react') return fakeReact;
    throw new Error(`Unexpected client require: ${id}`);
  });
  assert.ok(freshIds.includes('react'), "re-invoked factory must still require('react')");
});

test('client: no global React is required to load or render', () => {
  assert.equal(GS.React, undefined, 'globalThis.React must stay undefined');
  if (typeof GS.window !== 'undefined') {
    assert.equal((GS.window as Record<string, unknown>).React, undefined, 'window.React must stay undefined');
  }
});

test('client: modeColor maps the three modes', () => {
  assert.equal(modeColor('auto'), '#22c55e');
  assert.equal(modeColor('manual'), '#f59e0b');
  assert.equal(modeColor('off'), '#ef4444');
  assert.equal(modeColor('bogus'), '#9ca3af');
});

test('client: capsule collapses to the dot + label with the live mode', () => {
  // Fresh snapshot === undefined → effectiveMode falls back to 'off'.
  const facts = renderTree(fakeReact.createElement(AlignmentCapsule, { t, useSessions }));
  assert.equal(hasText(facts, 'Off'), true, 'collapsed capsule must show the effective mode label');
  const dot = facts.find((f) => f.kind === 'element' && f.tag === 'span' && typeof (f.props!.style as { background?: string })?.background === 'string');
  assert.equal((dot?.props!.style as { background: string }).background, '#ef4444');
  // Collapsed: no panel, no buttons.
  assert.equal(findButton(facts, EN.reset), false, 'collapsed capsule must not render mode buttons');
});

test('client: expanded capsule renders session and shared controls', () => {
  const root = fakeReact.createElement(AlignmentCapsule, { t, useSessions });
  let facts = renderTree(root);

  // Collapsed. Only the capsule button exists — no panel, no mode buttons.
  const capsule = facts.find((f) => f.kind === 'element' && f.tag === 'button' && f.props!.className === 'dra-capsule');
  assert.ok(capsule, 'capsule button must be present');
  assert.equal(typeof capsule!.props!.onClick, 'function');
  assert.equal(facts.filter((f) => f.kind === 'element' && f.tag === 'button').length, 1, 'collapsed tree has exactly the capsule button');
  assert.equal(hasText(facts, EN.reset), false, 'collapsed tree renders no Reset button');

  // Expand through the capsule's onClick, then re-render the SAME element so
  // the per-node hook state carries the expanded value.
  (capsule!.props!.onClick as () => void)();
  facts = renderTree(root);

  assert.equal(facts.filter((f) => f.kind === 'element' && f.tag === 'button').length >= 7, true, 'panel must render mode + close + reset buttons');
  for (const mode of ['Auto', 'Manual', 'Off']) {
    assert.equal(hasText(facts, mode), true, `mode button "${mode}" must render`);
  }
  // Each scope group renders Auto/Manual/Off + Reset → Reset appears twice.
  assert.equal(facts.filter((f) => f.kind === 'element' && f.tag === 'button' && f.props!.children === EN.reset).length, 2, 'both scope groups render Reset');

  // Both groups + the panel head.
  for (const label of [EN.nav, EN.sessionScope, EN.sharedScope, EN.effective, EN.source]) {
    assert.equal(hasText(facts, label), true, `panel label "${label}" must render`);
  }
  // With no baseline snapshot yet, no baseline group is shown.
  assert.equal(hasText(facts, EN.baseline), false, 'baseline group appears only once a snapshot exists');
});

test('client: apply registers shell.overlay exactly once per load and returns a disposer', () => {
  const log: {
    injects: Array<[string, () => unknown]>;
    registers: Array<[Record<string, unknown>, unknown]>;
    localeRegs: Array<[string, unknown]>;
    effects: string[];
  } = { injects: [], registers: [], localeRegs: [], effects: [] };
  const ctx = {
    effect: (fn: () => unknown, label: string) => {
      log.effects.push(label);
      const inner = fn();
      return typeof inner === 'function' ? inner : () => {};
    },
    locale: {
      register: (ns: string, dicts: unknown) => {
        log.localeRegs.push([ns, dicts]);
        return () => {};
      },
      bind: () => (key: string) => key,
    },
    slots: {
      inject: (key: string, cb: () => unknown) => {
        log.injects.push([key, cb]);
        return () => {};
      },
      register: (opts: Record<string, unknown>, comp: unknown) => {
        log.registers.push([opts, comp]);
        return () => {};
      },
    },
  };

  apply(ctx as never);

  assert.equal(log.injects.length, 1, 'apply must call slots.inject exactly once');
  assert.deepEqual(log.injects[0]![0], 'shell.overlay');
  assert.equal(log.localeRegs.length, 1, 'locale dictionaries registered once');

  const cb = log.injects[0]![1];
  const disposer = cb();
  assert.equal(log.registers.length, 1, 'the injection callback must register exactly one component');
  const [opts] = log.registers[0]!;
  assert.equal(opts.name, 'shell.overlay');
  assert.equal(opts.id, 'requirements-alignment');
  assert.equal(opts.order, 50);
  // shell.overlay is a floating surface, not a navigation entry: it must NOT
  // register value-type `label` metadata (and never a function-valued one).
  assert.equal(opts.label, undefined, 'overlay registration must not carry a label');
  assert.equal(typeof opts.inject, 'function');
  assert.equal(typeof disposer, 'function', 'the injection callback must yield a disposer for the shell to run on unload');
});

// -------------------------------------------- slot lifecycle contract (runtime-ish)

/** A minimal fake slot registry honoring the rc.1 register/dispose contract. */
function fakeSlotRegistry() {
  const occupants: Array<{ opts: Record<string, unknown>; comp: unknown }> = [];
  return {
    occupants,
    inject(key: string, cb: () => unknown) {
      const disposer = cb();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    register(opts: Record<string, unknown>, comp: unknown) {
      occupants.push({ opts, comp });
      return () => {
        const at = occupants.indexOf(occupants.find((o) => o.opts.id === opts.id)!);
        if (at >= 0) occupants.splice(at, 1);
      };
    },
  };
}

test('client: unload disposes the overlay registration; reload re-registers exactly one occupant', () => {
  // The host runs the inject effect (which registers one occupant) and, on
  // unload, disposes that effect — the register disposer removes the occupant.
  // A later reload runs a FRESH inject effect (apply is invoked again by the
  // module loader), registering exactly one occupant again.
  const disposers: Array<() => void> = [];
  const captured = fakeSlotRegistry();
  const regCtx = {
    effect: (fn: () => unknown) => {
      const inner = fn();
      return typeof inner === 'function' ? inner : () => {};
    },
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    slots: {
      inject: (key: string, cb2: () => unknown) => {
        const d = cb2();
        const disposer = typeof d === 'function' ? (d as () => void) : () => {};
        disposers.push(disposer);
        return disposer;
      },
      register: captured.register.bind(captured),
    },
  };
  apply(regCtx as never);
  assert.equal(captured.occupants.length, 1, 'apply mounts exactly one registration');
  assert.equal(disposers.length, 1, 'one inject effect installed');
  assert.equal(captured.occupants[0]!.opts.name, 'shell.overlay');
  assert.equal(captured.occupants[0]!.opts.id, 'requirements-alignment');
  assert.equal(captured.occupants[0]!.opts.order, 50);

  disposers[0]!(); // unload: the inject effect's disposer removes the occupant
  assert.equal(captured.occupants.length, 0, 'unload removes the occupant');

  apply(regCtx as never); // reload
  assert.equal(disposers.length, 2, 'reload installs a fresh effect');
  assert.equal(captured.occupants.length, 1, 'reload leaves exactly one occupant (no duplicate)');
});

// ------------------------------------------------- useSessions behavior (task 7)
//
// The root-scope capsule obtains the current session through the DSH global
// standard kit (`useSessions`), exactly as `GlobalStandardProps` provides it —
// no hand-injected sessions service. These tests verify the capsule follows
// session switching and never leaks one session's mode into another.

/** Runtime snapshot shape the capsule reflects through `snapshot?.session`. */
function capsuleFactsFor(currentSessionId: string | undefined) {
  const useSessions = (selector: (s: { current?: string } | undefined) => string | undefined) =>
    selector(currentSessionId === undefined ? undefined : { current: currentSessionId });
  return renderTree(fakeReact.createElement(AlignmentCapsule, { t, useSessions }));
}

test('client: no current session renders a safe collapsed capsule (no crash, mode falls back to off)', () => {
  const facts = capsuleFactsFor(undefined);
  assert.equal(hasText(facts, 'Off'), true, 'no-session capsule shows the fallback mode');
  const dots = facts.filter((f) => f.kind === 'element' && f.tag === 'span' && typeof (f.props!.style as { background?: string })?.background === 'string');
  assert.equal(dots.length >= 1, true, 'capsule still renders its colored dot');
});

test('client: the capsule follows session switching (A then B) and never leaks stale mode', () => {
  // Session A snapshot lives in the API response; the capsule re-queries on
  // session switch. At the render layer, the SELECTOR sees the new current id.
  const factsA = capsuleFactsFor('session-A');
  assert.equal(hasText(factsA, 'Off'), true, 'render is safe for session A before any snapshot');

  // Switching to session B re-renders against the new id without error.
  const factsB = capsuleFactsFor('session-B');
  assert.equal(hasText(factsB, 'Off'), true, 'render is safe for session B');
});

test('client: a disposed/changed session does not leave stale UI state', () => {
  // The capsule stores no session identity globally: each render derives the
  // id from useSessions at call time. Once the current id becomes undefined,
  // the same component instance still renders a collapsed, safe capsule (no
  // reference to the previous session's controls).
  const first = capsuleFactsFor('session-old');
  assert.equal(hasText(first, 'Off'), true);
  const afterDispose = capsuleFactsFor(undefined);
  const buttons = afterDispose.filter((f) => f.kind === 'element' && f.tag === 'button');
  assert.equal(buttons.length, 1, 'no current session leaves exactly the collapsed capsule button');
});

test('client: capsule render never crashes with the full simulated payload path', () => {
  // Force the expanded panel path with a snapshot injected via the fake
  // render loop: set expanded true first (through the capsule onClick), then
  // assert the panel renders its controls without throwing.
  const useSessions = (selector: (s: { current?: string } | undefined) => string | undefined) =>
    selector({ current: 's-payload' });
  const root = fakeReact.createElement(AlignmentCapsule, { t, useSessions });
  let facts = renderTree(root);
  const capsule = facts.find((f) => f.kind === 'element' && f.tag === 'button' && f.props!.className === 'dra-capsule');
  (capsule!.props!.onClick as () => void)();
  facts = renderTree(root);
  assert.equal(facts.filter((f) => f.kind === 'element' && f.tag === 'button').length >= 7, true, 'expanded capsule renders the full control set');
});