'use strict';
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const { load, save, init, id, nowISO, emit, notify, news } = require('./db');
const PLAYERS = require('./players');
// Real player photos: src/photos.json maps exact player names to
// verified Wikimedia Commons photos (free licenses). Loaded server-side
// only — never served as a route. A missing file simply means no photos.
let PHOTOS = {};
try { PHOTOS = require('./photos.json'); } catch { PHOTOS = {}; }
const { startScheduler, tick, startWorld } = require('./scheduler');
const { topBid, validBids, validateBid, placeBid } = require('./bids');
const { defaultTactics, withDefaults, validateTactics, PITCHES } = require('./tactics');
const { fixturePitch } = require('./matchEngine');
const supa = require('./supabase');

const SECRET = process.env.SESSION_SECRET || 'dev-only-change-me';
// Public origin of the site (scheme + host, no trailing slash) for
// building URLs that leave the server (OAuth redirects). PUBLIC_URL
// wins when set; otherwise the origin is derived from the request,
// which is https-correct behind a TLS-terminating proxy thanks to
// 'trust proxy' below. (Bug: the Supabase redirect_to used to be built
// from req.protocol alone, which is 'http' behind Render's proxy, so
// Google sign-in redirected to http://…onrender.com/ .)
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const publicOrigin = req => PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
const googleCallbackUrl = () => process.env.GOOGLE_CALLBACK_URL
  || (PUBLIC_URL ? `${PUBLIC_URL}/api/auth/google/callback` : 'http://localhost:3000/api/auth/google/callback');
// Session cookie attributes, shared by every login path. The JWT
// itself is stateless with a 30-day expiry, so sessions survive
// server restarts in both modes — the cookie must be just as
// long-lived: an explicit Path=/ and a 30-day Max-Age (a bare session
// cookie would vanish with the browser session and "log the user
// out" on refresh/reopen).
const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 864e5 };
const CLUBS = ['Chennai Super Kings','Mumbai Indians','Royal Challengers Bengaluru','Kolkata Knight Riders','Rajasthan Royals','Sunrisers Hyderabad','Delhi Capitals','Punjab Kings','Lucknow Super Giants','Gujarat Titans']; // the original IPL franchises
const START_BUDGET = 100;

const app = express();
app.set('trust proxy', true); // hosts (Render/Railway) terminate TLS and proxy http — honour X-Forwarded-Proto/Host
app.use(express.json()); app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- auth helpers ----------
function sign(u) { return jwt.sign({ uid: u.id }, SECRET, { expiresIn: '30d' }); }

// Supabase mode (migration step 1): Supabase Auth is the identity
// provider and public.managers is the game profile, linked 1:1 by
// auth_user_id. The app session is still our own JWT cookie whose uid
// is the managers.id, so every route below sees the same req.user
// shape in both modes. Without full Supabase config the server falls
// back to the local store, exactly as before.
const SUPA_AUTH = supa.mode() === 'supabase' && supa.isConfigured() && !!supa.getAnonClient();
const managerToUser = m => ({ id: m.id, authUserId: m.auth_user_id, name: m.name, email: m.email, provider: m.provider,
  profileImage: m.profile_image || '', stats: m.stats, trophies: m.trophies, history: m.history, createdAt: m.created_at });
async function getManagerById(admin, managerId) {
  const { data } = await admin.from('managers').select('*').eq('id', managerId).maybeSingle();
  return data || null;
}
async function ensureManager(admin, authUser, provider) {
  const { data: linked } = await admin.from('managers').select('*').eq('auth_user_id', authUser.id).maybeSingle();
  if (linked) return linked;
  const email = authUser.email;
  if (email) {
    const { data: byEmail } = await admin.from('managers').select('*').eq('email', email).maybeSingle();
    if (byEmail) { // link an existing profile to this auth identity
      const { data, error } = await admin.from('managers').update({ auth_user_id: authUser.id }).eq('id', byEmail.id).select('*').single();
      if (error) throw error;
      return data;
    }
  }
  const meta = authUser.user_metadata || {};
  const { data, error } = await admin.from('managers').insert({
    auth_user_id: authUser.id, name: meta.name || meta.full_name || email, email,
    provider: provider || (authUser.app_metadata && authUser.app_metadata.provider) || 'email',
    profile_image: meta.picture || meta.avatar_url || ''
  }).select('*').single();
  if (error) throw error;
  return data;
}
async function auth(req, res, next) {
  const t = req.cookies.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!t) return res.status(401).json({ error: 'Not logged in.' });
  let payload;
  try { payload = jwt.verify(t, SECRET); } catch { return res.status(401).json({ error: 'Session expired.' }); }
  try {
    if (SUPA_AUTH) {
      const m = await getManagerById(supa.getServiceClient(), payload.uid);
      if (!m) return res.status(401).json({ error: 'Not logged in.' });
      req.user = managerToUser(m);
    } else {
      req.user = load().users.find(u => u.id === payload.uid);
      if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
    }
  } catch { return res.status(503).json({ error: 'Auth service unavailable.' }); }
  next();
}
const pubUser = (db, u) => ({ id: u.id, name: u.name, email: u.email, provider: u.provider, profileImage: u.profileImage || '',
  joinedWorlds: db.memberships.filter(m => m.userId === u.id).map(m => m.worldId),
  createdWorlds: db.worlds.filter(w => w.creatorId === u.id).map(w => w.id),
  currentClub: (db.memberships.find(m => m.userId === u.id) || {}).clubName || null,
  stats: u.stats, trophies: u.trophies, history: u.history, createdAt: u.createdAt });
