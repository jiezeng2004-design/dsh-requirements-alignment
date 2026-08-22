# dsh-requirements-alignment

> Runtime requirement drift guard for DeepSeek Harness.

Keep long-running agents aligned with user intent while they work.

## Overview

`dsh-requirements-alignment` turns the user's request into a durable **requirement baseline** — goal, protected constraints, must-preserve behavior, allowed scope, and settled user decisions — and guards it while the agent executes. The agent works silently until a step would materially change the task direction; only then does the plugin surface a **drift candidate** to you, records your decision, and updates the baseline.

Canonical alignment state lives in the durable `AlignmentStateStore` sidecar — an official `storage-domain` domain over the `storage-json` backend — never in session events. The DSH Session log holds only official DSH-recognizable events, so a bare DSH build (without this plugin) reads any new session, and resume, fork, and compaction recover the same state. The `alignment/*` event vocabulary is kept solely for legacy compatibility, migration, and test/fold fallbacks; production never appends it.

**You decide the direction. The agent decides the engineering.**

## Requirements Alignment vs Plan Mode

```
Plan Mode asks:            "Is this the right implementation plan?"
Requirements Alignment asks: "Are we still solving the right problem?"
```

> Plan Mode prevents a bad plan from starting.
> Requirements Alignment prevents a good plan from drifting.

Plan Mode is the official review-approve step *before* implementation. Requirements Alignment is intent continuity *during* execution. They compose: plan, approve, execute — and this plugin keeps the execution on the approved direction. It never modifies plan mode, `exit_plan_mode`, or any `@deepseek-ai/*` core package.

## How it works

| Mechanism | What it does |
|---|---|
| System-prompt policy section | In `auto` mode (default) the drift-guard policy is contributed to every agent's prompt at order 60. It teaches the agent to hold a requirement baseline, monitor silently, and detect direction-level drift — scope expansion, constraint conflict, user-visible behavior change, architecture shift, invalidated assumptions, user direction change. |
| `establish_baseline` tool | Records the baseline (goal, `explicitConstraints`, `mustPreserve`, `allowedScope`, `userDecisions`, `openDirectionDecisions`). Silent — it never asks the user. Recording again bumps the baseline revision. |
| `report_drift` tool | Records a drift candidate (`reason`, `description`, `requiredChange`), asks you one question through the native user-questions channel, and records your decision. The default approve / stay-within-scope options are always offered; the two defaults map to `approve` / `reject`, a model-supplied alternative direction you pick — or your own free-text answer — maps to `revise` with your exact words as the note, never to a silent rejection. The tool result returns your exact choice (the `note`) and the required baseline change to the agent, so it never re-asks what you picked. Only alignment state managed by this plugin contributes to the requirement baseline — unrelated `ask_user_question` calls (plan mode, other plugins) never pollute it. |
| `/align` command | Manual entry: reports the current alignment status (baseline revision, goal, protected constraints, drift count, last drift, last decision, current status, and whether the mode is the profile default or a runtime override) and steers a fresh alignment inspection into the agent. It inspects; it never blocks execution. |
| `/align-mode` command | Always-on mode switch. No argument prints the three-layer snapshot (effective / profile default / runtime override). `/align-mode auto\|manual\|off` persists a runtime override; `/align-mode reset` drops it. Stays registered in Off so a live switch to Off is reversible without editing `settings.yaml`. |
| Durable state | Canonical alignment state is written to the durable `AlignmentStateStore` sidecar (official `storage-domain` → `storage-json` backend), keyed by session lifecycle identity, so it survives resume, fork, and compaction — and a bare DSH build without this plugin still reads new sessions. The session log itself only ever receives official DSH events; `alignment/*` remains a legacy/migration/fold fallback only. |

## Installation

```powershell
# from anywhere; path is anchored to your invoking directory
dsh plugin --profile web add <path-to-this-checkout>
# or from the registry once published
dsh plugin --profile web add dsh-requirements-alignment
```

The plugin is a **profile bundle** (`dsh.bundle.patch` + `cordis.patch.yml`), so it installs through the standard plugin mechanism and adds two rows:

- `requirements-alignment` — the controller (policy section, `/align`, `/align-mode`, both tools);
- `requirements-alignment-ask-user` — the model-facing question tool.

## Quick Start

