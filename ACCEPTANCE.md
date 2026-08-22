# Acceptance report — dsh-requirements-alignment v0.4.1

Date: 2026-08-21 · package 0.4.1 · DSH 0.1.1-rc.1 · workspace: `<local-workspace>`

v0.4.1 closes the current unreleased line by folding **DSH 0.1.1-rc.1
compatibility** directly into v0.4.0's Web floating-capsule scope (no version
bump beyond 0.4.1). Scope: the Web floating capsule + DSH 0.1.1-rc.1
compatibility + rc.1 migration parity + typecheck fix + client slot contract
fix. The plugin remains a soft runtime drift guard; the no-DSH-Core-patch
boundary and the sidecar-owning persistence design are unchanged.

## v0.4.1 checklist

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Dependency family pinned to real `0.1.1-rc.1` (no line drift, no `0.0.1-rc.1` fallout) | ✅ | `package.json` + `pnpm-lock.yaml` use exact `0.1.1-rc.1` pins; reused offline store, no stray registrations. |
| 2 | Typecheck green on both tsconfigs | ✅ | `tsc -p tsconfig.json` EXIT=0; `tsc -p tsconfig.check.json` EXIT=0. |
| 3 | Lint green | ✅ | eslint EXIT=0. |
| 4 | Full node suite green on the rc.1 family | ✅ | **228/228 passing** (0 fail), including the A–G mode-source/capability transaction matrix. |
| 5 | Migration parity with the real rc.1 writer/reader | ✅ | Real writer fixtures migrate through the real rc.1 reader with seq continuity, header, packed chunk rows, resume end-seed, and fork (`parentSession`/`seedLength`) lineage preserved. |
| 6 | Only whitelisted legacy events become `ignorable`; everything else byte-preserved | ✅ | `decoding`/`sequenceToLegacy`/`encodeSegment` unchanged; repo bytes for header, packed rows, end-seed, fork metadata preserved outside the 6-type whitelist. |
| 7 | Client slot registration contract (no function-valued label) | ✅ | `src/client/index.js` `shell.overlay` registration; `test/client-render.test.ts` asserts exactly one accepted registration. |
| 8 | Packed add / boot / remove cycle clean on a real rc.1 installation | ✅ | Real `dsh plugin add` reconciles the bundle; `--dump-config` composes the two plugin rows; a real headless boot mounts the service, verifies the full registration matrix live (policy section in the assembled prompt, `establish_baseline` + `report_drift` tools, `/align` + `/align-mode` from real registries); `dsh plugin remove` leaves zero rows and no leftover node_modules. |
| 9 | Session-mode persistence contract unchanged | ✅ | `entryOnlySessionModePort` fails loud when storage-domain is absent; 11 `session-mode-store` unit tests. |
| 10 | Production still appends zero `alignment/*` | ✅ | `KNOWN_SESSION_EVENT_TYPES` is the official rc.1 semantic set; `alignment/*` types are never runtime-registered (intersection invariant, not a fixed count). |
| 11 | Capability transition rollback atomicity (P0) | ✅ | `syncAgent` transitions are transactional: dispose → register → only a successful registration is committed to the Map; a failure ROLLS BACK by re-registering the previous mode with FRESH disposers (the executed record is never put back); a rollback failure FAILS LOUD into `degradedAgents` (pending reconciliation) with both error provenances. Tests A–D in `external-settings-failure.test.ts`. |
| 12 | Stale-session Web Capsule race (P1) | ✅ | The capsule holds the live session id in a ref plus a request-generation counter; responses are committed only when generation AND session id still match (late A/B responses are dropped); a session → no-session switch invalidates the snapshot immediately and no `?sessionId=undefined` request can ever be built. Tests E–H in `client-race.test.ts` run the production bundle against a REAL hooks/effects renderer (the previous fake `useEffect` was a no-op). |
| 13 | No fake map state / no reused disposers | ✅ | `agentCapabilities` is observable and the invariant "every entry corresponds to a live capability" is asserted directly (rollback record never equals the executed record); A–F assert live tool/command counts and fresh-disposer unwinding. |
| 14 | Mode source / active capability atomicity (P0) | ✅ | A mode mutation is ONE transaction: persist the target source → reconcile every affected agent's capabilities → on a failed transition COMPENSATE the persisted source back to its previous topology (presence-preserving for session overrides) → report FAILURE. The advertised effective mode equals the live capability mode in every stable state; the only exposed non-converged states are the explicit capability-degraded (double failure) and pending source-compensation ones. Tests A–G in `external-settings-failure.test.ts`. |

Node tests: **228/228 passing**; typecheck, lint, and build green.

### P0 — capability transition rollback atomicity (verified)

