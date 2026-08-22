/**
 * dsh-requirements-alignment Alignment Capsule (browser half).
 *
 * Registers a bottom-right floating capsule into the DSH web shell's
 * `shell.overlay` slot — the frame-wide floating layer above every column
 * (z-index 20, click-through until an entry opts into pointer events). The
 * capsule shows the current session's effective alignment mode as a colored
 * dot + label; expanding it reveals a compact manager for the two mode layers
 * the user controls:
 *
 *   - session layer   (auto | manual | off | reset) — affects ONLY the
 *                     current session (the session-scoped override);
 *   - shared layer    (auto | manual | off | reset) — the runtime override
 *                     every session without its own override inherits.
 *
 * All state comes from the loopback management API (/_dsh/requirements-alignment/*);
 * the widget never infers runtime state from clicks. GET /status is polled
 * while the page is visible (2s); the panel reflects the last snapshot. The
 * mutation endpoints carry the CSRF guard header.
 *
 * Stale-session protection: the current session id is held in a ref and a
 * request generation counter is bumped on every session change. A polling
 * (or post-mutation) response is committed only when its generation and its
 * captured session id still match the live session, and the render layer only
 * displays a snapshot whose session id equals the current one — so an
 * out-of-order response from a previous session can never overwrite or show
 * as the current session's state. With no selected session, session-scoped
 * actions are disabled and no `?sessionId=undefined` request is ever built.
 *
 * Layout uses the DSH design-token aliases used by native pages (group cards,
 * layered fills, brand-primary buttons) so the capsule reads as part of the
 * shell rather than an iframe.
 *
 * Plain-JS build: scripts/build-client.mjs wraps this file into
 * window.__ModuleLoader__.load({ id, factory: (require) => { ... } }).
 * React MUST be acquired from that factory require — the DSH web shell does
 * not expose React as a browser global.
 */
'use strict';

const React = require('react');

const NS = 'requirementsAlignment';
const API = '/_dsh/requirements-alignment';
const MUTATION_HEADER = 'x-dsh-requirements-alignment';
const STYLE_ID = 'dsh-requirements-alignment-floating';

const inject = ['slots', 'locale'];

const zh = {
  nav: '对齐',
  intro: '查看和切换当前会话的对齐模式。',
  sessionScope: '当前会话',
  sharedScope: '全局设置',
  effective: '有效模式',
  source: '来源',
  sessionOverride: '会话覆盖',
  sharedOverride: '运行时覆盖',
  profileDefault: '配置默认',
  none: '无',
  baseline: '基线',
  revision: '修订',
  status: '状态',
  driftCount: '漂移',
  manualChecks: '手动检查',
  switchHint: '切换会立即生效，无需重启。',
  close: '收起',
  expanded: '展开对齐管理器',
  collapsed: '折叠对齐胶囊',
  mode: '模式',
  reset: '重置',
  saving: '保存中…',
  offline: '未连接',
  error: '出错了',
  retry: '重试',
  st_unknown: '未知',
  st_aligned: '已对齐',
  st_drift_pending: '待决策',
  st_baseline_update_pending: '待更新',
  src_session: '会话',
  src_override: '运行',
  src_profile: '配置',
  mode_auto: '自动',
  mode_manual: '手动',
  mode_off: '关闭',
};

const en = {
  nav: 'Alignment',
  intro: 'View and switch the alignment mode of the current session.',
  sessionScope: 'Current session',
  sharedScope: 'Global',
  effective: 'Effective',
  source: 'Source',
  sessionOverride: 'Session override',
  sharedOverride: 'Runtime override',
  profileDefault: 'Profile default',
  none: 'none',
  baseline: 'Baseline',
  revision: 'Revision',
  status: 'Status',
  driftCount: 'Drifts',
  manualChecks: 'Checks',
  switchHint: 'Switches apply immediately, no restart needed.',
  close: 'Collapse',
  expanded: 'Expand alignment manager',
  collapsed: 'Collapse alignment capsule',
  mode: 'Mode',
  reset: 'Reset',
  saving: 'Saving…',
  offline: 'Offline',
  error: 'Error',
  retry: 'Retry',
  st_unknown: 'Unknown',
  st_aligned: 'Aligned',
  st_drift_pending: 'Waiting',
  st_baseline_update_pending: 'Pending update',
  src_session: 'session',
  src_override: 'runtime',
  src_profile: 'profile',
  mode_auto: 'Auto',
  mode_manual: 'Manual',
  mode_off: 'Off',
};

