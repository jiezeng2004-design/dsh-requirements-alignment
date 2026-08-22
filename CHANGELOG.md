# Changelog

All notable changes to this project are documented here.

## 0.4.1 - Web floating capsule + DSH 0.1.1-rc.1 compatibility

The plugin now ships a client half for DSH Web — the floating manager the user
asked for ("没有可以直接管理的悬浮框") — and is upgraded end-to-end to the
real **DeepSeek Harness 0.1.1-rc.1** baseline (dependencies pinned to the rc.1
family; migration + client + session parity validated against the actual rc.1
writers and readers).

### Added

- **`AlignmentCapsule` (`src/client/index.js`, built to `lib/client.js`)** — a
  bottom-right collapsible capsule registered into the frame-wide
  `shell.overlay` slot (`id: 'requirements-alignment'`, `order: 50`), the same
  client-injection recipe (`dsh.client.inject` + `scripts/build-client.mjs`)
  that `dsh-chatgpt-bridge` uses. Collapsed: colored dot + effective-mode
  label. Expanded: session-layer and shared-layer mode buttons (Auto / Manual /
  Off / Reset), the effective mode + source, and the baseline summary rows.
- **Loopback management API (`src/management-api.ts`)** — mounted only when the
  optional `webServer` service is present, under
  `/_dsh/requirements-alignment`. `GET /status?sessionId=` (four-layer picture
  + baseline), `PUT`/`DELETE /mode?sessionId=` (session override),
  `PUT`/`DELETE /shared-mode` (runtime override). Every mutation carries the
  same Host/Origin/loopback/CSRF-header guards as the bridge; GET endpoints
  never mutate.
- Every mutation and read goes through the SAME controller paths as
  `/align-mode`, so the capsule and the command can never disagree about the
  mode model.
- **Tests** — `test/management-api.test.ts` (all endpoints × happy/error/guard
  paths) and `test/client-render.test.ts` (fake-React smoke render of the
  bundle: ModuleLoader require('react'), collapsed/expanded capsule, `apply`
  registering `shell.overlay` exactly once).

### Changed (DSH 0.1.1-rc.1 compatibility)

- **Dependency family upgraded to `0.1.1-rc.1`.** All runtime `@deepseek-ai/dsh-*`
  dependencies, the `@deepseek-ai/dsh-agent` peer/dev dependency, and the
  supporting packages are pinned to the real `0.1.1-rc.1` releases (published
  in the npm registry; no range drift). `pnpm-lock.yaml` regenerated against
  the rc.1 physical packages.
- **`src/migration.ts` real-rc.1 parity.** The structural concatenated-frame
  container, the JSONL layout (`SESSION_FORMAT_VERSION`, `SessionHeader`,
  packed chunk rows, end-seed, fork lineage), and the legacy-event envelope
  repair were audited and updated against the real rc.1 physical format. Two
  new integration tests produce fixtures with the REAL rc.1 writer (`Context`
  + `SessionStore` + packed `JsonlSessionPersistence`) and reload the migrated
  artifacts through the real rc.1 reader: a full official-vocabulary session
  with five legacy `alignment/*` events, and a fork child carrying
  `parentSession` + `seedLength`. Only whitelisted legacy events are repaired
  to `ignorable: true`; every other byte is preserved; the reader's resume
  end-seed / interruption closer semantics are asserted exactly.
- **Client slot registration fix (`src/client/index.js`).** The capsule's
  `shell.overlay` slot registration no longer carries a function-valued label
  (the existing contract expects a plain string/serializable entry), so the
  registration is accepted by the rc.1 Web surface and `useSessions` reads the
  live session list correctly.

### Fixed (v0.4.1 release blockers)