Install the bundle and start a normal DSH task. Auto mode is enabled by default; clear tasks run with zero interruption, and you are only asked when the execution is about to change direction.

```powershell
dsh plugin --profile web add dsh-requirements-alignment
```

Use `/align` any time you want to inspect whether the current execution still matches the requirement baseline.

## Choose how alignment runs

Alignment mode is a **four-layer model** that can change at runtime without a profile restart:

```text
valid session override  ->  valid persisted runtime override  ->  valid profile default  ->  auto
```

| Layer | Source | Persisted where |
|---|---|---|
| **Session Override** (`sessionMode`) | Your per-session switching (`/align-mode session`). Only the calling session is affected. | The durable `requirements_alignment_modes` sidecar (official `storage-domain` → `storage-json`), keyed by session lifecycle identity |
| **Profile Default** (`defaultMode`) | The composition/profile config — `mode: auto|manual|off` in the profile bundle (`cordis.patch.yml`), default `auto` when absent. | Profile composition |
| **Runtime Override** (`overrideMode`) | Your runtime switching (`setMode` / the settings document). | `settings.yaml` via the DSH Settings service (`@deepseek-ai/dsh-settings`) |
| **Effective Mode** | `effectiveMode = valid session override ?? valid runtime override ?? valid profile default ?? auto`; **Effective Source** reports which layer produced it (`session` / `override` / `profile`). | derived |

```yaml
- id: requirements-alignment
  name: dsh-requirements-alignment
  config:
    mode: auto          # profile default; a runtime override wins over this
```

- **Session Override** — switching Auto → Manual → Off for ONE session via `/align-mode session`. Only the calling session's effective mode changes; other live sessions and the shared runtime override never move. Persisted per session (keyed by `id + createdAt + cwd`), so a resumed session restores its override, and a fork inherits the effective session override at its seed boundary (then becomes independently changeable). An invalid persisted value fails open to the next valid layer.
- **Profile Default** — the composition layer. It is the fallback when no session or runtime override exists. Changing it (or either override) never rewrites the others; switching modes never edits the profile YAML.
- **Runtime Override** — switching Auto → Manual → Off at runtime is persisted through the DSH Settings service, so a DSH restart restores `effective = your last runtime override`. An invalid persisted value (for example a hand-edited `mode: banana`) never fails startup: the plugin falls back to the profile default and repairs the document once.
- **Reset to Profile Default** — resetting (a `resetMode` call or replacing the settings section with `{}`) drops the runtime override. `effective = defaultMode`, source = `profile`. It never re-writes the current effective mode as a new override.
- **Web floating capsule (v0.4.1)** — in DSH Web, a bottom-right collapsible capsule shows the current session's effective mode as a colored dot + label. Expanding it manages the two layers you control: the **session layer** (toggles the current session's override only) and the **shared layer** (the runtime override every session falls back to). Everything goes through the loopback management API, so the capsule and `/align-mode` always agree.

**Hot switching** — mode transitions are per-agent register/dispose operations on the agent's OWN scope (`agent.ctx`), not a "change the config and restart" step. When a session's effective mode changes, that session's agent is re-synced: the outgoing capability set is disposed and the incoming one registered in the agent's scope. Two live sessions hold disjoint capability sets with zero leakage. Auto → Manual → Off → Auto can be cycled live with no duplicates, no listener leaks, and no profile restart. `/align-mode` is the always-on control command: an Off session has no alignment capabilities at all (no policy, no tools, no `/align`) but keeps `/align-mode` so it can switch itself back.

> **Runtime Mode backend: implemented.** **Web floating capsule: implemented** (v0.4.1). The capsule — a bottom-right collapsible float in the DSH Web `shell.overlay` slot — switches the session and shared layers via the plugin's loopback management API, so it can never disagree with `/align-mode`. The runtime override is also persisted through the official DSH Settings service (`@deepseek-ai/dsh-settings`), and an external `settings.yaml` hot edit is picked up live. The profile default remains `mode:` in the profile bundle.

**Auto is the recommended default.** Clear tasks run with zero interruption; you are only asked when the execution is about to change direction.

| Mode | Policy section | Alignment tools (`establish_baseline`, `report_drift`) | `/align` (+ `/align-migrate`) | `/align-mode` |
|---|---|---|---|---|
| **Auto** (recommended) | yes | yes | yes | yes |
| **Manual** | no | yes | yes | yes |
| **Off** | no | no | no | yes |