const memberOf = (db, worldId, userId) => db.memberships.find(m => m.worldId === worldId && m.userId === userId);
const tpl = wp => PLAYERS.find(p => p.id === wp.templateId) || {};
// Photo fields for a player template: real Commons photo + attribution
// when the manifest has the player's exact name, nulls otherwise (the
// client then falls back to generated role artwork / initials).
const photoFields = t => { const e = t && PHOTOS[t.name];
  return e ? { photoUrl: e.photoUrl || null, photoCredit: e.credit || null, photoLicense: e.license || null, photoPage: e.filePage || null }
           : { photoUrl: null, photoCredit: null, photoLicense: null, photoPage: null }; };

// ---------- auth routes ----------
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password || password.length < 6) return res.status(400).json({ error: 'Name, email and a 6+ character password are required.' });
  if (SUPA_AUTH) {
    try {
      const admin = supa.getServiceClient();
      const normEmail = String(email).toLowerCase();
      const { data: existing } = await admin.from('managers').select('id').eq('email', normEmail).maybeSingle();
      if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });
      const { data: created, error } = await admin.auth.admin.createUser({ email: normEmail, password, email_confirm: true, user_metadata: { name } });
      if (error) {
        if (/already|exists|registered/i.test(error.message || '')) return res.status(409).json({ error: 'An account with this email already exists.' });
        return res.status(502).json({ error: 'Could not create the account. Please try again.' });
      }
      const { data: m, error: insErr } = await admin.from('managers')
        .insert({ auth_user_id: created.user.id, name, email: normEmail, provider: 'email' }).select('*').single();
      if (insErr) return res.status(502).json({ error: 'Could not create the account. Please try again.' });
      const u = managerToUser(m);
      return res.cookie('token', sign(u), COOKIE_OPTS).json({ user: pubUser(load(), u), serverNow: nowISO() });
    } catch { return res.status(503).json({ error: 'Auth service unavailable.' }); }
  }
  const db = load();
  if (db.users.some(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: 'An account with this email already exists.' });
  const u = { id: id('mgr'), name, email, passwordHash: bcrypt.hashSync(password, 12), provider: 'email', profileImage: '', createdAt: nowISO(),
    stats: { matchesManaged: 0, wins: 0, auctionsWon: 0 }, trophies: [], history: [] };
  db.users.push(u); save();
  res.cookie('token', sign(u), COOKIE_OPTS).json({ user: pubUser(db, u), serverNow: nowISO() });
});
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (SUPA_AUTH) {
    try {
      const anon = supa.getAnonClient();
      const { data, error } = await anon.auth.signInWithPassword({ email: String(email || ''), password: password || '' });
      if (error || !data || !data.user) return res.status(401).json({ error: 'Invalid email or password.' });
      const m = await ensureManager(supa.getServiceClient(), data.user, 'email');
      const u = managerToUser(m);
      return res.cookie('token', sign(u), COOKIE_OPTS).json({ user: pubUser(load(), u), serverNow: nowISO() });
    } catch { return res.status(503).json({ error: 'Auth service unavailable.' }); }
  }
  const db = load();
  const u = db.users.find(x => x.email.toLowerCase() === String(email || '').toLowerCase());
  if (!u || u.ai || !u.passwordHash || !bcrypt.compareSync(password || '', u.passwordHash)) return res.status(401).json({ error: 'Invalid email or password.' }); // AI managers can never sign in
  res.cookie('token', sign(u), COOKIE_OPTS).json({ user: pubUser(db, u), serverNow: nowISO() });
});
app.post('/api/auth/logout', (req, res) => res.clearCookie('token', { path: '/' }).json({ ok: true }));
app.get('/api/auth/me', auth, (req, res) => { const db = load();
  db.memberships.filter(m => m.userId === req.user.id).forEach(m => m.lastSeenAt = nowISO()); save();
  res.json({ user: pubUser(db, req.user), serverNow: nowISO() }); });

