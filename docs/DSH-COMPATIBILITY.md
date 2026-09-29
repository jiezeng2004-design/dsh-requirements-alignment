# DSH compatibility check — 2026-09-29

## Release candidate: 0.5.0-rc.1

Target: **npm latest 0.1.7-rc.2**. Registry recheck also returned
next=0.2.0-rc.2 and alpha=0.1.7-alpha.2; this candidate does not claim either.
All DSH peer/development contracts are pinned to the audited target.

- Both TypeScript checks, ESLint, build and **233/233** applicable tests pass.
- `pnpm peers check` reports no development-graph issues.
- `pnpm check` includes real host services, serial agent creation, tools,
  question waterfall, fork boundary zero, session-mode commands, sidecar and
  JSONL reload, and fail-closed migration. Its SettingsForms service is real,
  but profile I/O in that integration fixture is simulated explicitly.
- Separate **packed CLI/Web acceptance passed** with the shipped CLI,
  SettingsForms and ConfigEditor: temporary profile installation, token-to-cookie
  login, root HTTP 200, missing-session validation 400, shared manual write,
  `cordis.patch.yml` persistence, restart and reset to profile auto/null.
  The owned child was stopped and its listener verified closed.
- The isolated profile package manager warns about host-supplied peers because
  its local package manifest does not include core host packages. The official
  CLI supplies those during composition; boot and native mutations passed.
  This warning is distinct from the clean repository development graph.
- The existing CI matrix executes the current host gate. The exact release
  commit's CI result must be checked before publication. Local runtime: Node 24.18.1.

Contract fixes: awaited agent/created instead of retired session-start;
dedicated requirements-alignment message source; owning-entry settings binding
by fiber uid; revision-checked runtimeMode mutation; explicit null reset;
ui-layout/ui-session/locale client dependencies. No Core patch is required.

The 15 legacy storage tests in migration.test.ts and
persistence-regression.test.ts are retained but excluded from the modern
runner and check tsconfig because they exercise removed host APIs. Their
historical pass counts must not be added to the 233 current tests. Modern
persistence and migration-refusal evidence comes from the current host gate.

Known release limitations: real browser capsule interactions and actual model
continuation. Browser control attempts were blocked; HTTP acceptance is not
browser acceptance. The user authorized RC publication with these limits.
The exact-commit CI matrix remains a required publication gate. No credentials,
existing sessions or user profile were copied for the local checks. Legacy
settings/session migration is not implemented for the new immutable-generation
format.

Reproduce local gates: `pnpm check`, `pnpm peers check`. After preparing a
disposable host root, installing the exact CLI and packed plugin into its
`cli-home` profile, run `node scripts/packed-web-check.mjs <probe-root>`.
The script keeps generated login material in memory and never prints it.

---

# Archived DSH compatibility check — 2026-09-27

Everything below is historical evidence for the old target, not current
support or acceptance for 0.5.0-rc.1.

## Current target and official evidence

The adaptation target is **npm `latest=0.1.5-rc.3`**, published on
2026-09-22. This is a release candidate: the registry version history contains
no stable semver release. The higher channels are `next=0.1.7-rc.2` and
`alpha=0.1.7-alpha.2`. These were freshly checked on 2026-09-27.

