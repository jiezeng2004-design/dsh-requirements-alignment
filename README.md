# dsh-requirements-alignment

> Lightweight requirement alignment for DeepSeek Harness.

## Overview

`dsh-requirements-alignment` adds a lightweight alignment layer before [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agents execute ambiguous or high-impact requests. It asks only when a decision materially affects direction, remembers resolved choices within the session, and stays out of the way once the intent is clear.

**You decide the direction. The agent decides the engineering.**

## Why this plugin exists

An agent can produce technically sound work in the wrong product direction when a request leaves a high-impact choice unresolved. This plugin applies the minimum intervention needed to surface that choice before execution: one focused question at a time, followed by autonomous implementation once the direction is coherent. It re-aligns only when the task direction materially changes.

## Focused scope

`dsh-requirements-alignment` intentionally focuses only on requirement direction alignment. It does not impose a complete engineering workflow and it does not change the user's normal DSH workflow.

It is **not**:

- a spec, TDD, code-review, or delivery-verification framework;
- a complete software development methodology;
- an interview bot (it asks 1 question at a time, then stops);
- a replacement for plan mode (`/plan` reviews a plan; this plugin aligns *direction* before implementation);
- a Web dashboard, database, or RAG system;
- a modification of DSH Core — it is a plain profile bundle.

## How it works

| Mechanism | What it does |
|---|---|
| System-prompt policy section | In `auto` mode (default) the alignment policy is contributed to every agent's prompt at order 60. After the first question round in a session, a no-repeat guard is appended ("do not re-run alignment for settled decisions; only re-align when a NEW direction-defining decision appears"). |
| Native user questions | The model asks through the shipped `ask_user_question` tool over the `ctx.userQuestions` seam — the same UI channel the Web client renders. The plugin's bundle also mounts `@deepseek-ai/dsh-tool-ask-user` so the tool exists in compositions without agent presets (e.g. headless). |
| `/align` command | Manual entry: records a durable `alignment/status` check, reports the session's folded status, and steers a compact alignment-check instruction into the agent for the actual analysis. |
| Durable session state | `alignment/status` events plus folded `ask_user_question` tool calls give per-session alignment state that survives resume, fork, and compaction (read straight from the session log — no live mirror). |

## Installation

```powershell
# from anywhere; path is anchored to your invoking directory
dsh plugin --profile web add <path-to-this-checkout>
# or from the registry once published
dsh plugin --profile web add dsh-requirements-alignment
```

The plugin is a **profile bundle** (`dsh.bundle.patch` + `cordis.patch.yml`), so it installs through the standard plugin mechanism and adds two rows:

- `requirements-alignment` — the controller (`mode: auto` by default);
- `requirements-alignment-ask-user` — the model-facing question tool.

## Quick Start

Install the bundle, start a normal DSH task, and answer only if DSH surfaces a direction-defining choice. Auto mode is enabled by default; no separate command or workflow is required.

```powershell
dsh plugin --profile web add dsh-requirements-alignment
```

Use `/align` when you want to request the same structured alignment check manually.

## Enable / disable / uninstall

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

Every registration is a Cordis effect disposer owned by the plugin's fiber: unloading removes the policy section, the `/align` command, and the tool row. Session history keeps the `alignment/status` events it appended (like every other plugin event, e.g. `plan/mode`).

## Behavior and decision logic

- Clear, repository-established work proceeds without an alignment question.
- Ambiguous or high-impact work asks about the highest-priority unresolved direction decision.
- Resolved direction choices are not repeatedly re-asked within the same session.
- A material direction change can trigger a new alignment round.
- Disabling or unloading the plugin removes its active registrations.

## Auto mode (default)

No setup needed. The policy section is present in every agent's system prompt:

- **Greenfield or vague work** (blank project, new product, undefined form / scope / interaction) triggers the *Greenfield Alignment Gate*: the agent confirms product goal, MVP scope, and primary interaction before substantive implementation — asking **one question at a time** via `ask_user_question`, highest-priority decision first, 2–3 distinct options, a clear recommendation first.
- **Explicit work** (repository establishes direction, or a clear local change like a bug fix) proceeds without questions. The agent never asks about filenames, helper placement, library choice, formatting, or anything the repository already establishes.
- **Delegated direction** ("pick whatever makes sense") does **not** waive the gate: the agent still asks the one highest-priority direction question before the first substantive implementation, then decides everything else itself.
- **Re-alignment**: when a NEW direction-defining decision appears mid-work (multi-user accounts, cloud sync, a new product form, …), the agent asks again — but never re-runs alignment for settled decisions.

Auto mode's judgment is the model's (it is a policy, not a gate). That is the honest limit of the mechanism; see *Limitations*.

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

`/align` records the check, reports the session's alignment status (question rounds so far, last manual check), and hands the actual analysis to the agent, which then behaves exactly as in auto mode for that step. It never takes over the workflow.

## Example interaction

```text
User: Build me a personal task manager.
Agent: Where should the first version run: local web app, desktop app, or mobile app?
User: Local web app.
Agent: [implements without continuing a requirements interview]
```

| User request | Behavior |
|---|---|
| "Build me a personal task manager." | Asks about product form / primary usage first, then implements. |
| "Fix the typo in README.md." | No questions; fixes it. |
| "The submit button throws TypeError when form.email is undefined. Fix it without changing the UI." | No interview; fixes the bug. |
| "Build me an AI tool that can make money. Pick whatever makes sense." | Still asks the one highest-priority direction question (which product / which user), then decides the rest itself. |
| "Now make it support multiple users across devices." (existing local app) | Re-aligns: asks about identity / sync / backend ownership, then implements. |

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `mode` | `auto` | `auto` — policy section + command; `manual` — command only; `off` — inert (row loaded, nothing registered). |
| `section` | shipped policy | Deployment-owned policy text replacing the shipped one (auto mode). Must be non-empty when provided. |

Unknown config keys fail at load (same stance as `dsh-plan-mode`).

## Safety boundary

- **No Core modifications.** Zero changes to `@deepseek-ai/*` packages; the only host-side file touched is the profile's bundle list / patch, which is exactly the mechanism DSH provides for installing plugins.
- **Question channel only.** The plugin never reads or writes the user's data; it appends two log-only session events and steers one user message on `/align`.
- **No file access.** It does not inspect the filesystem itself; the agent does that with its own tools under the normal sandbox.
- **No background monitoring.** Re-alignment is triggered by the model noticing new direction-defining decisions, not by a watcher; there is no repeated interruption loop.

## Limitations

- **Auto mode is policy, not enforcement.** Whether a decision is direction-defining is the model's judgment (that is also the product design: "user decides direction, agent decides engineering"). A model can still under- or over-ask; the no-repeat guard and the one-question-at-a-time rule reduce over-asking, and the delegated-direction rule reduces under-asking, but neither is a hard gate. For a hard gate, run alignment manually via `/align`.
- **`/align` needs a command adapter.** UI-less spines (the headless profile, ACP automation) do not dispatch slash commands; the command is exercised by the Web client and by the unit tests / dogfood driver.
- **Subagents cannot ask the user.** DSH rejects `ask_user_question` from owned children; the policy tells child agents to surface unresolved direction decisions in their final report instead.
- **One question round = one `ask_user_question` call.** The no-repeat guard counts tool calls; other plugins' questions to the user count the same way.
- **Question rounds are counted per session log**, so a resumed session inherits its alignment state — by design.

## Testing and verification

The release gate runs type checking, linting, a production build, and the Node test suite:

```powershell
pnpm run check
```

Real DSH dogfooding covers clear requests, ambiguous direction choices, duplicate-question suppression, direction-change re-alignment, manual `/align`, and plugin load/unload behavior:

```powershell
powershell -File scripts/dogfood.ps1
```

The v0.1.1 release gate verified:

- Core modifications: **0**
- Node tests: **31/31 passing**
- Real DSH dogfood scenarios: **6/6 passing**
- Packed plugin load/unload: **verified**

Detailed evidence and the bounded-run caveat are recorded in `ACCEPTANCE.md`; the release notes report the same layers without treating a build as runtime proof.

## Development

```powershell
pnpm install          # dependencies
pnpm run typecheck    # tsc (src + test)
pnpm run lint         # eslint (src + test)
pnpm run build        # tsc → lib/
pnpm test             # node:test (31 tests)
pnpm run check        # all of the above
```

Real dogfooding (boots real `dsh` profiles with an isolated `DSH_HOME`, runs the five behavioral scenarios plus a `/align` driver, and asserts the question records):

```powershell
powershell -File scripts/dogfood.ps1
```

See `docs/ARCHITECTURE.md` for the design decisions and the exact capability seams used.

## Compatibility

- DeepSeek Harness `0.1.0-rc.6` (verified against the local profile bundle set and the npm registry releases of the same version).
- `@deepseek-ai/cordis` 4.x, `@deepseek-ai/dsh-*` `^0.1.0-rc.6`.
- Windows (verified) and POSIX (no platform-specific code).

## License

MIT. See `LICENSE`.
