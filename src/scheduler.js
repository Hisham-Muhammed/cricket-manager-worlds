'use strict';
/**
 * Server scheduler — the persistent-world clock.
 * Runs on setInterval in-process (see server.js). In production you can ALSO
 * hit POST /api/admin/tick (with SESSION_SECRET as x-admin-key) from a system
 * cron every minute, so expiries/matches still fire if the process restarts.
 * Server time is the only source of truth; clients only render countdowns
 * from stored timestamps + the serverNow value returned by the API.
 */
const { load, save, id, nowISO, emit, notify, news } = require('./db');
const PLAYERS = require('./players');
const { generateFixtures } = require('./fixtures');
const { simulate } = require('./matchEngine');
let ticking = false;

function openAuctions(db, world) {
  if (db.auctions.some(a => a.worldId === world.id)) return;
  const start = new Date(world.auctionStartAt || Date.now());
  for (const t of PLAYERS) {
    const wpId = id('wp');
    db.worldPlayers.push({ id: wpId, worldId: world.id, templateId: t.id, ownerMembershipId: null, status: 'IN_MARKET', form: 50, fitness: 100, morale: 70 });
    db.auctions.push({ id: id('auc'), worldId: world.id, worldPlayerId: wpId, baseValue: t.baseValue,
      auctionStartsAt: start.toISOString(), auctionEndsAt: new Date(start.getTime() + 24 * 3600 * 1000).toISOString(),
      status: 'OPEN', highestBidId: null, relistCount: 0 });
  }
  emit(db, world.id, 'AUCTION_STARTED', {}); news(db, world.id, 'AUCTION_STARTED', 'Player auction is open', `${PLAYERS.length} players are in the central market for 24 hours.`);
}

function settleAuction(db, auction) {
  // Called once, synchronously — settlement is atomic in this process.
  const bids = db.bids.filter(b => b.auctionId === auction.id && b.status === 'VALID')
    .sort((a, b) => b.amount - a.amount || new Date(a.createdAt) - new Date(b.createdAt)); // earliest wins a tie
  const wp = db.worldPlayers.find(p => p.id === auction.worldPlayerId);
  const tpl = PLAYERS.find(p => p.id === (wp && wp.templateId)) || {};
  auction.status = 'EXPIRED'; emit(db, auction.worldId, 'AUCTION_EXPIRED', { auctionId: auction.id });
  if (!bids.length) { // no offers -> relist for another 24h
    auction.status = 'OPEN'; auction.relistCount = (auction.relistCount || 0) + 1;
    auction.auctionStartsAt = nowISO(); auction.auctionEndsAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    return;
  }
  const win = bids[0];
  const winner = db.memberships.find(m => m.id === win.membershipId);
  if (!winner || winner.budget < win.amount) { win.status = 'INVALID'; return settleAuction(db, auction); }
  winner.budget = +(winner.budget - win.amount).toFixed(2);
  win.status = 'WON'; bids.slice(1).forEach(b => { b.status = 'UNSUCCESSFUL';
    const loser = db.memberships.find(m => m.id === b.membershipId);
    if (loser) notify(db, loser.userId, auction.worldId, 'PLAYER_SOLD', `Your bid for ${tpl.name} was unsuccessful.`); });
  wp.ownerMembershipId = winner.id; wp.status = 'OWNED';
  auction.status = 'SOLD'; auction.highestBidId = win.id;
  emit(db, auction.worldId, 'PLAYER_SOLD', { player: tpl.name, club: winner.clubName, amount: win.amount });
  emit(db, auction.worldId, 'TRANSFER_COMPLETED', { player: tpl.name, club: winner.clubName, amount: win.amount });
  news(db, auction.worldId, 'TRANSFER_COMPLETED', 'TRANSFER COMPLETED', `${tpl.name} has joined ${winner.clubName} for ₹${win.amount} Cr.`);
  notify(db, winner.userId, auction.worldId, 'TRANSFER_COMPLETED', `${tpl.name} has joined your club for ₹${win.amount} Cr.`);
}

function applyResult(db, world, fixture, result) {
  const rows = [fixture.homeMembershipId, fixture.awayMembershipId].map(mid => {
    let r = db.league.find(l => l.worldId === world.id && l.membershipId === mid);
    if (!r) { r = { id: id('lg'), worldId: world.id, membershipId: mid, played: 0, won: 0, lost: 0, tied: 0, points: 0, runsFor: 0, runsAgainst: 0, nrr: 0 }; db.league.push(r); }
    return r;
  });
  const [h, a] = rows;
  h.played++; a.played++; h.runsFor += result.home.runs; h.runsAgainst += result.away.runs; a.runsFor += result.away.runs; a.runsAgainst += result.home.runs;
  if (!result.winnerMembershipId) { h.tied++; a.tied++; h.points++; a.points++; }
  else if (result.winnerMembershipId === h.membershipId) { h.won++; a.lost++; h.points += 2; } else { a.won++; h.lost++; a.points += 2; }
  rows.forEach(r => r.nrr = +(((r.runsFor - r.runsAgainst) / Math.max(1, r.played)) / 20).toFixed(3));
  // form / fitness drift for players who played
  for (const mid of [fixture.homeMembershipId, fixture.awayMembershipId])
    db.worldPlayers.filter(p => p.worldId === world.id && p.ownerMembershipId === mid)
      .forEach(p => { p.fitness = Math.max(60, (p.fitness ?? 100) - 4); p.form = Math.min(99, Math.max(20, (p.form ?? 50) + (result.winnerMembershipId === mid ? 5 : -2))); });
}

