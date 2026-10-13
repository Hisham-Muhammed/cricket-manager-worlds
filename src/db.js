'use strict';
/**
 * File/JSON DB layer.
 * - Single-process Node is the writer, mutations happen synchronously in
 *   memory and are flushed atomically (write temp file + rename), which is
 *   what makes bid placement / auction settlement atomic in this design.
 * - LOCAL DEV FALLBACK ONLY. Production uses Supabase — see
 *   supabase/schema.sql + supabase/seed.sql and src/supabase.js. Every
 *   collection below maps 1:1 to a Supabase table of the same name
 *   (users -> managers). Atomic bid/settle in Postgres: place_bid().
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  league: []        // {id,worldId,membershipId,played,won,lost,tied,points,nrr,runsFor,runsAgainst}
});

let data;
function load() {
  if (data) return data;
  try { data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { data = empty(); save(); }
  for (const k of Object.keys(empty())) if (!Array.isArray(data[k])) data[k] = [];
  return data;
}
function save() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_PATH);
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

module.exports = { load, save, id, nowISO, emit, notify, news, DB_PATH };
