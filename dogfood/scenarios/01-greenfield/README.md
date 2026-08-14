# Taskboard

A local-first, single-user personal task manager that runs entirely in your browser.
All data lives in your browser's `localStorage` — no accounts, no server, no cloud.

## Features

- Add tasks with an optional due date and priority (high / medium / low)
- Mark tasks complete / incomplete with one click
- Edit or delete any task
- Filter by All / Active / Completed, plus live text search (press `/` to jump to search)
- Overdue tasks are highlighted; sorting puts active tasks first, then by due date
- Everything persists automatically between sessions

## Run it

No build step and no dependencies. Either:

1. Double-click `index.html` to open it in your browser, or
2. Serve the folder (recommended) and open the URL:

```sh
python -m http.server 8000
# then visit http://localhost:8000
```

## Project layout

```
index.html   — app markup and edit dialog
styles.css   — styling (light theme, responsive)
app.js       — task model, localStorage persistence, rendering, events
```

## Deferred (out of scope for v1)

Reminders/notifications, recurring tasks, subtasks, tags/categories, drag-and-drop
reordering, cross-device sync, and accounts. The data model (`taskboard.tasks.v1`
in `localStorage`) is versioned so future versions can migrate.
