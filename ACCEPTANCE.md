# Acceptance report — dsh-requirements-alignment v0.1.1

Date: 2026-08-14 · package 0.1.1 · DSH 0.1.0-rc.6 · workspace: `<local-workspace>`

## Acceptance checklist

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Independent plugin (no DSH Core changes) | ✅ | `Core modifications: 0`. No `@deepseek-ai/*` file touched. Plugin = npm package with `dsh.bundle.patch` + `cordis.patch.yml` + Cordis service. |
| 2 | Loads in real DSH | ✅ | Installed the locally packed `dsh-requirements-alignment-0.1.1.tgz` into an isolated `align-headless` profile; the controller and ask-user rows appeared in the composed tree and real agent runs completed. |
| 3 | Unload / disable restores behavior | ✅ | `dsh plugin --profile align-headless rm dsh-requirements-alignment` removed the dependency; reinstalling the tarball restored both rows. The original isolated-profile source link was restored after the test. |
| 4 | Manual Alignment (`/align`) | ✅ | Executed in a real DSH tree at session start (driver): `command/run` logged, `resultKind: success` with status text, durable `alignment/status` manual-check event appended, check instruction steered into the agent. + unit tests. |
| 5 | Vague greenfield request triggers Alignment | ✅ | "Build me a personal task manager." → 1–3 native `ask_user_question` rounds (product form, MVP scope) before implementation. |
| 6 | Clear bug fix does not trigger | ✅ | "Fix the typo in README.md." and the TypeError fix → 0 question rounds, task done. |
| 7 | Native user-question mechanism | ✅ | Questions go through `ask_user_question` → `ctx.userQuestions` (web host renders it). Real answers returned by the scripted provider; the agent continued after every answer. |
| 8 | Agent continues after answers | ✅ | Every scenario: question → answer → full implementation → `turn/end completed` (exit 0). |
| 9 | Re-alignment | ✅ | "Now make it support multiple users across devices." on an existing single-user app → identity/sync/backend questions asked, then implemented accounts + cloud sync with migration. |
| 10 | Auto tests | ✅ | 31/31 `node:test` (config, status fold, policy branches incl. all six cases at policy level, controller mechanics, driver). |
| 11 | typecheck | ✅ | `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.check.json` — 0 errors. |
| 12 | lint | ✅ | `eslint src test` — 0 problems. |
| 13 | build | ✅ | `tsc -p tsconfig.json` → `lib/` (ESM + declarations). |
| 14 | Real DSH dogfooding | ✅ | 6 scenarios, real DSH boot, real model calls, isolated `DSH_HOME`: **6/6 scenario evidence passed**. |
| 15 | README | ✅ | Overview, focused scope, install, Quick Start, modes, `/align`, example interaction, decision logic, testing, safety, limitations, compatibility, development, and license. |
| 16 | Release safety | ✅ | No high-confidence secret pattern or repository-specific absolute path in the candidate tree; npm pack contains only 28 allowlisted files. |

## Final dogfood evidence

The bounded full-suite process completed scenarios 01–04 and 06 before its 15-minute command limit interrupted scenario 05. Scenario 05 was then reset and rerun independently with the same profile, overlay, task, and assertions. All six scenarios have exit-0 evidence:

```
[PASS] 01-greenfield : rounds=1 exit=0
[PASS] 02-typo : rounds=0 exit=0
[PASS] 03-bugfix : rounds=0 exit=0
[PASS] 04-pick-whatever : rounds=1 exit=0
[PASS] 06-align : driver-records=1 exit=0
[PASS] 06-align : /align executed (command/run=1, manual check recorded)
[PASS] 05-realign : rounds=1 exit=0
SCENARIO EVIDENCE: 6/6 passed
```

Recorded questions (excerpts from `dogfood/records/`):

- 01-greenfield: product-form direction question → local-first single-user web application → implementation completed.
- 04-pick-whatever: target-product direction question → pricing tool for indie creators → implementation completed.
- 05-realign: identity/sync direction question → multi-user accounts and cloud sync → implementation completed.

## Seam usage summary

**A. Capability seams actually used:**

| Seam | Use |
|---|---|
| `ctx.systemPrompt.section()` | always-on alignment policy, dynamic text folding the session log (order 60) |
| `ctx.commands.register()` | `/align` command (exact `CommandDefinition` contract) |
| `ctx.userQuestions` (via `ask_user_question` / `dsh-tool-ask-user`) | native question channel; the plugin's bundle mounts the tool where presets don't |
| `agent.steer()` + `createUserMessage` | `/align` hands the check to the agent |
| `session.append()` + `SessionEventMap` augmentation | durable `alignment/status` state |
| `agent/session-start` (driver) | dogfood-only `/align` executor |
| `ctx.inject(['commands'])` | optional dependency pattern (as `dsh-plan-mode`) |
| bundle patch layers (`dsh.bundle.patch` + `cordis.patch.yml`) | install/remove via `dsh plugin add/rm` — the sanctioned plugin mechanism |

**B. Fully plugin-implemented:** policy text and its per-session no-repeat rendering, `/align` command + status report, durable alignment state (fold + events), auto/manual/off modes, config validation, the scripted-answer E2E provider, the `/align` driver.

**C. DSH API limitations encountered:**

- Auto mode is policy, not a hard gate: the model decides when a decision is direction-defining. Observed variance: a greenfield run asked 3 questions (within the 1–3 rule) and one scenario-6 run asked an unnecessary question on an explicit typo task. Mitigations: no-repeat guard (log-derived), one-question-at-a-time rule, delegated-direction rule. A hard gate would require a Core-level interception point and was deliberately not built (task: don't hack Core).
- `/align` requires a command adapter; headless/ACP spines don't dispatch commands (verified via the driver instead).
- Subagents cannot call `ask_user_question` (`DELEGATED_CALLER`); the policy tells children to surface unresolved direction in their final report.
- The real behavior gate uses the headless DSH profile plus native question services. A separately running Web GUI session was not treated as equivalent runtime evidence.

**D. Core modifications: 0.**

## Environment notes

- Dogfood used an isolated `DSH_HOME`; no credentials or runtime logs are committed or included in the npm package.
- The public dogfood overlays contain placeholders. `scripts/dogfood.ps1` resolves record paths from the current checkout into ignored runtime files.