- Manual → Auto with the incoming registration failing: the previous **Manual** set is RE-REGISTERED with fresh disposers (the map record is not the disposed one), the live tool/command matrix is intact, and the failed auto registration's partials were unwound inside `registerForAgent` (no half-registered set can leak into a rollback). The mutation REJECTS and the persisted source is compensated back to Manual, so the advertised effective mode AND the active capability mode both stay `manual` — never a silent "auto requested / manual active" split.
- Auto → Manual with the incoming registration failing (shared, plus the session-override variant): the previous **Auto** set is re-registered fresh; no leaked tools/commands (exactly one of each surviving command); the shared/session override is compensated back — a session that inherited Auto is compensated by CLEARING (the override never reappears as an equal-value record).
- Double failure (incoming register AND rollback both fail): the Map records NOTHING, the double failure is parked on `degradedAgents` with both error messages, an error-level log entry carries both provenances (fail loud), AND the persisted source is compensated back. Recovery: the next session-override sync re-registers and clears the degraded marker.
- Success path: Manual → Auto → Manual → Off → Auto plus a session-override clear restores the profile default; every Map record matches the live capability matrix at each step and the advertised effective mode equals the active capability mode.

### P0 — mode source / active capability atomicity (verified)

- Shared transition compensation (A/B): a failed Manual → Auto and Auto → Manual SHARED switch rejects the mutation, re-registers the previous capability set fresh, and compensates the shared source to its previous topology; `/align-mode` reports `Failed to switch alignment mode: ...` (never `Switched to Auto.`), and the management API returns the existing 4xx/5xx structured error (never a target-active 200).
- Session override compensation (C/D): a failed `session inherited Auto → Manual` switch leaves the session override ABSENT (presence semantics — never an equal-value override); a failed `session explicit Off → Manual` switch restores the exact previous `Off` override.
- Compensation-write failure (E): when the compensating source write itself fails, the system records an explicit PENDING source compensation — the status payload exposes `source-compensation` with the ACTUAL active capability mode; the next mutation replays the compensation first and converges (source Manual, active Manual, pending cleared).
- Double capability failure with compensated source (F): the agent is `capability-degraded` (no Map entry, both error provenances, status shows the actual previous active mode) and recovers on the next trigger.
- Public API failure semantics: `setMode` / `resetMode` / `setSessionMode` / `clearSessionOverride` throw on a failed transition (after compensating the source); `/align-mode` uses the existing command-error style; the management API returns the existing structured error contract. No path reports the target as active unless BOTH the persisted source and the live capabilities converged.

- Consistency invariant (asserted in every stable test): advertised `effectiveMode` == active `agentCapabilities.mode` (`assertAgentModeConsistent`); the only advertised non-converged states are the explicit `capability-degraded` / `source-compensation` ones (`assertAgentModeDegraded`).

### P1 — stale-session Web Capsule race (verified with real hooks)

- E — Session A → B with out-of-order responses: A's late response never renders; the UI shows only B.
- F — A → no-session: the snapshot clears immediately, session-scoped buttons are disabled, shared actions still work, and no `sessionId=undefined` request is ever constructed.
- G — with an old A request still in flight, a session mutation always targets the CURRENT session B (never A), and the post-mutation refresh targets B.
- H — rapid A → B → C resolving out of order: only C is ever shown.