// Google OAuth — real flow; without credentials it says so, it never fake-logs-in.
app.get('/api/auth/google', (req, res) => {
  if (SUPA_AUTH) {
    // Identity via Supabase Auth (Google provider is enabled there). It
    // redirects back to the site root with the session in the URL hash;
    // public/app.js hands the access token to the session route below,
    // which verifies it and links/creates the manager profile.
    const redirectTo = `${publicOrigin(req)}/`;
    return res.redirect(`${process.env.SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`);
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)
    return res.status(501).send('Google OAuth needs configuration: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see README / .env.example), then restart the server. Email login works without it.');
  const p = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: googleCallbackUrl(),
    response_type: 'code', scope: 'openid email profile', access_type: 'offline', prompt: 'select_account' });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + p);
});
app.post('/api/auth/google/session', async (req, res) => {
  // Supabase mode only: the token comes from the Supabase OAuth redirect
  // (URL hash, forwarded by the frontend). It is verified against
  // Supabase Auth here — a bare name/email is never trusted.
  if (!SUPA_AUTH) return res.status(404).json({ error: 'Not available in local mode.' });
  const accessToken = (req.body || {}).accessToken;
  if (!accessToken) return res.status(400).json({ error: 'Missing access token.' });
  try {
    const admin = supa.getServiceClient();
    const { data, error } = await admin.auth.getUser(accessToken);
    if (error || !data || !data.user || !data.user.email) return res.status(401).json({ error: 'Google sign-in failed.' });
    const m = await ensureManager(admin, data.user, 'google');
    const u = managerToUser(m);
    return res.cookie('token', sign(u), COOKIE_OPTS).json({ user: pubUser(load(), u), serverNow: nowISO() });
  } catch { return res.status(503).json({ error: 'Auth service unavailable.' }); }
});
app.get('/api/auth/google/callback', async (req, res) => {
  try {
    if (!req.query.code) throw new Error('no code');
    const tok = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: req.query.code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleCallbackUrl(), grant_type: 'authorization_code' }) })).json();
    const info = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + tok.access_token } })).json();
    if (!info.email) throw new Error('no email');
    const db = load(); let u = db.users.find(x => x.email.toLowerCase() === info.email.toLowerCase());
    if (!u) { u = { id: id('mgr'), name: info.name || info.email, email: info.email, passwordHash: null, provider: 'google', profileImage: info.picture || '', createdAt: nowISO(), stats: { matchesManaged: 0, wins: 0, auctionsWon: 0 }, trophies: [], history: [] }; db.users.push(u); save(); }
    res.cookie('token', sign(u), COOKIE_OPTS).redirect('/');
  } catch { res.status(502).send('Google sign-in failed. Check OAuth credentials / redirect URI in .env.'); }
});

// ---------- worlds ----------
const pubWorld = (db, w, userId) => ({ id: w.id, name: w.name, description: w.description, creatorId: w.creatorId,
  creatorName: (db.users.find(u => u.id === w.creatorId) || {}).name || '', numberOfClubs: w.numberOfClubs,
  managersCount: db.memberships.filter(m => m.worldId === w.id).length, status: w.state, state: w.state,
  startDate: w.startDate, auctionStartAt: w.auctionStartAt, seasonStartAt: w.seasonStartAt, format: w.format,
  competitionStructure: w.competitionStructure, matchIntervalDays: w.matchIntervalDays, matchTime: w.matchTime,
  timezone: w.timezone, seasonLength: w.seasonLength, isPrivate: !!w.passwordHash, aiFill: w.aiFill !== false,
  joined: userId ? !!memberOf(db, w.id, userId) : false, serverNow: nowISO() });

