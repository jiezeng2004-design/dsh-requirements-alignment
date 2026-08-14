# Architecture decision: Requirements Alignment as a native DSH plugin

Date: session 2026-08 (DSH 0.1.0-rc.6, local checkout at
`<dsh-home>/profiles/node_modules/@deepseek-ai` + the launcher package
`@deepseek-ai/dsh` from the pnpm dlx cache).

## 1. What DSH actually is, locally

DSH is a Cordis-based (`@deepseek-ai/cordis`) plugin host. A **profile** is a
directory (`$DSH_HOME/profiles/<name>`) whose `package.json` lists
`dsh.profile.bundles`: ordered npm packages that each ship a
`cordis.patch.yml` bundle patch (declared via `dsh.bundle.patch`). The
launcher composes the patches into a plugin row tree, then the
`cordis-plugin-loader` mounts the rows. `dsh plugin --profile <name> add <pkg>`
is the sanctioned install path: it runs pnpm in the profile and reconciles the
bundle list. Uninstalling removes the package and its patch layer — the host
returns to its previous behavior. This is the plugin architecture, not a
hack.

Two composition planes exist:

- **Host plane** (profile bundles): registries and policy — `sessions`,
  `systemPrompt`, `commands`, `userQuestions` (service only), `tools`,
  sandbox, persistence, `plan-mode`, `skills`.
- **Agent-preset plane** (`dsh-agent-presets`, shipped presets
  `standard|code|cordis|minimal`): per-agent composition mounted under a
  standing scope — model-facing tools (`ask_user_question`, `tool-fs`, …),
  per-agent `plan-mode` realm, skills. Sessions join a preset; scoped
  registrations shadow global ones.

## 2. Answers to the research questions

### Q1. Most suitable extension point

A **host-plane Cordis plugin bundle** (one npm package with
`dsh.bundle.patch` + `cordis.patch.yml` + a Cordis plugin default export).
Requirements Alignment is a *policy + interaction* plugin: it must influence
every agent's prompt (system prompt section), provide a slash command (UI
plane), and use the native human-question mechanism. All of that is host-plane
reachable; per-agent scoping (preset plane) is unnecessary for v0.1 because the
policy is global by nature and state is keyed per session.

### Q2. Which seams (actually used)

