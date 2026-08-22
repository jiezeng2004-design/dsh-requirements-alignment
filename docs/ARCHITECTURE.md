# Architecture decision: Requirements Alignment as a runtime drift guard

Date: session 2026-08 (baseline **DSH 0.1.1-rc.1**; earlier sessions audited
against the local checkout at `<dsh-home>/profiles/node_modules/@deepseek-ai`
+ the launcher package `@deepseek-ai/dsh` from the pnpm dlx cache).

**Canonical state (v0.2.2+):** alignment lives in the `AlignmentStateStore`
sidecar (`storage-domain` → `storage-json`, unit `requirements_alignment`),
keyed by session lifecycle identity. Production never appends `alignment/*`
session events — those types exist only so legacy logs fold and migrate.
v0.3.0 adds ModeStore + AlignmentRuntime hot switching and the always-on
`/align-mode` command. v0.4.0 adds the session-scoped mode selector:
a `SessionModeStore` sidecar (`requirements_alignment_modes`) holds one
override per session, and alignment capabilities are registered in each
agent's OWN scope (`agent.ctx`) instead of at plugin scope — so two live
sessions can hold different effective modes with zero leakage.

## 1. What v0.2 is

v0.1 aligned direction *before* execution (greenfield gate + `ask_user_question`
counting). v0.2 repositions the plugin as a **runtime requirement drift guard**:

> Plan Mode prevents a bad plan from starting.
> Requirements Alignment prevents a good plan from drifting.

The execution holds a durable **requirement baseline** (goal, explicit
constraints, must-preserve behavior, allowed scope, settled user decisions).
The policy teaches the agent to monitor silently and to detect *direction-level*
drift; a dedicated model-facing tool (`report_drift`) records the candidate,
asks the user, and records the decision; the baseline advances by revision
after an approved direction change. Everything is log-only and folded — no live
mirror, no watcher, no periodic checks, no hard gate in v0.2.

## 2. Why the v0.1 `questionRounds` mechanism was replaced

v0.1 counted every `tool/call` whose name is `ask_user_question` as one
alignment round. That is no longer usable, because:

- official Plan Mode asks the user through the same channel
  (`exit_plan_mode` → `userQuestions.ask`);
- other plugins and ordinary agent questions use the same tool;
- the count said nothing about *direction*.

v0.2 therefore owns **dedicated alignment state**, written only by this
plugin's two tools and the `/align` command. Since v0.2.2 that state is a
sidecar checkpoint, not a session event. Unrelated `ask_user_question`
calls are invisible to the alignment view by construction.

## 3. Requirement Baseline data model

```ts
interface RequirementBaseline {
  revision: number;                  // 1-based; 0 = none recorded (implicit baseline)
  goal?: string;
  explicitConstraints?: string[];    // "do not change the UI", "keep public API"
  mustPreserve?: string[];           // data format, backend behavior
  allowedScope?: string[];           // what the execution may touch
  userDecisions?: string[];          // settled user decisions
  openDirectionDecisions?: string[]; // unresolved direction items
  updatedAt: number;                 // epoch ms
}
```

Deliberately minimal: only what decides task direction, never a full
specification. Baseline events are **whole-value snapshots** (the payload
carries the complete post-change baseline, revision included) — the same rule
as `plan/mode` — so the last baseline event alone reconstructs the state.

## 4. Canonical sidecar (v0.2.2+) and legacy session events

Canonical writes go to `AlignmentStateStore` whole-state checkpoints
`{ visibleThroughSeq, state }` in the `requirements_alignment` storage-domain
unit. Resume, historical fork (`stateAt(seedLength - 1)`), and compaction
read that timeline. Production appends **zero** `alignment/*` session events
(a bare DSH reader would otherwise refuse the log).

The `alignment/*` vocabulary below is **legacy only** — read for v0.1/v0.2
logs, migration (`/align-migrate`), and fold-fallback when a parent has no
sidecar record:

| Event | Payload | Writer (legacy only) |
|---|---|---|
| `alignment/baseline` | `{ baseline }` | `establish_baseline` (first record, revision ≥ 1) |
| `alignment/baseline-updated` | `{ baseline }` | `establish_baseline` (revision bump, whole-value replace) |
| `alignment/drift` | `{ reason, description, requiredChange?, at }` | `report_drift` |
| `alignment/decision` | `{ driftSeq, decision: 'approve'\|'reject'\|'revise', note?, at }` | `report_drift` |
| `alignment/manual-check` | `{ at }` | `/align` |
| `alignment/status` (legacy) | `{ kind: 'manual-check', at }` | v0.1 only — read for compatibility, never written |