const CSS = `
.dra-page{position:fixed;right:20px;bottom:20px;z-index:30;display:flex;flex-direction:column;align-items:flex-end;gap:8px;font-family:var(--ds-font-family-ui,inherit)}
.dra-capsule{box-sizing:border-box;display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 14px;border-radius:17px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-subtle,rgba(128,128,128,.35)));background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-module-platform,rgba(255,255,255,.92)));box-shadow:0 4px 16px rgba(0,0,0,.12);cursor:pointer;color:var(--dsw-alias-label-primary);transition:border-color .15s ease,box-shadow .15s ease}
.dra-capsule:hover{border-color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.5));box-shadow:0 6px 20px rgba(0,0,0,.16)}
.dra-capsule:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#6366f1);outline-offset:2px}
.dra-dot{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none}
.dra-capsule-label{font-size:12.5px;line-height:20px;font-weight:600;letter-spacing:.2px}
.dra-panel{box-sizing:border-box;width:300px;max-height:min(70vh,520px);overflow:auto;display:flex;flex-direction:column;gap:10px;padding:14px 14px 12px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-subtle,rgba(128,128,128,.22)));background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-module-platform,rgba(255,255,255,.97)));box-shadow:0 12px 36px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary)}
.dra-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dra-panel-title{font-size:13px;font-weight:600;line-height:20px}
.dra-close{box-sizing:border-box;height:24px;min-width:24px;padding:0 6px;border:1px solid transparent;border-radius:12px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:22px;cursor:pointer}
.dra-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}
.dra-group{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent)}
.dra-group-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.dra-group-title{font-size:12px;font-weight:600;line-height:18px}
.dra-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}
.dra-meta-label{flex:none}
.dra-meta-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.dra-meta-value.dra-cap{text-transform:capitalize}
.dra-btnrow{display:flex;flex-wrap:wrap;gap:6px}
.dra-btn{box-sizing:border-box;height:26px;padding:0 10px;border-radius:13px;font:inherit;font-size:12px;line-height:22px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-primary)}
.dra-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}
.dra-btn:disabled{opacity:.45;cursor:default}
.dra-btn-on{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-interactive-bg-active,rgba(80,120,255,.9)));color:var(--dsw-alias-label-primary-foreground,#fff)}
.dra-btn-on:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,rgba(80,120,255,.95)))}
.dra-btn-danger{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dra-hint{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.dra-error{box-sizing:border-box;padding:8px 10px;border-radius:10px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary,#ef4444);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 10%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 28%,transparent)}
.dra-sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (max-width:560px){.dra-panel{width:min(84vw,300px)}}
`.replace(/\n/g, '');

function ensureStyles() {
  if (typeof document === 'undefined' || !document.head) return;
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute('data-plugin-css', STYLE_ID);
    document.head.appendChild(style);
  }
  if (style.textContent !== CSS) style.textContent = CSS;
}

ensureStyles();

function apply(ctx) {
  ensureStyles();
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'requirements-alignment: copy dictionaries');
  const t = ctx.locale.bind(NS);
  const injected = () => ({ t });
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        // A floating overlay has no navigable label: the DSH-list `label`
        // metadata is value-type and this surface does not consume one, so it
        // is omitted (an empty/function-valued label adds nothing).
        id: 'requirements-alignment',
        order: 50,
        inject: injected,
      },
      AlignmentCapsule,
    ),
  );
}

// ------------------------------------------------------------------------- api

async function apiGet(path) {
  const response = await fetch(API + path, { cache: 'no-store' });
  return response.json();
}