app.get('/api/worlds', auth, (req, res) => { const db = load(); res.json({ worlds: db.worlds.map(w => pubWorld(db, w, req.user.id)), serverNow: nowISO() }); });
app.post('/api/worlds', auth, (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'World name is required.' });
  const db = load();
  const start = b.startDate ? new Date(b.startDate) : new Date(Date.now() + 24 * 3600 * 1000);
  const w = { id: id('world'), name: b.name, description: b.description || '', creatorId: req.user.id,
    numberOfClubs: Math.min(CLUBS.length, Math.max(2, parseInt(b.numberOfClubs || 10, 10))),
    format: b.format || 'League (Home & Away)', competitionStructure: b.competitionStructure || 'Round-robin league',
    matchIntervalDays: Math.min(7, Math.max(1, parseInt(b.matchIntervalDays || 3, 10))), matchTime: b.matchTime || '20:00',
    timezone: b.timezone || 'Asia/Kolkata', seasonLength: b.seasonLength || '1 season',
    auctionSettings: b.auctionSettings || { durationHours: 24, startingBudget: START_BUDGET },
    startDate: start.toISOString(), auctionStartAt: (b.auctionStartAt ? new Date(b.auctionStartAt) : new Date(start.getTime() + 24 * 3600 * 1000)).toISOString(),
    seasonStartAt: (b.seasonStartAt ? new Date(b.seasonStartAt) : new Date(start.getTime() + 4 * 24 * 3600 * 1000)).toISOString(),
    passwordHash: b.password ? bcrypt.hashSync(b.password, 12) : null, // hashed, never returned
    aiFill: b.aiFill !== false, // empty clubs are filled with AI managers when the creator starts the world
    state: 'RECRUITING', createdAt: nowISO() };
  db.worlds.push(w); emit(db, w.id, 'WORLD_CREATED', { name: w.name }); save();
  res.status(201).json({ world: pubWorld(db, w, req.user.id) });
});
app.get('/api/worlds/:id', auth, (req, res) => { const db = load(); const w = db.worlds.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'World not found.' });
  const taken = db.memberships.filter(m => m.worldId === w.id).map(m => m.clubName);
  res.json({ world: pubWorld(db, w, req.user.id),
    availableClubs: CLUBS.slice(0, w.numberOfClubs).filter(c => !taken.includes(c)),
    members: db.memberships.filter(m => m.worldId === w.id).map(m => ({ clubName: m.clubName, managerName: (db.users.find(u => u.id === m.userId) || {}).name || '', budget: m.budget, ai: !!m.ai })),
    myMembership: memberOf(db, w.id, req.user.id) || null, serverNow: nowISO() }); });

app.post('/api/worlds/:id/join', auth, (req, res) => {
  const db = load(); const w = db.worlds.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'World not found.' });
  if (memberOf(db, w.id, req.user.id)) return res.status(409).json({ error: 'You have already joined this world.' });
  if (w.passwordHash && !bcrypt.compareSync((req.body || {}).password || '', w.passwordHash))
    return res.status(403).json({ error: 'Incorrect world password.' }); // exact message required by spec
  const clubName = (req.body || {}).clubName;
  const taken = db.memberships.filter(m => m.worldId === w.id);
  if (taken.length >= w.numberOfClubs) return res.status(409).json({ error: 'This world is full.' });
  if (!CLUBS.slice(0, w.numberOfClubs).includes(clubName)) return res.status(400).json({ error: 'Select an available club from the list.' });
  if (taken.some(m => m.clubName === clubName)) return res.status(409).json({ error: 'That club is already taken.' });
  const m = { id: id('mem'), worldId: w.id, userId: req.user.id, clubName, budget: START_BUDGET, // NO initial squad
    xi: [], tactics: defaultTactics(), captainId: null, viceCaptainId: null, joinedAt: nowISO(), lastSeenAt: nowISO() };
  db.memberships.push(m);
  db.league.push({ id: id('lg'), worldId: w.id, membershipId: m.id, played: 0, won: 0, lost: 0, tied: 0, points: 0, runsFor: 0, runsAgainst: 0, nrr: 0 });
  emit(db, w.id, 'MANAGER_JOINED', { clubName }); news(db, w.id, 'MANAGER_JOINED', `${clubName} joined`, `${req.user.name} took charge of ${clubName}. Squad is empty — build it in the auction.`);
  save(); res.status(201).json({ membership: m, budget: START_BUDGET, squad: [] });
});

// ---------- AI managers + creator start ----------
// An AI manager is a normal manager record flagged ai:true, created
// internally only: it gets a random, unusable password hash and the
// login route refuses ai accounts outright, so it can never be signed
// into. Its membership is identical to a human's (₹100 Cr, empty squad).
function fillAiManagers(db, w) {
  const taken = db.memberships.filter(m => m.worldId === w.id).map(m => m.clubName);
  const free = CLUBS.slice(0, w.numberOfClubs).filter(c => !taken.includes(c));
  let added = 0;
  for (const clubName of free) {
    const short = clubName.split(/\s+/).map(x => x[0]).join('').toUpperCase();
    let email = `ai.${w.id.slice(-6)}.${short.toLowerCase()}@ai.local`;
    let n = 2; while (db.users.some(u => u.email === email)) email = `ai.${w.id.slice(-6)}.${short.toLowerCase()}${n++}@ai.local`;
    const u = { id: id('mgr'), name: `AI Manager — ${short}`, email,
      passwordHash: bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12), // random: unknowable, so no login is possible
      provider: 'ai', ai: true, profileImage: '', createdAt: nowISO(),
      stats: { matchesManaged: 0, wins: 0, auctionsWon: 0 }, trophies: [], history: [] };
    db.users.push(u);
    const m = { id: id('mem'), worldId: w.id, userId: u.id, clubName, budget: START_BUDGET, ai: true,
      xi: [], tactics: defaultTactics(), captainId: null, viceCaptainId: null, joinedAt: nowISO(), lastSeenAt: nowISO() };
    db.memberships.push(m);
    db.league.push({ id: id('lg'), worldId: w.id, membershipId: m.id, played: 0, won: 0, lost: 0, tied: 0, points: 0, runsFor: 0, runsAgainst: 0, nrr: 0 });
    emit(db, w.id, 'MANAGER_JOINED', { clubName, ai: true });
    added++;
  }
  return added;
}

