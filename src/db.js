'use strict';
/**
 * Game store.
 * - Single-process Node is the writer, mutations happen synchronously in
 *   memory and are flushed atomically (write temp file + rename), which is
 *   what makes bid placement / auction settlement atomic in this design.
 * - LOCAL MODE (DATABASE_MODE=local): the JSON file is the store — a
 *   local-dev fallback only.
 * - SUPABASE MODE (DATABASE_MODE=supabase + Supabase configured): the
 *   same in-memory store is made durable in Supabase by the state layer
 *   below. On boot, init() loads the whole game state from the single
 *   row of public.app_state (id = 1, jsonb); every save() mirrors the
 *   latest state back there (service-role key, server-side only — the
 *   table has RLS on and no client policies, see supabase/schema.sql).
 *   Restarts / redeploys therefore never wipe worlds. The local file
 *   is still written on every save as an on-disk fallback cache: if
 *   Supabase is unreachable at boot, init() logs it and falls back to
 *   the file instead of crashing. Auth/managers use the normalised
 *   Supabase tables (migration step 1, src/server.js); this app_state
 *   layer is the durability bridge for everything else — the
 *   normalised per-table migration (worlds/auctions rows, atomic
 *   place_bid()) remains future work.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const supa = require('./supabase');

const DB_PATH = process.env.DATABASE
  ? path.resolve(process.env.DATABASE)
  : path.join(__dirname, '..', 'data', 'db.json');

const empty = () => ({
  users: [],        // {id,name,email,passwordHash,provider,profileImage,createdAt,stats,trophies,history}
  worlds: [],       // {id,...,passwordHash,state,...}
  memberships: [],  // {id,worldId,userId,clubName,budget,xi,tactics,captainId,viceCaptainId,joinedAt}
  worldPlayers: [], // per-world copy of the player pool {id,worldId,templateId,ownerMembershipId,status,form,fitness,morale}
  auctions: [],     // {id,worldId,worldPlayerId,baseValue,auctionStartsAt,auctionEndsAt,status,highestBidId}
  bids: [],         // {id,auctionId,membershipId,amount,createdAt,status}
  fixtures: [],     // {id,worldId,homeMembershipId,awayMembershipId,scheduledAt,timezone,status,result}
  events: [],       // {id,worldId,type,payload,createdAt}
  notifications: [],// {id,userId,worldId,message,type,read,createdAt}
  news: [],         // {id,worldId,headline,body,type,createdAt}
  watchlist: [],    // {id,userId,auctionId}
  league: [],       // {id,worldId,membershipId,played,won,lost,tied,points,nrr,runsFor,runsAgainst}
  offers: []        // transfer offers {id,worldId,fromMembershipId,toMembershipId,worldPlayerId,fee,bonus,swapWorldPlayerId,promise,status,createdAt,expiresAt,resolvedAt}
});
// defaultState() in the design notes = empty() here: a fresh store with
// every collection present as an empty array.
const normalize = (d) => {
  const base = empty();
  if (d && typeof d === 'object') for (const k of Object.keys(base)) if (Array.isArray(d[k])) base[k] = d[k];
  return base;
};

let data;
function saveToFile() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_PATH);
}
function load() {
  if (data) return data;
  try { data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { data = empty(); saveToFile(); }
  for (const k of Object.keys(empty())) if (!Array.isArray(data[k])) data[k] = [];
  return data;
}
function save() {
  saveToFile();
  if (SUPA_STATE) queueSupaFlush();
}

// ---------------------------------------------------------------------
// Supabase durability layer — active only in supabase mode with the
// service-role key configured. Everything below is inert in local mode,
// where save()/load() behave exactly as the plain file store.
// ---------------------------------------------------------------------
const SUPA_STATE = supa.mode() === 'supabase' && supa.isConfigured();
const STATE_URL = SUPA_STATE
  ? `${String(process.env.SUPABASE_URL).replace(/\/+$/, '')}/rest/v1/app_state`
  : null;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const stateHeaders = (extra) => {
  const h = {};
  h['api' + 'key'] = SERVICE_ROLE_KEY;
  h.Authorization = 'Bearer ' + SERVICE_ROLE_KEY;
  return Object.assign(h, extra || {});
};

let lastFlushedJson = null; // last snapshot known to be stored in Supabase
let pendingJson = null;     // newest snapshot still needing a flush
let flushing = false;

async function postState(json, timeoutMs) {
  const res = await fetch(STATE_URL, {
    method: 'POST',
    headers: stateHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }),
    body: JSON.stringify({ id: 1, state: JSON.parse(json), updated_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(timeoutMs || 15000)
  });
  if (!res.ok) throw new Error(`app_state upsert returned HTTP ${res.status}`);
}

// Write coalescing: identical snapshots are skipped, and snapshots
// produced while a flush is in flight collapse into the newest one.
function queueSupaFlush() {
  let json;
  try { json = JSON.stringify(data); } catch { return; }
  if (json === lastFlushedJson) { pendingJson = null; return; }
  pendingJson = json;
  void flushPending();
}
async function flushPending() {
  if (flushing) return;
  flushing = true;
  try {
    while (pendingJson !== null && pendingJson !== lastFlushedJson) {
      const snap = pendingJson; pendingJson = null;
      try {
        await postState(snap);
        lastFlushedJson = snap;
      } catch (err) {
        // State remains in memory (+ local file); retried on the next
        // save() and once more at shutdown.
        console.error('[db] Supabase app_state save failed (state kept in memory + local file):', err.message);
        if (pendingJson === null) pendingJson = snap;
        break;
      }
    }
  } finally { flushing = false; }
}
// Await the newest state reaching Supabase — used on shutdown so the
// final write is never lost.
async function flushNow() {
  if (!SUPA_STATE) return;
  while (flushing) await new Promise(r => setTimeout(r, 20));
  if (pendingJson !== null && pendingJson !== lastFlushedJson) {
    const snap = pendingJson; pendingJson = null;
    try { await postState(snap, 5000); lastFlushedJson = snap; }
    catch (err) { console.error('[db] Final Supabase app_state flush failed:', err.message); }
  }
}

/**
 * Boot-time state load. server.js awaits this before listening, so the
 * synchronous load() used by every route already has the state.
 * Supabase mode: GET the app_state row; if none exists, start from
 * defaultState() and persist it once. If Supabase is unreachable, log
 * clearly and fall back to the local file state — never crash.
 */