Every cell above describes ONE session's effective mode. Since v0.4.0 the capabilities are registered in that session's agent scope (`agent.ctx`), so two live sessions can hold different effective modes at the same time — the matrix applies per session, never globally.

- **Auto** — the drift-guard policy is in this session's system prompt. The agent records a light baseline when the request carries protected scope, stays silent otherwise, and calls `report_drift` only for a real direction change.
- **Manual** — no automatic policy. The agent works normally until you run `/align`, which reports status and steers a fresh inspection.
- **Off** — this session has NO alignment capabilities: no policy, no alignment tools, no `/align`. `/align-mode` (registered at plugin scope) stays so you can switch this session back to Auto or Manual without editing the profile or `settings.yaml`.

### Session-scoped mode (v0.4.0)

`/align-mode` operates on the **shared** layers (runtime override + profile default); `/align-mode session` operates on **only the current session**:

```
/align-mode                  # this session's four-layer snapshot
/align-mode session          # same four-layer snapshot
/align-mode session auto|manual|off   # set ONLY this session's override
/align-mode session reset    # drop this session's override -> shared layers
/align-mode auto|manual|off  # shared runtime override (all sessions fall back to it)
/align-mode reset            # drop the shared runtime override -> profile default
```

`/align-mode session` is explicit so you cannot accidentally change every session while intending to change only the current one. Two concurrent sessions can hold different effective modes with zero leakage; changing Session A never changes Session B or the shared runtime override. A resumed session restores its override, and a fork inherits the effective session override at its seed boundary (then becomes independently changeable). The four-layer snapshot identifies the exact source of the current session's effective mode (`session override` / `runtime override` / `profile default`).

### State is never lost by switching modes

Canonical alignment state (baselines, drifts, decisions, manual checks) lives in the **independent** `AlignmentStateStore` sidecar, and session-mode overrides live in the separate `requirements_alignment_modes` sidecar. Switching Auto → Manual → Off → Auto (shared or per session) only changes which capabilities are registered in that session's agent scope; it never deletes a baseline, never deletes either sidecar, never clears state, and never rewrites session events. A baseline established in Auto is still there after Off and back, and a session override is never touched by a shared reset.

### Off ≠ Uninstall

`mode: off` (as profile default, a runtime override, or a session override) leaves the bundle in the profile. The row is still loaded; an Off session has no alignment capabilities, and `/align-mode session auto|manual|off` can switch it back live. That is not the same as uninstalling. (A session that predates the persistence-compatibility fix may still carry legacy `alignment/*` events in its log; current production never appends them.)

```yaml
# disable the controller only (leaves the ask-user tool mounted)
#   in the profile's cordis.patch.yml:
#   - id: requirements-alignment
#     disabled: true
```

```powershell
# full uninstall — DSH returns to its previous behavior
dsh plugin --profile web rm dsh-requirements-alignment
```

Every registration is a Cordis effect disposer: unloading removes the plugin-scope `/align-mode` and explicitly unwinds every per-agent capability set (policy section, `/align` + `/align-migrate`, both tools). Canonical alignment state remains in the durable sidecars. Only sessions written by older versions keep legacy `alignment/*` events in their log — the current plugin never appends them to live sessions.

## Auto mode (default)

The policy section is present in every agent's system prompt. Behavior at task start:

- **Clear request with protected scope** ("Fix the form bug without changing the UI or public API") — the agent records a *light* baseline with `establish_baseline` (silent) **before the first substantive edit**, pinning the constraints, then works. No user question is involved.
- **Trivial request** ("Fix the typo in README.md") — nothing is recorded; the agent just works.
- **No baseline can be formed** (greenfield / vague: new product, undefined form, scope, or interaction) — the agent asks the ONE highest-priority direction question via `ask_user_question`, records the baseline, and works.

During execution the agent is **fully silent** unless an action would materially change the baseline (drift). There are no periodic checks, no tool-call counting, no per-file questions. When a drift candidate appears, the agent calls `report_drift` *before* acting; the tool result names your exact choice back to the agent (the `note` and any required baseline change), it records the outcome and, if you approved or revised the direction, the baseline advances to the next revision. The same choice is projected in the per-session baseline summary, so an interrupted or crashed run that resumes knows exactly what you picked without asking again.

