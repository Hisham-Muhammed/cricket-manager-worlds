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
const vm = require('node:vm');

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

async function req(pathname, { method = 'GET', body, cookie, headers } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON response */ }
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const tokenCookie = setCookies.find(c => c.startsWith('token='));
  return { status: res.status, json, cookie: tokenCookie ? tokenCookie.split(';')[0] : null, setCookies };
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

// ---------- AI managers, creator start, undisclosed bids, withdraw, guards ----------

const MANAGER_C = { name: 'Cira Creator', email: 'cira@example.com', password: 'secret3' };
const MANAGER_D = { name: 'Dev Manager', email: 'dev@example.com', password: 'secret4' };
let cookieC;
let cookieD;
let world2Id;
let targetAuction; // a cheap, low-rated auction the AI managers will not chase

async function startedWorld(creator, emailPrefix) {
  const reg = await req('/api/auth/register', { method: 'POST', body: creator });
  assert.equal(reg.status, 200);
  const create = await req('/api/worlds', { method: 'POST', cookie: reg.cookie, body: { name: `${emailPrefix} League`, numberOfClubs: 2 } });
  assert.equal(create.status, 201);
  const wid = create.json.world.id;
  const join = await req(`/api/worlds/${wid}/join`, { method: 'POST', cookie: reg.cookie, body: { clubName: 'Chennai Super Kings' } });
  assert.equal(join.status, 201);
  const start = await req(`/api/worlds/${wid}/start`, { method: 'POST', cookie: reg.cookie, body: {} });
  assert.equal(start.status, 200);
  assert.equal(start.json.world.state, 'AUCTION');
  return { cookie: reg.cookie, worldId: wid };
}

test('a non-creator cannot start a world (403)', async () => {
  const regC = await req('/api/auth/register', { method: 'POST', body: MANAGER_C });
  assert.equal(regC.status, 200); cookieC = regC.cookie;
  const regD = await req('/api/auth/register', { method: 'POST', body: MANAGER_D });
  assert.equal(regD.status, 200); cookieD = regD.cookie;

  const create = await req('/api/worlds', { method: 'POST', cookie: cookieC, body: { name: 'Start Test League', numberOfClubs: 4 } });
  assert.equal(create.status, 201);
  assert.equal(create.json.world.aiFill, true, 'aiFill defaults to true');
  world2Id = create.json.world.id;

  const byStranger = await req(`/api/worlds/${world2Id}/start`, { method: 'POST', cookie: cookieD, body: {} });
  assert.equal(byStranger.status, 403);

  const joinC = await req(`/api/worlds/${world2Id}/join`, { method: 'POST', cookie: cookieC, body: { clubName: 'Chennai Super Kings' } });
  assert.equal(joinC.status, 201);
  const joinD = await req(`/api/worlds/${world2Id}/join`, { method: 'POST', cookie: cookieD, body: { clubName: 'Mumbai Indians' } });
  assert.equal(joinD.status, 201);

  const byMember = await req(`/api/worlds/${world2Id}/start`, { method: 'POST', cookie: cookieD, body: {} });
  assert.equal(byMember.status, 403);
  assert.equal(byMember.json.error, 'Only the world creator can start this world.');
});

test('the creator can start a world below full — AI managers fill the empty clubs', async () => {
  const r = await req(`/api/worlds/${world2Id}/start`, { method: 'POST', cookie: cookieC, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.world.state, 'AUCTION');
  assert.equal(r.json.aiAdded, 2, 'two empty clubs should be filled by AI');
  assert.equal(r.json.managersCount, 4);

  const detail = await req(`/api/worlds/${world2Id}`, { cookie: cookieC });
  assert.equal(detail.json.members.length, 4);
  const aiMembers = detail.json.members.filter(m => m.ai);
  assert.equal(aiMembers.length, 2);
  assert.match(aiMembers[0].managerName, /^AI Manager — /);
  assert.ok(detail.json.members.every(m => m.budget === 100), 'AI memberships start with the same ₹100 Cr budget');

  const auction = await req(`/api/worlds/${world2Id}/auction`, { cookie: cookieC });
  assert.equal(auction.json.state, 'AUCTION');
  assert.equal(auction.json.auctions.length, 409, 'starting opens the full player pool');
  // Pick a cheap, low-rated target for the bid tests — the AI managers
  // chase high ratings, so they will not interfere with this auction.
  targetAuction = [...auction.json.auctions].sort((a, b) => a.player.rating - b.player.rating || a.baseValue - b.baseValue)[0];
  assert.ok(targetAuction.baseValue <= 0.5);
});

test('starting an already-started world is rejected (409)', async () => {
  const r = await req(`/api/worlds/${world2Id}/start`, { method: 'POST', cookie: cookieC, body: {} });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'This world has already started.');
});

