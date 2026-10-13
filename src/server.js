'use strict';
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { load, save, id, nowISO, emit, notify, news } = require('./db');
const PLAYERS = require('./players');
const { startScheduler, tick } = require('./scheduler');
const supa = require('./supabase');

const SECRET = process.env.SESSION_SECRET || 'dev-only-change-me';
const CLUBS = ['Kerala Kings','Mumbai Warriors','Delhi Strikers','Bangalore Titans','Chennai Superstars','Kolkata Knights','Hyderabad Hurricanes','Rajasthan Royals XI','Punjab Lions','Lucknow Giants','Gujarat Titans','Pune Panthers'];
const START_BUDGET = 100;

const app = express();
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
      return res.cookie('token', sign(u), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 }).json({ user: pubUser(load(), u), serverNow: nowISO() });
    } catch { return res.status(503).json({ error: 'Auth service unavailable.' }); }
  }
  const db = load();
  if (db.users.some(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: 'An account with this email already exists.' });
  const u = { id: id('mgr'), name, email, passwordHash: bcrypt.hashSync(password, 12), provider: 'email', profileImage: '', createdAt: nowISO(),
    stats: { matchesManaged: 0, wins: 0, auctionsWon: 0 }, trophies: [], history: [] };
  db.users.push(u); save();
  res.cookie('token', sign(u), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 }).json({ user: pubUser(db, u), serverNow: nowISO() });
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
      return res.cookie('token', sign(u), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 }).json({ user: pubUser(load(), u), serverNow: nowISO() });
    } catch { return res.status(503).json({ error: 'Auth service unavailable.' }); }
  }
  const db = load();
  const u = db.users.find(x => x.email.toLowerCase() === String(email || '').toLowerCase());
  if (!u || !u.passwordHash || !bcrypt.compareSync(password || '', u.passwordHash)) return res.status(401).json({ error: 'Invalid email or password.' });
  res.cookie('token', sign(u), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 }).json({ user: pubUser(db, u), serverNow: nowISO() });
});
app.post('/api/auth/logout', (req, res) => res.clearCookie('token').json({ ok: true }));
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
    const redirectTo = `${req.protocol}://${req.get('host')}/`;
    return res.redirect(`${process.env.SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`);
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)
    return res.status(501).send('Google OAuth needs configuration: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see README / .env.example), then restart the server. Email login works without it.');
  const p = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/api/auth/google/callback',
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
    return res.cookie('token', sign(u), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 }).json({ user: pubUser(load(), u), serverNow: nowISO() });
  } catch { return res.status(503).json({ error: 'Auth service unavailable.' }); }
});
app.get('/api/auth/google/callback', async (req, res) => {
  try {
    if (!req.query.code) throw new Error('no code');
    const tok = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: req.query.code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/api/auth/google/callback', grant_type: 'authorization_code' }) })).json();
    const info = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + tok.access_token } })).json();
    if (!info.email) throw new Error('no email');
    const db = load(); let u = db.users.find(x => x.email.toLowerCase() === info.email.toLowerCase());
    if (!u) { u = { id: id('mgr'), name: info.name || info.email, email: info.email, passwordHash: null, provider: 'google', profileImage: info.picture || '', createdAt: nowISO(), stats: { matchesManaged: 0, wins: 0, auctionsWon: 0 }, trophies: [], history: [] }; db.users.push(u); save(); }
    res.cookie('token', sign(u), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 }).redirect('/');
  } catch { res.status(502).send('Google sign-in failed. Check OAuth credentials / redirect URI in .env.'); }
});

// ---------- worlds ----------
const pubWorld = (db, w, userId) => ({ id: w.id, name: w.name, description: w.description, creatorId: w.creatorId,
  creatorName: (db.users.find(u => u.id === w.creatorId) || {}).name || '', numberOfClubs: w.numberOfClubs,
  managersCount: db.memberships.filter(m => m.worldId === w.id).length, status: w.state, state: w.state,
  startDate: w.startDate, auctionStartAt: w.auctionStartAt, seasonStartAt: w.seasonStartAt, format: w.format,
  competitionStructure: w.competitionStructure, matchIntervalDays: w.matchIntervalDays, matchTime: w.matchTime,
  timezone: w.timezone, seasonLength: w.seasonLength, isPrivate: !!w.passwordHash,
  joined: userId ? !!memberOf(db, w.id, userId) : false, serverNow: nowISO() });