- **Capability transition rollback atomicity (`src/index.ts` +
  `src/runtime-mode-controller.ts`).** The previous `syncAgent` disposed
  the outgoing mode, then tried to register the incoming mode, and on failure
  put the *already-disposed* registration record back into
  `agentCapabilities` — dead bookkeeping (the runtime had already lost the
  old capability while the Map still advertised it). Transitions are now
  transactional:

  - the outgoing registrations are disposed first (synchronous, idempotent
    scope-table removals that never throw);
  - the incoming mode is registered; only a successful registration is
    committed to the Map;
  - a failed registration rolls back by **re-registering the previous mode
    with fresh disposers** — the executed record is never put back;
  - if the rollback re-registration fails too, the session fails loud and
    closed: the Map records nothing (a Map entry must always correspond to a
    live capability) and the double failure is recorded explicitly on
    `degradedAgents` (target mode, previous mode, primary + rollback error
    provenance) as pending reconciliation — the next sync trigger retries and
    clears it;
  - `registerForAgent` itself is now self-cleaning: a mid-registration
    throw unwinds the partials it already collected before surfacing, so no
    half-registered capability set can leak into a rollback;
  - `resyncSharedAgents` also retries degraded (fail-closed) agents, so a
    shared-layer change is a recovery window for a double failure.

- **Mode source / active capability atomicity (`src/index.ts`).** The
  capability rollback made the RUNTIME transaction atomic, but the persisted
  mode SOURCE was still committed first and never compensated on a capability
  failure — a failed switch could leave `effectiveMode = auto` (source) while
  the runtime implements `manual`. Every mode mutation is now ONE
  transaction (`setMode`, `resetMode`, `setSessionMode`, `clearSessionOverride`):

  - the previous source topology is captured (presence + value);
  - the target is persisted, then every affected agent's capabilities are
    reconciled against it inside the same synchronous window (subscription
    resyncs are deferred to the mutation);
  - if ANY agent could not converge, the persisted source is compensated back
    to its previous topology — a failed Manual `→` Auto switch reports failure
    and leaves source = effective = capability = Manual;
  - session overrides keep PRESENCE semantics: an inherited (override-less)
    session is compensated by clearing (never an equal-value override), an
    explicit previous override is restored to its exact value;
  - a failed mode switch no longer reports the target as active: `setMode` /
    `setSessionMode` / `resetMode` / `clearSessionOverride` throw, `/align-mode`
    returns the existing `Failed to switch alignment mode: ...` error style,
    and the management API returns the existing 4xx/5xx structured error;
  - a compensating source write that itself fails is recorded as an explicit
    PENDING source compensation — exposed on the status payload
    (`reconciliation: { pending, kind: 'source-compensation', activeCapabilityMode }`,
    the actual active mode), retried at the start of the next mutation,
    cleared the moment it lands;
  - a capability double failure with a compensated source stays
    `capability-degraded` (no Map entry, both error provenances, the previous
    active mode exposed) and recovers on the next trigger;
  - `assertAgentModeConsistent` (advertised effective mode == active capability
    mode) and `assertAgentModeDegraded` are asserted in every regression test;
    the A—G matrix in `external-settings-failure.test.ts` covers shared /
    session compensation, presence restoration, compensation-write failure,
    double capability failure, and the success paths.

- **Stale-session Web Capsule race (`src/client/index.js`).** The capsule's
  `refresh` captured `currentSessionId` in its closure, so an
  out-of-order response (Session A's status landing after Session B's) could
  overwrite the current session's snapshot — showing A's state under B's
  controls. The capsule now holds the live session id in a ref plus a request
  generation counter:

  - the generation is bumped and the snapshot cleared the moment the session
    identity changes (including to no session);
  - a response is committed only when its captured generation AND session id
    still match the live session (late responses are dropped);
  - the render layer only displays a snapshot whose session id equals the
    current session (defensive identity check);
  - with no selected session, session-scoped buttons are disabled and no
    `?sessionId=undefined` request can ever be built (shared actions stay
    usable).

- **Typecheck regression fix** — `tsconfig.check.json` (src + test) reported
  the client fake-React gaps after the halo; the capsule now also uses
  `useRef`, and both client test files type-check strict with zero errors.

### Verification