A delegated instruction such as "pick whatever makes sense" does not waive the one start question for a greenfield idea.

## Manual `/align`

```yaml
# profile cordis.patch.yml (or a --patch overlay):
- id: requirements-alignment
  config:
    mode: manual
```

Manual mode contributes no policy section — the agent works normally until you invoke the command:

```
/align
```

`/align` records the inspection, reports the current alignment status, and steers a fresh alignment check into the agent (which may then run the drift protocol if it finds a candidate). It never takes over the workflow and never blocks execution. The steered check uses the durable sidecar baseline, not the session event log.

```
/align-mode          # show effective / profile default / runtime override
/align-mode manual   # persist a runtime override and hot-switch now
/align-mode reset    # drop the override; return to the profile default
```

## Example interaction

```text
User:  Fix the submit bug. Don't change the UI or the public API.
Agent: [records the baseline silently, fixes the bug — no questions]
```

```text
User:  The result-page filter is the only thing to improve. Do not refactor backend logic.
Agent: [working… discovers the backend filter itself is broken and a correct fix would
       need backend changes]
Agent: [report_drift → you are asked]
User:  Stay within the current scope.
Agent: [improves the UI only, leaves the backend untouched]
```

```text
User:  The app is single-user and local-only. Now make it work across devices.
Agent: [detects an architecture shift]
Agent: [report_drift → you are asked]
User:  Approve the direction change — multi-user with accounts and cloud sync.
Agent: [records the updated baseline (revision advances) and implements]
```

## A long task that waits, then continues

When a step needs you, the agent asks and waits instead of guessing. The session below is a real run of a long publish: the log shows the agent asking you to finish browser authorization, then continuing after you did.

![Waiting for browser authorization, then authorization completed and publish resumed](alignment-continuation.png)

What the session log can prove: the agent asked the user to complete browser authorization for publish and waited for an answer; after the user completed authorization, the publish job finished with exit 0 and the session continued. The log does not record a later registry listing or any outcome beyond that job's exit code.

## Drift taxonomy

The plugin records one of these reasons on every drift candidate:

| Reason | Meaning |
|---|---|
| `scope-expansion` | Doing materially more than asked (e.g. "optimize the page" → "refactor all state management"). |
| `constraint-conflict` | An explicit constraint blocks the way ("keep the API" — but the API must change to continue). |
| `behavior-change` | A decision changes product behavior, UX, defaults, or compatibility without prior authorization. |
| `architecture-shift` | Local→cloud, backend, auth, multi-user, sync, persistence model, public API, schema, migration. |
| `data-model-change` | The data model must change in a way the user did not authorize. |
| `compatibility-change` | Existing callers, formats, or APIs would break. |
| `assumption-invalidated` | The implementation rested on a key assumption the code now disproves, and continuing needs a new direction. |
| `user-direction-change` | The user introduced a new direction mid-task. |

## What never triggers alignment

The agent decides autonomously: filenames, helper placement, variable naming, map vs loop, routine refactors, formatter, lint, test placement, ordinary library use, the repository's established stack, small internal designs that do not change observable behavior, in-scope bug fixes, and necessary test additions.

## Subagents

DSH child agents cannot ask the user (`ask_user_question` and `report_drift` reject with `DELEGATED_CALLER` for owned children). A child that would need to change the baseline does not decide: it includes a `Requirement drift candidate` block — reason, current baseline, required change, decision needed — in its final report (or the `report` tool when available). The parent owns the user interaction and runs the drift protocol.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `mode` | `auto` | **Profile default layer** of the runtime mode (`auto` — policy section + tools + commands; `manual` — tools + commands only; `off` — inert, nothing registered). A valid persisted runtime override wins over it at startup and while running; reset drops the override and returns to this value. |
| `section` | shipped policy | Deployment-owned policy text replacing the shipped one (auto mode). Must be non-empty when provided. |

Unknown config keys fail at load (same stance as `dsh-plan-mode`).

## Safety boundary

