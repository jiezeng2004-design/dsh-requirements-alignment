// local-tasks server: multi-user accounts + cloud-synced tasks.
// Zero dependencies — Node 18+ standard library only.
import { createServer } from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), 'data');

const USERNAME_RE = /^[A-Za-z0-9._-]{1,32}$/;
const MIN_PASSWORD_LEN = 6;

// token -> username. Sessions live in server memory: restarting the server
// logs everyone out (they just log in again).
const sessions = new Map();

mkdirSync(join(DATA_DIR, 'users'), { recursive: true });

function userDir(username) {
  return join(DATA_DIR, 'users', username);
}

function accountFile(username) {
  return join(userDir(username), 'account.json');
}

function tasksFile(username) {
  return join(userDir(username), 'tasks.json');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

function verifyPassword(password, record) {
  const { hash } = hashPassword(password, record.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(record.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function createSession(username) {
  const token = randomBytes(24).toString('hex');
  sessions.set(token, username);
  return token;
}

function authenticate(req) {
  const match = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? '');
  if (!match) return null;
  return sessions.get(match[1]) ?? null;
}

function loadTasks(username) {
  return readJson(tasksFile(username), []);
}

function saveTasks(username, tasks) {
  writeJson(tasksFile(username), tasks);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function handleSignup(req, res) {
  const { username, password } = await readBody(req);
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return send(res, 400, { error: 'username must match [A-Za-z0-9._-], max 32 chars' });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    return send(res, 400, { error: `password must be at least ${MIN_PASSWORD_LEN} characters` });
  }
  if (readJson(accountFile(username), null) !== null) {
    return send(res, 409, { error: 'username already taken' });
  }
  mkdirSync(userDir(username), { recursive: true });
  writeJson(accountFile(username), {
    username,
    ...hashPassword(password),
    createdAt: new Date().toISOString(),
  });
  saveTasks(username, []);
  send(res, 201, { token: createSession(username), username });
}

async function handleLogin(req, res) {
  const { username, password } = await readBody(req);
  const record = typeof username === 'string' ? readJson(accountFile(username), null) : null;
  if (!record || typeof password !== 'string' || !verifyPassword(password, record)) {
    return send(res, 401, { error: 'invalid username or password' });
  }
  send(res, 200, { token: createSession(username), username });
}

function handleListTasks(res, username) {
  send(res, 200, loadTasks(username));
}

async function handleAddTask(req, res, username) {
  const { title } = await readBody(req);
  if (typeof title !== 'string' || title.trim() === '') {
    return send(res, 400, { error: 'title is required' });
  }
  const tasks = loadTasks(username);
  const task = {
    id: tasks.reduce((max, t) => Math.max(max, t.id), 0) + 1,
    title: title.trim(),
    done: false,
  };
  tasks.push(task);
  saveTasks(username, tasks);
  send(res, 201, task);
}

function handleCompleteTask(res, username, id) {
  const tasks = loadTasks(username);
  const task = tasks.find((t) => t.id === id);
  if (!task) return send(res, 404, { error: 'task not found' });
  task.done = true;
  saveTasks(username, tasks);
  send(res, 200, task);
}

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    const parts = pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && pathname === '/api/health') {
      return send(res, 200, { ok: true, service: 'local-tasks', multiUser: true });
    }
    if (req.method === 'POST' && pathname === '/api/signup') {
      return handleSignup(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/login') {
      return handleLogin(req, res);
    }

    const username = authenticate(req);
    if (!username) return send(res, 401, { error: 'authentication required' });

    if (req.method === 'GET' && pathname === '/api/tasks') {
      return handleListTasks(res, username);
    }
    if (req.method === 'POST' && pathname === '/api/tasks') {
      return handleAddTask(req, res, username);
    }
    if (
      req.method === 'POST' &&
      parts.length === 4 &&
      parts[0] === 'api' &&
      parts[1] === 'tasks' &&
      parts[3] === 'complete'
    ) {
      const id = Number(parts[2]);
      if (!Number.isInteger(id)) return send(res, 400, { error: 'invalid task id' });
      return handleCompleteTask(res, username, id);
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'internal server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`local-tasks server listening on http://${HOST}:${PORT}`);
  console.log(`data directory: ${DATA_DIR}`);
});
