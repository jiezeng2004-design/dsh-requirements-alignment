# Project Memory — dsh-requirements-alignment

Operational rules learned from real runs. Read before running dogfood,
packed smoke, or any real DSH integration work. These rules exist so runs do
not stall or burn model time on known environment issues.

## 1. Dogfood MUST run under danger-full-access (host sandbox)

`scripts/dogfood.ps1` boots real `dsh` headless sessions whose agents modify
files in the scenario workspace. DSH's internal file sandbox (windows-acl)
stages a temp copy and calls `SetFileSecurityW`; under the host's
`workspace-write` sandbox that call is denied (`EACCES (Win32 5)`), so the
agent cannot modify ANY existing file and every scenario degrades into long
retry loops (observed: a typo fix took ~11 minutes and still failed).

- Run: `pwsh -File scripts/dogfood.ps1 ...` with `danger-full-access`.
- Under `workspace-write` the suite will be marked INFRASTRUCTURE FAILURE —
  do not "fix" the model or the plugin; fix the host sandbox mode.
- History: ACCEPTANCE.md environment notes record the same constraint for
  earlier successful runs.

## 2. Development iterations use the smoke suite, not the full suite

Full dogfood (10 correctness scenarios) + `scripts/packed-smoke.ps1` are
**release-candidate gates only**. During development:

- `pwsh -File scripts/dogfood.ps1 -Smoke` — core 4 cases: 02-typo,
  03-bugfix, 04-scope-drift, 09-drift-choice.
- `pwsh -File scripts/dogfood.ps1 -Scenario <name>` — one scenario.
- `pwsh -File scripts/dogfood.ps1 -Benchmark05` — the 05-arch-shift natural
  benchmark only (3 runs, NATURAL DRIFT TRIGGER N/M).
- `-FailFast` aborts at the first failed check (development).
- `-TimeoutSec <n>` (default 600) is a hard per-scenario timeout: the
  process tree is killed and the case fails. Never let a case run unbounded.

## 3. Infrastructure-error rule: ≤ 2 workaround attempts, then terminate

A simple dogfood case that hits infrastructure/permission errors
(`SetFileSecurityW`, `EACCES`, `windows-acl`, sandbox failures) must NOT be
retried more than twice with different workarounds. After that:

- mark the case **INFRASTRUCTURE FAILURE**,
- keep the logs (`dogfood/logs/*.out.txt`, driver records),
- terminate the case and move on (or stop the run).

The script auto-detects the failure signatures and reports
`INFRASTRUCTURE FAILURES: N` in the summary. Fix the environment/root cause
before re-running; repeated model-side workarounds waste time.

## 3b. Protocol-forced case tasks must be explicit about mechanism

The model is variable about tool usage details. Mechanism scenarios (09,
11, 12) initially produced retry loops (3-5 drift questions) because the
task text said "present the choice" without saying how. Deterministic
mechanism cases must spell out the mechanism in the task: "present the drift
question with exactly these two directions as its options" (09, 12) /
"record the current baseline with establish_baseline first ... run the drift
protocol with the default options" (11). Natural cases (03, 04, 05) must keep
NO mechanism hints — that separation is the point.

## 4. Natural vs protocol-forced reporting

Natural-behavior runs (03, 04, 05) measure the model's policy adherence;
protocol-forced mechanism runs (01, 06, 07, 08, 09, 10, 11, 12) verify the
tool mechanisms. Never present natural trigger data as a mechanism verification
and vice versa. The 05 natural benchmark is excluded from the full
correctness suite on purpose (`-Benchmark05`).

## 5. Headless has no CLI resume

The headless app is one-shot (`--help` only). Interruption-durability
verification (cases 11, 12) halts the process via the driver and re-folds the
PERSISTED sidecar (`storages/requirements_alignment.json`) with
`scripts/fold-session.mjs`; the post-resume `establish_baseline` is simulated
on the same sidecar record. The fold result — and, for case 12, the projected
baseline summary a resumed session would see — is what resume would
reconstruct. The script falls back to the legacy session-log fold only when
the sidecar has no record for that session.

## 6. Packaging notes

- `npm pack` needs a writable `--cache` on this host (the default npm cache
  is outside the sandbox): `npm pack --dry-run --cache <workspace dir>`.
- Every `exports` target must exist in the packed tarball (check with
  `npm pack --dry-run`); `lib/` is the only shipped build output.
- The packed smoke must run against the CURRENT tarball — historical
  verification is not evidence for the current build.
- The packed-smoke disposable profile must NOT be copied with node_modules
  (deep nested links break recursive copy): copy the profile skeleton
  (package.json, pnpm-workspace.yaml, pnpm-lock.yaml, cordis.yml,
  cordis.patch.yml) and run `pnpm install --offline` from the shared store;
  pass `--offline` to `dsh plugin add` as well.

## 7. Do not churn full test suites

Minimal relevant tests during modification; `pnpm run check` and the full
dogfood suite only when the code is stable. Do not re-run full suites that
already passed unless a change invalidates them.

## 8. External LLM service flakes

A scenario can fail with an empty final message and `llm/retry` events
(`EMPTY_RESPONSE` / `RATE_LIMIT` / `TIMEOUT`) in the persisted session log.
That is external service variance, not a plugin defect. Retry the scenario
once; if it fails again, investigate before more retries.

## 8b. QUOTA: Insufficient Balance is an environment limit, not a defect

When the external model API reports `QUOTA: Insufficient Balance`, every
real-agent scenario that needs a model call (subagent creation, drift
questions, task completion) cannot complete — the process exits non-zero
before the model runs. This is not a plugin defect; do NOT "fix" the plugin
or the model for it. The dogfood driver still records the deterministic
pre-model behavior (per-agent capability registration at `agent/created`),
so assert that, mark the model-dependent assertions as QUOTA-limited, and
report the quota separately rather than claiming a mechanism pass (v0.4.0
scenario 13 and packed-smoke boot behave this way). Refill the balance before
re-running the full gate.

## 9. DSH 0.1.1-rc.1 boot / probe rules (v0.4.1)

Learned during the v0.4.1 packed smoke against the real rc.1 installation:

- `dsh --profile <name> --dump-config` always works without mounting anything
  (boot-free), so composition can be verified deterministically.
- A base headless boot (no `--dump-config`) hangs waiting on the LLM with zero
  output — no `sessions/` dir is created. An agent that is created but never
  asked to continue (`agents.create` without a followup) does NOT wake the
  model (`whenIdle` escapes), enabling a real agent with a full registration
  matrix, quota-free.
- `--patch` overlays apply only after the `@deepseek-ai/dsh-headless` bundle is
  in `dsh.profile.bundles`; without it the headless code-runtime rows never
  mount.
- The headless runner still requires a task positional (`error: a task is
  required`) — always pass a task string even when the probe self-exits.
- To attach application code to a boot, wrap it in `--patch` with an explicit
  `inject: [...]` list (dependency-free rows mount first); a bare patch applies
  before any injectable service exists.
- `/align-mode session` with no storage-domain mounted fails loud with "cannot
  persist a session mode override: no storage-domain service is mounted" — that
  is the design fail-open (entry-only port), not a defect.
- All smoke home/probe state must live under an isolated disposable `DSH_HOME`
  (temp dir), never the user's real `~/.dsh`.