- **No Core modifications.** Zero changes to `@deepseek-ai/*` packages; the only host-side file touched is the profile's bundle list / patch, which is exactly the mechanism DSH provides for installing plugins.
- **Question channel + durable sidecar.** The plugin never inspects the user's workspace files. It writes alignment state to the official `storage-domain` sidecar, persists a runtime mode override through the DSH Settings service when one is mounted, and steers one user message on `/align`. Production never appends `alignment/*` session events.
- **No file access.** It does not inspect the filesystem itself; the agent does that with its own tools under the normal sandbox.
- **No background monitoring.** Drift detection is model-driven policy, not a watcher; there is no periodic interruption loop.

## Limitations

- **Soft guard, not a hard gate.** Whether an action is a drift candidate is the model's judgment (that is the product design: "user decides direction, agent decides engineering"). The plugin records and re-aligns; it does not block execution. A future `mode: guard` can build on the same events (the fold already derives `drift-pending` and `baseline-update-pending`) without changing the architecture.
- **Natural drift detection is model-driven.** In natural runs (no protocol instruction in the task), a mid-task user direction change triggers `report_drift` in a fraction of runs (measured honestly in the acceptance report: 3/4 in the RC benchmark); agent-detected constraint conflicts are more reliable. The policy is written to maximize the natural rate; the mechanism itself is deterministic once invoked.
- **`/align` needs a command adapter.** UI-less spines (the headless profile, ACP automation) do not dispatch slash commands; the command is exercised by the Web client and by the unit tests / dogfood driver.
- **Subagents cannot ask the user.** They report drift candidates to the parent, which owns the interaction.
- **Baseline content is model-produced.** The fold is deterministic; what the model records as the baseline is the model's reading of the task. Keep prompts explicit when the direction matters.
- **Sidecar grows append-only.** Every baseline, drift, decision, and manual check appends a whole-state checkpoint; there is no pruning yet. Very long sessions with many `/align` runs accumulate checkpoints (reads stay `O(1)` at the head, storage grows with the mutation count).
- **Capsule state is polled, not pushed.** The floating capsule polls the loopback management API every 2s while the page is visible; a mode change applied from another tab or by `settings.yaml` hot edit may take up to one poll cycle (~2s) to appear. Full baseline history is still inspected through `/align` text; the capsule shows the latest snapshot only.
- **The capsule rides the `shell.overlay` slot and the webServer service.** If the web profile is not running, or the `shell.overlay` slot is unavailable, the capsule simply does not mount and `/align-mode` remains the control surface.

## Testing and verification

The release gate runs type checking, linting, a production build, and the Node test suite:

```powershell
pnpm run check
```

Real DSH dogfooding boots real `dsh` profiles with an isolated `DSH_HOME`. Three run modes keep development fast and honest:

```powershell
powershell -File scripts/dogfood.ps1 -Smoke        # development: 02-typo, 03-bugfix, 04-scope-drift, 09-drift-choice
powershell -File scripts/dogfood.ps1 -Scenario 12-interrupt-revise   # one scenario
powershell -File scripts/dogfood.ps1               # FULL correctness suite (RC gate): 01..13 minus the 05 benchmark
powershell -File scripts/dogfood.ps1 -Benchmark05  # natural benchmark: 3 runs, reports NATURAL DRIFT TRIGGER N/M
```

`-FailFast` aborts at the first failed check; `-TimeoutSec <n>` (default 600) is a hard per-scenario timeout that kills the process tree. Scenario tasks for natural-behavior cases (03, 04, 05) contain NO protocol instructions; protocol-forced mechanism cases (01, 06, 07, 08, 09, 10, 11, 12, 13) are reported separately — the natural drift trigger rate is its own metric, never presented as a mechanism verification. Scenario 13 (session-scoped mode) exercises the two-session isolation probe (`switchTopLevelOnSubagent`). The full suite must run under `danger-full-access` (see `docs/PROJECT-MEMORY.md`).

The packed-artifact smoke packs the current tarball, installs it into a disposable profile, boots Auto → Manual → Off (`/align`, `establish_baseline`, and the policy section are asserted from the assembled system prompt and live registries — not a loose word match), removes it, and verifies the profile restores cleanly:

```powershell
powershell -File scripts/packed-smoke.ps1
```

The v0.2.1 release gate verified:

- Core modifications: **0**
- Node tests: **91/91 passing**
- Packed add/rm smoke: **34/34** — Auto → Manual → Off against the current v0.2.1 tarball
- v0.2.0 dogfood baseline (unchanged protocol): **63/63 checks passing** (11 scenarios); natural drift trigger **3/4**