- Type checking (both tsconfigs), linting, and build **PASS**.
- Node tests: **228/228 passing** (largely rewritten for the rc.1 seams,
  plus `client-render`, `management-api`, `session-mode-store`,
  `session-mode`, the two real-rc.1 migration parity suites,
  `client-race` — a real hooks/effects stale-session race harness — and the
  A–G mode-source/capability transaction matrix in
  `external-settings-failure`).
- Packed-artifact smoke against a real `0.1.1-rc.1` DSH installation: the
  tarball installs into a disposable profile (the real `dsh plugin` forwarder
  + bundle reconciliation), `--dump-config` shows exactly the plugin's two rows
  (`requirements-alignment` `mode: auto` + `requirements-alignment-ask-user`),
  a real headless boot mounts the plugin service and, with a live agent
  created through the real registry, the full capability matrix is present
  from the real registries — policy section in the assembled system prompt,
  `establish_baseline` + `report_drift` tools, `/align` + `/align-mode`
  commands. Mode persistence fails *loud* (entry-only port) when the
  storage-domain sidecar is absent, exactly as designed; removing the bundle
  leaves no leftover rows in the composed tree. External model completion was
  unavailable (`QUOTA`) and is reported separately, never counted as a model
  E2E pass (see `ACCEPTANCE.md`).

### Known limitations

- The floating capsule is validated end-to-end short of a browser window: the
  rebuilt bundle is served by the live DSH Web `0.1.1-rc.1` instance
  (`/plugins/dsh-requirements-alignment/client.js`, 21697 bytes, P1
  markers present), the loopback management API guard contract (400/404/403)
  was verified live, and the capsule's render behavior is executed by the
  real-hooks race harness (`client-race.test.ts`) plus the render test
  (`client-render.test.ts`). A pixel-level browser-window E2E and any
  live-model completion were unavailable this round (no browser automation;
  model `QUOTA: Insufficient Balance`) and are not claimed as executed
  passes — see `ACCEPTANCE.md`.
- The `dsh plugin` registry reconcile over the flaky npm network during the
  disposable smoke required an offline store re-run for full parity; the plugin
  bundles themselves never depend on the network once fetched.

## 0.4.0 - session-scoped mode selector

### Added (session-scoped mode)

- **`SessionModeStore` (`src/session-mode-store.ts`)** — one alignment-mode
  override per session lifecycle identity (`id + createdAt + cwd`), persisted
  to its own `requirements_alignment_modes` storage-domain sidecar
  (durable-first writes, identity binding, fork inheritance, change
  notification).
- **Four-layer resolution** — `valid session override -> valid persisted
  runtime override -> valid profile default -> auto`. `effectiveModeFor`
  reports the mode and its exact source (`session` / `override` / `profile`).
- **`/align-mode session`** — set, inspect, or reset the override of ONLY the
  calling session; the shared runtime override and other live sessions never
  move. `/align-mode` (no argument) prints the four-layer snapshot.
- **Per-agent capability model** — policy section, both tools, `/align`, and
  `/align-migrate` are registered in each agent's OWN scope (`agent.ctx`)
  instead of at plugin scope. Two live sessions can hold different effective
  modes with zero leakage; an Off session has no alignment capabilities at all
  (only the plugin-scope `/align-mode` remains, so it can switch itself back).
  `AlignmentRuntime` becomes a per-agent registrar (`registerForAgent`);
  the v0.3.0 global register/dispose hot-switch is retired.
- **Per-agent lifecycle** (`agent/session-start`, `agent/disposed`, ModeStore /
  SessionModeStore subscriptions) — the controller syncs an agent's
  capabilities when its session's effective mode changes; a failed per-agent
  registration rolls back its partials, keeps the previous capability set, and
  recovers on the next trigger.
- **Fork inheritance** — a fork child adopts the parent's session override at
  its seed boundary (one-time copy), then becomes independently changeable.
- **Durability** — session overrides survive cold resume (restored per
  identity) and are never touched by a shared reset; mode persistence,
  session-mode persistence, and alignment-state persistence stay fully
  independent.

### Changed (architecture)