app.get('/api/worlds', auth, (req, res) => { const db = load(); res.json({ worlds: db.worlds.map(w => pubWorld(db, w, req.user.id)), serverNow: nowISO() }); });
app.post('/api/worlds', auth, (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'World name is required.' });
  const db = load();
  const start = b.startDate ? new Date(b.startDate) : new Date(Date.now() + 24 * 3600 * 1000);
  const w = { id: id('world'), name: b.name, description: b.description || '', creatorId: req.user.id,
    numberOfClubs: Math.min(20, Math.max(2, parseInt(b.numberOfClubs || 12, 10))),
    format: b.format || 'League (Home & Away)', competitionStructure: b.competitionStructure || 'Round-robin league',
    matchIntervalDays: Math.min(7, Math.max(1, parseInt(b.matchIntervalDays || 3, 10))), matchTime: b.matchTime || '20:00',
    timezone: b.timezone || 'Asia/Kolkata', seasonLength: b.seasonLength || '1 season',
    auctionSettings: b.auctionSettings || { durationHours: 24, startingBudget: START_BUDGET },
    startDate: start.toISOString(), auctionStartAt: (b.auctionStartAt ? new Date(b.auctionStartAt) : new Date(start.getTime() + 24 * 3600 * 1000)).toISOString(),
    seasonStartAt: (b.seasonStartAt ? new Date(b.seasonStartAt) : new Date(start.getTime() + 4 * 24 * 3600 * 1000)).toISOString(),
    passwordHash: b.password ? bcrypt.hashSync(b.password, 12) : null, // hashed, never returned
    state: 'RECRUITING', createdAt: nowISO() };
  db.worlds.push(w); emit(db, w.id, 'WORLD_CREATED', { name: w.name }); save();
  res.status(201).json({ world: pubWorld(db, w, req.user.id) });
});
app.get('/api/worlds/:id', auth, (req, res) => { const db = load(); const w = db.worlds.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'World not found.' });
  const taken = db.memberships.filter(m => m.worldId === w.id).map(m => m.clubName);
  res.json({ world: pubWorld(db, w, req.user.id),
    availableClubs: CLUBS.slice(0, w.numberOfClubs).filter(c => !taken.includes(c)),
    members: db.memberships.filter(m => m.worldId === w.id).map(m => ({ clubName: m.clubName, managerName: (db.users.find(u => u.id === m.userId) || {}).name || '', budget: m.budget })),
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
    xi: [], tactics: { formation: 'Balanced', battingApproach: 'Balanced', bowlingApproach: 'Balanced' }, captainId: null, viceCaptainId: null, joinedAt: nowISO(), lastSeenAt: nowISO() };
  db.memberships.push(m);
  db.league.push({ id: id('lg'), worldId: w.id, membershipId: m.id, played: 0, won: 0, lost: 0, tied: 0, points: 0, runsFor: 0, runsAgainst: 0, nrr: 0 });
  emit(db, w.id, 'MANAGER_JOINED', { clubName }); news(db, w.id, 'MANAGER_JOINED', `${clubName} joined`, `${req.user.name} took charge of ${clubName}. Squad is empty — build it in the auction.`);
  save(); res.status(201).json({ membership: m, budget: START_BUDGET, squad: [] });
});

// ---------- auction ----------
app.get('/api/worlds/:id/auction', auth, (req, res) => { const db = load(); const w = db.worlds.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'World not found.' });
  const list = db.auctions.filter(a => a.worldId === w.id).map(a => {
    const wp = db.worldPlayers.find(p => p.id === a.worldPlayerId); const t = tpl(wp || {});
    const bids = db.bids.filter(b => b.auctionId === a.id && b.status === 'VALID').sort((x, y) => y.amount - x.amount || new Date(x.createdAt) - new Date(y.createdAt));
    const top = bids[0]; const tm = top && db.memberships.find(m => m.id === top.membershipId);
    return { auctionId: a.id, player: { id: wp && wp.id, name: t.name, age: t.age, role: t.role, nationality: t.nationality, rating: t.rating, batting: t.batting, bowling: t.bowling, leadership: t.leadership },
      baseValue: a.baseValue, auctionStartsAt: a.auctionStartsAt, auctionEndsAt: a.auctionEndsAt, status: a.status,
      highestBid: top ? top.amount : null, highestBidderClub: tm ? tm.clubName : null,
      watched: db.watchlist.some(x => x.userId === req.user.id && x.auctionId === a.id) };
  });
  res.json({ auctions: list, state: w.state, serverNow: nowISO() }); });