app.post('/api/worlds/:id/start', auth, (req, res) => {
  const db = load(); const w = db.worlds.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'World not found.' });
  if (w.creatorId !== req.user.id) return res.status(403).json({ error: 'Only the world creator can start this world.' });
  if (!['CREATED', 'RECRUITING'].includes(w.state)) return res.status(409).json({ error: 'This world has already started.' });
  if (!memberOf(db, w.id, req.user.id)) return res.status(400).json({ error: 'Join a club in this world before starting it.' });
  let aiAdded = 0;
  if (w.aiFill !== false) aiAdded = fillAiManagers(db, w);
  const total = db.memberships.filter(m => m.worldId === w.id).length;
  if (total < 2) return res.status(400).json({ error: 'At least 2 managers are needed to start a world.' });
  startWorld(db, w);
  save();
  res.json({ world: pubWorld(db, w, req.user.id), aiAdded, managersCount: total, serverNow: nowISO() });
});

// ---------- auction ----------
// ---------- auction views (undisclosed bids are masked here) ----------
// An undisclosed bid hides its amount AND its bidder from everyone
// except the bidder themself. The auction's current PRICE stays public
// (you must be able to bid against it); only the leader's identity is
// hidden when the leading bid is undisclosed. Settlement always uses
// the real stored amounts.
function bidView(db, bid, viewerMembershipId) {
  const m = db.memberships.find(x => x.id === bid.membershipId);
  const u = m && db.users.find(x => x.id === m.userId);
  const mine = bid.membershipId === viewerMembershipId;
  const hidden = !!bid.undisclosed && !mine;
  return { id: bid.id, auctionId: bid.auctionId, amount: hidden ? null : bid.amount,
    undisclosed: !!bid.undisclosed, status: bid.status, createdAt: bid.createdAt, mine,
    managerName: hidden ? 'Undisclosed' : (u ? u.name : ''), clubName: hidden ? 'Undisclosed' : (m ? m.clubName : '') };
}
function auctionView(db, a, viewerMembershipId, userId) {
  const wp = db.worldPlayers.find(p => p.id === a.worldPlayerId); const t = tpl(wp || {});
  const top = topBid(db, a.id);
  const tm = top && db.memberships.find(m => m.id === top.membershipId);
  const leaderHidden = !!top && !!top.undisclosed && top.membershipId !== viewerMembershipId;
  const owner = wp && wp.ownerMembershipId && db.memberships.find(m => m.id === wp.ownerMembershipId);
  return { auctionId: a.id, worldPlayerId: a.worldPlayerId,
    player: { id: wp && wp.id, worldPlayerId: wp && wp.id, name: t.name, age: t.age, role: t.role, nationality: t.nationality, rating: t.rating, batting: t.batting, bowling: t.bowling, leadership: t.leadership, prefBatPos: t.prefBatPos, prefOvers: t.prefOvers, approach: t.approach, ...photoFields(t) },
    baseValue: a.baseValue, auctionStartsAt: a.auctionStartsAt, auctionEndsAt: a.auctionEndsAt, status: a.status,
    currentPrice: top ? top.amount : a.baseValue, // the price is always public
    highestBid: top ? top.amount : null, highestBidderClub: top ? (leaderHidden ? 'Undisclosed' : (tm ? tm.clubName : null)) : null,
    leaderUndisclosed: leaderHidden, ownerClub: owner ? owner.clubName : null,
    bidsCount: validBids(db, a.id).length,
    watched: userId ? db.watchlist.some(x => x.userId === userId && x.auctionId === a.id) : false };
}

app.get('/api/worlds/:id/auction', auth, (req, res) => { const db = load(); const w = db.worlds.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'World not found.' });
  const mine = memberOf(db, w.id, req.user.id);
  const list = db.auctions.filter(a => a.worldId === w.id).map(a => auctionView(db, a, mine && mine.id, req.user.id));
  res.json({ auctions: list, state: w.state, serverNow: nowISO() }); });