test('an undisclosed bid is masked for other managers but visible to the bidder', async () => {
  const bid = await req(`/api/auctions/${targetAuction.auctionId}/bid`, {
    method: 'POST', cookie: cookieC, body: { amount: 1, undisclosed: true },
  });
  assert.equal(bid.status, 201);
  assert.equal(bid.json.bid.amount, 1, 'the bidder sees their own amount');
  assert.equal(bid.json.bid.undisclosed, true);

  const asOther = await req(`/api/worlds/${world2Id}/players/${targetAuction.worldPlayerId}`, { cookie: cookieD });
  assert.equal(asOther.status, 200);
  assert.equal(asOther.json.auction.currentPrice, 1, 'the current price stays public');
  assert.equal(asOther.json.auction.highestBidderClub, 'Undisclosed');
  assert.equal(asOther.json.auction.leaderUndisclosed, true);
  const hidden = asOther.json.bids.find(b => b.undisclosed);
  assert.ok(hidden, 'bid history should contain the undisclosed bid');
  assert.equal(hidden.amount, null, 'amount is masked for everyone but the bidder');
  assert.equal(hidden.managerName, 'Undisclosed');
  assert.equal(hidden.clubName, 'Undisclosed');

  const asBidder = await req(`/api/worlds/${world2Id}/players/${targetAuction.worldPlayerId}`, { cookie: cookieC });
  const own = asBidder.json.bids.find(b => b.mine);
  assert.equal(own.amount, 1);
  assert.equal(own.managerName, MANAGER_C.name);
  assert.equal(own.clubName, 'Chennai Super Kings');
});

test('withdrawing the leading bid recomputes the leader and price', async () => {
  const bid = await req(`/api/auctions/${targetAuction.auctionId}/bid`, {
    method: 'POST', cookie: cookieD, body: { amount: 2 },
  });
  assert.equal(bid.status, 201);

  const before = await req(`/api/worlds/${world2Id}/players/${targetAuction.worldPlayerId}`, { cookie: cookieC });
  assert.equal(before.json.auction.currentPrice, 2);
  assert.equal(before.json.auction.highestBidderClub, 'Mumbai Indians');

  const withdraw = await req(`/api/auctions/${targetAuction.auctionId}/withdraw`, { method: 'POST', cookie: cookieD, body: {} });
  assert.equal(withdraw.status, 200);
  assert.equal(withdraw.json.auction.currentPrice, 1, 'price falls back to the next bid');

  const after = await req(`/api/worlds/${world2Id}/players/${targetAuction.worldPlayerId}`, { cookie: cookieD });
  assert.equal(after.json.auction.highestBidderClub, 'Undisclosed', 'the undisclosed bid leads again, still masked');
  const withdrawn = after.json.bids.find(b => b.mine);
  assert.equal(withdrawn.status, 'WITHDRAWN');

  const again = await req(`/api/auctions/${targetAuction.auctionId}/withdraw`, { method: 'POST', cookie: cookieD, body: {} });
  assert.equal(again.status, 400);
  assert.equal(again.json.error, 'You have no bid on this auction to withdraw.');
});