The v0.2.2 persistence-compatibility gate verified:

- Core modifications: **0**
- Node tests: **133/133 passing** (2 `statusCache` session-identity + 3 align-driver lazy-resolution regressions)
- Targeted store / persistence / migration regression suites: **29/29 passing**
- Align-driver regression: `apply()` before the controller exists → later reads resolve the sidecar (revision 1), never the legacy fold
- Real dogfood 01-greenfield / 02-typo / 03-bugfix: **PASS** (03 asserts `baseline recorded` + `revision >= 1`)
- `npm pack --dry-run` passes (exports targets all present; no v0.3.0 runtime-mode / hot-switch files)
- DSH rc.6 at the time: `KNOWN_SESSION_EVENT_TYPES` = **44** official known event types; `alignment/*` = **0** official known event types. The invariant is *semantic*: the registry intersects with the upstream known set and never contains `alignment/*` types — the fixed count is informational, not contractual.

The v0.3.0 runtime-mode / hot-switching gate verified:

- Core modifications: **0**
- Node tests: **176/176 passing** (v0.2.2 suite plus ModeStore, AlignmentRuntime, hot-switch, first-start rollback, external-failure, `/align-mode`, sidecar fold)
- Hot-switch matrix: Auto → Manual, Manual → Auto, Auto → Off, Off → Auto, Manual → Off, Off → Manual — **PASS** (live register/dispose, exactly-one capability sets, no duplicates after repeated cycles)
- Persistence independence: a baseline recorded in Auto survives Auto → Manual → Off → Auto
- Runtime override persistence: startup restores a persisted override; reset returns to the profile default (`effectiveSource = profile`); an invalid persisted override falls back and repairs
- Rollback: transition failure restores the prior mode; a settings persistence failure compensates the runtime back (no split-brain)
- Persistence regression suite (cold resume, fork, historical fork, compaction, legacy migration): **PASS** — production writer still emits **zero** `alignment/*` events
- Current-tarball packed add/boot/remove: **40/40** — clean profile with no source link; Auto / Manual / Off registries, `/align`, `/align-mode`, direct `establish_baseline`, uninstall, and manifest restoration verified. External model completion was unavailable (`QUOTA: Insufficient Balance`) and is reported separately rather than claimed as an E2E pass.

The v0.4.0 session-scoped-mode gate verified:

- Core modifications: **0**
- Node tests: **188/188 passing** (v0.3.0 suite rewritten for the per-agent capability model plus new `session-mode` and `session-mode-store` suites: four-layer resolution, two-session isolation, `/align-mode session`, fork inheritance, durable sidecar, identity binding, per-agent registration failure rollback)
- Per-agent capability matrix (unit): Auto registers policy + tools + `/align` + `/align-migrate` in the agent's own scope; Manual keeps tools + commands; Off registers nothing (only the plugin-scope `/align-mode` survives). Two live sessions hold disjoint capability sets with zero leakage.
- Shared-layer changes resync only agents without a session override; a session override pins that session against the shared layer.
- Session override durability: `setOverride`/`clearOverride` are durable-first (failed writes never commit); identity binding prevents id-reuse leakage; fork children inherit the parent override once and become independent.
- Dogfood scenario 13 (real boot, driver-confirmed pre-model): the top-level agent registers its full **auto** capability set in its own scope. The subagent/top-switch assertions require a live external model and could not run (`QUOTA: Insufficient Balance`) — reported separately, never claimed as a mechanism pass.
- Packed add/install/compose against the current 0.4.0 tarball: **PASS**; Auto/Manual/Off boot verification is blocked by the same external `QUOTA`.

The v0.4.1 Web capsule + DSH rc.1 compatibility gate verified:

- Core modifications: **0** (no `@deepseek-ai/*` change; no DSH Core patch).
- Node tests: **228/228 passing** — the full suite on the rc.1 dependency family
  (re-verified this round; +A–D capability rollback +E–H stale-session race,
  + the A–G mode-source/capability transaction matrix).