- The v0.3.0 global capability matrix (Auto/Manual/Off at plugin scope) is now
  a per-session matrix. Tests for the global register/dispose model
  (`hot-switch`, `controller`, `external-settings-failure`,
  `runtime-mode-controller`) were rewritten for the per-agent model; new
  `session-mode` and `session-mode-store` suites cover isolation, resolution,
  fork inheritance, and durability.

### Added (verification)

- New dogfood scenario `13-session-mode`: the align-driver switches ONLY the
  top-level session to Off once a subagent session appears, and asserts the
  subagent keeps its policy while the top-level agent loses policy, tools, and
  `/align`.
- `align-driver` gains `switchTopLevelOnSubagent` / `switchTopLevelTo` and
  per-agent registration records.

## 0.3.0 - 2026-08-20

### Added (persistent runtime mode & hot switching)

- **ModeStore (`src/mode-store.ts`)** — the single authority over the runtime
  alignment mode. Three-layer model
  `valid persisted override -> valid profile default -> auto`. Exposes
  `getSnapshot()` (default / override / effective / source), `setOverride`,
  `resetOverride`, and `subscribe`; invalid stored overrides fall back to the
  profile default and are repaired (never fail startup; a later invalid value
  is repaired too).
- **Settings-backed override persistence (`src/settings-mode-store.ts`)** —
  runtime overrides persist through the official `@deepseek-ai/dsh-settings`
  service (new dependency, rc.6; no DSH Core changes). A DSH restart restores
  the last override; a permissive storage schema plus ModeStore validation
  guarantee an invalid persisted value (e.g. `mode: banana`) stays inert, and
  an external `settings.yaml` hot edit is applied live. Deployments without a
  settings service degrade to an entry-only port.
- **AlignmentRuntime (`src/runtime-mode-controller.ts`)** — real
  register/dispose hot transitions. Auto registers the policy section, both
  tools, `/align`, and `/align-migrate`; Manual registers tools + both
  commands; Off unregisters those. `/align-mode` is always registered so a
  live switch to Off is reversible. Transitions are idempotent, exactly-one by
  construction, and failure-safe (partials disposed, previous mode restored).
- **`/align-mode`** — user-facing mode switch that does not need a DSH Core
  Settings card. No argument prints the three-layer snapshot; `auto` /
  `manual` / `off` persist a runtime override; `reset` returns to the profile
  default. `/align` now names whether the effective mode is the profile
  default or a runtime override.
- **Controller integration (`src/index.ts`)** — `RequirementsAlignmentController`
  now owns `AlignmentStateStore` (unchanged sidecar), `ModeStore`, and
  `RuntimeModeController`. Adds `setMode(mode)` (validate → transition →
  persist, with persistence-failure rollback) and `resetMode()`; a startup
  override is applied immediately.
- **Mode persistence is independent of alignment state persistence.** Switching
  modes never deletes a baseline, the sidecar, or session events.

### Fixed (external-transition failure compensation)

- A hot-edited settings document whose runtime transition fails (for example an
  Auto policy registration error) no longer leaves a ModeStore/Runtime
  split-brain (`{ effective: auto, runtime: manual }`). The controller
  serializes hot-switch reconciliation and, on transition failure, restores the
  persisted user layer to the source of the previous snapshot — a
  `profile`-sourced previous is restored by resetting the override (no `mode:`
  key written), an `override`-sourced previous by rewriting exactly its mode —
  so ModeStore, Settings, and Runtime re-converge. Nothing is swallowed: the
  failure is logged, the compensation is bounded (no recursion, no duplicate
  registrations, no listener growth), and the path stays recoverable for later
  external edits.

### Fixed (compensation write double fault)

- A transition failure whose compensation write ALSO fails no longer silently
  ends in a permanent split-brain (`{ runtime: manual, settings: auto }`).
  The controller now keeps a pending compensation (the previous snapshot whose
  persisted source must be restored) and treats **runtime rollback as only the
  first step**: while it is set, the runtime stays authoritative on the pending
  target, and the very next reconciliation (any settings/document update)
  settles it first — restore the persisted source, confirm the live snapshot
  actually converged, then clear — before any newer desired transition runs.