test('the budget guard rejects a bid that would leave too little to complete an 18-player squad (400)', async () => {
  const { cookie, worldId: wid } = await startedWorld(
    { name: 'Farah Guard', email: 'farah@example.com', password: 'secret5' }, 'Guard');
  const auction = await req(`/api/worlds/${wid}/auction`, { cookie });
  const cheap = [...auction.json.auctions].sort((a, b) => a.baseValue - b.baseValue || a.player.rating - b.player.rating)[0];
  assert.equal(cheap.baseValue, 0.3, 'the IPL pool minimum base price is ₹0.3 Cr');

  // 95 + 17 more players × ₹0.3 Cr minimum = 100.1 > 100 budget
  const tooBig = await req(`/api/auctions/${cheap.auctionId}/bid`, { method: 'POST', cookie, body: { amount: 95 } });
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.json.error, /keep enough budget to complete a minimum 18-player squad/);

  // A sane bid on the same player is fine: 50 + 17 × 0.3 = 55.1 ≤ 100
  const ok = await req(`/api/auctions/${cheap.auctionId}/bid`, { method: 'POST', cookie, body: { amount: 50 } });
  assert.equal(ok.status, 201);
});

test('the squad cap rejects a bid that would take a manager past 25 leading players (400)', async () => {
  const { cookie, worldId: wid } = await startedWorld(
    { name: 'Eshan Cap', email: 'eshan@example.com', password: 'secret6' }, 'Cap');
  const auction = await req(`/api/worlds/${wid}/auction`, { cookie });
  const cheapest = [...auction.json.auctions]
    .sort((a, b) => a.baseValue - b.baseValue || a.player.rating - b.player.rating).slice(0, 26);
  assert.equal(cheapest.length, 26);
  for (const a of cheapest.slice(0, 25)) {
    const r = await req(`/api/auctions/${a.auctionId}/bid`, { method: 'POST', cookie, body: { amount: a.baseValue } });
    assert.equal(r.status, 201, `leading bid #${cheapest.indexOf(a) + 1} should be accepted`);
  }
  const overflow = await req(`/api/auctions/${cheapest[25].auctionId}/bid`, {
    method: 'POST', cookie, body: { amount: cheapest[25].baseValue },
  });
  assert.equal(overflow.status, 400);
  assert.equal(overflow.json.error, 'Squad is full (max 25 players).');
});

// ---------- real player photos (Wikimedia Commons manifest) ----------

test('manifest players return a real Commons photoUrl; non-manifest players return photoUrl null', async () => {
  const auction = await req(`/api/worlds/${world2Id}/auction`, { cookie: cookieC });
  assert.equal(auction.status, 200);

  const kohli = auction.json.auctions.find(a => a.player.name === 'Virat Kohli');
  assert.ok(kohli, 'Virat Kohli should be in the pool');
  assert.ok(kohli.player.photoUrl && kohli.player.photoUrl.includes('upload.wikimedia.org'),
    'Kohli should carry a real Wikimedia Commons photo URL');
  assert.ok(kohli.player.photoCredit, 'the photo credit should be present');
  assert.ok(kohli.player.photoPage && kohli.player.photoPage.includes('commons.wikimedia.org'),
    'the Commons file page should be present');

  const detail = await req(`/api/worlds/${world2Id}/players/${kohli.worldPlayerId}`, { cookie: cookieC });
  assert.equal(detail.status, 200);
  assert.ok(detail.json.player.photoUrl.includes('upload.wikimedia.org'),
    'the player detail response should carry the same photoUrl');

  const klaasen = auction.json.auctions.find(a => a.player.name === 'Heinrich Klaasen');
  assert.ok(klaasen, 'Heinrich Klaasen should be in the pool');
  assert.equal(klaasen.player.photoUrl, null, 'a player with no freely licensed Commons photo returns photoUrl null');
});

// ---------- bug-fix regressions (2026-10-14) ----------

const adminTick = () => req('/api/admin/tick', { method: 'POST', headers: { 'x-admin-key': 'test-secret' } });

