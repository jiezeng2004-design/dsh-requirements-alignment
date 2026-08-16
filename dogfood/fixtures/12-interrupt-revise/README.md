# local-tasks

A **single-user, local-first task manager**. Tasks are stored in a plain JSON
file on this machine only — no accounts, no server, no cloud.

## Quick start

```bash
node index.js add "write report"   # add a task
node index.js list                 # list tasks
node index.js complete 1           # mark task 1 done
```

## Commands

```
node index.js add <title>      add a task
node index.js list             list tasks
node index.js complete <id>    mark a task done
```

## Notes

- All data lives in `tasks.json` next to the app. Nothing leaves this device.