- Recovery is bounded and intent-preserving. Each trigger performs at most one
  compensation write (a failed write never notifies, so a persistently broken
  persistence layer parks the pending state until the next external trigger:
  no busy loop, no recursion). If the pending restore clobbered a newer user
  change, the latest desired snapshot is re-persisted after the restore settles,
  so a `manual -> auto (fails) -> off` sequence converges to the latest intent
  (`off`) through the transactional previous (`manual`) first.
- The profile-vs-override restore semantics are unchanged: a `profile`-sourced
  previous clears the override (no `mode:` key written), an
  `override`-sourced previous rewrites exactly its mode.
- Observability: the transition failure and the compensation-write failure are
  logged as distinct events (`... failed; restoring previous ...` vs
  `... failed to restore the persisted mode source ...; compensation remains
  pending`), and a public `pendingCompensation` probe exposes the pending
  rollback target.

### Restored tests

- `test/mode-store.test.ts` (11), `test/runtime-mode-controller.test.ts` (4),
  `test/hot-switch.test.ts` (8) — ported from the v0.3 development backup and
  adapted to the v0.2.2 architecture (store-backed tools, `/align-migrate` and
  the always-on `/align-mode` in the command groups, state-preservation
  matrix). All 133 v0.2.2 tests are unchanged and passing.
- `test/external-settings-failure.test.ts` (11) — regression coverage for the
  external-transition compensation: profile-source rollback, override-source
  rollback, recoverability, and no-duplicates/no-recursion after failure +
  compensation + retry, plus six double-fault cases (profile-source and
  override-source compensation-write failure, recover-after-double-fault,
  latest user intent, no busy retry, and no duplicates after a full
  double-fault cycle) and the `setMode` rollback double fault.
- `test/sidecar-fold.test.ts` (4) + `src/sidecar-fold.ts` — the sidecar-read
  and simulated-resume helpers behind `scripts/fold-session.mjs`.

### Fixed (release-ready follow-through)

- **First-start registration failure is fully rolled back.** If the initial
  `null -> Auto/Manual` transition fails, the runtime now keeps only the
  always-on `/align-mode` control command; it no longer leaks `/align` and
  `/align-migrate` while reporting `activeMode = null`. A regression test also
  proves a later retry can recover normally.
- **Fresh installs stay on the verified DSH rc.6 seam.** Runtime DSH package
  dependencies are pinned to `0.1.0-rc.6` instead of prerelease caret ranges,
  so a clean tarball install cannot silently mix newly published rc.7 packages
  into the rc.6 profile validated by this release.
- **`/align` no longer tells the model to fold the session log.** The manual
  check message points at the durable sidecar baseline and the steered user
  message now includes the current status report, so Manual mode can see the
  baseline without a policy section.
- **Dogfood 11/12 fold the sidecar.** `scripts/fold-session.mjs` reads
  `storages/requirements_alignment.json` (legacy session-log fold is fallback
  only).
- **Invalid override repair is no longer one-shot.** A later illegal value
  after a successful repair is cleared again.
- **`setMode` / `resetMode` share pending compensation** with the external
  settings path: a persist failure whose runtime rollback also fails no longer
  silently split-brains.

### Verification

- Type checking, linting, and build passed.
- Node tests: **176/176 passing**.
- Current-tarball packed add/boot/remove smoke: **40/40**. The profile starts
  without a source checkout link; Auto / Manual / Off, `/align`, `/align-mode`,
  policy presence, tool registration, direct `establish_baseline`, uninstall,
  and manifest restoration are verified through real DSH registries. External
  model completion was unavailable (`QUOTA: Insufficient Balance`) and is not
  counted as a model E2E pass.
- Hot-switch matrix (all six cross-mode transitions): PASS, including Off →
  Auto via `/align-mode`.