test('bug 1: the AI defends its star after a human outbids it with an UNDISCLOSED bid', async () => {
  // Regression: the AI used to open ~2 new fronts per tick with no
  // commitment cap until its whole ₹100 Cr was committed (≈₹99.95 Cr
  // across ~18-20 star leads), after which validateBid rejected every
  // further bid and it could never respond on a contested auction
  // again — the user hit it right after placing an undisclosed bid.
  const { cookie, worldId: wid } = await startedWorld(
    { name: 'Gita Tick', email: 'gita@example.com', password: 'secret7' }, 'Tick');
  // Let the AI accumulate leads over several ticks first (the state in
  // which the freeze used to happen).
  for (let i = 0; i < 8; i++) assert.equal((await adminTick()).status, 200);

  const list = await req(`/api/worlds/${wid}/auction`, { cookie });
  const star = [...list.json.auctions].sort((a, b) => b.player.rating - a.player.rating)[0];
  assert.equal(star.player.name, 'Jasprit Bumrah');
  const before = await req(`/api/worlds/${wid}/players/${star.worldPlayerId}`, { cookie });
  assert.equal(before.json.auction.highestBidderClub, 'Mumbai Indians', 'the AI should be leading its top target');
  const price = before.json.auction.currentPrice;

  const humanBid = await req(`/api/auctions/${star.auctionId}/bid`, {
    method: 'POST', cookie, body: { amount: +(price + 1).toFixed(2), undisclosed: true },
  });
  assert.equal(humanBid.status, 201);

  for (let i = 0; i < 2; i++) assert.equal((await adminTick()).status, 200);

  const after = await req(`/api/worlds/${wid}/players/${star.worldPlayerId}`, { cookie });
  const aiCounter = after.json.bids.find(b => b.clubName === 'Mumbai Indians' && b.amount > price + 1);
  assert.ok(aiCounter, 'the AI must counter-bid on the auction after the undisclosed outbid');
  assert.equal(after.json.auction.currentPrice, aiCounter.amount);
  assert.equal(after.json.auction.highestBidderClub, 'Mumbai Indians');
});

test('bug 3 (server): the session cookie is long-lived — Max-Age 30 days, Path=/, HttpOnly', async () => {
  const r = await req('/api/auth/login', {
    method: 'POST', body: { email: MANAGER_A.email, password: MANAGER_A.password },
  });
  assert.equal(r.status, 200);
  const raw = r.setCookies.find(c => c.startsWith('token='));
  assert.ok(raw, 'login should set the token cookie');
  assert.match(raw, /Max-Age=2592000/, 'cookie must live 30 days, not just the browser session');
  assert.match(raw, /Path=\//);
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/i);
});