- Mode source / active capability atomicity (P0, this round): a mode change is
  considered COMMITTED only after BOTH the persisted source and the live agent
  capabilities converge; a failed capability transition compensates the source
  back (presence-preserving for session overrides), and the mutation reports
  failure — `/align-mode` and the management API never claim the target is
  active. The only advertised non-converged states are the explicit
  capability-degraded and pending source-compensation ones (both exposed on the
  status payload with the ACTUAL active capability mode).
- DSH baseline upgraded to **`0.1.1-rc.1`** exactly; `KNOWN_SESSION_EVENT_TYPES`
  is the official rc.1 semantic set (`alignment/*` types are never runtime-
  registered — the invariant is *intersection with the official known set*, not a
  hand-maintained count).
- Real-rc.1 migration parity: real rc.1 writer fixtures (full official
  vocabulary + five legacy alignment events; a fork child with
  `parentSession`/`seedLength`) migrate and reload through the real rc.1 reader
  with seq continuity, header, packed chunk rows, resume end-seed, and fork
  lineage preserved. Only whitelisted legacy events become `ignorable`;
  everything else is byte-preserved.
- Packed-artifact smoke against a real `0.1.1-rc.1` DSH installation: the
  tarball installs via the real `dsh plugin` command (bundle reconciled),
  `--dump-config` composes the plugin's two rows, a real headless boot mounts
  the plugin service and the full capability matrix is verified live — policy
  section in the assembled prompt, `establish_baseline` + `report_drift`
  tools, `/align` + `/align-mode` from the real registries. `/align-mode`
  persistence fails *loud* on the entry-only port when storage-domain is absent
  (verifies the no-silent-live-only contract); removing the bundle leaves no
  leftover rows. External model completion was unavailable (`QUOTA`) and is
  reported separately, never claimed as a model E2E pass.
- Client slot contract fix: the capsule's `shell.overlay` registration no longer
  uses a function-valued label; the render test asserts exactly one accepted
  registration.
- Capability transition rollback atomicity (P0, this round): the controller no
  longer reuses an executed (disposed) registration record on a failed
  transition — it RE-REGISTERS the previous mode with fresh disposers, and a
  double failure fails loud into an explicit degraded pending-reconciliation
  state. Verified in unit tests A–D.
- Stale-session Web Capsule race (P1, this round): the capsule now uses a
  request-generation token + session ref, so an out-of-order (or
  session→no-session) response can never overwrite the current session's
  snapshot, session mutations always target the current session, and no
  `?sessionId=undefined` request can ever be built. Verified in unit tests E–H
  against the production bundle with a real hooks/effects renderer, and the
  rebuilt bundle + loopback management API guard contract were verified live
  against the running DSH Web `0.1.1-rc.1`.

Detailed evidence and the bounded-run caveat are recorded in `ACCEPTANCE.md`.

## Development

```powershell
pnpm install          # dependencies
pnpm run typecheck    # tsc (src + test)
pnpm run lint         # eslint (src + test)
pnpm run build        # tsc → lib/
pnpm test             # node:test
pnpm run check        # all of the above
```

Real dogfooding (boots real `dsh` profiles with an isolated `DSH_HOME`; smoke mode for development, full suite + natural benchmark + packed add/rm smoke for the RC gate):

```powershell
powershell -File scripts/dogfood.ps1 -Smoke
powershell -File scripts/dogfood.ps1               # full correctness suite (RC gate)
powershell -File scripts/dogfood.ps1 -Benchmark05  # natural drift benchmark
powershell -File scripts/packed-smoke.ps1          # packed add/rm smoke (RC gate)
# run a single scenario:
powershell -File scripts/dogfood.ps1 -Scenario 05-arch-shift
```

See `docs/ARCHITECTURE.md` for the design decisions and the exact capability seams used.

## Compatibility

- DeepSeek Harness `0.1.1-rc.1` (verified against the npm registry releases and
  a real rc.1 DSH installation through the packed-artifact add/boot/remove
  smoke; migration parity is byte-for-byte with the rc.1 writer/reader).
- `@deepseek-ai/cordis` 4.x, `@deepseek-ai/dsh-*` `0.1.1-rc.1` (exact pins, no
  prerelease range drift).
- Windows (verified) and POSIX (no platform-specific code).
- Old v0.1 sessions fold safely: legacy `alignment/status` events still count as manual checks, and a session without the new events simply reports revision 0 / "unknown" instead of crashing.

## License

MIT. See `LICENSE`.