// Player detail: full player info + its auction + complete bid history
// (masked per-viewer). This powers the SPA's player page.
app.get('/api/worlds/:wid/players/:pid', auth, (req, res) => { const db = load(); const w = db.worlds.find(x => x.id === req.params.wid);
  if (!w) return res.status(404).json({ error: 'World not found.' });
  const wp = db.worldPlayers.find(p => p.id === req.params.pid && p.worldId === w.id);
  if (!wp) return res.status(404).json({ error: 'Player not found.' });
  const t = tpl(wp);
  const mine = memberOf(db, w.id, req.user.id);
  const auction = db.auctions.find(a => a.worldPlayerId === wp.id);
  const owner = wp.ownerMembershipId && db.memberships.find(m => m.id === wp.ownerMembershipId);
  const history = auction ? db.bids.filter(b => b.auctionId === auction.id)
    .sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt) || y.amount - x.amount)
    .map(b => bidView(db, b, mine && mine.id)) : [];
  res.json({ player: { worldPlayerId: wp.id, templateId: wp.templateId, name: t.name, age: t.age, role: t.role,
      nationality: t.nationality, rating: t.rating, batting: t.batting, bowling: t.bowling, leadership: t.leadership,
      prefBatPos: t.prefBatPos, prefOvers: t.prefOvers, approach: t.approach, ...photoFields(t),
      baseValue: t.baseValue, form: wp.form, fitness: wp.fitness, morale: wp.morale, status: wp.status,
      ownerClub: owner ? owner.clubName : null },
    auction: auction ? auctionView(db, auction, mine && mine.id, req.user.id) : null,
    bids: history, myMembership: mine || null, serverNow: nowISO() }); });

app.post('/api/auctions/:id/bid', auth, (req, res) => {
  const db = load(); const a = db.auctions.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Auction not found.' });
  if (a.status !== 'OPEN') return res.status(409).json({ error: 'This auction is closed / player already sold.' });
  if (Date.now() >= new Date(a.auctionEndsAt).getTime()) return res.status(409).json({ error: 'This auction has expired.' });
  const m = memberOf(db, a.worldId, req.user.id);
  if (!m) return res.status(403).json({ error: 'You are not a manager in this world.' });
  const amount = +(req.body || {}).amount;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid bid.' });
  const top = topBid(db, a.id);
  if (top && amount <= top.amount) return res.status(400).json({ error: 'Bid must be higher than the current highest bid.' });
  if (amount < a.baseValue) return res.status(400).json({ error: 'Bid must be at least the base value.' });
  // Squad-size (max 25) + budget guard (keep enough to reach 18 players)
  const guard = validateBid(db, m, a, amount);
  if (guard) return res.status(400).json({ error: guard });
  const bid = placeBid(db, m, a, amount, { undisclosed: !!(req.body || {}).undisclosed });
  save(); res.status(201).json({ bid: bidView(db, bid, m.id), auction: auctionView(db, a, m.id, req.user.id), serverNow: nowISO() });
});

app.post('/api/auctions/:id/withdraw', auth, (req, res) => {
  const db = load(); const a = db.auctions.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Auction not found.' });
  if (a.status !== 'OPEN') return res.status(409).json({ error: 'This auction is closed / player already sold.' });
  if (Date.now() >= new Date(a.auctionEndsAt).getTime()) return res.status(409).json({ error: 'This auction has expired.' });
  const m = memberOf(db, a.worldId, req.user.id);
  if (!m) return res.status(403).json({ error: 'You are not a manager in this world.' });
  // The caller's own highest live bid is withdrawn — allowed even when leading.
  const mine = validBids(db, a.id).filter(b => b.membershipId === m.id);
  if (!mine.length) return res.status(400).json({ error: 'You have no bid on this auction to withdraw.' });
  const bid = mine[0];
  bid.status = 'WITHDRAWN';
  const top = topBid(db, a.id); // leader/current price recomputed from what remains
  a.highestBidId = top ? top.id : null;
  const wp = db.worldPlayers.find(p => p.id === a.worldPlayerId);
  const playerName = tpl(wp || {}).name;
  if (bid.undisclosed) emit(db, a.worldId, 'BID_WITHDRAWN', { player: playerName, undisclosed: true });
  else emit(db, a.worldId, 'BID_WITHDRAWN', { player: playerName, club: m.clubName });
  if (top && top.membershipId !== m.id) { const leader = db.memberships.find(x => x.id === top.membershipId);
    if (leader) notify(db, leader.userId, a.worldId, 'BID_WITHDRAWN', `A higher bid for ${playerName} was withdrawn — you are leading this auction again.`); }
  save(); res.json({ ok: true, withdrawnBidId: bid.id, auction: auctionView(db, a, m.id, req.user.id), serverNow: nowISO() });
});
app.post('/api/auctions/:id/watchlist', auth, (req, res) => { const db = load();
  const i = db.watchlist.findIndex(x => x.userId === req.user.id && x.auctionId === req.params.id);
  if (i >= 0) db.watchlist.splice(i, 1); else db.watchlist.push({ id: id('wl'), userId: req.user.id, auctionId: req.params.id });
  save(); res.json({ watched: i < 0 }); });