// Spawn a throwaway extra server (own DB file) for env-specific tests.
async function spawnExtraServer(port, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmw-extra-'));
  const srv = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATABASE: path.join(dir, 'db.json'),
      SESSION_SECRET: 'test-secret', SCHEDULER_INTERVAL_MS: '3600000', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/server-time`); if (r.ok) return { srv, dir }; }
    catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  srv.kill('SIGKILL');
  throw new Error('extra server did not start:\n' + log);
}

test('bug 2: local-mode Google redirect_uri is built from PUBLIC_URL (https) when GOOGLE_CALLBACK_URL is unset', async () => {
  const { srv, dir } = await spawnExtraServer(3221, {
    DATABASE_MODE: 'local', SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '',
    GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_CALLBACK_URL: '', PUBLIC_URL: 'https://game.example.test',
  });
  try {
    const res = await fetch('http://127.0.0.1:3221/api/auth/google', { redirect: 'manual' });
    assert.equal(res.status, 302);
    const loc = res.headers.get('location');
    assert.ok(loc.startsWith('https://accounts.google.com/'), 'should redirect to Google');
    assert.ok(decodeURIComponent(loc).includes('redirect_uri=https://game.example.test/api/auth/google/callback'),
      `redirect_uri should be the PUBLIC_URL callback, got: ${loc}`);
  } finally { srv.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bug 2: supabase-mode Google redirect_to uses PUBLIC_URL (https), not the http request origin', async () => {
  // Dummy Supabase URL on a dead local port: auth construction needs
  // no network, db.init() falls back to the local file by design.
  const { srv, dir } = await spawnExtraServer(3222, {
    DATABASE_MODE: 'supabase', SUPABASE_URL: 'http://127.0.0.1:9',
    SUPABASE_ANON_KEY: 'dummy-anon', SUPABASE_SERVICE_ROLE_KEY: 'dummy-service',
    PUBLIC_URL: 'https://cricket-manager-worlds.onrender.com',
  });
  try {
    const res = await fetch('http://127.0.0.1:3222/api/auth/google', { redirect: 'manual' });
    assert.equal(res.status, 302);
    const loc = res.headers.get('location');
    assert.ok(loc.includes('/auth/v1/authorize?provider=google'), `should redirect to Supabase authorize, got: ${loc}`);
    assert.ok(loc.includes('redirect_to=https%3A%2F%2Fcricket-manager-worlds.onrender.com%2F'),
      `redirect_to must be the https PUBLIC_URL root, got: ${loc}`);
    assert.ok(!loc.includes('redirect_to=http%3A'), 'redirect_to must not be http');
  } finally { srv.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bug 2: without PUBLIC_URL, the request origin honours X-Forwarded-Proto behind a proxy', async () => {
  const { srv, dir } = await spawnExtraServer(3223, {
    DATABASE_MODE: 'supabase', SUPABASE_URL: 'http://127.0.0.1:9',
    SUPABASE_ANON_KEY: 'dummy-anon', SUPABASE_SERVICE_ROLE_KEY: 'dummy-service',
    PUBLIC_URL: '',
  });
  try {
    const res = await fetch('http://127.0.0.1:3223/api/auth/google', {
      redirect: 'manual', headers: { 'x-forwarded-proto': 'https' },
    });
    assert.equal(res.status, 302);
    const loc = res.headers.get('location');
    assert.ok(decodeURIComponent(loc).includes('redirect_to=https://127.0.0.1:3223/'),
      `redirect_to should be https via the forwarded proto, got: ${loc}`);
  } finally { srv.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bug 3 (SPA): nav persistence helpers round-trip the saved view/world/player and survive corrupt data', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const start = src.indexOf('// [nav-persistence:start]');
  const end = src.indexOf('// [nav-persistence:end]');
  assert.ok(start >= 0 && end > start, 'the nav-persistence block should exist in app.js');
  const block = src.slice(start, end);
  const store = new Map();
  const sandbox = {
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    tab: 'Player', worldId: 'world_abc', playerPid: 'wp_123', backTab: 'Auction', focusPid: 'wp_123',
  };
  vm.runInNewContext(`${block}\nthis.__nav = { saveNav, loadNav, clearNav };`, sandbox);
  sandbox.__nav.saveNav();
  // JSON round-trip: the vm realm's objects fail strict prototype checks.
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.__nav.loadNav())),
    { tab: 'Player', worldId: 'world_abc', playerPid: 'wp_123', backTab: 'Auction', focusPid: 'wp_123' },
    'a refresh should restore the same screen, world and player page');
  store.set('cmw.nav.v1', '{corrupt json');
  assert.equal(sandbox.__nav.loadNav(), null, 'corrupt saved state must fall back to null (-> Lobby)');
  sandbox.__nav.saveNav();
  sandbox.__nav.clearNav();
  assert.equal(sandbox.__nav.loadNav(), null, 'logout clears the saved view');
});

test('bug 3 (server): a session cookie stays valid across a server restart (stateless JWT)', async () => {
  // A second instance over the SAME database file + session secret —
  // the "restart" — must accept the cookie issued by the first.
  const { srv, dir } = await (async () => {
    const s = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: '3219', DATABASE: path.join(tmpDir, 'db.json'),
        DATABASE_MODE: 'local', SESSION_SECRET: 'test-secret',
        SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '',
        SCHEDULER_INTERVAL_MS: '3600000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const deadline = Date.now() + 20000;
    for (;;) {
      try { const r = await fetch('http://127.0.0.1:3219/api/server-time'); if (r.ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) { s.kill('SIGKILL'); throw new Error('restart instance did not start'); }
      await new Promise(r => setTimeout(r, 250));
    }
    return { srv: s, dir: null };
  })();
  try {
    const r = await fetch('http://127.0.0.1:3219/api/auth/me', { headers: { Cookie: cookieA } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.user.email, MANAGER_A.email);
  } finally { srv.kill('SIGKILL'); if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
});
