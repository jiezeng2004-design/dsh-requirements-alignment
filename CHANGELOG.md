# Changelog

All notable changes to this project are documented here.

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