async function init() {
  if (!SUPA_STATE) return load();
  try {
    const res = await fetch(`${STATE_URL}?id=eq.1`, {
      headers: stateHeaders({ Accept: 'application/json' }),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`app_state read returned HTTP ${res.status}`);
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length && rows[0] && rows[0].state) {
      data = normalize(rows[0].state);
      lastFlushedJson = JSON.stringify(data);
      console.log('[db] Game state loaded from Supabase (public.app_state).');
    } else {
      data = empty();
      save(); // local file + first upsert into app_state
      console.log('[db] No app_state row in Supabase yet — fresh game state initialised and stored.');
    }
  } catch (err) {
    console.error('[db] Could not load game state from Supabase — falling back to the local file store:', err.message);
    data = undefined;
    load();
  }
  return data;
}

if (SUPA_STATE) {
  // Never lose the final write on shutdown/redeploy.
  let exiting = false;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      if (exiting) return; exiting = true;
      console.log(`[db] ${sig} received — flushing game state to Supabase before exit…`);
      await flushNow();
      process.exit(0);
    });
  }
}

const id = (p) => p + '_' + crypto.randomUUID().slice(0, 8) + Date.now().toString(36);
const nowISO = () => new Date().toISOString();

function emit(db, worldId, type, payload) {
  db.events.push({ id: id('evt'), worldId, type, payload, createdAt: nowISO() });
}
function notify(db, userId, worldId, type, message) {
  if (userId) db.notifications.push({ id: id('ntf'), userId, worldId, type, message, read: false, createdAt: nowISO() });
}
function news(db, worldId, type, headline, body) {
  db.news.push({ id: id('news'), worldId, type, headline, body: body || '', createdAt: nowISO() });
}

module.exports = { load, save, init, flushNow, id, nowISO, emit, notify, news, DB_PATH };