async function apiMutate(method, path, body) {
  const headers = { 'Content-Type': 'application/json', [MUTATION_HEADER]: '1' };
  const response = await fetch(API + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return response.json();
}

// -------------------------------------------------------------------- helpers

function modeColor(mode) {
  if (mode === 'auto') return '#22c55e';
  if (mode === 'manual') return '#f59e0b';
  if (mode === 'off') return '#ef4444';
  return '#9ca3af';
}

// ------------------------------------------------------------------- capsule

/**
 * The floating manager. Root-scope (shell.overlay) so it stays mounted across
 * session switches: the current session id arrives through the framework
 * `useSessions` standard kit, and the two mode layers are manipulated through
 * the management API addressed to that id.
 */
function AlignmentCapsule(props) {
  const t = props.t;
  const useSessions = props.useSessions;
  const [snapshot, setSnapshot] = React.useState(undefined);
  const [expanded, setExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState(undefined);
  const [error, setError] = React.useState(undefined);

  const currentSessionId =
    typeof useSessions === 'function'
      ? useSessions((s) => (s && s.current !== undefined ? s.current : undefined))
      : undefined;

  // The LIVE session identity for async continuations: a closure captures the
  // id of the render that created it, which can be stale by the time a fetch
  // resolves. Every async callback reads this ref instead, and the effect below
  // re-points it the moment the current session changes.
  const currentSessionRef = React.useRef(currentSessionId);
  // Request generation: bumped every time the session identity changes (mount
  // included). A response is committed only when its captured generation still
  // matches AND its captured session still matches — a late response from a
  // previous session is dropped, never rendered, so an old snapshot can never
  // overwrite a newer session's state.
  const requestVersionRef = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const sessionId = currentSessionRef.current;
    if (sessionId === undefined) return;
    const version = requestVersionRef.current;
    try {
      const json = await apiGet('/status?sessionId=' + encodeURIComponent(sessionId));
      if (version !== requestVersionRef.current || sessionId !== currentSessionRef.current) {
        // stale: a newer session/generation took over while this was in flight
        return;
      }
      if (json.ok) {
        if (json.session !== undefined && String(json.session.id) !== sessionId) {
          // defensive: never render a snapshot whose payload identity does not
          // match the session that was requested
          return;
        }
        setSnapshot(json);
        setError(undefined);
      }
    } catch {
      // transient network failure; the next poll retries
    }
  }, []);

  React.useEffect(() => {
    // Invalidate the moment the session identity changes: bump the generation
    // (any in-flight response becomes stale), clear the old snapshot's UI, and
    // re-point the live-session ref BEFORE the next request is issued.
    currentSessionRef.current = currentSessionId;
    requestVersionRef.current += 1;
    setSnapshot(undefined);
    setError(undefined);
    if (currentSessionId === undefined) {
      // No session: no polling and no requests — never build ?sessionId=undefined.
      return;
    }
    ensureStyles();
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void refresh();
    }, 2000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [currentSessionId, refresh]);

  // Render-time identity guard: only a snapshot whose session id matches the
  // CURRENT session may be displayed. Anything else (stale, from a previous
  // session, or no session at all) renders as unavailable/loading — never an
  // old session's status under a new session's controls.
  const snapshotForSession =
    snapshot !== undefined && currentSessionId !== undefined && snapshot.session !== undefined
      && String(snapshot.session.id) === currentSessionId
      ? snapshot
      : undefined;

  const effectiveMode = snapshotForSession?.session?.effectiveMode ?? 'off';
  const effectiveSource = snapshotForSession?.session?.effectiveSource ?? 'profile';

  const switchMode = async (scope, mode) => {
    const sessionId = scope === 'session' ? currentSessionRef.current : undefined;
    if (scope === 'session' && sessionId === undefined) return; // no session -> never a session mutation
    setBusy(scope + ':' + mode);
    setError(undefined);
    try {
      let json;
      if (scope === 'session') {
        json = await apiMutate('PUT', '/mode?sessionId=' + encodeURIComponent(sessionId), { mode });
      } else {
        json = await apiMutate('PUT', '/shared-mode', { mode });
      }
      if (!json.ok) setError(json.error ?? 'switch failed');
      else await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const resetMode = async (scope) => {
    const sessionId = scope === 'session' ? currentSessionRef.current : undefined;
    if (scope === 'session' && sessionId === undefined) return; // no session -> never a session mutation
    setBusy(scope + ':reset');
    setError(undefined);
    try {
      let json;
      if (scope === 'session') {
        json = await apiMutate('DELETE', '/mode?sessionId=' + encodeURIComponent(sessionId));
      } else {
        json = await apiMutate('DELETE', '/shared-mode');
      }
      if (!json.ok) setError(json.error ?? 'reset failed');
      else await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const session = snapshotForSession?.session;
  const baseline = snapshotForSession?.baseline;
  const sessionOverride = session?.sessionOverride ?? null;
  const sharedOverride = session?.sharedOverride ?? null;

  const scopeButtons = (scope, current) => {
    const buttons = [];
    // Session-scoped actions need a live session: without one the buttons are
    // disabled (the mutation handlers also guard, so no ?sessionId=undefined is
    // ever constructed).
    const sessionDisabled = scope === 'session' && currentSessionId === undefined;
    for (const mode of ['auto', 'manual', 'off']) {
      const active = current === mode;
      const label = t('mode_' + mode);
      buttons.push(
        React.createElement(
          'button',
          {
            key: 'm-' + mode,
            type: 'button',
            disabled: busy !== undefined || sessionDisabled,
            className: 'dra-btn' + (active ? ' dra-btn-on' : ''),
            onClick: () => switchMode(scope, mode),
            'aria-pressed': active,
          },
          label,
        ),
      );
    }
    buttons.push(
      React.createElement(
        'button',
        {
          key: 'r',
          type: 'button',
          disabled: busy !== undefined || current === null || sessionDisabled,
          className: 'dra-btn dra-btn-danger',
          onClick: () => resetMode(scope),
        },
        t('reset'),
      ),
    );
    return buttons;
  };
  const metaRow = (label, value, cap) =>
    React.createElement(
      'div',
      { className: 'dra-meta' },
      React.createElement('span', { className: 'dra-meta-label' }, label),
      React.createElement(
        'span',
        { className: 'dra-meta-value' + (cap ? ' dra-cap' : '') },
        String(value),
      ),
    );

  const children = [];

  children.push(
    React.createElement(
      'button',
      {
        type: 'button',
        className: 'dra-capsule',
        onClick: () => setExpanded(!expanded),
        'aria-label': expanded ? t('collapsed') : t('expanded'),
        'aria-expanded': expanded,
      },
      React.createElement('span', { className: 'dra-dot', style: { background: modeColor(effectiveMode) } }),
      React.createElement('span', { className: 'dra-capsule-label' }, t('mode_' + effectiveMode)),
    ),
  );

  if (expanded) {
    const panel = [
      React.createElement(
        'div',
        { className: 'dra-panel-head', key: 'head' },
        React.createElement('span', { className: 'dra-panel-title' }, t('nav')),
        React.createElement(
          'button',
          { type: 'button', className: 'dra-close', onClick: () => setExpanded(false) },
          t('close'),
        ),
      ),
    ];

    if (error !== undefined) {
      panel.push(
        React.createElement(
          'div',
          { className: 'dra-error', role: 'status', key: 'err' },
          error,
        ),
      );
    }

    const sessionGroup = [
      metaRow(t('effective'), t('mode_' + effectiveMode)),
      metaRow(t('source'), t('src_' + effectiveSource), true),
    ];
    sessionGroup.push(
      React.createElement(
        'div',
        { className: 'dra-btnrow', key: 'row' },
        ...scopeButtons('session', sessionOverride),
      ),
    );
    panel.push(
      React.createElement(
        'div',
        { className: 'dra-group', key: 'grp-session' },
        React.createElement(
          'div',
          { className: 'dra-group-head' },
          React.createElement('span', { className: 'dra-group-title' }, t('sessionScope')),
          React.createElement('span', { className: 'dra-meta dra-meta-value dra-cap' }, sessionOverride ? t('mode_' + sessionOverride) : t('none')),
        ),
        ...sessionGroup,
      ),
    );

    const sharedGroup = [];
    sharedGroup.push(
      React.createElement(
        'div',
        { className: 'dra-btnrow', key: 'row' },
        ...scopeButtons('shared', sharedOverride),
      ),
    );
    panel.push(
      React.createElement(
        'div',
        { className: 'dra-group', key: 'grp-shared' },
        React.createElement(
          'div',
          { className: 'dra-group-head' },
          React.createElement('span', { className: 'dra-group-title' }, t('sharedScope')),
          React.createElement('span', { className: 'dra-meta dra-meta-value dra-cap' }, sharedOverride ? t('mode_' + sharedOverride) : t('none')),
        ),
        ...sharedGroup,
      ),
    );

    if (baseline !== undefined) {
      const baselineGroup = [
        metaRow(t('revision'), String(baseline.revision ?? 0)),
        metaRow(t('status'), t('st_' + baseline.status) ?? String(baseline.status)),
        metaRow(t('driftCount'), String(baseline.driftCount ?? 0)),
        metaRow(t('manualChecks'), String(baseline.manualChecks ?? 0)),
      ];
      panel.push(
        React.createElement(
          'div',
          { className: 'dra-group', key: 'grp-baseline' },
          React.createElement(
            'div',
            { className: 'dra-group-head' },
            React.createElement('span', { className: 'dra-group-title' }, t('baseline')),
          ),
          ...baselineGroup,
        ),
      );
    }

    children.push(React.createElement('div', { className: 'dra-panel', key: 'panel', role: 'region', 'aria-label': t('nav') }, ...panel));
  }

  return React.createElement('div', { className: 'dra-page' }, ...children);
}

module.exports = {
  apply,
  inject,
  AlignmentCapsule,
  modeColor,
  dictionaries: { zh, en },
};