app.post('/api/auctions/:id/bid', auth, (req, res) => {
  const db = load(); const a = db.auctions.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Auction not found.' });
  if (a.status !== 'OPEN') return res.status(409).json({ error: 'This auction is closed / player already sold.' });
  if (Date.now() >= new Date(a.auctionEndsAt).getTime()) return res.status(409).json({ error: 'This auction has expired.' });
  const m = memberOf(db, a.worldId, req.user.id);
  if (!m) return res.status(403).json({ error: 'You are not a manager in this world.' });
  const amount = +(req.body || {}).amount;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid bid.' });
  const valid = db.bids.filter(b => b.auctionId === a.id && b.status === 'VALID');
  const top = valid.sort((x, y) => y.amount - x.amount)[0];
  if (top && amount <= top.amount) return res.status(400).json({ error: 'Bid must be higher than the current highest bid.' });
  if (amount < a.baseValue) return res.status(400).json({ error: 'Bid must be at least the base value.' });
  // Server-side budget validation: budget minus this manager's other live leading bids
  const myLeading = db.bids.filter(b => b.status === 'VALID' && db.auctions.some(x => x.id === b.auctionId && x.worldId === a.worldId))
    .filter(b => { const others = db.bids.filter(o => o.auctionId === b.auctionId && o.status === 'VALID'); return b.membershipId === m.id && others.every(o => o.amount <= b.amount) && b.auctionId !== a.id; })
    .reduce((s, b) => s + b.amount, 0);
  if (amount > m.budget - myLeading) return res.status(400).json({ error: 'Insufficient transfer funds.' });
  const bid = { id: id('bid'), auctionId: a.id, membershipId: m.id, amount, createdAt: nowISO(), status: 'VALID' };
  db.bids.push(bid); a.highestBidId = bid.id;
  const wp = db.worldPlayers.find(p => p.id === a.worldPlayerId);
  emit(db, a.worldId, 'BID_PLACED', { player: tpl(wp || {}).name, amount, club: m.clubName });
  if (top && top.membershipId !== m.id) { const out = db.memberships.find(x => x.id === top.membershipId);
    if (out) notify(db, out.userId, a.worldId, 'BID_PLACED', `Your bid for ${tpl(wp || {}).name} was outbid.`); }
  save(); res.status(201).json({ bid, serverNow: nowISO() });
});
app.post('/api/auctions/:id/watchlist', auth, (req, res) => { const db = load();
  const i = db.watchlist.findIndex(x => x.userId === req.user.id && x.auctionId === req.params.id);
  if (i >= 0) db.watchlist.splice(i, 1); else db.watchlist.push({ id: id('wl'), userId: req.user.id, auctionId: req.params.id });
  save(); res.json({ watched: i < 0 }); });

// ---------- squad / XI / captaincy ----------
app.get('/api/worlds/:id/squad', auth, (req, res) => { const db = load(); const m = memberOf(db, req.params.id, req.user.id);
  if (!m) return res.status(403).json({ error: 'Not a member of this world.' });
  const squad = db.worldPlayers.filter(p => p.worldId === req.params.id && p.ownerMembershipId === m.id)
    .map(p => ({ ...tpl(p), worldPlayerId: p.id, form: p.form, fitness: p.fitness, morale: p.morale, isCaptain: m.captainId === p.id, isViceCaptain: m.viceCaptainId === p.id }));
  res.json({ squad, budget: m.budget, xi: m.xi, tactics: m.tactics, captainId: m.captainId, viceCaptainId: m.viceCaptainId, clubName: m.clubName }); });
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
  if (xi) { const owned = new Set(db.worldPlayers.filter(p => p.ownerMembershipId === m.id).map(p => p.id));
    if (!Array.isArray(xi) || xi.length > 11 || xi.some(x => !owned.has(x))) return res.status(400).json({ error: 'XI must be up to 11 players from your own squad.' });
    m.xi = xi; }
  if (tactics) m.tactics = { ...m.tactics, ...tactics };
  save(); res.json({ xi: m.xi, tactics: m.tactics }); });

// ---------- fixtures / league / misc ----------
app.get('/api/worlds/:id/fixtures', auth, (req, res) => { const db = load();
  const club = mid => (db.memberships.find(m => m.id === mid) || {}).clubName || '—';
  res.json({ fixtures: db.fixtures.filter(f => f.worldId === req.params.id).sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
    .map(f => ({ ...f, homeClub: club(f.homeMembershipId), awayClub: club(f.awayMembershipId), locked: Date.now() >= new Date(f.tacticalLockAt).getTime() })), serverNow: nowISO() }); });
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
app.listen(PORT, () => { console.log(`Cricket Manager Worlds running on http://localhost:${PORT}`); console.log(`[db] mode=${supa.mode()} supabaseConfigured=${supa.isConfigured()} (Supabase is the production backend; 'local' is the dev fallback — see README)`); startScheduler(); });
