# Roadmap

This roadmap records intended product direction; it is not a claim that the
listed behavior ships in the current package.

## v0.4.1 — session-scoped mode selector + Web capsule

> **Status: implemented in the current package.** The four-layer resolution,
> the `/align-mode session` command surface, per-session persistence (the
> `SessionModeStore` sidecar), fork inheritance, and the per-agent capability
> model are shipped, and v0.4.1 adds the `AlignmentCapsule` Web float driven by
> the plugin's loopback management API. The package also folds DSH
> `0.1.1-rc.1` compatibility (dependencies pinned to the rc.1 family, migration
> parity with the real rc.1 writer/reader). The native Web session-local
> selector below remains a host-UI option, not a DSH Core patch; see
> `docs/ARCHITECTURE.md`.

### Outcome

Let one session use Auto, Manual, or Off without changing the effective mode
of other live sessions. Keep the v0.3.0 profile/runtime mode as the shared
fallback and preserve the no-DSH-Core-patch boundary.

### Resolution model

The proposed precedence is:

```text
valid session override
    -> valid persisted runtime override
    -> valid profile default
    -> auto
```

`/align-mode` continues to report and change the shared runtime override.
Session-scoped operations are explicit so a user cannot accidentally change
every session while intending to change only the current one:

```text
/align-mode session
/align-mode session auto
/align-mode session manual
/align-mode session off
/align-mode session reset
```

The status result must show all four layers and identify the exact source of
the current session's effective mode.

### Selector surface

The command surface above is the required fallback and works without DSH Core
changes. v0.4.1 ships the Web-client selector: an `AlignmentCapsule` float in
the `shell.overlay` slot, driven entirely through the plugin's loopback
management API (`/_dsh/requirements-alignment/*`) so the widget and the
`/align-mode` command can never disagree. No DSH Core changes; no profile-file
editing.

### Persistence and lifecycle

- Key session overrides by lifecycle identity (`id + createdAt + cwd`), not by
  the reusable session id alone.
- A resumed session restores its override.
- A fork inherits the effective session override at its seed boundary, then
  becomes independently changeable.
- Reset removes only the current session override and reveals the shared
  runtime/profile fallback.
- Switching or resetting a mode never deletes requirement baselines, drifts,
  decisions, manual checks, or legacy migration evidence.
- Invalid stored values fail open to the next valid layer and are repaired
  without preventing session startup.

### Runtime architecture gate

v0.3.0 registers policy, tools, and commands at plugin scope. v0.4.0 must not
pretend those global registrations are session-local. Before implementation,
confirm supported DSH seams for per-session prompt contribution and tool
availability. Where discovery remains global, handlers must resolve and
enforce the calling session's effective mode, and the documentation must state
any capability that remains visible but inert in a session.

### Acceptance gate

- Two concurrent sessions can hold different effective modes with no leakage.
- Changing Session A never changes Session B or the shared runtime override.
- Auto / Manual / Off behavior is correct per session on new, resumed, forked,
  and historically forked sessions.
- Session reset and shared reset affect only their documented layer.
- Persistence failure and registration failure leave no split-brain state.
- The selector remains usable when the current session is Off.
- Unit tests, Windows + Ubuntu CI, current-tarball packed install, and real DSH
  two-session dogfood all pass before release.

### Non-goals for v0.3.0

The v0.3.0 release remains a shared Profile/runtime hot-switching release. It
does not claim session-scoped selection or a native Web Settings control.