- Persistence regression suite (cold resume / fork / historical fork /
  compaction / legacy migration): PASS — production still emits zero
  `alignment/*` session events.
- Runtime Mode backend + `/align-mode`: implemented. Native Web Settings UI:
  not implemented (no DSH Core patch this round).

## 0.2.2 - 2026-08-18

### Changed (DSH rc.6 persistence compatibility)

- **Canonical alignment state moved out of the Session event log.** The DSH
  Session log now carries official DSH-recognizable events only; canonical
  alignment state lives in the durable `AlignmentStateStore` sidecar — an
  official `storage-domain` → `storage-json` backend domain keyed by session
  lifecycle identity (`{ id, createdAt, cwd }`). A bare DSH build without this
  plugin still reads any new session.
- **Storage-domain durable sidecar.** Whole-state checkpoints
  (`{ visibleThroughSeq, state }`) with durable-first mutations: validate →
  durable put → memory commit, so a failed durable write surfaces and never
  leaves a divergent live view.
- **Resume / historical fork / compaction support.** Sidecar checkpoints
  restore identical state on cold load, inherit the state in force at a
  historical `seedLength - 1` boundary, and survive compaction.
- **Legacy `alignment/*` migration.** The `alignment/*` event vocabulary is
  kept only as legacy compatibility / legacy migration / test fixture / fold
  fallback; production paths append zero `alignment/*` session events.
- **statusCache session-identity isolation fix.** `AlignmentStateStore`'s
  derived-status cache is now bound to the lifecycle identity
  (`id + createdAt + cwd`) that produced it, matching the record lookup's
  identity rule. A cached status only hits when the identity matches, so a
  session id reused by a different lifecycle can never leak stale alignment
  state through the cache, and lineage inheritance for a reused-id fork is no
  longer suppressed by a stale cached status.
- **Align-driver lifecycle regression fix.** The dogfood align driver no
  longer captures the `requirementsAlignment` store eagerly at `apply()` time:
  it re-resolves the store on every status read, so a driver mounted before
  the controller (and its sidecar) appears reads the durable sidecar revision
  instead of permanently falling back to the legacy session-log fold
  (revision 0). The legacy fold remains the fallback when no store ever
  exists.

### Verification

- Type checking, linting, and build passed.
- Node tests: 133/133 passing (2 statusCache identity + 3 align-driver
  lazy-resolution regressions).
- Targeted persistence / migration / store regression suites pass (29/29).
- Real dogfood 01-greenfield / 02-typo / 03-bugfix pass (03 asserts
  `baseline recorded` + `revision >= 1` from the sidecar).
- `npm pack --dry-run` passes (exports targets all present; no v0.3.0
  runtime-mode / hot-switch files; no test artifacts).

## 0.2.1 - 2026-08-16

### Added

- **Native configuration schema for auto / manual / off modes.** The plugin
  now exports a DSH/Schemastery `Config` schema so Cordis can validate
  `mode` as `auto` / `manual` / `off` at load. YAML stays
  `mode: auto|manual|off` (default `auto`). `resolveConfig` remains the
  runtime rule: invalid `mode`, unknown keys, and a blank or non-string
  `section` still fail at load. Current DSH Web does not auto-generate a
  Settings UI control from this schema for third-party plugins.
- **`/align` mode line.** Auto and Manual status text includes `Mode: Auto` or
  `Mode: Manual`. Off still registers no `/align`.
- **Three-mode packed smoke.** `scripts/packed-smoke.ps1` installs the current
  tarball, then boots Auto → Manual → Off and asserts policy / tools / `/align`
  from the assembled system prompt and live registries before remove restores
  the profile.
- **Mode-selection docs.** README adds Choose how alignment runs, the three-mode
  matrix, Auto as the recommended default, Off ≠ Uninstall, and the wait-for-
  browser-auth → publish-resumed screenshot (caption limited to what the
  session log can prove).

### Verification

- Type checking, linting, and build passed.
- Node tests: 91/91 passing.
- Packed add/rm smoke: **34/34** — Auto → Manual → Off against the current v0.2.1 tarball.