// ---------- squad / XI / captaincy ----------
app.get('/api/worlds/:id/squad', auth, (req, res) => { const db = load(); const m = memberOf(db, req.params.id, req.user.id);
  if (!m) return res.status(403).json({ error: 'Not a member of this world.' });
  const squad = db.worldPlayers.filter(p => p.worldId === req.params.id && p.ownerMembershipId === m.id)
    .map(p => { const t = tpl(p); return { ...t, ...photoFields(t), worldPlayerId: p.id, form: p.form, fitness: p.fitness, morale: p.morale, isCaptain: m.captainId === p.id, isViceCaptain: m.viceCaptainId === p.id }; });
  res.json({ squad, budget: m.budget, xi: m.xi, tactics: withDefaults(m.tactics), captainId: m.captainId, viceCaptainId: m.viceCaptainId, clubName: m.clubName }); });
app.post('/api/worlds/:id/captain', auth, (req, res) => { const db = load(); const m = memberOf(db, req.params.id, req.user.id);
  if (!m) return res.status(403).json({ error: 'Not a member.' });
  const { worldPlayerId, role } = req.body || {};
  const p = db.worldPlayers.find(x => x.id === worldPlayerId && x.ownerMembershipId === m.id);
  if (!p) return res.status(400).json({ error: 'Player is not in your squad.' });
  if (role === 'vice') m.viceCaptainId = worldPlayerId; else m.captainId = worldPlayerId;
  p.morale = Math.min(99, (p.morale || 70) + 10); // leadership lifts morale -> chemistry/performance in the engine
  emit(db, m.worldId, 'CAPTAINCY_CHANGED', { player: tpl(p).name, role: role || 'captain' }); save(); res.json({ captainId: m.captainId, viceCaptainId: m.viceCaptainId }); });
app.post('/api/worlds/:id/xi', auth, (req, res) => { const db = load(); const m = memberOf(db, req.params.id, req.user.id);
  if (!m) return res.status(403).json({ error: 'Not a member.' });
  // Tactical lock: no XI/tactics changes within 30 min of your next fixture
  const next = db.fixtures.filter(f => f.worldId === m.worldId && [f.homeMembershipId, f.awayMembershipId].includes(m.id) && f.status !== 'COMPLETED')
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))[0];
  if (next && Date.now() >= new Date(next.tacticalLockAt).getTime() && Date.now() < new Date(next.scheduledAt).getTime() + 30 * 60000)
    return res.status(423).json({ error: 'Team selection is locked for the upcoming match (deadline was 30 minutes before start).' });
  const { xi, tactics } = req.body || {};
  const owned = new Set(db.worldPlayers.filter(p => p.ownerMembershipId === m.id).map(p => p.id));
  const newXi = xi !== undefined ? xi : (m.xi || []);
  if (xi !== undefined && (!Array.isArray(xi) || xi.length > 11 || xi.some(x => !owned.has(x))))
    return res.status(400).json({ error: 'XI must be up to 11 players from your own squad.' });
  if (tactics !== undefined) {
    if (!tactics || typeof tactics !== 'object' || Array.isArray(tactics)) return res.status(400).json({ error: 'Tactics must be an object.' });
    // Detailed tactics (batting order / bowling plan / per-player
    // approach / home pitch) are validated against the effective XI.
    const err = validateTactics(db, m, newXi, tactics);
    if (err) return res.status(400).json({ error: err });
  }
  if (xi !== undefined) m.xi = xi;
  if (tactics !== undefined) {
    // Merge only known tactics keys; the detailed fields were validated above.
    const cur = withDefaults(m.tactics); const clean = {};
    for (const k of ['formation', 'battingApproach', 'bowlingApproach', 'battingOrder', 'bowlingPlan', 'playerApproach', 'homePitch'])
      if (tactics[k] !== undefined) clean[k] = tactics[k];
    m.tactics = { ...cur, ...clean };
  }
  save(); res.json({ xi: m.xi, tactics: withDefaults(m.tactics) }); });

// ---------- home pitch ----------
// The home manager prepares the pitch. A standing preference lives on
// the membership (tactics.homePitch, applies to every home fixture);
// a fixture can be given its own pitch until its tactical lock.
app.post('/api/worlds/:id/pitch', auth, (req, res) => { const db = load(); const m = memberOf(db, req.params.id, req.user.id);
  if (!m) return res.status(403).json({ error: 'Not a member.' });
  const pitch = (req.body || {}).pitch;
  if (!PITCHES.includes(pitch)) return res.status(400).json({ error: `Pitch must be one of: ${PITCHES.join(', ')}.` });
  m.tactics = { ...withDefaults(m.tactics), homePitch: pitch };
  emit(db, m.worldId, 'PITCH_CHANGED', { club: m.clubName, pitch, scope: 'home default' });
  save(); res.json({ homePitch: pitch }); });