| Seam | Use |
|---|---|
| `ctx.systemPrompt.section()` | The always-on alignment policy section (order 60, after plan-mode's 50). Its `text` is a function of the calling agent's session log, so it renders the full policy on a fresh session and appends a "do not re-align settled decisions" guard after the first question round — a durable, log-derived no-repeat signal. |
| `ctx.commands.register()` | The `/align` manual entry (exact `CommandDefinition` contract from `dsh-commands`). |
| Native `ask_user_question` tool (`dsh-tool-ask-user`) over `ctx.userQuestions` | The question mechanism. The plugin's own bundle patch mounts this tool when absent (headless-style compositions have no agent preset, so the tool would otherwise be missing), making the plugin self-contained. The web host UI already renders the provider. |
| `agent.steer()` + `createUserMessage` | `/align` hands the actual direction check to the agent: a compact alignment-check user message is steered into the next step; the agent inspects, classifies, and asks via the native tool. |
| `session.append()` + custom `alignment/status` session event (`SessionEventMap` module augmentation) | Durable per-session alignment state (manual checks), folded with `tool/call` records for `ask_user_question` into `foldAlignmentStatus()`. Used by the policy shortener and the `/align` status report. Resume/fork/compaction recover it from the log — no live mirror. |
| `ctx.inject(['commands'], …)` | Optional-dependency pattern exactly as `dsh-plan-mode` does, so the plugin loads in compositions without the commands service. |

Not used (deliberately): `ctx.planMode` (plan mode is a different product:
reviewing a plan, not aligning direction), a model-facing tool of our own (the
judgment is the model's; a wrapper tool would add nothing), client plugins (the
web client already renders `userQuestions` natively), skills (a skill needs a
load step; the whole point here is an always-on guardrail; the existing
`requirements-alignment` skill at `~/.agents/skills` remains compatible and
independent).

### Q3. Template packages

- **`@deepseek-ai/dsh-plan-mode`** — command registration + `userQuestions`
  interaction + system-prompt section with a log-folded `text()` + session
  events + `agent.steer()`. Every pattern the plugin needs exists there.
- **`@deepseek-ai/dsh-commands` / `dsh-command-compact`** — command contract.
- **`@deepseek-ai/dsh-base` / `dsh-web-app` / `dsh-headless` patches** —
  row/patch conventions, strict config validation style.

### Q4. Shape of the deliverable

One **host plugin package** (not client+host, not a skill provider, not a
system-prompt-only contribution, not multiple small plugins):

- Auto mode = system prompt section (policy) + native questions.
- Manual mode = `/align` command only (no section).
- A bundled **scripted answer provider** subpath export for E2E/dogfooding
  only (mounted in test profiles, never by default).
- One patch with two rows: the controller and the ask-user tool.

### Q5. Avoiding Core intrusion

Zero edits to `@deepseek-ai/*`. The only host-side file the plugin touches is
the *user's profile directory* (bundles list + patch), which is exactly the
mechanism DSH provides for installing plugins. Uninstall:
`dsh plugin --profile <name> rm dsh-requirements-alignment` — the bundle
layer is removed and DSH restores its previous behavior.

### Q6. Unload / restore

Removing the plugin removes: the policy section, the `/align` command, the
ask-user tool row it mounted, and the session events it appended (log-only;
the log keeps history, as it does for every other plugin event such as
`plan/mode`). No hooks remain registered because every registration is a
Cordis effect disposer owned by the plugin's fiber.

## 3. Auto vs Manual — honest positioning

- **Auto (default)** = policy + native questions. The *judgment* of whether a
  decision is direction-defining remains with the model (that is the product
  design: "user decides direction, agent decides engineering"), but the
  mechanism is native: the policy is always in the prompt (no skill-loading
  step), questions go through `ask_user_question`, and the session-log fold
  gives a durable "already aligned" signal that the policy text turns into an
  explicit no-repeat guard. This is as reliable as the underlying model —
  documented, not claimed otherwise.
- **Manual** = `/align` only. `/align` steers a compact alignment-check
  instruction into the agent; the agent then behaves exactly as in auto mode
  for that step.

## 4. Test strategy

1. Unit (node:test on TS sources; Node 24 type stripping — erasable syntax
   only, same constraint as DSH's own `run_code`): config validation, log
   folding, section rendering branches (fresh / already-aligned / manual /
   off / custom section), `/align` handler mechanics (event append, steer,
   result text), registration contract.
2. Real dogfooding: an isolated `DSH_HOME` under the workspace, a
   `align-headless` profile (base + headless + this plugin via
   `dsh plugin --profile align-headless add`), a scripted answer provider,
   and real one-shot agent runs of the five behavioral cases. Headless runs a
   real agent loop, real session log, real model calls.
3. Web GUI dogfooding: the running web app cannot hot-load new bundles
   (web HMR is disabled in the shipped patch); a restart of the user's web
   server would be required. Documented as the one environment-blocked step;
   the plugin is additionally installed into the web profile so a restart
   activates it.

## 5. Dogfooding findings (real runs, 2026-08)

All runs used a real `dsh` boot (isolated `DSH_HOME` under the workspace,
profile `align-headless` = base + headless + this plugin, scripted answer
provider, real model calls to `deepseek-official`).

| Case | Result |
|---|---|
| 1. "Build me a personal task manager." | Asked product-form question ("How do you want to use your personal task manager day to day? This decides the product form I build first."), then MVP-scope follow-ups (1–3 rounds across runs), then implemented a complete app. |
| 2. "Fix the typo in README.md." | 0 questions; fixed. |
| 3. TypeError bug fix | 0 questions; fixed without UI changes. |
| 4. "Pick whatever makes sense." | First run: 0 questions (gap!). Policy strengthened with the explicit "delegated direction does not waive the gate" rule; second run: 1 question ("Which money-making AI tool should I build?"), direction followed. |
| 5. "Now make it support multiple users across devices." | Re-aligned: asked sync/identity architecture + backend ownership; implemented accounts + cloud sync with migration. |
| 6. `/align` | Executed through the real commands registry at session start (driver): `command/run` event, success result with status text, durable `alignment/status` manual check appended, check instruction steered into the agent. |

Issues found and fixed during dogfooding:

1. **Exports map mismatch** — the package.json exports pointed at
   `lib/types/*.js` (the DSH convention) while this build emits `.d.ts`
   beside `.js` at `lib/` root; the loader failed with ERR_MODULE_NOT_FOUND.
   Fixed by aligning the exports with the actual build layout.
2. **Plugin metadata** — the scripted provider accessed `ctx.userQuestions`
   without declaring `inject`; Cordis fails loud ("cannot get property ...
   without inject"). Fixed by attaching `inject` to the plugin function.
3. **Policy gap (case 4)** — "pick whatever" was treated as a waiver. The
   shipped policy now states explicitly that delegated direction still
   requires the one highest-priority question before first implementation.
   Verified by re-run.
4. **Recorder robustness** — the dogfood record path's directory was missing;
   the recorder now creates it.
5. **Environment (not plugin)** — the harness's pwsh tool intermittently
   resolved the WindowsApps execution alias (ENOENT). Fixed via the
   hot-reloaded `shell.pwshPath` settings section; no plugin change needed.
6. **Model variance** — greenfield runs asked 1–3 questions (all within the
   "1-3, then stop" rule); one scenario-6 run asked an unnecessary question
   on an explicit typo task. Auto mode is policy, not enforcement — this is
   the documented limitation, mitigated by the no-repeat guard and the
   delegated-direction rule.

Uninstall/restore was verified on the dogfood profile: `dsh plugin rm`
removes the plugin's rows from the composed tree and the bundle list;
re-adding restores them. The plugin is also installed in the user's `web`
profile (bundle list updated; composed tree verified); the running web server
needs a restart to load it (web HMR is disabled in the shipped patch).
