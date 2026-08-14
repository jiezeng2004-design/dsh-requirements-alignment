// local-tasks: single-user, local-first task manager.
// Tasks are stored in a local JSON file on this machine only.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STORE = join(process.cwd(), 'tasks.json');

export function loadTasks() {
  try {
    return JSON.parse(readFileSync(STORE, 'utf8'));
  } catch {
    return [];
  }
}

export function saveTasks(tasks) {
  writeFileSync(STORE, JSON.stringify(tasks, null, 2));
}

export function addTask(title) {
  const tasks = loadTasks();
  const task = { id: tasks.length + 1, title, done: false };
  tasks.push(task);
  saveTasks(tasks);
  return task;
}

export function completeTask(id) {
  const tasks = loadTasks();
  const task = tasks.find((t) => t.id === id);
  if (task) task.done = true;
  saveTasks(tasks);
  return task;
}