app.post('/api/worlds/:id/fixtures/:fid/pitch', auth, (req, res) => { const db = load(); const m = memberOf(db, req.params.id, req.user.id);
  if (!m) return res.status(403).json({ error: 'Not a member.' });
  const f = db.fixtures.find(x => x.id === req.params.fid && x.worldId === req.params.id);
  if (!f) return res.status(404).json({ error: 'Fixture not found.' });
  if (f.homeMembershipId !== m.id) return res.status(403).json({ error: 'Only the home manager prepares the pitch for this fixture.' });
  const pitch = (req.body || {}).pitch;
  if (!PITCHES.includes(pitch)) return res.status(400).json({ error: `Pitch must be one of: ${PITCHES.join(', ')}.` });
  if (f.status === 'COMPLETED' || f.status === 'CANCELLED') return res.status(409).json({ error: 'This match has already been played.' });
  if (Date.now() >= new Date(f.tacticalLockAt).getTime())
    return res.status(423).json({ error: 'The pitch is locked for this match (deadline was 30 minutes before start).' });
  f.pitch = pitch;
  emit(db, m.worldId, 'PITCH_CHANGED', { club: m.clubName, pitch, fixtureId: f.id });
  save(); res.json({ fixtureId: f.id, pitch }); });

// ---------- fixtures / league / misc ----------
app.get('/api/worlds/:id/fixtures', auth, (req, res) => { const db = load();
  const club = mid => (db.memberships.find(m => m.id === mid) || {}).clubName || '—';
  const mine = memberOf(db, req.params.id, req.user.id);
  res.json({ fixtures: db.fixtures.filter(f => f.worldId === req.params.id).sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
    .map(f => ({ ...f, homeClub: club(f.homeMembershipId), awayClub: club(f.awayMembershipId),
      pitch: fixturePitch(db, f, db.memberships.find(m => m.id === f.homeMembershipId)),
      pitchSet: !!f.pitch, isHome: !!mine && f.homeMembershipId === mine.id,
      locked: Date.now() >= new Date(f.tacticalLockAt).getTime() })), serverNow: nowISO() }); });
app.get('/api/worlds/:id/league', auth, (req, res) => { const db = load();
  res.json({ table: db.league.filter(l => l.worldId === req.params.id).map(l => ({ ...l, clubName: (db.memberships.find(m => m.id === l.membershipId) || {}).clubName || '—' })).sort((a, b) => b.points - a.points || b.nrr - a.nrr) }); });
app.get('/api/worlds/:id/finance', auth, (req, res) => { const db = load(); const m = memberOf(db, req.params.id, req.user.id);
  if (!m) return res.status(403).json({ error: 'Not a member.' });
  const spent = db.bids.filter(b => b.status === 'WON' && b.membershipId === m.id).reduce((s, b) => s + b.amount, 0);
  res.json({ budget: m.budget, startingBudget: START_BUDGET, spentOnPlayers: spent }); });
app.get('/api/worlds/:id/news', auth, (req, res) => { const db = load(); res.json({ news: db.news.filter(n => n.worldId === req.params.id).slice(-100).reverse() }); });
app.get('/api/notifications', auth, (req, res) => { const db = load(); res.json({ notifications: db.notifications.filter(n => n.userId === req.user.id).slice(-100).reverse(), serverNow: nowISO() }); });
app.get('/api/worlds/:id/events', auth, (req, res) => { const db = load(); res.json({ events: db.events.filter(e => e.worldId === req.params.id).slice(-200).reverse() }); });
app.get('/api/server-time', (req, res) => res.json({ serverNow: nowISO() }));
app.post('/api/admin/tick', (req, res) => { if (req.headers['x-admin-key'] !== SECRET) return res.status(403).json({ error: 'Forbidden' }); tick(); res.json({ ok: true, serverNow: nowISO() }); });

const PORT = parseInt(process.env.PORT || '3000', 10);
// Load the game state before serving: in supabase mode db.init() reads
// the durable state from public.app_state (falling back to the local
// file if Supabase is unreachable); in local mode it resolves at once.
init()
  .catch(err => console.error('[db] State init failed — continuing with the local store:', err.message))
  .then(() => {
    app.listen(PORT, () => { console.log(`Cricket Manager Worlds running on http://localhost:${PORT}`); console.log(`[db] mode=${supa.mode()} supabaseConfigured=${supa.isConfigured()} (Supabase is the production backend; 'local' is the dev fallback — see README)`); startScheduler(); });
  });
