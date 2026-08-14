// local-tasks client: talks to the local-tasks server over HTTP.
// Tasks live on the server, so the same account sees the same list from any
// device that can reach SERVER_URL. Zero dependencies, Node 18+.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_URL = (process.env.SERVER_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const SESSION_FILE = join(process.cwd(), '.session.json');

function loadSession() {
  try {
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveSession(session) {
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
}

async function request(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// --- Programmatic API (same names as the old local module, now async) ---

export async function loadTasks() {
  const session = loadSession();
  if (!session) throw new Error('not logged in');
  return request('/api/tasks', { token: session.token });
}

export async function addTask(title) {
  const session = loadSession();
  if (!session) throw new Error('not logged in');
  return request('/api/tasks', { method: 'POST', body: { title }, token: session.token });
}

export async function completeTask(id) {
  const session = loadSession();
  if (!session) throw new Error('not logged in');
  return request(`/api/tasks/${id}/complete`, { method: 'POST', token: session.token });
}

// --- CLI ---

function fail(message) {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

async function cmdSignup(username, password) {
  if (!username || !password) return fail('usage: node index.js signup <username> <password>');
  const { token } = await request('/api/signup', { method: 'POST', body: { username, password } });
  saveSession({ token, username });
  console.log(`Signed up as ${username}`);
}

async function cmdLogin(username, password) {
  if (!username || !password) return fail('usage: node index.js login <username> <password>');
  const { token } = await request('/api/login', { method: 'POST', body: { username, password } });
  saveSession({ token, username });
  console.log(`Logged in as ${username}`);
}

async function cmdLogout() {
  rmSync(SESSION_FILE, { force: true });
  console.log('Logged out');
}

async function cmdWhoami() {
  const session = loadSession();
  if (!session) return fail('not logged in');
  console.log(`Logged in as ${session.username}`);
}

async function cmdList() {
  const tasks = await loadTasks();
  if (tasks.length === 0) {
    console.log('No tasks.');
    return;
  }
  for (const task of tasks) {
    console.log(`${task.id}. ${task.title}${task.done ? ' [done]' : ''}`);
  }
}

async function cmdAdd(title) {
  if (!title) return fail('usage: node index.js add <title>');
  const task = await addTask(title);
  console.log(`Added task #${task.id}: ${task.title}`);
}

async function cmdComplete(id) {
  if (id === undefined || !/^\d+$/.test(String(id))) return fail('usage: node index.js complete <id>');
  const task = await completeTask(Number(id));
  console.log(`Completed task #${task.id}: ${task.title}`);
}

function usage() {
  console.log(`local-tasks client (server: ${SERVER_URL})

Usage:
  node index.js signup <username> <password>   create an account
  node index.js login  <username> <password>   log in (session saved locally)
  node index.js logout                          forget the saved session
  node index.js whoami                          show the logged-in user
  node index.js list                            list my tasks
  node index.js add <title>                     add a task
  node index.js complete <id>                   mark a task done

Set SERVER_URL to point at your server, e.g. http://192.168.1.20:3000`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'signup': return await cmdSignup(args[0], args[1]);
      case 'login': return await cmdLogin(args[0], args[1]);
      case 'logout': return await cmdLogout();
      case 'whoami': return await cmdWhoami();
      case 'list': return await cmdList();
      case 'add': return await cmdAdd(args.join(' ').trim());
      case 'complete': return await cmdComplete(args[0]);
      default: return usage();
    }
  } catch (err) {
    fail(err.message);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
