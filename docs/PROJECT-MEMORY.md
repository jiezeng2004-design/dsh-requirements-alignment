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
PERSISTED session log with `scripts/fold-session.mjs` (zstd frames +
chunk-run expansion via `decodeStorageRecord`); the post-resume
`establish_baseline` is simulated on the same log. The fold result — and, for
case 12, the projected baseline summary a resumed session would see — is what
resume would reconstruct.

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