- [Official registry metadata](https://registry.npmjs.org/@deepseek-ai%2fdsh)
- [Official releases](https://github.com/deepseek-ai/deepseek-harness/releases)
- [Next release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2)
- [Breaking changes introduced in 0.1.7-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.1)

The checked GitHub release list does not contain a matching 0.1.5-rc.3 release
entry (it does contain rc.2). The published npm package and declarations are
the primary authority for the exact latest target. Next-channel release notes
describe Session V4, configuration-backed settings, runtime plugin resolution
and client multi-session changes.

## Current changes

- Replace the retired `dsh-client-runtime` client graph edge with real
  `dsh-client-ui-layout` and `dsh-client-ui-session` modules. Both publish
  `dsh.client` and `./client`; the latter supplies `useSessions`. Keep locale
  and the browser `slots`/`locale` service injection.
- Express shared host services, Session/error identities, storage-domain and
  Schemastery as peer contracts rather than pinning private old copies.
  DSH peers explicitly include the tested latest and legacy fixture versions,
  not the incompatible next channel. The legacy backend range is not a claim
  that the updated client graph supports rc.2 Web.
- Preserve the pre-existing snapshotEvents, fork boundary, question waterfall,
  fixed namespace and fail-closed migration work, plus client drag/render edits.
- Add an isolated registry probe, version-aware session fixtures, client/peer
  regressions, real report_drift interaction, immutable-generation readback and
  sidecar/settings reload checks. Smoke reports the installed host version,
  never the historical hardcoded alpha version.

## Current verification

| Layer | Evidence and boundary |
| --- | --- |
| Legacy fixture graph | `pnpm run check`: both TypeScript checks, lint, build, 244/244 tests. Backend dev pins intentionally remain rc.2 for old-format migration coverage. |
| Isolated npm latest graph | Exact DSH family 0.1.5-rc.3, Cordis 4.0.2, Schemastery 3.18.2; source and applicable-test declaration checks, build, 229/229 tests. No source aliases or global DSH. |
| Legacy-only fixtures | `migration.test.ts` and `persistence-regression.test.ts` (15 tests) run on the legacy graph, not counted as modern acceptance. Modern migration refusal has a regression and real-host check. |
| Real service integration | Real Cordis, AgentLoop, SessionStore, commands, tools, UserQuestions, JSONL and storage-domain JSON. Baseline, drift/revise, answerer unload, mode commands, zero-inheritance fork, flush/read, no private alignment events, migration refusal; fresh services reload sidecar state/session mode/shared mode. Real SettingsProvider contract with a fixture-only JSON backend, not the shipped settings-file implementation. No model/account. |
| Packed install and CLI | Local tarball installed using actual `dsh plugin --profile web add` into fresh DSH_HOME. Actual 0.1.5-rc.3 Web CLI boots on loopback with a random port and no browser auto-open. |
| HTTP and plugin route | Unauthenticated `/` returns 401. Plugin `/status` returns expected missing-session 400. PUT shared mode returns 200 with `manual`; DELETE reset returns 200 with `auto` and profile source. Temporary host stopped after checks. |
| Live UI | **Not verified**: in-app browser gives `ERR_BLOCKED_BY_CLIENT` for local host; public example.com control also times out. No browser policy/connector changes. Fake-React tests are not live UI evidence. |
| Real model/user workflow | **Not run**: no credentials, model setup, active user session or production environment. Scripted answers are not real human/model E2E. |

Node: 24.18.1; pnpm: 11.19.0. The legacy developer graph has known peer
warnings: modern client metadata packages want Cordis 4.0.2, while legacy
fixture services use 4.0.1; also the pre-existing ESLint 9 / @eslint/js 10
mismatch. The acceptance probe uses its own coherent modern host graph.

### Reproduce the modern gate

```powershell
node scripts/prepare-host-probe.mjs 0.1.5-rc.3
# cd to the printed PLUGIN directory (temporary, isolated)
node scripts/test-modern-host.mjs
```

Installation disables lifecycle scripts. The runner refuses to create its
temporary TypeScript config in the source checkout. Temporary probes contain
synthetic sessions only and are retained for inspection.

### Next-channel assessment: not supported

An independent 0.1.7-rc.2 graph with Cordis 4.0.4 and Schemastery 3.18.4 fails
source checking: `agent/session-start` is removed, before-start handler typing
changed, createUserMessage no longer accepts source `plugin`, and
SettingsProvider/SettingsScope are removed. Basic tool/session services alone
still execute, which is **insufficient**: the early smoke did not mount the
changed settings layer. Full acceptance now explicitly requires 0.1.5-rc.3
and tests settings. Do not infer 0.1.7 support from partial runtime checks.

## Current rollback / release boundary

No commit, push, PR, publish, global DSH update, user configuration/session
change, tunnel or production networking change was performed. The working
tree was already dirty (main, HEAD 079e678). A separate temporary baseline
copy of source/tests/scripts/docs/manifests was retained before this run.
Reverse only this run's reviewed hunks; do not restore HEAD over pre-existing
compatibility/client work. Restore package/lock changes as a pair, reinstall
the selected graph and rebuild. Historical release gates are not modern proof.

---

# Historical source-only report — 2026-09-07 (superseded)

The following is historical evidence; its target, publication gap and native
binding blocker are not the current 2026-09-27 status.

## Target and publication gap

The selected target is **0.1.3-alpha.1**, the newest official GitHub prerelease.
No stable release exists in either the checked GitHub Releases list or npm version history.
The official npm registry still exposes `latest=next=0.1.2-rc.1` and
`alpha=0.1.2-alpha.5`; `0.1.3-alpha.1` is not available there. A `latest` tag
does not make a prerelease stable. Check these sources again before installing:

- [Official release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1)
- [Official npm metadata](https://registry.npmjs.org/@deepseek-ai%2fdsh)
- Source tag commit: `d347e703908d0406b7a7ef80e3a0e594d86b2215`.

This is a source-runtime compatibility update, **not a claim of complete
installable 0.1.3 support**. Package pins and the lockfile retain the previously
installable `0.1.1-rc.2` baseline; they do not point to nonexistent npm packages.
The modern source probe resolves the entire DSH family through the official
source aliases, rather than mixing old installed packages with new host services.

## Changes

- Read session history through `snapshotEvents()` where present, preserving the
  existing fallback for older `events` arrays.
- Resolve fork state using `Session.inheritedEventCount`, including zero; older
  hosts retain `header.seedLength`. A child's later events cannot expand its
  original inherited boundary.
- Use a fixed valid settings namespace without importing the removed
  `settingsNamespace` constructor. Settings still registers and validates it.
- The dogfood driver accepts the renamed `ToolCallId` runtime constructor.
- Scripted answers support the new `user-questions/request` waterfall as well
  as legacy provider registration; disposing the plugin removes the answerer.
- Load the legacy migration codec only after confirming the legacy persistence
  API. Handle-based hosts reject `/align-migrate` before any artifact I/O.
  This is deliberate: v2 uses immutable adjacent generations; the old in-place
  migration algorithm must never rewrite them. Legacy alignment-event recovery
  on v2 is unsupported, and requires a separately verified generation migration.

## Verification

- Original dependency baseline: `pnpm run check` (both typechecks, lint, build,
  and the full Node test suite): 243/243 passing.
- The official checkout completed `pnpm run build:official`. The plugin passes
  declaration checking against that built host using its own TypeScript options:
  `node scripts/check-host-types.mjs <built-official-checkout>`. This checks
  source imports against generated host declarations, not registry installation.
- Official 0.1.3 source runtime: all tests except `migration.test.ts` and
  `persistence-regression.test.ts`. These two files are old-format fixtures using
  retired writer/reader APIs; their original-baseline success is not v2 evidence.
  The remaining 228 tests pass against the official source aliases.
- `scripts/modern-host-smoke.mjs`: real Cordis, AgentLoop, SessionStore, commands,
  tools and JSON-backed storage-domain services. Checks asynchronous Agent
  creation, `establish_baseline`, per-session Auto/Manual/Off commands, fork
  boundary zero, refusal of unsafe legacy migration, and absence of private
  alignment events in the host log. Also verifies the real question waterfall
  and refusal after the scripted answerer is unloaded. No model, credentials, or account is used.
  Temporary sidecars are retained and their path is printed.

To reproduce the modern source probe from the verified official checkout
(whose dependencies must already be installed), use PowerShell:

```powershell
$env:TSX_TSCONFIG_PATH = Join-Path (Get-Location) 'tsconfig.base.json'
# Replace <plugin-checkout> with the actual plugin source directory.
node --import tsx/esm <plugin-checkout>/scripts/modern-host-smoke.mjs
```

The current evidence does **not** establish full DSH profile boot,
packed npm installation, Web UI behavior, real model E2E,
or v2 legacy-artifact migration. The source CLI `--version` result establishes
only the CLI version entry. `scripts/packed-smoke.ps1` remains the historical
rc.2 harness and must not be reported as a modern-host check.

An actual built CLI launch was attempted with a fresh `DSH_HOME`, copied plugin
build and standard Web bundles, `--host 127.0.0.1 --port 3187 --no-open` and
telemetry disabled. It exited before serving HTTP because the installed
`fs-ext@2.1.1` native binding was absent. An isolated native rebuild failed:
node-gyp could not find a usable Visual Studio C++ installation. No system
toolchain was installed and no upstream locking code was bypassed. Therefore
the Web UI gate is **blocked**, not passed. The diagnostic profile contains no
real account or historical session configuration.

## Rollback

No release, commit, push, or global DSH change is part of this update. Revert only
the compatibility edits after reviewing the diff; preserve existing client and
session-history work. The automation's `runs/20260907/resume-baseline/` contains
the exact pre-edit copies of overlapping files. Do not overwrite later edits
with those copies. Rebuild `lib` from the chosen source state with `pnpm run build`.