## 0.2.0 RC round 2 - 2026-08-16

### Fixed (release-gate findings)

- **The user's exact choice now comes back to the agent.** `report_drift`'s
  tool result carries `note` (the free-form answer or the selected option
  label) and echoes `requiredChange`; the rendered outcome names the chosen
  direction verbatim ("The user chose the direction \"Use export files\"...").
  Previously the tool returned only `decision`, so the agent re-asked "which
  direction did you pick?" after every revise decision (dogfood case 09
  reproduced this with two question rounds).
- **Resume/crash recovery of the chosen direction.** `baselineSummary()` now
  projects the last decision with its note ("Last user decision: revise - Use
  export files"), the last drift's `requiredChange`, and the pending line names
  the chosen direction. A resumed session's system prompt therefore shows
  exactly what the user picked; before this round only the posture
  (`baseline-update-pending`) was recoverable.
- **Case 09 gate tightened to exactly one question round.** report_drift →
  user picks the custom option → the agent goes straight to
  `establish_baseline`; any re-ask fails the case.
- **New interruption test (case 12, revise path).** The driver halts right
  after a revise decision whose note is "Use export files"; the persisted
  on-disk log folds to `baseline-update-pending`, the durable decision event
  keeps the exact chosen direction, and the projected summary (what a resumed
  session sees) contains "Use export files" verbatim.
- **Packed-smoke policy assertion tightened.** The align driver now assembles
  the REAL system prompt per session (`verifyPolicySection`) and records
  whether the `requirements-alignment:policy` section is present in the
  section registry plus the head of its resolved text; the packed smoke gates
  on that plus the unique policy heading instead of the loose
  `align|baseline|drift` final-answer match (which the user task text itself
  could satisfy).
- **Release hygiene.** `.gitignore` normalized to LF with no trailing
  whitespace (a ZIP copy of the working tree previously showed `MM
  .gitignore` on machines without `core.autocrlf`); `.gitattributes` pins
  `eol=lf` for `.gitignore` and itself.

### Verification

- Type checking, linting, and build passed.
- Node tests: 84/84 passing.
- Real DSH dogfood re-verified per scenario: 09-drift-choice **6/6**
  (rounds=1), 11-interrupt **9/9** (regression), 12-interrupt-revise **12/12**
  (new) — full-suite recount: 11 scenarios / 63 checks.
- Packed v0.2 add/rm smoke: **14/14** against the current tarball; the policy
  section is verified through the assembled system prompt / section registry.
- Core modifications: 0.

## 0.2.0 - 2026-08-14

### Changed (directional rewrite)

- Repositioned the plugin from pre-execution alignment to a **runtime requirement drift guard** ("Plan Mode prevents a bad plan from starting; Requirements Alignment prevents a good plan from drifting").
- Introduced the **Requirement Baseline** (goal, explicit constraints, must-preserve behavior, allowed scope, settled user decisions) with whole-value, revisioned `alignment/baseline` and `alignment/baseline-updated` session events.
- Replaced the generic `ask_user_question` counting with **dedicated alignment events** (`alignment/drift`, `alignment/decision`, `alignment/manual-check`) written only by this plugin; unrelated questions (plan mode, other plugins, ordinary agents) can no longer pollute alignment state.
- Added two model-facing tools over the native seams: `establish_baseline` (silent baseline recording/revision) and `report_drift` (drift candidate → user question → recorded decision).
- Rewrote the system-prompt policy around silent monitoring, the drift taxonomy, the drift protocol, and the child-agent escalation rule; the section now also renders the folded baseline summary per session.
- Redefined `/align` as a manual alignment inspection (status report + fresh check steering); removed all "hard gate" wording.
- Kept `mode: auto|manual|off`, the profile-bundle install path, plan-mode compatibility, and zero Core modifications.

### RC fixes (release-candidate round)

- **Decision mapping**: a model-supplied alternative direction the user picks now maps to `revise` with the chosen option label as the note (free text keeps the user's own words). The exact default approve / stay-within-scope options are always offered alongside the model's options (`withDefaultOptions`), so a "stay" intent can never be trapped inside a model-rewritten label. Uninterpretable answers (no selection, multiple selections, or a label matching no presented option) fail loud instead of being silently recorded as `reject`.
- **Durability state machine**: the fold now distinguishes `unknown` / `aligned` / `drift-pending` / `baseline-update-pending`. After an approve/revise decision, the session stays `baseline-update-pending` until a newer baseline event is recorded — an interrupted, crashed, or resumed session can no longer fold to `aligned` against the stale baseline. `reject` keeps the current baseline in force with no forced revision.
- **Side-effect ordering**: `report_drift` validates all arguments and interaction prerequisites before appending anything; invalid input fails with zero session pollution.
- **Protected-constraint policy**: explicit scope/preservation constraints ("do not change X", "without changing X", "preserve X", "keep X compatible", "only change X", "do not refactor Y", "no backend changes", "keep public API unchanged", "no UI changes") now require a silent `establish_baseline` BEFORE the first substantive mutation, and the drift protocol explicitly requires `report_drift` before implementation of a changed direction (never as a post-hoc summary).
- **Packaging**: fixed the `"."` exports `types` path to the real build output (`./lib/index.d.ts`) and dropped the dead `./src/*` subpath; every remaining exports target now resolves inside the packed tarball.
- **Dogfood**: added custom drift choice (09), invalid options (10), and approve-interruption durability (11) scenarios; 03 now hard-asserts the silent baseline with both protected constraints captured before the first mutation; the 05 natural benchmark runs separately (`-Benchmark05`, NATURAL DRIFT TRIGGER N/M, never presented as a mechanism verification); `scripts/fold-session.mjs` re-folds the persisted on-disk session log; `scripts/packed-smoke.ps1` verifies add → boot → remove against the current v0.2.0 tarball. The runner gained per-scenario hard timeouts (`-TimeoutSec`), `-FailFast`, a development `-Smoke` mode (02/03/04/09), infrastructure-error detection with logs kept, and a project-memory document (`docs/PROJECT-MEMORY.md`) with the operational rules (full-access requirement, smoke-first, ≤2 workaround attempts).

### Verification

- Type checking, linting, and build passed.
- Node tests: 81/81 passing.
- Real DSH dogfood: full correctness suite 10 scenarios, 50/50 checks passing.
- Natural drift trigger: 3/4 natural runs (04 ×1, 05 ×3 via `-Benchmark05`) called `report_drift` on their own.
- Packed v0.2 add/rm smoke: PASS (13/13 checks against the current tarball).
- Core modifications: 0.

### Known limitations

- Drift detection remains model-driven policy, not a hard gate (the fold already derives `drift-pending` and `baseline-update-pending` for a future `mode: guard`).
- Natural user-direction-change runs trigger `report_drift` in a fraction of runs (3/4 in the RC benchmark; measured honestly in ACCEPTANCE.md). Agent-detected constraint conflicts are more reliable.
- Baseline content is model-produced; the fold is deterministic.
- `/align` requires a command adapter (headless/ACP spines do not dispatch slash commands).
- DSH is still in developer preview, so integration points may need adaptation as its APIs evolve.

## 0.1.1 - 2026-08-14

### Changed

- Reframed the public documentation around lightweight, low-interruption requirement alignment.
- Removed repository-specific absolute paths and made dogfood overlays portable across checkouts.
- Added package discovery metadata, public repository links, and a cross-platform CI gate.

### Verification

- Type checking, linting, and build passed.
- Node tests: 31/31 passing.
- Real DSH dogfood scenarios: 6/6 passing.
- Local npm tarball install/uninstall verified against an isolated DSH profile.

### Known limitations

- Alignment decisions remain heuristic and model-dependent.
- DSH is still in developer preview, so integration points may need adaptation as its APIs evolve.

## 0.1.0 - 2026-08-14

- Initial npm publication of the native DSH requirement-alignment plugin.
