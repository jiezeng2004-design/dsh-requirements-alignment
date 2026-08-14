# local-tasks

A **multi-user task manager with accounts and cloud sync**, served by a
self-hosted Node server. Each user logs in with an account and their tasks are
stored on the server, so the same list is reachable from any device — laptop,
desktop, or another machine on your network.

- **Accounts** — sign up with a username + password; passwords are hashed with
  scrypt, sessions use bearer tokens.
- **Cloud sync** — tasks live server-side in `data/users/<username>/tasks.json`
  (gitignored), not on your device. Any device that can reach the server and
  log in sees the same tasks.
- **Zero dependencies** — Node 18+ standard library only.

## Quick start

```bash
node server.js                 # start the server (http://127.0.0.1:3000)
node index.js signup alice s3cret!   # create an account (first time)
node index.js add "write report"     # add a task
node index.js list                   # list tasks
node index.js complete 1             # mark task 1 done
```

Run the client from any other device with `SERVER_URL` pointed at the server
(e.g. `http://192.168.1.20:3000`); log in with the same account and the tasks
are there.

## Commands

```
node index.js signup <username> <password>   create an account
node index.js login  <username> <password>   log in (session saved locally)
node index.js logout                          forget the saved session
node index.js whoami                          show the logged-in user
node index.js list                            list my tasks
node index.js add <title>                     add a task
node index.js complete <id>                   mark a task done
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Server bind address (`0.0.0.0` to allow other devices) |
| `PORT` | `3000` | Server port |
| `DATA_DIR` | `data` | Where accounts and tasks are stored |
| `SERVER_URL` | `http://127.0.0.1:3000` | Server the client talks to |

## API

```
GET  /api/health                    → { ok, service, multiUser }
POST /api/signup    {username, password}   → { token, username }   (201)
POST /api/login     {username, password}   → { token, username }
GET  /api/tasks                       (Bearer token)  → task list
POST /api/tasks     {title}           (Bearer token)  → created task (201)
POST /api/tasks/:id/complete          (Bearer token)  → completed task
```

## Notes

- Sessions live in server memory; restarting the server logs everyone out
  (just log in again).
- The client saves its session token in `.session.json` in the directory it
  runs from (gitignored); delete it or run `logout` to forget the session.
- Usernames are restricted to `[A-Za-z0-9._-]`, max 32 chars; passwords must be
  at least 6 characters.
- User data under `data/` is never committed; keep a backup if the server
  machine matters to you.
