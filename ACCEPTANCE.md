# Acceptance report — dsh-requirements-alignment v0.2.0 (RC)

Date: 2026-08-16 (round 2) · package 0.2.0 · DSH 0.1.0-rc.6 · workspace: `<local-workspace>`

## Positioning

v0.2.0 is the **runtime requirement drift guard** rewrite:

> Plan Mode prevents a bad plan from starting.
> Requirements Alignment prevents a good plan from drifting.

The plugin maintains a durable requirement baseline during execution, detects
direction-level drift through policy, re-aligns with the user through a
dedicated `report_drift` tool, and records every candidate/decision as
log-only session events folded by pure functions.

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
| 2 | New event schema | ✅ | `alignment/baseline`, `alignment/baseline-updated`, `alignment/drift`, `alignment/decision`, `alignment/manual-check` via `SessionEventMap` augmentation; legacy `alignment/status` read-only. All log-only (non-surface). |
| 3 | Requirement Baseline model | ✅ | `{ revision, goal?, explicitConstraints?, mustPreserve?, allowedScope?, userDecisions?, openDirectionDecisions?, updatedAt }`; whole-value replace; minimal by design. |
| 4 | Drift detection policy | ✅ | System-prompt section (order 60) teaches silent monitoring + the 8-reason taxonomy + the drift protocol; explicit scope/preservation constraints demand a silent baseline BEFORE the first mutation; per-session baseline summary rendered from the fold. |
| 5 | Baseline revision mechanism | ✅ | `establish_baseline` records v1 and bumps revision on every later whole-value update; dogfood case 5 (architecture shift) showed `0 → 1`, dogfood case 8 (subagent) showed `0 → 2` — matching the real records. |
| 6 | Decision mapping | ✅ | Default options → `approve`/`reject`; model-supplied option picked → `revise` + chosen label as note; free text → `revise` + user words; uninterpretable → fail loud (never silent `reject`). Unit + dogfood case 09. |
| 7 | Durability state machine | ✅ | Fold distinguishes `unknown` / `aligned` / `drift-pending` / `baseline-update-pending`; pure log fold (no live mirror). Approve-interruption dogfood case 11: the persisted on-disk session log folds to `baseline-update-pending`; a simulated post-resume `establish_baseline` yields `aligned`, revision +1. |
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
| `session.append()` + `SessionEventMap` augmentation | durable `alignment/*` events |
| `agent/session-start`, `session/event` (driver) | dogfood-only snapshots (start / first mutation / halted decision / turn end) + `/align` executor + real system-prompt assembly for the policy-section registry check (`verifyPolicySection`) |
| `ctx.inject(['commands'])` | optional dependency pattern (as `dsh-plan-mode`) |
| bundle patch layers | install/remove via `dsh plugin add/rm` |

**B. Fully plugin-implemented:** baseline model + revision, drift taxonomy and
protocol, both tools, dedicated events + pure folds, `/align` inspection,
auto/manual/off modes, config validation, policy + baseline summary rendering,
the scripted-answer E2E provider (incl. `optionMatch`), the align driver.

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