`SessionEventMap` augmentation is TypeScript-only; it is not runtime
registration into `KNOWN_SESSION_EVENT_TYPES`. The invariant is semantic:
at runtime `alignment/*` types never appear in the known set — `KNOWN_SESSION_EVENT_TYPES`
is the official DSH rc.1 session-event vocabulary minus `alignment/*`, verified
by intersection with the upstream set, not by a hand-maintained count.

## 5. Pure folds

```ts
foldRequirementBaseline(events): RequirementBaseline | undefined  // last baseline event wins
foldAlignmentStatus(events): AlignmentStatus
// { baseline?, revision, driftCount, lastDrift?, lastDecision?,
//   status: 'unknown' | 'aligned' | 'drift-pending' | 'baseline-update-pending',
//   manualChecks, lastManualCheckAt? }
```

`status` is derived purely from sidecar checkpoints (the legacy log fold is
kept byte-identical for migration equivalence), so resume, fork, and
compaction replay the same posture:

1. the last drift has no paired decision → `drift-pending`;
2. the last decision is `approve`/`revise` and no `alignment/baseline` /
   `alignment/baseline-updated` event followed it (`decision.seq > last
   baseline seq`) → `baseline-update-pending` — the durability state between
   an approved direction and the baseline that records it; an interrupted or
   crashed session in that window must NOT fold to `aligned` against the
   stale baseline;
3. a baseline exists → `aligned` (a `reject` leaves the current baseline in
   force — no revision is forced);
4. otherwise → `unknown` (revision 0).

`tool/call` events never participate. Legacy v0.1 logs fold to
`revision 0 / unknown` with their manual checks counted — no crash, safe
fallback.

## 6. Model-facing tools (the plan-mode pattern)

Both tools are registered with `ctx.tools.register(defineTool(...))`, exactly
like plan-mode's `exit_plan_mode`:

- **`establish_baseline`** — silent. Validates the baseline input (at least
  one meaningful field, arrays of strings), folds the current baseline, and
  appends `alignment/baseline` or `alignment/baseline-updated` with
  `revision + 1`. Never asks the user.
- **`report_drift`** — interactive. Validates every argument before any
  durable write (reason against the finite `DRIFT_REASONS` taxonomy, non-empty
  description, string `requiredChange`, 2-3 distinct non-blank option labels)
  and validates the interaction prerequisite (a `userQuestions` channel must
  exist), so an invalid call fails with ZERO session pollution — no stranded
  drift event. Only then does it append `alignment/drift` and ask the user
  directly through `ctx.userQuestions.ask()` (the same channel the Web UI
  renders, with the calling agent and signal attached). The answer maps
  deterministically: the default options → `approve` / `reject`; a
  model-supplied option the user picked → `revise` with the chosen label as
  the note; free text → `revise` with the user's own words. Anything
  uninterpretable (no selection, multiple selections, a label that matches no
  presented option) throws — fail loud is better than silently mis-recording
  a rejection. The tool RESULT returns `decision`, the user's exact `note`
  (option label or free text), and the echoed `requiredChange`; the rendered
  outcome names the chosen direction verbatim ("The user chose the direction
  \"Use export files\"..."), so the agent never re-asks what the user picked.
  A `DELEGATED_CALLER` / `CALLER_NOT_LIVE` rejection converts to
  an error telling the child to report the candidate to its parent;
  `ASK_CANCELLED` tells the model to stop and wait. The drift event is already
  durable at that point.

The tools are registered in `auto` and `manual` modes (inert unless called —
the plan-mode precedent of keeping the tool catalog stable) and nothing in
`off`. They are `isConcurrencySafe: false` — a drift question must never run
in parallel.

## 7. Policy section (auto mode)

Order 60, after plan-mode's 50; the text is a function of the calling agent's
folded status:

