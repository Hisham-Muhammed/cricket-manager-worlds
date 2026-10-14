'use strict';
/**
 * Local-mode API tests — Cricket Manager Worlds.
 *
 * These tests pin the game's trust rules, not just happy paths:
 *  - registration validation (6+ character password, duplicate email)
 *  - login rejects a wrong password
 *  - a password-protected world rejects a wrong password with exactly
 *    "Incorrect world password." (spec-required string)
 *  - joining a world starts with an EMPTY squad and the shared
 *    starting budget of 100 (₹100 Cr) — nobody gets a free squad
 *  - a club can only be taken once, and a manager can only join once
 *  - the world password hash is never exposed in API responses
 *
 * They run the real server (src/server.js) against a throwaway JSON
 * database (DATABASE env var), using Node's built-in test runner and
 * fetch — no extra dependencies. Run with: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3217;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

let server;
let serverLog = '';
let tmpDir;

async function waitForServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/server-time`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start in time:\n' + serverLog);
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmw-test-'));
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE: path.join(tmpDir, 'db.json'),
      DATABASE_MODE: 'local',
      SESSION_SECRET: 'test-secret',
      // Make sure no real Supabase project is touched by the tests.
      SUPABASE_URL: '',
      SUPABASE_ANON_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });
  await waitForServer();
});

after(() => {
  if (server) server.kill('SIGTERM');
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function req(pathname, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON response */ }
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const tokenCookie = setCookies.find(c => c.startsWith('token='));
  return { status: res.status, json, cookie: tokenCookie ? tokenCookie.split(';')[0] : null };
}

const MANAGER_A = { name: 'Asha Manager', email: 'asha@example.com', password: 'secret1' };
const MANAGER_B = { name: 'Basil Manager', email: 'basil@example.com', password: 'secret2' };
const WORLD_PASSWORD = 'worldpw123';

let cookieA;
let cookieB;
let worldId;

test('register rejects a password shorter than 6 characters (400)', async () => {
  const r = await req('/api/auth/register', {
    method: 'POST',
    body: { name: 'Shorty', email: 'shorty@example.com', password: 'abc12' },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /6\+ character password/);
});

test('register creates a manager and sets a session cookie', async () => {
  const r = await req('/api/auth/register', { method: 'POST', body: MANAGER_A });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.email, MANAGER_A.email);
  assert.ok(r.cookie && r.cookie.startsWith('token='), 'expected a token cookie');
  cookieA = r.cookie;
});

test('registering the same email twice is rejected (409)', async () => {
  const r = await req('/api/auth/register', { method: 'POST', body: MANAGER_A });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'An account with this email already exists.');
});

test('login with the wrong password is rejected (401)', async () => {
  const r = await req('/api/auth/login', {
    method: 'POST',
    body: { email: MANAGER_A.email, password: 'wrong-password' },
  });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'Invalid email or password.');
});

test('login with the correct password succeeds', async () => {
  const r = await req('/api/auth/login', {
    method: 'POST',
    body: { email: MANAGER_A.email, password: MANAGER_A.password },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.email, MANAGER_A.email);
});

test('protected routes reject requests without a session (401)', async () => {
  const r = await req('/api/auth/me');
  assert.equal(r.status, 401);
});

test('a second manager can create a password-protected world; the hash is never exposed', async () => {
  const reg = await req('/api/auth/register', { method: 'POST', body: MANAGER_B });
  assert.equal(reg.status, 200);
  cookieB = reg.cookie;

  const r = await req('/api/worlds', {
    method: 'POST',
    cookie: cookieB,
    body: { name: 'Test Premier League', numberOfClubs: 4, password: WORLD_PASSWORD },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.world.isPrivate, true);
  assert.ok(!('passwordHash' in r.json.world), 'password hash must never be exposed');
  assert.ok(!JSON.stringify(r.json).includes(WORLD_PASSWORD), 'world password must never be exposed');
  worldId = r.json.world.id;
});

test('joining with the wrong world password returns exactly "Incorrect world password." (403)', async () => {
  const r = await req(`/api/worlds/${worldId}/join`, {
    method: 'POST',
    cookie: cookieA,
    body: { clubName: 'Chennai Super Kings', password: 'not-the-password' },
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'Incorrect world password.');
});

test('joining with the correct password starts with an EMPTY squad and budget 100 (₹100 Cr)', async () => {
  const r = await req(`/api/worlds/${worldId}/join`, {
    method: 'POST',
    cookie: cookieA,
    body: { clubName: 'Chennai Super Kings', password: WORLD_PASSWORD },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.budget, 100);
  assert.deepEqual(r.json.squad, []);
  assert.deepEqual(r.json.membership.xi, []);
  assert.equal(r.json.membership.clubName, 'Chennai Super Kings');
});

test('a manager cannot join the same world twice (409)', async () => {
  const r = await req(`/api/worlds/${worldId}/join`, {
    method: 'POST',
    cookie: cookieA,
    body: { clubName: 'Mumbai Indians', password: WORLD_PASSWORD },
  });
  assert.equal(r.status, 409);
});

test('a club that is already taken cannot be taken again (409)', async () => {
  const r = await req(`/api/worlds/${worldId}/join`, {
    method: 'POST',
    cookie: cookieB,
    body: { clubName: 'Chennai Super Kings', password: WORLD_PASSWORD },
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'That club is already taken.');
});
