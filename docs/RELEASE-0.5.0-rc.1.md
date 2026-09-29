# dsh-requirements-alignment 0.5.0-rc.1

Release candidate for DeepSeek Harness **0.1.7-rc.2** (npm `latest` at release
preparation). This version is not compatible with older DSH host APIs.

## What's changed

- Adapted agent initialization to DSH's awaited `agent/created` lifecycle and
  declared the plugin's own manual message source.
- Moved shared mode persistence to the current SettingsForms / ConfigEditor
  contract. `runtimeMode: null` resets to the profile default while preserving
  other settings.
- Updated the Web client dependency graph and added current-host regression
  and service integration checks.
- Kept migration from unsupported legacy storage formats fail-closed.

## Install

```powershell
dsh plugin --profile web add dsh-requirements-alignment@0.5.0-rc.1
```

## Verification and limits

Local typecheck, lint, build, 233 applicable tests, and packed CLI/Web HTTP
acceptance passed. The exact release commit's Windows/Ubuntu × Node 22.18/24
CI matrix is required before publication. Live browser capsule interaction
and external-model completion were not verified for this RC. The 15 historical
storage fixtures use retired host APIs and are excluded from the current test
count; modern persistence and migration refusal were checked separately.

Found a bug or have an idea? Open an [Issue](https://github.com/jiezeng2004-design/dsh-requirements-alignment/issues). Pull requests are welcome.
