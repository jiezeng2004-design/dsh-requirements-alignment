# Roadmap

This roadmap records intended product direction; it is not a claim that the
listed behavior ships in the current package.

## v0.4.0 — session-scoped mode selector

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
changes. The release should also provide a session-local selector in the Web
client if DSH exposes a supported plugin UI contribution seam. If it does not,
v0.4.0 must not patch Core: the command selector remains the supported surface,
and the missing host UI seam is reported explicitly rather than simulated by
editing profile files.

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