function tick() {
  if (ticking) return; ticking = true;
  try {
    const db = load(); const now = Date.now(); let changed = false;
    for (const world of db.worlds) {
      // State machine, driven by stored server timestamps
      if (world.state === 'CREATED') { world.state = 'RECRUITING'; changed = true; }
      if (world.state === 'RECRUITING' && world.auctionStartAt && now >= new Date(world.auctionStartAt).getTime()) {
        world.state = 'AUCTION'; openAuctions(db, world); changed = true;
      }
      if (world.state === 'AUCTION' && !db.auctions.some(a => a.worldId === world.id && a.status === 'OPEN')) { world.state = 'SQUAD_BUILDING'; changed = true; }
      if ((world.state === 'SQUAD_BUILDING' || world.state === 'AUCTION') && world.seasonStartAt && now >= new Date(world.seasonStartAt).getTime() - 24 * 3600 * 1000 && world.state !== 'PRE_SEASON') {
        if (world.state === 'SQUAD_BUILDING') { world.state = 'PRE_SEASON'; changed = true; }
      }
      if ((world.state === 'PRE_SEASON' || world.state === 'SQUAD_BUILDING') && world.seasonStartAt && now >= new Date(world.seasonStartAt).getTime()) {
        const fx = generateFixtures(db, world);
        db.fixtures.push(...fx); world.state = 'ACTIVE_SEASON';
        emit(db, world.id, 'SEASON_STARTED', { fixtures: fx.length }); news(db, world.id, 'SEASON_STARTED', 'Season started', `${fx.length} fixtures generated.`);
        db.memberships.filter(m => m.worldId === world.id).forEach(m => notify(db, m.userId, world.id, 'SEASON_STARTED', 'Your season has started. First fixture is scheduled.'));
        changed = true;
      }
      if (world.state === 'ACTIVE_SEASON') {
        const mine = db.fixtures.filter(f => f.worldId === world.id);
        if (mine.length && mine.every(f => ['COMPLETED', 'CANCELLED'].includes(f.status))) { world.state = 'SEASON_FINISHED'; emit(db, world.id, 'SEASON_COMPLETED', {}); changed = true; }
      }
    }
    // Expire auctions automatically (no manual "complete" step exists)
    for (const a of db.auctions.filter(x => x.status === 'OPEN' && now >= new Date(x.auctionEndsAt).getTime())) { settleAuction(db, a); changed = true; }
    // Auto-simulate fixtures at their scheduled server time
    for (const f of db.fixtures) {
      const world = db.worlds.find(w => w.id === f.worldId); if (!world) continue;
      if (f.status === 'SCHEDULED' && now >= new Date(f.scheduledAt).getTime() - 5 * 60000 && now < new Date(f.scheduledAt).getTime()) { f.status = 'PREPARING'; changed = true; }
      if ((f.status === 'SCHEDULED' || f.status === 'PREPARING') && now >= new Date(f.scheduledAt).getTime()) {
        f.status = 'LIVE'; emit(db, f.worldId, 'MATCH_STARTED', { fixtureId: f.id });
        const result = simulate(db, world, f);
        f.result = result; f.status = 'COMPLETED'; f.completedAt = nowISO();
        applyResult(db, world, f, result);
        emit(db, f.worldId, 'MATCH_COMPLETED', { fixtureId: f.id, summary: result.summary });
        news(db, f.worldId, 'MATCH_COMPLETED', result.summary, (result.report || []).join(' '));
        for (const mid of [f.homeMembershipId, f.awayMembershipId]) {
          const m = db.memberships.find(x => x.id === mid);
          if (m) notify(db, m.userId, f.worldId, 'MATCH_COMPLETED', `Match completed: ${result.summary}. Check Match Centre for the scorecard${m.lastSeenAt && new Date(m.lastSeenAt) < new Date(f.scheduledAt) ? ' — you missed this match while offline' : ''}.`);
        }
        changed = true;
      }
    }
    if (changed) save();
  } finally { ticking = false; }
}
function startScheduler() {
  const ms = parseInt(process.env.SCHEDULER_INTERVAL_MS || '10000', 10);
  setInterval(() => { try { tick(); } catch (e) { console.error('[scheduler]', e); } }, ms);
  console.log(`[scheduler] ticking every ${ms}ms (server time is source of truth)`);
}
module.exports = { tick, startScheduler, settleAuction, openAuctions };
