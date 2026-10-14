'use strict';
/**
 * Supabase-mode email OTP confirmation tests — Cricket Manager Worlds.
 *
 * Boots the real server in DATABASE_MODE=supabase against a local MOCK
 * of the Supabase endpoints the app actually calls (GoTrue auth +
 * PostgREST for public.managers / public.app_state) — the same stubbing
 * approach as the earlier supabase-mode smoke tests, so no real project
 * is ever touched. The mock:
 *  - issues a fixed OTP code (OTP_CODE below) via POST /auth/v1/otp and
 *    checks it at POST /auth/v1/verify (type "email"), confirming the
 *    auth user's email on success, exactly like GoTrue;
 *  - enforces "Confirm email" at password sign-in (unconfirmed users
 *    get email_not_confirmed) — a test can flip `requireConfirm` off to
 *    exercise the app's own profile-flag gate instead;
 *  - serves public.managers through PostgREST semantics (eq filters,
 *    object+json single rows, PGRST116 for empty singles).
 *
 * Pins the OTP trust rules: no session before verification, wrong code
 * 401, unverified login 403 needsOtp (both gate layers), verified
 * duplicate 409, unverified re-register proceeds, resend never leaks
 * account existence, Google profiles are verified by default.
 * Run with: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const APP_PORT = 3317;
const MOCK_PORT = 3417;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const ROOT = path.join(__dirname, '..');
const OTP_CODE = '123456';

// ---------------- mock Supabase ----------------
function createMockSupabase() {
  const state = {
    usersById: new Map(), usersByEmail: new Map(),
    managers: [], otps: new Map(), sessions: new Map(), appState: null,
    requireConfirm: true, // GoTrue "Confirm email" ON behaviour
  };
  const pubUser = u => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
    email_confirmed_at: u.email_confirmed_at, user_metadata: u.user_metadata || {},
    app_metadata: u.app_metadata || { provider: 'email', providers: ['email'] },
    created_at: u.created_at, updated_at: u.created_at });
  const newSession = u => { const t = 'tok_' + crypto.randomUUID(); state.sessions.set(t, u.id);
    return { access_token: t, token_type: 'bearer', expires_in: 3600, refresh_token: 'ref_' + crypto.randomUUID(), user: pubUser(u) }; };
  const sendJson = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  const readBody = req => new Promise(resolve => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });
  const matches = (row, params) => [...params.entries()].every(([k, v]) => !v.startsWith('eq.') || String(row[k]) === v.slice(3));

  async function handle(req, res) {
    const url = new URL(req.url, 'http://mock');
    const p = url.pathname;
    // ---- GoTrue (auth) ----
    if (p === '/auth/v1/admin/users' && req.method === 'POST') {
      const b = await readBody(req);
      if (state.usersByEmail.has(b.email)) return sendJson(res, 422, { code: 'email_exists', msg: 'User already registered' });
      const u = { id: crypto.randomUUID(), email: b.email, password: b.password,
        email_confirmed_at: b.email_confirm ? new Date().toISOString() : null,
        user_metadata: b.user_metadata || {}, app_metadata: { provider: 'email', providers: ['email'] },
        created_at: new Date().toISOString() };
      state.usersById.set(u.id, u); state.usersByEmail.set(u.email, u);
      return sendJson(res, 200, pubUser(u));
    }
    const adminUser = p.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/);
    if (adminUser && req.method === 'PUT') {
      const u = state.usersById.get(adminUser[1]);
      if (!u) return sendJson(res, 404, { msg: 'User not found' });
      const b = await readBody(req);
      if (b.password) u.password = b.password;
      if (b.user_metadata) u.user_metadata = b.user_metadata;
      return sendJson(res, 200, pubUser(u));
    }
    if (adminUser && req.method === 'GET') {
      const u = state.usersById.get(adminUser[1]);
      return u ? sendJson(res, 200, pubUser(u)) : sendJson(res, 404, { msg: 'User not found' });
    }
    if (p === '/auth/v1/token' && req.method === 'POST') {
      const b = await readBody(req);
      const u = state.usersByEmail.get(b.email);
      if (!u || u.password !== b.password) return sendJson(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      if (state.requireConfirm && !u.email_confirmed_at) return sendJson(res, 400, { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
      return sendJson(res, 200, newSession(u));
    }
    if (p === '/auth/v1/otp' && req.method === 'POST') {
      const b = await readBody(req);
      if (state.usersByEmail.has(b.email) || b.create_user) state.otps.set(b.email, OTP_CODE);
      return sendJson(res, 200, {});
    }
    if (p === '/auth/v1/verify' && req.method === 'POST') {
      const b = await readBody(req);
      const u = state.usersByEmail.get(b.email);
      if (!u || state.otps.get(b.email) !== String(b.token)) return sendJson(res, 401, { code: 401, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
      state.otps.delete(b.email);
      u.email_confirmed_at = new Date().toISOString();
      return sendJson(res, 200, newSession(u));
    }
    if (p === '/auth/v1/user' && req.method === 'GET') {
      const uid = state.sessions.get((req.headers.authorization || '').replace('Bearer ', ''));
      const u = uid && state.usersById.get(uid);
      return u ? sendJson(res, 200, pubUser(u)) : sendJson(res, 401, { msg: 'Invalid token' });
    }
    // ---- PostgREST ----
    if (p === '/rest/v1/managers') {
      const wantObject = (req.headers.accept || '').includes('application/vnd.pgrst.object+json');
      if (req.method === 'GET') {
        const rows = state.managers.filter(r => matches(r, url.searchParams));
        if (wantObject) {
          if (rows.length === 1) return sendJson(res, 200, rows[0]);
          return sendJson(res, 406, { code: 'PGRST116', details: `The result contains ${rows.length} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' });
        }
        return sendJson(res, 200, rows);
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const row = { id: crypto.randomUUID(), profile_image: '', stats: { matchesManaged: 0, wins: 0, auctionsWon: 0 },
          trophies: [], history: [], created_at: new Date().toISOString(), ...b };
        state.managers.push(row);
        return sendJson(res, 201, wantObject ? row : [row]);
      }
      if (req.method === 'PATCH') {
        const b = await readBody(req);
        const rows = state.managers.filter(r => matches(r, url.searchParams));
        rows.forEach(r => Object.assign(r, b));
        return sendJson(res, 200, wantObject ? (rows[0] || null) : rows);
      }
    }
    if (p === '/rest/v1/app_state') {
      if (req.method === 'GET') return sendJson(res, 200, state.appState ? [{ id: 1, state: state.appState }] : []);
      if (req.method === 'POST') { const b = await readBody(req); state.appState = b.state; return sendJson(res, 201, []); }
    }
    return sendJson(res, 404, { msg: 'mock: unhandled ' + req.method + ' ' + p });
  }
  const server = http.createServer((req, res) => { handle(req, res).catch(e => sendJson(res, 500, { msg: String((e && e.message) || e) })); });
  return { server, state };
}

// ---------------- app server under test ----------------
let appServer, appLog = '', tmpDir, mock;

before(async () => {
  mock = createMockSupabase();
  await new Promise(r => mock.server.listen(MOCK_PORT, '127.0.0.1', r));
  // Pre-seed a Google auth user + a live session token for it, so the
  // /api/auth/google/session test can verify the token the way the SPA
  // hands over the Supabase OAuth access token.
  const g = { id: crypto.randomUUID(), email: 'goog.otp@example.com', password: null,
    email_confirmed_at: new Date().toISOString(), user_metadata: { name: 'Goog Manager', picture: '' },
    app_metadata: { provider: 'google', providers: ['google'] }, created_at: new Date().toISOString() };
  mock.state.usersById.set(g.id, g); mock.state.usersByEmail.set(g.email, g);
  mock.state.sessions.set('google-access-token', g.id);

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmw-otp-'));
  appServer = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), DATABASE: path.join(tmpDir, 'db.json'),
      DATABASE_MODE: 'supabase', SESSION_SECRET: 'test-secret', SCHEDULER_INTERVAL_MS: '3600000',
      SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`, SUPABASE_ANON_KEY: 'mock-anon', SUPABASE_SERVICE_ROLE_KEY: 'mock-service',
      PUBLIC_URL: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_CALLBACK_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  appServer.stdout.on('data', d => { appLog += d; });
  appServer.stderr.on('data', d => { appLog += d; });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/api/server-time`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('supabase-mode server did not start in time:\n' + appLog);
});

after(() => {
  if (appServer) appServer.kill('SIGTERM');
  if (mock) mock.server.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function req(pathname, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const tokenCookie = setCookies.find(c => c.startsWith('token='));
  return { status: res.status, json, cookie: tokenCookie ? tokenCookie.split(';')[0] : null };
}

const OTP_USER = { name: 'Otp Manager', email: 'otp.user@example.com', password: 'secret1' };

test('otp: register returns 201 needsOtp, creates an unverified profile and NO session', async () => {
  const r = await req('/api/auth/register', { method: 'POST', body: OTP_USER });
  assert.equal(r.status, 201);
  assert.equal(r.json.needsOtp, true);
  assert.equal(r.json.email, OTP_USER.email);
  assert.equal(r.cookie, null, 'no session may be issued before verification');
  const row = mock.state.managers.find(m => m.email === OTP_USER.email);
  assert.ok(row, 'managers profile was created');
  assert.equal(row.email_verified, false, 'profile starts unverified');
  assert.equal(mock.state.otps.get(OTP_USER.email), OTP_CODE, 'an OTP email was triggered via Supabase');
});

test('otp: login before verification is gated — 403 needsOtp, no cookie (Supabase "email not confirmed")', async () => {
  const r = await req('/api/auth/login', { method: 'POST', body: { email: OTP_USER.email, password: OTP_USER.password } });
  assert.equal(r.status, 403);
  assert.equal(r.json.needsOtp, true);
  assert.equal(r.json.email, OTP_USER.email);
  assert.equal(r.cookie, null);
});

test('otp: the profile-flag gate also holds when Supabase lets the password sign-in through', async () => {
  mock.state.requireConfirm = false; // project with "Confirm email" OFF
  try {
    const r = await req('/api/auth/login', { method: 'POST', body: { email: OTP_USER.email, password: OTP_USER.password } });
    assert.equal(r.status, 403);
    assert.equal(r.json.needsOtp, true);
    assert.equal(r.cookie, null);
  } finally { mock.state.requireConfirm = true; }
});

test('otp: a wrong code is rejected 401 with the clean message and nothing changes', async () => {
  const r = await req('/api/auth/verify-otp', { method: 'POST', body: { email: OTP_USER.email, code: '999999' } });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'Invalid or expired code.');
  assert.equal(r.cookie, null);
  assert.equal(mock.state.managers.find(m => m.email === OTP_USER.email).email_verified, false);
});

test('otp: the correct code verifies, flips email_verified and issues the session', async () => {
  const r = await req('/api/auth/verify-otp', { method: 'POST', body: { email: OTP_USER.email, code: mock.state.otps.get(OTP_USER.email) } });
  assert.equal(r.status, 200);
  assert.ok(r.cookie && r.cookie.startsWith('token='), 'session cookie issued after verification');
  assert.equal(r.json.user.email, OTP_USER.email);
  assert.equal(r.json.user.emailVerified, true);
  assert.equal(mock.state.managers.find(m => m.email === OTP_USER.email).email_verified, true);
  const me = await req('/api/auth/me', { cookie: r.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, OTP_USER.email);
});

test('otp: login after verification succeeds normally', async () => {
  const r = await req('/api/auth/login', { method: 'POST', body: { email: OTP_USER.email, password: OTP_USER.password } });
  assert.equal(r.status, 200);
  assert.ok(r.cookie && r.cookie.startsWith('token='));
  assert.equal(r.json.user.emailVerified, true);
});

test('otp: registering an already-verified email is 409 with the login hint', async () => {
  const r = await req('/api/auth/register', { method: 'POST', body: OTP_USER });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'Account already exists — please log in.');
});

test('otp: re-registering an UNVERIFIED email refreshes the password and sends a fresh code', async () => {
  const u2 = { name: 'Second Try', email: 'otp.retry@example.com', password: 'firstpw1' };
  let r = await req('/api/auth/register', { method: 'POST', body: u2 });
  assert.equal(r.status, 201);
  assert.equal(r.json.needsOtp, true);
  r = await req('/api/auth/register', { method: 'POST', body: { ...u2, password: 'secondpw2' } });
  assert.equal(r.status, 201, 'unverified re-register proceeds instead of 409');
  assert.equal(r.json.needsOtp, true);
  assert.equal(mock.state.otps.get(u2.email), OTP_CODE, 'a fresh code was issued');
  r = await req('/api/auth/verify-otp', { method: 'POST', body: { email: u2.email, code: OTP_CODE } });
  assert.equal(r.status, 200);
  r = await req('/api/auth/login', { method: 'POST', body: { email: u2.email, password: 'firstpw1' } });
  assert.equal(r.status, 401, 'the old password no longer works');
  r = await req('/api/auth/login', { method: 'POST', body: { email: u2.email, password: 'secondpw2' } });
  assert.equal(r.status, 200, 'the refreshed password works');
});

test('otp: resend is a generic 200 for unknown and verified emails alike, and re-issues for unverified ones', async () => {
  let r = await req('/api/auth/resend-otp', { method: 'POST', body: { email: 'ghost@example.com' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(mock.state.otps.has('ghost@example.com'), false, 'no code is conjured for unknown accounts');
  const u3 = { name: 'Resend Me', email: 'otp.resend@example.com', password: 'secret3' };
  await req('/api/auth/register', { method: 'POST', body: u3 });
  mock.state.otps.delete(u3.email); // pretend the first email was lost
  r = await req('/api/auth/resend-otp', { method: 'POST', body: { email: u3.email } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(mock.state.otps.get(u3.email), OTP_CODE, 'resend re-issues a code for the unverified profile');
  r = await req('/api/auth/resend-otp', { method: 'POST', body: { email: OTP_USER.email } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true }, 'verified accounts get the identical generic response');
});

test('otp: Google-created profiles are verified by default — session immediately, no OTP gate', async () => {
  const r = await req('/api/auth/google/session', { method: 'POST', body: { accessToken: 'google-access-token' } });
  assert.equal(r.status, 200);
  assert.ok(r.cookie && r.cookie.startsWith('token='), 'Google sign-in issues a session immediately');
  assert.equal(r.json.user.emailVerified, true);
  const row = mock.state.managers.find(m => m.email === 'goog.otp@example.com');
  assert.ok(row, 'profile was created');
  assert.equal(row.email_verified, true);
});