1. **Baseline rules** — when the request carries explicit scope or
   preservation constraints (trigger phrases: "do not change X", "without
   changing X", "preserve X", "keep X compatible", "only change X", "do not
   refactor Y", "no backend changes", "keep public API unchanged", "no UI
   changes"), call `establish_baseline` (silent) BEFORE the first substantive
   implementation or mutation and pin the constraints; record nothing for
   trivial tasks; ask the ONE highest-priority direction question (via
   `ask_user_question`) when no baseline can be formed; delegated direction
   does not waive the greenfield question.
2. **Silent monitoring** — zero interruption; never check by tool-call count,
   time, tokens, or file count; the agent decides all engineering details.
3. **Drift detection** — the taxonomy with concrete examples (scope expansion,
   constraint conflict, behavior change, architecture/product-shape shift,
   data-model change, compatibility change, invalidated assumption, user
   direction change).
4. **Drift protocol** — call `report_drift` *before* the direction-changing
   action; after the decision, update the baseline via `establish_baseline`
   when approved/revised.
5. **Child agents** — cannot ask; report a `Requirement drift candidate` block
   in the final report; the parent owns user interaction.
6. **Plan-mode compatibility** — while plan mode is active its instructions
   govern planning; this policy guards execution.

The section also renders the **baseline summary** from the fold whenever a
baseline or drift is recorded, so resume/fork/compaction feed the durable
state back to the model at every assembly. The summary projects the last
drift (including its `requiredChange`), the last user decision with its note
("Last user decision: revise - Use export files"), and — while
`baseline-update-pending` — names the chosen direction in the pending line,
so a resumed session knows exactly what the user picked without re-asking.

## 8. `/align` and `/align-mode`

`/align-mode` is the always-on control command (including Off), registered at
plugin scope. No argument prints the **four-layer snapshot** of the calling
session (session override / runtime override / profile default / effective
mode with its exact source). `auto` / `manual` / `off` change the SHARED
runtime override (persisted through the DSH Settings service); `reset` drops
it back to the profile default. The `session` sub-command operates on ONLY the
calling session: `session` / `session auto|manual|off` / `session reset`
persist or drop that session's override in the `SessionModeStore` sidecar and
resync that session's agent. Because `/align-mode` stays registered at plugin
scope, an Off session can switch itself back without editing `settings.yaml`.

## 8c. Per-agent capability model (v0.4.0)

v0.3.0 registered policy, tools, `/align`, and `/align-migrate` at plugin
scope and hot-switched ONE global set. v0.4.0 retires that: alignment
capabilities are registered in each agent's own scope (`agent.ctx`) when the
session starts, and the controller re-syncs an agent when its effective mode
changes. DSH provides the per-session seam natively — `Agent.ctx` is an
agent-scoped Cordis context whose contributions are agent-local and unwind on
disposal, and the system-prompt / tools / commands registries all accept
scoped registrations ("Scoped registrations shadow globals"). `/align-mode`
is the only plugin-scope alignment contribution left.

The controller owns the per-agent lifecycle:

- `agent/session-start` → pin fork inheritance (alignment state AND session
  override) and `syncAgent` (register the session's capabilities per its
  effective mode).
- `agent/disposed` → drop the bookkeeping (`agent.ctx` already unwound).
- `ModeStore` change (shared) → re-sync every agent WITHOUT a session override.
- `SessionModeStore` change → re-sync exactly that session's agent.
- Unload → dispose the shared mode store, the `/align-mode` registration, and
  every per-agent capability set explicitly.

A mode transition in `syncAgent` is transactional (v0.4.1): the outgoing
registrations are disposed first (scope-table removals are synchronous and
never throw), then the incoming mode is registered and only a SUCCESSFUL
registration is committed to `agentCapabilities`. A failed registration
rolls back by RE-REGISTERING the previous mode with fresh disposers — the
executed record is never put back, so a Map entry always corresponds to a live
capability. If the rollback re-registration fails too, the agent fails loud and
closed: the Map records nothing and the double failure (target mode, previous
mode, both error provenances) is parked on `degradedAgents` for explicit
reconciliation — the next sync trigger (session start, mode change, shared
re-sync, disposal) retries and clears it. `registerForAgent` itself is
self-cleaning: a mid-registration throw unwinds the partials it already
collected before surfacing. Never a half-registered set, never a dead Map
entry.

### 8a. Mode mutations are ONE transaction (v0.4.1 source atomicity)

The runtime rollback above is only half of the atomicity story: the PERSISTED
mode source used to be committed first and was never compensated when the
capability transition failed, leaving `effectiveMode` claiming the target while
the runtime implemented the previous mode. The four mutations `setMode`,
`resetMode`, `setSessionMode`, and `clearSessionOverride` now own the whole
switch as one transaction:

1. replay any PENDING source compensation (restore the previous topology);
2. capture the previous source topology (presence + value);
3. persist the target source;
4. reconcile every affected agent's capabilities inside the same exclusive
   window (the store subscriptions defer their own re-sync to the mutation);
5. converge → the commit stands (and any stale pending compensation is
   cleared);
6. any agent that could not converge → compensate the source back to its
   previous topology and THROW, so `/align-mode` and the management API
   report failure and never claim the target is active.

Session compensation keeps PRESENCE semantics: an inherited (override-less)
session is compensated by clearing, never by writing an equal-value override;
an explicit previous override is restored to its exact value. A compensating
write that itself fails is recorded as an explicit pending source compensation
(keyed by scope, exposed on the status payload with the ACTUAL active
capability mode) and replayed at the start of the next mutation. A capability
double failure with a successfully compensated source stays
`capability-degraded` (no Map entry, both error provenances) until the next
trigger. Invariant: the advertised effective mode equals the active capability
mode in every stable state; the only advertised non-converged states are the
explicit `source-compensation` and `capability-degraded` ones.

## 8b. `/align` — inspection, not a gate

`/align` appends `alignment/manual-check`, folds the status, returns a
multi-line report (revision, goal, protected constraints, drift count, last
drift, last decision, current status), and steers a compact fresh-check
instruction into the agent. It never blocks execution and never takes over the
workflow. The docs no longer describe it as a hard gate (v0.1's README
suggested "for a hard gate, run alignment manually via /align").

## 9. Plan Mode compatibility

No interaction with `ctx.planMode`; `exit_plan_mode`, the plan UI, and all
`@deepseek-ai/*` sources are untouched. The policy explicitly defers to plan
mode while it is active. **Core modifications: 0.**

## 10. Subagent behavior

`ctx.userQuestions.ask()` rejects owned children with `DELEGATED_CALLER`, and
`report_drift` converts that into a "report the candidate to your parent"
error — the policy tells children the same in prose. Forked children inherit
the parent's baseline events in their seed, so a child can fold the baseline
it was delegated under. The parent decides and, when needed, runs `report_drift`
itself; multiple children never ask the user simultaneously.

## 11. Why no hard gate in v0.2

Drift detection is model judgment; a blocking gate needs a low false-positive
rate first. v0.2 delivers baseline + policy + events + revision + status +
subagent escalation as a soft guard. The architecture keeps the gate open:
the fold already derives `drift-pending` and `baseline-update-pending`, and a
future `mode: guard` could intercept at `agent/pre-step` (the plan-mode
pending-intent seam) without changing the event schema.

## 12. Seams actually used

| Seam | Use |
|---|---|
| `agent.ctx` (agent-scoped Cordis context) | every per-agent capability registration (v0.4.0) — scoped `systemPrompt.section`, `tools.register`, `commands.register` |
| `agent/session-start`, `agent/disposed` | per-agent capability sync + lifecycle bookkeeping |
| `ctx.systemPrompt.section()` | drift-guard policy + folded baseline summary (order 60), scoped per agent |
| `ctx.tools.register(defineTool(...))` | `establish_baseline` + `report_drift` (the plan-mode tool pattern), scoped per agent |
| `ctx.userQuestions.ask()` | the drift question (native channel, agent + signal attached) |
| `ctx.commands.register()` | `/align` + `/align-migrate` (scoped per agent) and `/align-mode` (plugin scope) |
| `agent.steer()` + `createUserMessage` | `/align` hands the fresh check to the agent |
| `ctx.storageDomain` | canonical `AlignmentStateStore` sidecar + `SessionModeStore` sidecar (v0.4.0) |
| `ctx.get('settings')` / `settings.register` | shared runtime mode override (v0.3.0) |
| `ctx.get('agents')` | live-agent lookup for shared-layer resync |
| `session.append()` + `SessionEventMap` augmentation | LEGACY `alignment/*` vocabulary only |
| `agent/session-start`, `session/event` (driver) | dogfood-only snapshots + `/align` executor |
| `ctx.inject(['commands'])` | optional dependency pattern (as `dsh-plan-mode`) |
| `ctx.inject(['webServer'])` | management API under `/_dsh/requirements-alignment` (optional; web profile only) |
| bundle patch layers (`dsh.bundle.patch` + `cordis.patch.yml`) | install/remove via `dsh plugin add/rm` |
| `dsh.client.inject` + `scripts/build-client.mjs` → `lib/client.js` | Web UI floating capsule (`shell.overlay` slot), same injection recipe as `dsh-chatgpt-bridge` |

Not used (deliberately): `ctx.planMode` (plan mode is a different product),
`agent/pre-step` (no pending state in v0.2), session projections (the pure
folds are the read face; an `alignment` projection can be registered later for
client UIs without schema changes).

## 12a. Web UI floating capsule (v0.4.1+)

The plugin ships a client half for DSH Web (`platform: web` client inject, the
same recipe `dsh-chatgpt-bridge` uses). It registers the `AlignmentCapsule`
into the frame-wide `shell.overlay` slot (`id: 'requirements-alignment',
order: 50`) — a bottom-right collapsible capsule showing the current
session's effective mode as a colored dot + label. Expanding it reveals a
compact manager for the two mode layers the user controls:

- **session layer** — `auto | manual | off | reset`, addressed to the current
  session's override (`PUT` / `DELETE` `/_dsh/requirements-alignment/mode`);
- **shared layer** — `auto | manual | off | reset`, the runtime override every
  session without its own override inherits (`PUT` / `DELETE`
  `/_dsh/requirements-alignment/shared-mode`).

State is fetched (not inferred) from the loopback management API
(`GET /status?sessionId=...`, polled every 2s while the page is visible), so
the capsule can never disagree with the `/align-mode` command — both exercise
the SAME `SessionModeStore` / `ModeStore`/controller paths. The API is mounted
only when the optional `webServer` service is present (web profile); it is
loopback-only with the same Host/Origin/CSRF-header guards as the bridge, so
no third-party page can forge a mutation. See `src/management-api.ts` for the
endpoint contract and `test/management-api.test.ts` + `test/client-render.test.ts`
for the coverage.

## 13. Test strategy

1. Unit (node:test on TS sources; Node 24 type stripping — erasable syntax
   only): config validation, baseline fold, revision mechanics, drift/decision
   pairing, manual `/align`, old-session compatibility, unrelated-question
   isolation, policy rendering (off/manual/auto, baseline summary), both
   tools (silent record, question flow, child escalation, cancellation), and
   controller registrations incl. unload.
2. Real dogfooding: an isolated `DSH_HOME` under the workspace, the
   `align-headless` profile (base + headless + this plugin + scripted answer
   provider + align driver), and real one-shot agent runs. Natural-behavior
   scenarios (03 protected-constraint bug fix — silent baseline before the
   first mutation; 04 scope drift; 05 architecture shift — a natural task with
   NO protocol instruction) are measured and reported separately from the
   protocol-forced mechanism scenarios (01 greenfield start, 02 typo,
   06 unrelated `ask_user_question` isolation, 07 manual `/align`,
   08 subagent drift escalation, 09 custom drift choice, 10 invalid options,
   11 approve-interruption durability, 12 revise-interruption durability).
   The driver folds `alignment/*` state
   at session start, at the first non-read-only tool call, at the first
   decision when halting (cases 11/12), and at every turn end, so assertions
   read the real event log; `scripts/fold-session.mjs` re-folds the persisted
   on-disk session log (zstd frames + chunk-run expansion) for the
   interruption cases and also projects the baseline-summary block a resumed
   session would see. With `verifyPolicySection`, the driver assembles the
   REAL system prompt through the systemPrompt service and records whether
   the `requirements-alignment:policy` section is present in the section
   registry plus the head of its resolved text (the packed smoke gates on
   this). A separate `scripts/packed-smoke.ps1` packs the current
   tarball and exercises add → boot → verify → remove against a disposable
   profile.

## 14. Dogfooding findings (v0.2, real runs)

All runs used a real `dsh` boot (isolated `DSH_HOME` under the workspace,
profile `align-headless`, scripted answer provider, align driver, real model
calls). Final full correctness run: **11 scenarios, 63/63 checks** (four
scenarios hit the documented external LLM transport flake and passed on the
one permitted retry — project-memory rule 8); natural
drift benchmark (`-Benchmark05`): **3/4** (04 1/1, 05 2/3); packed add/rm
smoke against the current tarball: **14/14**.

| Scenario | Result |
|---|---|
| 01-greenfield | Start direction question asked (1 round), baseline recorded at revision 1, 0 drift, implemented. |
| 02-typo | 0 questions, 0 drift, typo fixed. |
| 03-bugfix | 0 questions, 0 drift, silent baseline revision 1 with UI+API constraints recorded BEFORE the first mutation (first-mutation driver snapshot proves it), TypeError fixed. |
| 04-scope-drift | Drift detected (`constraint-conflict` — the correct filter fix lives in `server.js`, excluded by the constraint); user decision `reject`; `server.js` untouched; no baseline revision. |
| 06-isolation | Synthetic `ask_user_question` tool call injected; the fold reports `driftCount 0 / revision 0`; `/align` succeeds. |
| 07-align | `/align` executes through the real commands registry: `command/run`, manual-check event, readable status text. |
| 08-subagent | Child session observed; child's analysis reported; parent ran `report_drift` (`constraint-conflict`), decision `approve`, baseline revision `0 → 2`, `deleteItem` added. |
| 09-drift-choice | Custom direction choice presented as options; the picked option recorded as `revise` with the chosen label as note; revision bumped. **Exactly one question round** — the tool result returned the chosen direction, so the agent never re-asked. |
| 10-invalid-options | Invalid `report_drift` call failed with zero session pollution (`driftCount 0`); typo still fixed. |
| 11-interrupt | Halted right after the approve decision; in-memory and PERSISTED-log folds both report `baseline-update-pending`; simulated post-resume `establish_baseline` yields `aligned`, revision +1. |
| 12-interrupt-revise | Halted right after a `revise` decision whose note is the exact chosen direction ("Use export files"); the persisted decision event keeps the note verbatim and the projected resumed summary contains "Last user decision: revise - Use export files" and the pending line names the direction. |
| 05-arch-shift (benchmark) | 3 natural runs; 2/3 called `report_drift` on their own; 1/3 did not (reported honestly in the trigger metric). |

Findings and fixes during dogfooding:

1. **Noise isolation is structural** — because alignment state is written only
   by the plugin's own tools, scenario 06 passed without any fold changes.
2. **Model variance on user direction change** — with a purely natural task
   message, the model sometimes runs the drift protocol and sometimes not
   (2/3 in the benchmark run; earlier sessions observed ~50%). The policy
   states explicitly that mid-task direction changes must go through
   `report_drift`; the benchmark is reported as its own metric, never as a
   mechanism verification.
3. **Model variance on custom options** — mechanism scenarios must spell the
   mechanism out in the task ("present the drift question with exactly these
   two directions as its options", "record the current baseline with
   establish_baseline first"); otherwise the model retries fail-loud rounds.
   The exact default approve/stay options are appended to every drift
   question (`withDefaultOptions`), so a "stay" intent can never be trapped
   inside a model-rewritten label and mis-recorded as `revise`.
4. **Host sandbox mode** — the dogfood runs must execute under
   `danger-full-access`: under `workspace-write` the DSH file sandbox cannot
   call `SetFileSecurityW` and every scenario fails with permission errors
   (see `docs/PROJECT-MEMORY.md`).
5. **LLM service flake** — one scenario run failed with
   `EMPTY_RESPONSE/RATE_LIMIT/TIMEOUT` retries and a missing final message;
   the rerun passed (external service variance, not a plugin defect).
6. **Environment (not plugin)** — the harness workspace-write sandbox denies
   `SetFileSecurityW` used by DSH's atomic file replace on Windows; the
   dogfood runs executed under full access (the agent's own in-profile
   sandbox still confined every write to the scenario directory).
7. **Fixture discipline** — scenario workspaces are runtime areas recreated
   from fixtures by `scripts/dogfood.ps1`; they are no longer tracked in git
   (v0.1 committed post-run end states, which was misleading).
8. **The user's choice must come back to the agent** (round-2 fix) — before
   the fix, `report_drift` returned only `decision`, so after a revise the
   agent re-asked which direction the user picked (case 09 reproduced it with
   a second question round; the same pattern appeared in natural 05 runs).
   The tool result now carries `note` + `requiredChange` and the summary
   projects both; case 09 is gated at exactly one round and case 12 proves
   the chosen direction survives crash + resume in the projected summary.
9. **Model compliance on extra instructions is unreliable** (round-2 fix) —
   the packed smoke originally tried to confirm the policy by asking the
   model to state it; the model complied mid-turn but the headless runner
   prints only the final message, so the assertion was flaky. The gate is now
   deterministic: the driver assembles the real system prompt and checks the
   section registry + unique policy heading.

Packed add/rm is verified against the **current v0.2.0 tarball** by
`scripts/packed-smoke.ps1` (pack → `dsh plugin add <tarball>` into a
disposable profile → compose rows → real boot: `/align` executes,
`establish_baseline` works, policy section present — verified via the driver's
real system-prompt assembly / section registry check, not a loose word match
→ `dsh plugin rm` → manifest/bundle list clean). The plugin is also installed
in the user's `web` profile; the running web server needs a restart to load
the new build (web HMR is disabled in the shipped patch).