Packed add / boot / remove cycle against a real `0.1.1-rc.1` DSH installation:
**PASS** — re-verified end-to-end this round with an isolated disposable
`DSH_HOME` (`.dsh-dogfood`, the plugin's own dogfood home — never the
user's real ~/.dsh profile):

- **Runtime family parity fixed and guarded**: the align-headless dogfood
  profile was found pinned to the STALE `0.1.0-rc.6` family (the earlier
  rounds' "packed rc.1" boots actually ran on that rc.6 runtime, where
  `commands.execute` has the 3-arg signature and the plugin's 4-arg calls
  could never execute). The profile was upgraded to the exact `0.1.1-rc.1`
  family (overrides pin ALL `@deepseek-ai/dsh-*` transitive packages to
  `0.1.1-rc.1`, no rc.2 drift), and the packed smoke now ASSERTS the
  disposable runtime versions (dsh-headless / dsh-commands / dsh-base =
  `0.1.1-rc.1`) before any boot;
- pack → tarball → disposable-profile offline install → plugin-not-preinstalled →
  `dsh plugin add` installs `0.4.1`, dep spec matches the tarball,
  installed package is a regular directory isolated from the source checkout;
- composition includes exactly the two plugin rows;
- live headless boots at Auto / Manual / Off (real rc.1 registries): the full
  capability matrix is present pre-model — Auto = policy section +
  `establish_baseline`/`report_drift` + `/align` + `/align-mode`;
  Manual = tools + `/align` + `/align-mode` without the policy section;
  Off = only the always-on `/align-mode`. The policy section is asserted in
  the assembled system prompt, `establish_baseline` writes revision 1
  through the packed install's real tools registry, and `/align` executes
  through the real commands registry;
- **Runtime mode-switch probe (v0.4.1)**: the dogfood align-driver now runs
  the REAL `/align-mode` command through the real commands registry at boot
  and records the capability matrix before/after. B → Auto boots at auto
  and switches the shared layer to Manual (effective `manual/override`,
  policy section gone, tools kept); A → Manual boots at manual and
  switches to Auto (effective `auto/override`, full auto matrix back). Both
  switches execute through the real rc.1 commands service and the effective
  mode always equals the live capability mode;
- remove → zero leftover rows, no leftover `node_modules/dsh-requirements-alignment`,
  manifest restored.
- The model-dependent half of dogfood scenario 13 and any live-model completion
  were unavailable during this run (`QUOTA: Insufficient Balance`) and are
  reported separately — they are **not** presented as successful model E2E runs.

Live GUI gate (real DSH Web `0.1.1-rc.1` running at {loopback}:3080, web profile
dev-linking this checkout): **PASS for everything executable without a browser.**

- GET /plugins/dsh-requirements-alignment/client.js serves the rebuilt capsule
  bundle (21697 bytes) containing the P1 markers (`requestVersionRef`,
  `snapshotForSession`, `currentSessionRef`, the `?sessionId=undefined` guard,
  `shell.overlay` slot) — the exact bytes the browser tab loads;
- the loopback management API is mounted live: GET /status without a sessionId
  → 400 (sessionId required), GET /status?sessionId=<unknown> → 404 (session not live),
  PUT /mode without the Host/Origin/CSRF-header guard → 403 — the full guard
  contract runs on the live rc.1 server;
- the capsule render behavior itself was executed by the headless real-hooks
  harness (client-race E–H) — no browser automation exists in this environment,
  so a pixel-level "capsule visible in a browser window" is NOT claimed here; the
  served bytes + live backend contract + real render execution together form
  this round's GUI evidence.

---

# Acceptance report — dsh-requirements-alignment v0.4.0

Date: 2026-08-21 · package 0.4.0 · DSH 0.1.0-rc.6 · workspace: `<local-workspace>`

v0.4.0 is the **session-scoped mode selector** release. Direction is
unchanged: the plugin is a soft runtime drift guard. This round lets one
session use Auto, Manual, or Off without changing the effective mode of other
live sessions, keeps the v0.3.0 profile/runtime mode as the shared fallback,
and preserves the no-DSH-Core-patch boundary.

## v0.4.0 checklist

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Two concurrent sessions hold different effective modes with no leakage | ✅ | `session-mode.test.ts`: Session A off + Session B manual + Session C shared auto, disjoint capability sets. |
| 2 | Changing Session A never changes Session B or the shared runtime override | ✅ | `session-mode.test.ts`: `/align-mode session manual` on A leaves B and `modeStore` untouched. |
| 3 | Auto/Manual/Off correct per session on new, resumed, forked, and historically forked sessions | ✅ | per-agent capability matrix + `persistence-regression` cold-resume/fork paths; fork inherits the parent override once. |
| 4 | Session reset and shared reset affect only their documented layer | ✅ | `/align-mode session reset` drops only the session override; `resetMode` drops only the shared override. |
| 5 | Persistence and registration failures leave no split-brain state | ✅ | `external-settings-failure.test.ts`: failed shared persist leaves snapshot + agents untouched; failed per-agent registration rolls back partials and recovers. |
| 6 | The selector remains usable when the current session is Off | ✅ | `/align-mode` is plugin-scope; `session-mode.test.ts` switches an Off session back to auto. |
| 7 | Four-layer resolution with the exact effective source | ✅ | `effectiveModeFor` returns `session` / `override` / `profile`; `/align-mode` prints all four layers. |
| 8 | Session override durability (identity binding, cold resume) | ✅ | `session-mode-store.test.ts`: durable-first writes, id-reuse shadowing, store-recreation survival. |
| 9 | No DSH Core changes | ✅ | Agent-scoped registration (`agent.ctx`) + storage-domain sidecar; no `@deepseek-ai/*` modification. |
| 10 | Production still appends zero `alignment/*` | ✅ | Persistence regression suite unchanged. |

Node tests: **188/188 passing**; typecheck, lint, and build green.

Packed add/install/compose against the current 0.4.0 tarball: **PASS**. The
Auto/Manual/Off boot verification and the model-dependent half of dogfood
scenario 13 require a live external model, which was unavailable during this
run (`QUOTA: Insufficient Balance`); those layers are reported separately and
are not presented as successful model E2E runs. The dogfood driver DID confirm
(pre-model, deterministic) that the top-level agent registers its full auto
capability set in its own scope on a real boot.

---

# Acceptance report — dsh-requirements-alignment v0.3.0

Date: 2026-08-20 · package 0.3.0 · DSH 0.1.0-rc.6 · workspace: `<local-workspace>`

v0.3.0 is the **persistent runtime mode & hot-switching** release on top of
the v0.2.2 sidecar. Direction is unchanged: the plugin is a soft runtime
drift guard. This round makes Auto / Manual / Off a live three-layer model
and gives the user a Core-free switch (`/align-mode`).

## v0.3.0 checklist

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `/align-mode` always registered, including Off | ✅ | AlignmentRuntime control group; Off → Auto via the command in unit tests. |
| 2 | `/align` reports profile default vs runtime override | ✅ | `statusText(..., source)`; steered `/align` message includes the report. |
| 3 | Manual check does not fold the session log | ✅ | `MANUAL_CHECK_MESSAGE` names the sidecar; policy tests lock that in. |
| 4 | Dogfood 11/12 fold the sidecar | ✅ | `scripts/fold-session.mjs` + `src/sidecar-fold.ts`; session-log fold is fallback only. |
| 5 | Invalid override repair is repeatable | ✅ | ModeStore resets the in-flight flag after each repair. |
| 6 | `setMode` uses pending compensation | ✅ | Persist + runtime-rollback double fault parks `pendingCompensation`. |
| 7 | No DSH Core changes | ✅ | Settings service + `/align-mode`; no native Settings UI card. |
| 8 | Production still appends zero `alignment/*` | ✅ | Persistence regression suite. |
| 9 | First-start registration failure leaves no interactive half-state | ✅ | `null -> Auto` failure keeps only always-on `/align-mode`; a later retry recovers. |
| 10 | Fresh tarball install cannot drift beyond the verified DSH rc.6 seam | ✅ | Runtime DSH dependencies use exact `0.1.0-rc.6`; packed smoke starts from a profile with no source link. |

Node tests: **176/176 passing**; typecheck, lint, and build green.

Current-tarball packed smoke: **40/40 checks passed**. The disposable profile
starts without a source link, installs `0.3.0` as an isolated package, verifies
Auto / Manual / Off through real DSH registries, executes `/align`, calls
`establish_baseline` through the real tools registry, removes the plugin, and
verifies manifest/package-list restoration. The external model completion was
unavailable during this run (`QUOTA: Insufficient Balance`); that layer is
reported separately and is not presented as a successful model E2E run.

Native Web Settings UI remains out of scope (would need a DSH Core patch).
Session-scoped mode selection is planned for v0.4.0 in `docs/ROADMAP.md`.
Web status projection and `mode: guard` remain deferred.

---

# Acceptance report — dsh-requirements-alignment v0.2.0 (RC)

Date: 2026-08-16 (round 2) · package 0.2.0 · DSH 0.1.0-rc.6 · workspace: `<local-workspace>`

## Positioning

v0.2.0 is the **runtime requirement drift guard** rewrite:

> Plan Mode prevents a bad plan from starting.
> Requirements Alignment prevents a good plan from drifting.

The plugin maintains a durable requirement baseline during execution, detects
direction-level drift through policy, and re-aligns with the user through a
dedicated `report_drift` tool. Since the persistence-compatibility fix,
canonical alignment state is written by the `AlignmentStateStore` sidecar (an
official `storage-domain` → `storage-json` domain), **not** as session events.
The `alignment/*` event vocabulary is kept only as a legacy/migration/fold
fallback, and production never appends it to a live session log.

## Persistence-compatibility fix architecture (0.2.2)

DSH Session log → official DSH-recognizable events only (a bare DSH build
without this plugin still reads any new session).

Alignment canonical state → `AlignmentStateStore` → `storage-domain` →
`storage-json` backend, keyed by session lifecycle identity
(`{ id, createdAt, cwd }`), with durable-first mutations and
checkpoint/`visibleThroughSeq` semantics supporting resume, historical fork,
lineage inheritance, and compaction.

`alignment/*` is kept only for legacy compatibility, legacy migration, test
fixtures, and the fold fallback (a parent without a sidecar record folds its
seed prefix). Production paths append zero `alignment/*` session events.

The dogfood align driver reads this sidecar through the `requirementsAlignment`
service and resolves the store **lazily** on every snapshot: it never captures
the store at `apply()` time, so a driver mounted before the controller appears
starts reading the durable sidecar the moment the controller does — dogfood 03
(`baseline recorded`, `revision >= 1`) is decided by the sidecar, never by a
revision-0 legacy fold. When no store ever exists, the legacy fold remains the
fallback.

## RC fix answers (release-candidate round)

1. **Custom drift option mapping** — a model-supplied alternative direction
   the user picks maps to `revise` with the chosen option label as the note
   (free text keeps the user's own words). Uninterpretable answers (no
   selection, multiple selections, or a label matching no presented option)
   fail loud; nothing is silently mapped to `reject`. The exact default
   approve / stay-within-scope options are always offered alongside the
   model's options, so a "stay" intent can never be trapped inside a
   model-rewritten label.
2. **Status after approve/revise before a baseline update** —
   `baseline-update-pending` (folded purely from the session log; an
   interrupted/crashed/resumed session in that window never folds to
   `aligned` against the stale baseline).
3. **Reject** — no baseline revision is forced; status returns to `aligned`
   with the current baseline still in force.
4. **Protected constraints** — the policy requires a silent
   `establish_baseline` BEFORE the first substantive mutation; dogfood case 03
   verifies it end-to-end (0 questions, revision ≥ 1, both constraints
   captured, baseline present at the first non-read-only tool call).
5. **Invalid `report_drift` input** — every argument and the interaction
   prerequisite are validated before any durable write; unit tests and
   dogfood case 10 confirm zero session pollution.
6. **Packed v0.2 add/rm** — actually executed against the current tarball
   (`scripts/packed-smoke.ps1`): add → compose → boot (command + tool +
   policy live) → remove → restore verified. Result: **PASS**.

## RC round 2 fixes (release-gate findings, 2026-08-16)

1. **The user's exact choice comes back to the agent.** `report_drift`'s tool
   result now carries `note` (the selected option label or the free-form
   answer) and echoes `requiredChange`; the rendered outcome names the chosen
   direction verbatim. Before this fix the agent saw only `decision` and
   re-asked "which direction did you pick?" (reproduced in case 09 with two
   question rounds; case 05 showed the same pattern in natural runs).
2. **Resume/crash recovery of the chosen direction.** `baselineSummary()`
   projects the last decision with its note, the last drift's
   `requiredChange`, and names the chosen direction in the pending line. A
   resumed session's system prompt shows exactly what the user picked — only
   the posture was recoverable before. Case 12 verifies this end-to-end on the
   persisted on-disk log.
3. **Case 09 gate tightened to rounds = 1** — report_drift → user picks the
   custom option → agent goes straight to `establish_baseline`; a re-ask now
   fails the case.
4. **New interruption test (case 12, revise path)** — the driver halts right
   after a revise decision; the durable decision event keeps the exact chosen
   direction and the resumed-summary projection contains it verbatim.
5. **Packed-smoke policy assertion tightened** — the align driver assembles
   the real system prompt and records the policy section's presence in the
   section registry plus its resolved text head; the smoke gates on that and
   the unique policy heading instead of the loose `align|baseline|drift`
   final-answer match.
6. **Release hygiene** — `.gitignore` normalized to LF (no CRLF, no trailing
   whitespace) so a ZIP copy of the working tree no longer shows `MM
   .gitignore`; `.gitattributes` pins `eol=lf` for it.

## Acceptance checklist

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Independent plugin (no DSH Core changes) | ✅ | `Core modifications: 0`. No `@deepseek-ai/*` file touched. `ctx.planMode` untouched; `exit_plan_mode` untouched. |
| 2 | Legacy event schema (read compatibility) | ✅ | `alignment/baseline`, `alignment/baseline-updated`, `alignment/drift`, `alignment/decision`, `alignment/manual-check` declared via `SessionEventMap` augmentation + legacy `alignment/status` read-only. These are the LEGACY vocabulary only — canonical state now lives in the `AlignmentStateStore` sidecar, and production appends none of these to a live session (a bare DSH reader stays compatible). |
| 3 | Requirement Baseline model | ✅ | `{ revision, goal?, explicitConstraints?, mustPreserve?, allowedScope?, userDecisions?, openDirectionDecisions?, updatedAt }`; whole-value replace; minimal by design. |
| 4 | Drift detection policy | ✅ | System-prompt section (order 60) teaches silent monitoring + the 8-reason taxonomy + the drift protocol; explicit scope/preservation constraints demand a silent baseline BEFORE the first mutation; per-session baseline summary rendered from the fold. |
| 5 | Baseline revision mechanism | ✅ | `establish_baseline` records v1 and bumps revision on every later whole-value update; dogfood case 5 (architecture shift) showed `0 → 1`, dogfood case 8 (subagent) showed `0 → 2` — matching the real records. |
| 6 | Decision mapping | ✅ | Default options → `approve`/`reject`; model-supplied option picked → `revise` + chosen label as note; free text → `revise` + user words; uninterpretable → fail loud (never silent `reject`). Unit + dogfood case 09. |
| 7 | Durability state machine | ✅ | `AlignmentStateStore` derives `unknown` / `aligned` / `drift-pending` / `baseline-update-pending` from durable sidecar checkpoints (durable-first: validate → durable put → memory commit — no live mirror that can diverge). The legacy log fold (`foldAlignmentStatus`) stays byte-identical purely for migration and fold-fallback equivalence. Approve-interruption case 11: the persisted state folds to `baseline-update-pending`; a simulated post-resume `establish_baseline` yields `aligned`, revision +1. |
| 8 | Validation ordering | ✅ | `report_drift` validates all args + channel prerequisite before appending; invalid input → tool fails with `alignment/drift` count 0 (unit + dogfood case 10). |
| 9 | `/align` new behavior | ✅ | Appends `alignment/manual-check`, folds status (incl. `baseline-update-pending`), returns revision/goal/constraints/drift count/last drift/last decision/status; steers a fresh check; never a gate. |
| 10 | Plan Mode compatibility | ✅ | No interaction with plan mode; policy defers to it while active; plan-mode's own `ask_user_question`/`exit_plan_mode` calls never pollute alignment state (verified by the isolation case). |
| 11 | Subagent behavior | ✅ | Children cannot ask (`DELEGATED_CALLER` → explicit report instruction); parent owns interaction; real parent→child drift escalation verified end-to-end. |
| 12 | Backwards compatibility | ✅ | v0.1 sessions fold safely (legacy `alignment/status` → manual checks, no new events → revision 0 / `unknown`); `mode: auto|manual|off` and config keys unchanged; bundle identity unchanged. |
| 13 | Auto tests | ✅ | 84/84 `node:test` (config, baseline fold, revision, drift/decision fold incl. all four postures, custom option mapping + default-option appending, fail-loud answers, validation ordering, tool-result note/requiredChange feedback, resume-summary projection, manual `/align`, old-session compat, question isolation, policy rendering, both tools, scripted provider, driver incl. `verifyPolicySection`, controller incl. unload). |
| 14 | typecheck | ✅ | `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.check.json` — 0 errors. |
| 15 | lint | ✅ | `eslint src test` — 0 problems. |
| 16 | build | ✅ | `tsc -p tsconfig.json` → `lib/` (ESM + declarations). |
| 17 | Package exports | ✅ | `"."` types now points at the real `./lib/index.d.ts`; every subpath target exists in the packed tarball (verified by `npm pack --dry-run`); dead `./src/*` subpath removed. |
| 18 | Real DSH dogfooding | ✅ | Full correctness suite (11 scenarios): **63/63 checks passed**; natural drift benchmark **3/4** (see below); real DSH boot, real model calls, isolated `DSH_HOME`. |
| 19 | Packed add/rm smoke (v0.2 tarball) | ✅ | `scripts/packed-smoke.ps1`: pack → add → compose rows → boot (`/align` executes, `establish_baseline` works, policy present — verified via the assembled system prompt / section registry) → rm → restore verified. **14/14 checks passed.** |
| 20 | README / docs | ✅ | README repositioned (drift guard, vs Plan Mode, taxonomy, silent monitoring, `/align`, statuses, decision mapping); ACCEPTANCE rewritten; ARCHITECTURE updated; CHANGELOG extended with the RC-fix round. |
| 21 | Release safety | ✅ | No publish, no GitHub release, no push, no tag (per instruction); release-ready staged tree prepared. |

## Final dogfood evidence

The full suite ran against the isolated `align-headless` profile (dsh-base +
dsh-headless + this plugin + scripted answer provider + align driver) with
real model calls.

**Natural vs protocol-forced split** (reported separately, never merged):

- Natural-behavior scenarios: **03** (protected-constraint bug fix — silent
  baseline before the first mutation), **04** (agent-detected scope drift),
  **05** (architecture shift — natural task text with NO protocol
  instruction).
- Protocol-forced mechanism scenarios: **01** greenfield start, **02** typo,
  **06** question isolation, **07** manual `/align`, **08** subagent
  escalation, **09** custom drift choice, **10** invalid options,
  **11** approve-interruption durability, **12** revise-interruption
  durability.

Final full-suite run (all eleven correctness scenarios, one process; the 05
natural benchmark is a separate `-Benchmark05` run). Four scenarios hit the
documented external LLM transport flake (`TRANSPORT: DeepSeek API request ...
failed` — see project-memory rule 8) and were retried once per the rule; the
retries passed. The final per-scenario evidence is the passing retry:

```
[PASS] 01-greenfield : rounds=2 exit=0          (start direction question, baseline revision 1, 0 drift)
[PASS] 02-typo : rounds=0 exit=0                (typo fixed, 0 drift)
[PASS] 03-bugfix : rounds=0 exit=0              (silent baseline revision 1 with UI+API constraints BEFORE first mutation, bug fixed)
[PASS] 04-scope-drift : rounds=1 exit=0         (drift detected, decision=reject, backend untouched, no baseline revision)
[PASS] 06-isolation : rounds=0 exit=0           (synthetic ask_user_question injected; fold ignores it)
[PASS] 07-align : rounds=0 exit=0               (/align executed: command/run=1, manual check=1, status text)
[PASS] 08-subagent : rounds=1 exit=0            (child drift report → parent report_drift → decision → revision 0→2)
[PASS] 09-drift-choice : rounds=1 exit=0        (custom option picked → decision=revise, note=chosen label; EXACTLY one question — no re-ask)
[PASS] 10-invalid-options : rounds=0 exit=0     (invalid report_drift failed, driftCount=0, typo still fixed)
[PASS] 11-interrupt : rounds=1 exit=0           (halted after approve; fold = baseline-update-pending; persisted log re-fold + resume simulation = aligned revision 2)
[PASS] 12-interrupt-revise : rounds=1 exit=0    (halted after revise "Use export files"; persisted log folds to baseline-update-pending; the exact direction survives in the resumed summary)
DOGFOOD SUMMARY: 63/63 passed
```

**Natural drift trigger**: `3/4` — M natural drift-opportunity runs (04 ×1,
05 ×3 via `-Benchmark05`, task text without protocol instructions), N runs
where the model called `report_drift` on its own before mutating (04: 1/1,
05: 2/3). Protocol-forced cases are excluded from this metric by definition.
The observed natural rate is model-dependent — the soft guard by design; the
mechanism itself is deterministic once invoked.

Recorded events (excerpts from `dogfood/records/`, folded by the plugin's own
`foldAlignmentStatus` inside the dogfood driver):

- 01-greenfield: one start question ("How do you want to use your personal
  task manager day to day?"), final `revision 1`, `driftCount 0`.
- 02-typo: `0` questions, `driftCount 0`; the typo is fixed.
- 03-bugfix: `0` questions, `driftCount 0`; final `revision 1`,
  `baselineRecorded true`, `baselineConstraints` contain a UI constraint and
  an API constraint; the `first-mutation` driver snapshot (first non-read-only
  tool call) already shows `revision 1` + `baselineRecorded true` — the
  baseline existed BEFORE the first mutation; the TypeError is fixed.
- 04-scope-drift: drift question cites the detected `constraint-conflict`
  ("the broken logic is in the backend, which the constraints exclude");
  decision `reject`; `server.js` byte-identical to the fixture; revision
  stays at the pre-reject value (no forced baseline).
- 05-arch-shift (natural benchmark, `-Benchmark05`): 3 natural runs; 2/3
  called `report_drift` on their own (reason `user-direction-change`,
  decision recorded, baseline revision bumped); 1/3 proceeded without the
  drift protocol (counted honestly in the trigger metric).
- 06-isolation: synthetic `ask_user_question` tool call in the log while
  `driftCount 0` and `revision 0`; `/align` succeeded with "Baseline
  revision: 0".
- 07-align: `/align` result `success`, `alignCommandRuns 1`,
  `manualCheckEvents 1`, readable status text.
- 08-subagent: two sessions observed (parent + child); the parent's drift
  question cites the child's report; decision `approve`; revision `0 → 2`;
  `deleteItem` present in the public API afterwards.
- 09-drift-choice: drift question presented the two candidate directions;
  the scripted user picked the export-files option; `lastDecision.decision =
  revise`, `lastDecision.note` = the chosen option label (contains "export");
  revision bumped. **Exactly one question round** — the tool result returned
  the chosen direction, so the agent never re-asked (the round-2 regression
  that previously produced a second "which direction did you pick?" question
  is gone).
- 10-invalid-options: the invalid `report_drift` call failed; final
  `driftCount 0`, status `unknown` — zero session pollution; the typo was
  fixed.
- 11-interrupt: the driver halted the process right after the
  `alignment/decision` (approve) event; the in-memory fold at that point and
  the fold of the PERSISTED on-disk session log (`scripts/fold-session.mjs`,
  zstd frames + chunk-run expansion) both report `baseline-update-pending`
  with the baseline revision intact — never `aligned`; simulating the
  post-resume `establish_baseline` call on the same log yields `aligned`,
  revision +1. (The headless runner has no CLI resume, so the continuation is
  simulated on the durable log — the fold result is exactly what resume would
  reconstruct.)
- 12-interrupt-revise: the driver halted right after a `revise` decision
  whose note is the exact chosen direction ("Use export files"); the
  persisted fold is `baseline-update-pending`, the durable decision event
  keeps the note verbatim, and the projected summary — the block a resumed
  session's system prompt would show — contains
  "Last user decision: revise - Use export files" and
  "Baseline update pending: the user chose a new direction: Use export
  files". The resumed agent knows exactly what the user picked; no re-ask.

## Packed add/rm smoke (v0.2 tarball, `scripts/packed-smoke.ps1`)

Run against the **current v0.2.0 tarball** (not historical evidence):

1. `pnpm pack` → `dsh-requirements-alignment-0.2.0.tgz`.
2. Disposable profile copied from `align-headless`; manifest snapshot taken.
3. `dsh plugin --profile packed-smoke add <tarball>` → dependency spec is the
   packed 0.2.0 install; `--dump-config` shows both rows
   (`requirements-alignment`, `requirements-alignment-ask-user`).
4. Real boot through the packed install: `/align` executed via the real
   commands registry (driver `runAlign`), `establish_baseline` recorded
   revision ≥ 1 (tool live), and the policy section is verified
   deterministically — the driver assembles the REAL system prompt for the
   session and records that the `requirements-alignment:policy` section is
   present in the section registry, with its resolved text starting with the
   unique shipped heading "## Requirements Alignment policy".
5. `dsh plugin --profile packed-smoke rm dsh-requirements-alignment` →
   manifest has no plugin dependency/bundle entry; `pnpm ls` no longer lists
   it; disposable profile removed.

Result: **PASS — 14/14 checks passed** (pack → add → rows compose → real
boot with `/align`, `establish_baseline`, and policy all live — policy
verified via the assembled system prompt / section registry → rm → manifest
and package list clean → disposable profile removed).

## Seam usage summary

**A. Capability seams actually used:**

| Seam | Use |
|---|---|
| `ctx.systemPrompt.section()` | drift-guard policy + folded baseline summary (order 60) |
| `ctx.tools.register(defineTool(...))` | `establish_baseline` + `report_drift` (plan-mode tool pattern) |
| `ctx.userQuestions.ask()` | the drift question (native channel, agent + signal attached) |
| `ctx.commands.register()` | `/align` (exact `CommandDefinition` contract) |
| `agent.steer()` + `createUserMessage` | `/align` hands the fresh check to the agent |
| `ctx.storageDomain` (open domain table) | canonical state: `AlignmentStateStore` durable sidecar (`storage-domain` → `storage-json`) |
| `session.append()` + `SessionEventMap` augmentation | LEGACY vocabulary only — kept for read compatibility / migration / fold-fallback; production never appends `alignment/*` |
| `agent/session-start`, `session/event` (driver) | dogfood-only snapshots (start / first mutation / halted decision / turn end) + `/align` executor + real system-prompt assembly for the policy-section registry check (`verifyPolicySection`) |
| `ctx.inject(['commands'])` | optional dependency pattern (as `dsh-plan-mode`) |
| bundle patch layers | install/remove via `dsh plugin add/rm` |

**B. Fully plugin-implemented:** baseline model + revision, drift taxonomy and
protocol, both tools, the `AlignmentStateStore` durable sidecar + legacy fold
layer, `/align` inspection, auto/manual/off modes, config validation, policy +
baseline summary rendering, the scripted-answer E2E provider (incl.
`optionMatch`), the align driver.

**C. DSH API limitations encountered:**

- Drift detection is model judgment (policy, not enforcement): the fold
  derives `drift-pending` and `baseline-update-pending` so a future
  `mode: guard` can gate on them without schema changes; v0.2 stays a soft
  guard by design.
- Natural user-direction-change runs trigger `report_drift` in a fraction of
  runs (measured honestly above); agent-detected constraint conflicts are
  more reliable. The policy is written to maximize the natural rate.
- The headless runner is one-shot (no CLI resume), so the interruption
  durability continuation is simulated on the persisted log; the fold result
  is what resume would reconstruct.
- `/align` requires a command adapter; headless/ACP spines don't dispatch
  commands (verified via the driver instead).
- Children cannot ask the user (`DELEGATED_CALLER`); `report_drift` converts
  that into an explicit "report to your parent" error and the policy says the
  same in prose.
- Baseline content is model-produced; the fold is deterministic.
- Environment note: on this host, the harness workspace-write sandbox denies
  `SetFileSecurityW` used by DSH's atomic file replace, so the dogfood runs
  executed under full access (the agent's own in-profile sandbox still
  confined every write to the scenario directory). `npm pack` requires a
  writable `--cache` (the default npm cache is outside the sandbox).

**D. Core modifications: 0.**

## Environment notes

- Dogfood used an isolated `DSH_HOME`; no credentials or runtime logs are
  committed or included in the npm package.
- The public dogfood overlays contain placeholders. `scripts/dogfood.ps1`
  resolves record paths from the current checkout into ignored runtime files.
- Scenario workspaces, records, and logs are gitignored runtime areas;
  fixtures are tracked.
