# Changelog

All notable changes to this project are documented here.

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
