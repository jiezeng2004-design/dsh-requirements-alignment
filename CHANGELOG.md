# Changelog

All notable changes to this project are documented here.

## 0.1.1 - 2026-08-14

### Changed

- Reframed the public documentation around lightweight, low-interruption requirement alignment.
- Removed repository-specific absolute paths and made dogfood overlays portable across checkouts.
- Added package discovery metadata, public repository links, and a cross-platform CI gate.

### Verification

- Type checking, linting, and build passed.
- Node tests: 31/31 passing.
- Real DSH dogfood scenarios: 6/6 passing.
- Local npm tarball install/uninstall verified against an isolated DSH profile.

### Known limitations

- Alignment decisions remain heuristic and model-dependent.
- DSH is still in developer preview, so integration points may need adaptation as its APIs evolve.

## 0.1.0 - 2026-08-14

- Initial npm publication of the native DSH requirement-alignment plugin.
