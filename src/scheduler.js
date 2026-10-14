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
const { withDefaults, buildAutoBowlingPlan } = require('./tactics');
const { AI_SQUAD_TARGET, topBid, validBids, squadCount, leadingList, validateBid, placeBid } = require('./bids');
const { expireOffers, aiTransfers } = require('./offers');
// Share of its budget an AI may have committed to NEW fronts. The rest
// is a war-chest, kept free so the AI can always defend its targets.
const AI_WARCHEST_FRACTION = 0.6;
let ticking = false;

/**
 * Start a world NOW (creator action — POST /api/worlds/:id/start).
 * The auction opens immediately for its stored 24-hour window; the
 * season start is pushed out if it would no longer leave room for the
 * auction + squad building. Uses the same openAuctions() path as the
 * scheduled start, so both produce identical world state.
 */
function startWorld(db, world) {
  const now = Date.now();
  if (!world.auctionStartAt || new Date(world.auctionStartAt).getTime() > now) world.auctionStartAt = nowISO();
  // Fast (test) pace compresses the run-up to the season: draft
  // worlds (no auction) start ~2 minutes after the creator start;
  // auction worlds get the 10-minute auction plus a 2-minute
  // squad-building buffer. Standard pace is unchanged (3 days).
  const fast = world.pace === 'fast';
  const minSeasonMs = fast ? (world.squadMode === 'draft' ? 2 : 12) * 60000 : 3 * 24 * 3600 * 1000;
  const minSeason = new Date(world.auctionStartAt).getTime() + minSeasonMs;
  if (fast || !world.seasonStartAt || new Date(world.seasonStartAt).getTime() < minSeason)
    world.seasonStartAt = new Date(minSeason).toISOString();
  if (world.squadMode === 'draft') {
    // Draft mode: no auction — squads are distributed equally and the
    // world goes straight to squad building (season timing unchanged).
    distributeDraft(db, world);
    world.state = 'SQUAD_BUILDING';
    emit(db, world.id, 'WORLD_STARTED', { name: world.name, squadMode: 'draft' });
    news(db, world.id, 'WORLD_STARTED', 'World started', 'Squads have been distributed equally to every club — no auction in draft mode. Trade in the transfer market.');
    db.memberships.filter(m => m.worldId === world.id)
      .forEach(m => notify(db, m.userId, world.id, 'WORLD_STARTED', `World "${world.name}" has started — your squad of ${DRAFT_SQUAD_SIZE} players is ready.`));
    return;
  }
  world.state = 'AUCTION';
  openAuctions(db, world);
  emit(db, world.id, 'WORLD_STARTED', { name: world.name });
  news(db, world.id, 'WORLD_STARTED', 'World started', world.pace === 'fast' ? 'The player auction is open for 10 minutes (fast pace).' : 'The player auction is open for 24 hours.');
  db.memberships.filter(m => m.worldId === world.id)
    .forEach(m => notify(db, m.userId, world.id, 'WORLD_STARTED', `World "${world.name}" has started — the player auction is open.`));
}

/* ------------------------------------------------------------------ *
 * World Mode 2 — draft distribution.
 *
 * Every club receives exactly DRAFT_SQUAD_SIZE players from the pool,
 * balanced so each club's TOTAL rating lands within ~2% of the mean.
 * The pool is ordered by rating (descending) with a seeded shuffle
 * inside equal-rating groups, so every world drafts differently.
 * Dealing is quota-first: clubs short on wicket-keepers get the best
 * remaining WKs, then bowling options (Bowler/All-Rounder) up to the
 * quota, then batting-capable players (Batsman/AR/WK); remaining slots
 * are filled rating-first, always handing the next player to the club
 * that needs him most (fewest in the category, then lowest total
 * rating). A final repair pass swaps same-role players between the
 * strongest and weakest clubs until the spread is inside tolerance —
 * same-role swaps preserve every quota. Budgets are untouched (₹100 Cr)
 * and assigned players cost nothing. AI-filled clubs are distributed
 * identically. Unassigned templates stay in the central market.
 * ------------------------------------------------------------------ */
const DRAFT_SQUAD_SIZE = 20, DRAFT_MIN_WK = 2, DRAFT_MIN_BOWL = 6, DRAFT_MIN_BAT = 7;
const DRAFT_TOLERANCE = 0.02; // max (max-min)/mean spread of club total ratings

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function distributeDraft(db, world) {
  if (db.worldPlayers.some(p => p.worldId === world.id)) return 0;
  const members = db.memberships.filter(m => m.worldId === world.id);
  const rnd = mulberry32(hashString(String(world.id) + '|' + String(world.createdAt || '')));
  // rating-descending pool, shuffled inside equal-rating groups
  const byRating = [...PLAYERS].sort((a, b) => b.rating - a.rating);
  const pool = [];
  for (let i = 0; i < byRating.length;) {
    let j = i;
    while (j < byRating.length && byRating[j].rating === byRating[i].rating) j++;
    const grp = byRating.slice(i, j);
    for (let k = grp.length - 1; k > 0; k--) { const x = Math.floor(rnd() * (k + 1)); [grp[k], grp[x]] = [grp[x], grp[k]]; }
    pool.push(...grp); i = j;
  }
  const isBowl = t => t.role === 'Bowler' || t.role === 'All-Rounder';
  const isBat = t => t.role === 'Batsman' || t.role === 'All-Rounder' || t.role === 'Wicket-Keeper';
  const clubs = members.map((m, idx) => ({ m, idx, players: [], total: 0, wk: 0, bowl: 0, bat: 0 }));
  const used = new Set();
  const assign = (club, t) => {
    club.players.push(t); club.total += t.rating; used.add(t.id);
    if (t.role === 'Wicket-Keeper') club.wk++;
    if (isBowl(t)) club.bowl++;
    if (isBat(t)) club.bat++;
  };
  // hand the next player to the club that needs the category most
  const deal = (list, key, quota) => {
    for (const t of list) {
      if (clubs.every(c => c[key] >= quota)) break;
      if (used.has(t.id)) continue;
      const c = clubs.filter(x => x.players.length < DRAFT_SQUAD_SIZE)
        .sort((a, b) => a[key] - b[key] || a.total - b.total || a.idx - b.idx)[0];
      if (!c) break;
      assign(c, t);
    }
  };
  deal(pool.filter(t => t.role === 'Wicket-Keeper'), 'wk', DRAFT_MIN_WK);
  deal(pool.filter(isBowl), 'bowl', DRAFT_MIN_BOWL);
  deal(pool.filter(isBat), 'bat', DRAFT_MIN_BAT);
  for (const t of pool) { // fill remaining slots, weakest club first
    if (clubs.every(c => c.players.length >= DRAFT_SQUAD_SIZE)) break;
    if (used.has(t.id)) continue;
    const c = clubs.filter(x => x.players.length < DRAFT_SQUAD_SIZE)
      .sort((a, b) => a.players.length - b.players.length || a.total - b.total || a.idx - b.idx)[0];
    if (!c) break;
    assign(c, t);
  }
  // repair pass: pull the strongest and weakest club totals together
  for (let iter = 0; iter < 500 && clubs.length > 1; iter++) {
    const mean = clubs.reduce((s, c) => s + c.total, 0) / clubs.length;
    const hi = clubs.reduce((a, c) => c.total > a.total ? c : a, clubs[0]);
    const lo = clubs.reduce((a, c) => c.total < a.total ? c : a, clubs[0]);
    const diff = hi.total - lo.total;
    if (hi === lo || diff <= Math.max(1, DRAFT_TOLERANCE * mean)) break;
    let best = null;
    for (const a of hi.players) for (const b of lo.players) {
      if (a.role !== b.role) continue; // same role => quotas preserved
      const d = a.rating - b.rating;
      if (d <= 0) continue;
      const nd = Math.abs((hi.total - d) - (lo.total + d));
      if (!best || nd < best.nd) best = { a, b, nd };
    }
    if (!best || best.nd >= diff) break;
    hi.players[hi.players.indexOf(best.a)] = best.b;
    lo.players[lo.players.indexOf(best.b)] = best.a;
    hi.total -= best.a.rating - best.b.rating;
    lo.total += best.a.rating - best.b.rating;
  }
  const ownerOf = new Map();
  clubs.forEach(c => c.players.forEach(t => ownerOf.set(t.id, c.m.id)));
  for (const t of PLAYERS) {
    const owner = ownerOf.get(t.id) || null;
    db.worldPlayers.push({
      id: id('wp'), worldId: world.id, templateId: t.id, ownerMembershipId: owner,
      status: owner ? 'OWNED' : 'IN_MARKET', form: 50, fitness: 100, morale: 70
    });
  }
  emit(db, world.id, 'SQUADS_DISTRIBUTED', { clubs: members.length, perClub: DRAFT_SQUAD_SIZE });
  news(db, world.id, 'SQUADS_DISTRIBUTED', 'Squads distributed',
    `Every club received ${DRAFT_SQUAD_SIZE} players, balanced by rating and role. Budgets stay at ₹100 Cr — trade with other clubs in the transfer market.`);
  return members.length * DRAFT_SQUAD_SIZE;
}

/**
 * AI managers take their auction turn. Bounded and polite: per tick
 * each AI places at most 2 bids, bids a modest increment over the
 * current price, and never snipes in the final minutes. Every bid goes
 * through the same validateBid() guard as a human bid (squad cap +
 * budget reserve for a minimum 18-player squad) and stops once the
 * AI's squad + live leads reach its target size.
 *
 * Candidate order per AI: FIRST the auctions it was outbid on (it holds
 * a live bid but no longer leads — a manager defends its targets
 * before opening new fronts), then new auctions, highest-rated first.
 * And an AI only opens a NEW front while its live commitments stay
 * under AI_WARCHEST_FRACTION of its budget.
 *
 * Why: the old policy opened 2 new fronts per tick with no commitment
 * cap, so within ~10 ticks an AI led ~18 star-heavy auctions totalling
 * ≈₹99.95 Cr of its ₹100 Cr (measured on a live-style repro). From
 * then on validateBid() rejected EVERY further bid ("Insufficient
 * transfer funds.") and the target-count check was saturated too —
 * the AI was frozen for the rest of the auction. When a human then
 * outbid it on a star (the reported case used an undisclosed bid, but
 * disclosed bids froze identically), re-bidding needed top+5% while
 * its other leads still committed ≈₹85 Cr, so it could never respond
 * on that auction again; the other AIs never reached it either, each
 * scanning from its own offset and spending its 2-bid quota first.
 * Masking was NOT the cause: this path reads raw db.bids via
 * bids.js (topBid/validBids/leadingList); bidView/auctionView masking
 * exists only in HTTP serialization (src/server.js) and never feeds
 * server logic.
 */
function aiTakeTurn(db, world) {
  const now = Date.now();
  const aiMembers = db.memberships.filter(m => m.worldId === world.id && m.ai);
  if (!aiMembers.length) return false;
  const open = db.auctions.filter(a => a.worldId === world.id && a.status === 'OPEN'
    && new Date(a.auctionEndsAt).getTime() - now > (world.pace === 'fast' ? 60000 : 10 * 60 * 1000)); // not the final-minutes chaos (final minute in fast pace)
  if (!open.length) return false;
  const ranked = open.map(a => {
    const wp = db.worldPlayers.find(p => p.id === a.worldPlayerId);
    const t = PLAYERS.find(p => p.id === (wp && wp.templateId)) || {};
    return { auction: a, rating: t.rating || 0 };
  }).sort((x, y) => y.rating - x.rating);
  let changed = false;
  aiMembers.forEach((m, mi) => {
    let placed = 0;
    const leads = leadingList(db, world.id, m.id);
    let committedCount = squadCount(db, world.id, m.id) + leads.length;
    let committedCr = leads.reduce((s, l) => s + l.bid.amount, 0);
    const leadIds = new Set(leads.map(l => l.auction.id));
    // Auctions this AI is contesting but no longer leads: defend first.
    const defend = ranked.filter(r => !leadIds.has(r.auction.id)
      && validBids(db, r.auction.id).some(b => b.membershipId === m.id));
    const defendIds = new Set(defend.map(r => r.auction.id));
    const offset = ranked.length ? (mi * 13) % ranked.length : 0; // AIs don't all chase the same player first
    const fresh = [];
    for (let i = 0; i < ranked.length; i++) {
      const r = ranked[(offset + i) % ranked.length];
      if (!leadIds.has(r.auction.id) && !defendIds.has(r.auction.id)) fresh.push(r);
    }
    for (const { auction } of [...defend, ...fresh]) {
      if (placed >= 2 || committedCount >= AI_SQUAD_TARGET) break;
      const top = topBid(db, auction.id);
      if (top && top.membershipId === m.id) continue; // already leading it
      const isDefend = defendIds.has(auction.id);
      // War-chest: new fronts only while commitments stay under the
      // ceiling — otherwise the AI strands its whole budget in early
      // leads and can never defend any of them (see note above).
      // Defending a lost lead is exempt; validateBid still applies.
      if (!isDefend && committedCr >= AI_WARCHEST_FRACTION * m.budget) continue;
      const amount = top ? +(top.amount + Math.max(0.1, Math.round(top.amount * 5) / 100)).toFixed(2) : auction.baseValue;
      if (validateBid(db, m, auction, amount)) continue; // same guard as humans
      placeBid(db, m, auction, amount, {});
      placed++; committedCount++; committedCr = +(committedCr + amount).toFixed(2); changed = true;
    }
  });
  return changed;
}

/**
 * AI managers pick a playing XI + captain/vice-captain from what they
 * won, and set sensible detailed tactics: a batting order that follows
 * each player's preferred position, a 20-over bowling plan built from
 * bowling ratings and preferred phases, each player's default approach,
 * and a standing home pitch (fixed per club, varied across clubs).
 */
function aiPickTeams(db, world) {
  db.memberships.filter(m => m.worldId === world.id && m.ai).forEach(m => {
    const owned = db.worldPlayers.filter(p => p.worldId === world.id && p.ownerMembershipId === m.id)
      .map(p => ({ p, t: PLAYERS.find(x => x.id === p.templateId) || {} }));
    const byRating = [...owned].sort((a, b) => (b.t.rating || 0) - (a.t.rating || 0));
    m.xi = byRating.slice(0, 11).map(o => o.p.id);
    const byLeadership = [...owned].sort((a, b) => (b.t.leadership || 0) - (a.t.leadership || 0));
    if (byLeadership[0]) m.captainId = byLeadership[0].p.id;
    if (byLeadership[1]) m.viceCaptainId = byLeadership[1].p.id;
    const xiMerged = m.xi.map(pid => { const o = owned.find(x => x.p.id === pid); return o ? { ...o.t, ...o.p } : null; }).filter(Boolean);
    const battingOrder = [...xiMerged]
      .sort((a, b) => (a.prefBatPos || 11) - (b.prefBatPos || 11) || (b.batting || 0) - (a.batting || 0))
      .map(p => p.id);
    const playerApproach = {};
    xiMerged.forEach(p => { playerApproach[p.id] = p.approach || 'balanced'; });
    const pitchPick = ['batting', 'balanced', 'bowling', 'balanced'][[...m.clubName].reduce((s, c) => s + c.charCodeAt(0), 0) % 4];
    const prev = m.tactics || {};
    m.tactics = { ...withDefaults(prev),
      battingOrder, bowlingPlan: buildAutoBowlingPlan(xiMerged), playerApproach,
      homePitch: prev.homePitch || pitchPick };
  });
}

function openAuctions(db, world) {
  if (db.auctions.some(a => a.worldId === world.id)) return;
  const start = new Date(world.auctionStartAt || Date.now());
  const fast = world.pace === 'fast';
  const durationMs = fast ? 10 * 60000 : 24 * 3600 * 1000; // fast pace: a 10-minute auction so the mode is testable end to end
  for (const t of PLAYERS) {
    const wpId = id('wp');
    db.worldPlayers.push({ id: wpId, worldId: world.id, templateId: t.id, ownerMembershipId: null, status: 'IN_MARKET', form: 50, fitness: 100, morale: 70 });
    db.auctions.push({ id: id('auc'), worldId: world.id, worldPlayerId: wpId, baseValue: t.baseValue,
      auctionStartsAt: start.toISOString(), auctionEndsAt: new Date(start.getTime() + durationMs).toISOString(),
      status: 'OPEN', highestBidId: null, relistCount: 0 });
  }
  emit(db, world.id, 'AUCTION_STARTED', {}); news(db, world.id, 'AUCTION_STARTED', 'Player auction is open', `${PLAYERS.length} players are in the central market for ${fast ? '10 minutes (fast pace)' : '24 hours'}.`);
}

function settleAuction(db, auction) {
  // Called once, synchronously — settlement is atomic in this process.
  const bids = db.bids.filter(b => b.auctionId === auction.id && b.status === 'VALID')
    .sort((a, b) => b.amount - a.amount || new Date(a.createdAt) - new Date(b.createdAt)); // earliest wins a tie
  const wp = db.worldPlayers.find(p => p.id === auction.worldPlayerId);
  const tpl = PLAYERS.find(p => p.id === (wp && wp.templateId)) || {};
  auction.status = 'EXPIRED'; emit(db, auction.worldId, 'AUCTION_EXPIRED', { auctionId: auction.id });
  if (!bids.length) { // no offers -> relist for another window (24h standard, 10 min fast pace)
    const w = db.worlds.find(x => x.id === auction.worldId);
    auction.status = 'OPEN'; auction.relistCount = (auction.relistCount || 0) + 1;
    auction.auctionStartsAt = nowISO(); auction.auctionEndsAt = new Date(Date.now() + (w && w.pace === 'fast' ? 10 * 60000 : 24 * 3600 * 1000)).toISOString();
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
  // Tactics fit: players used in their preferred position/phases gain
  // morale; misused players lose morale and form (see matchEngine).
  for (const e of (result && result.moraleEffects) || []) {
    const p = db.worldPlayers.find(x => x.id === e.worldPlayerId && x.worldId === world.id);
    if (!p) continue;
    p.morale = Math.min(99, Math.max(10, (p.morale ?? 70) + (e.moraleDelta || 0)));
    p.form = Math.min(99, Math.max(20, (p.form ?? 50) + (e.formDelta || 0)));
  }
}

/* ------------------------------------------------------------------ *
 * Season rollover — the loop after SEASON_FINISHED.
 *
 * When the last fixture of a season completes, finishSeason() records
 * the final standings + champion on the world and stamps
 * seasonFinishedAt. After a gap (standard: 3 days; fast pace: 10
 * minutes) the tick runs rolloverSeason(): prize money is paid by
 * final position, the league table resets, players refresh (form to
 * a fresh random 60–75, morale halfway back to 70, rating drifts
 * −1/0/+1 — kept as a capped per-player ratingDelta so it persists),
 * squads and ownership are RETAINED, fresh fixtures are generated and
 * the world goes straight back to ACTIVE_SEASON at seasonNumber+1
 * (passing briefly through OFF_SEASON inside the same transition).
 * ------------------------------------------------------------------ */
const PRIZE_TABLE = [20, 15, 12, 10, 8, 7, 6, 5, 4, 3]; // ₹ Cr for positions 1..10; fewer clubs take the table by position index
const ROLLOVER_GAP_MS = { standard: 3 * 24 * 3600 * 1000, fast: 10 * 60000 };
const rolloverGapMs = world => ROLLOVER_GAP_MS[world.pace === 'fast' ? 'fast' : 'standard'];

function finalStandings(db, world) {
  const club = mid => (db.memberships.find(m => m.id === mid) || {}).clubName || '—';
  return db.league.filter(l => l.worldId === world.id)
    .sort((a, b) => b.points - a.points || b.nrr - a.nrr || b.won - a.won)
    .map((l, i) => ({ position: i + 1, membershipId: l.membershipId, clubName: club(l.membershipId),
      played: l.played, won: l.won, lost: l.lost, tied: l.tied, points: l.points, nrr: l.nrr }));
}

function finishSeason(db, world) {
  const standings = finalStandings(db, world);
  const champion = standings[0] || null;
  world.lastSeasonStandings = standings;
  world.championMembershipId = champion ? champion.membershipId : null;
  world.seasonFinishedAt = nowISO();
  world.state = 'SEASON_FINISHED';
  const season = world.seasonNumber || 1;
  emit(db, world.id, 'SEASON_COMPLETED', { season, champion: champion ? champion.clubName : null, championMembershipId: world.championMembershipId });
  news(db, world.id, 'SEASON_COMPLETED', `Season ${season} complete — ${champion ? champion.clubName : '—'} are champions!`,
    champion ? `${champion.clubName} topped the table with ${champion.points} points. Prize money is paid when the next season is set up.` : '');
}

function rolloverSeason(db, world) {
  const season = world.seasonNumber || 1;
  // Normally finishSeason() already snapshotted the final table; if a
  // world reached SEASON_FINISHED without one (older saves), rebuild
  // it from the league rows before they are reset below.
  if (!(Array.isArray(world.lastSeasonStandings) && world.lastSeasonStandings.length)) {
    world.lastSeasonStandings = finalStandings(db, world);
    world.championMembershipId = world.lastSeasonStandings.length ? world.lastSeasonStandings[0].membershipId : null;
  }
  const standings = world.lastSeasonStandings;
  // Prize money by final position (paid into the retained budgets).
  const awards = standings.map(s => ({ ...s, prize: PRIZE_TABLE[s.position - 1] || 0 }));
  for (const a of awards) {
    if (!a.prize) continue;
    const m = db.memberships.find(x => x.id === a.membershipId);
    if (m) m.budget = +(m.budget + a.prize).toFixed(2);
  }
  emit(db, world.id, 'PRIZE_MONEY', { season, awards: awards.map(a => ({ club: a.clubName, position: a.position, amount: a.prize })) });
  // League table resets for the new season (rows are kept, counters zeroed).
  for (const l of db.league.filter(l => l.worldId === world.id))
    Object.assign(l, { played: 0, won: 0, lost: 0, tied: 0, points: 0, runsFor: 0, runsAgainst: 0, nrr: 0 });
  // Player refresh: squads/ownership retained; form re-rolled to
  // 60–75, morale pulled halfway back to 70, and each player's rating
  // drifts −1/0/+1 (stored as ratingDelta, capped at ±3 over a career).
  for (const p of db.worldPlayers.filter(p => p.worldId === world.id)) {
    p.form = 60 + Math.floor(Math.random() * 16);
    const morale = p.morale ?? 70;
    p.morale = Math.round(morale + (70 - morale) / 2);
    p.ratingDelta = Math.max(-3, Math.min(3, (p.ratingDelta || 0) + (Math.floor(Math.random() * 3) - 1)));
  }
  world.seasonNumber = season + 1;
  world.state = 'OFF_SEASON'; // brief — the new season is set up in the same transition below
  world.seasonStartAt = new Date(Date.now() + (world.pace === 'fast' ? 2 * 60000 : 24 * 3600 * 1000)).toISOString();
  const fx = generateFixtures(db, world);
  db.fixtures.push(...fx);
  aiPickTeams(db, world); // AI managers re-pick XI/tactics for the new season
  world.state = 'ACTIVE_SEASON';
  world.seasonFinishedAt = null;
  emit(db, world.id, 'NEW_SEASON', { season: world.seasonNumber, fixtures: fx.length });
  news(db, world.id, 'NEW_SEASON', `Season ${world.seasonNumber} fixtures released`,
    `${fx.length} fixtures generated for season ${world.seasonNumber} of "${world.name}". Squads carry over; prize money from season ${season} has been paid.`);
  db.memberships.filter(m => m.worldId === world.id)
    .forEach(m => notify(db, m.userId, world.id, 'NEW_SEASON', `Season ${world.seasonNumber} has started in "${world.name}" — fixtures are out and prize money has been paid.`));
  return fx.length;
}

function tick() {
  if (ticking) return; ticking = true;
  try {
    const db = load(); const now = Date.now(); let changed = false;
    for (const world of db.worlds) {
      if (!world.seasonNumber) { world.seasonNumber = 1; changed = true; } // worlds created before season numbering
      // State machine, driven by stored server timestamps
      if (world.state === 'CREATED') { world.state = 'RECRUITING'; changed = true; }
      if (world.state === 'RECRUITING' && world.auctionStartAt && now >= new Date(world.auctionStartAt).getTime()) {
        if (world.squadMode === 'draft') { distributeDraft(db, world); world.state = 'SQUAD_BUILDING'; }
        else { world.state = 'AUCTION'; openAuctions(db, world); }
        changed = true;
      }
      if (world.state === 'AUCTION' && !db.auctions.some(a => a.worldId === world.id && a.status === 'OPEN')) { world.state = 'SQUAD_BUILDING'; changed = true; }
      if ((world.state === 'SQUAD_BUILDING' || world.state === 'AUCTION') && world.seasonStartAt && now >= new Date(world.seasonStartAt).getTime() - 24 * 3600 * 1000 && world.state !== 'PRE_SEASON') {
        if (world.state === 'SQUAD_BUILDING') { world.state = 'PRE_SEASON'; changed = true; }
      }
      if ((world.state === 'PRE_SEASON' || world.state === 'SQUAD_BUILDING') && world.seasonStartAt && now >= new Date(world.seasonStartAt).getTime()) {
        const fx = generateFixtures(db, world);
        db.fixtures.push(...fx); aiPickTeams(db, world); world.state = 'ACTIVE_SEASON';
        emit(db, world.id, 'SEASON_STARTED', { fixtures: fx.length }); news(db, world.id, 'SEASON_STARTED', 'Season started', `${fx.length} fixtures generated.`);
        db.memberships.filter(m => m.worldId === world.id).forEach(m => notify(db, m.userId, world.id, 'SEASON_STARTED', 'Your season has started. First fixture is scheduled.'));
        changed = true;
      }
      if (world.state === 'ACTIVE_SEASON') {
        const mine = db.fixtures.filter(f => f.worldId === world.id);
        if (mine.length && mine.every(f => ['COMPLETED', 'CANCELLED'].includes(f.status))) { finishSeason(db, world); changed = true; }
      }
      if (world.state === 'SEASON_FINISHED') {
        if (!world.seasonFinishedAt) {
          // Finished before rollover tracking existed: start the gap
          // clock now and snapshot the final table if it is missing.
          world.seasonFinishedAt = nowISO();
          if (!Array.isArray(world.lastSeasonStandings)) {
            const s = finalStandings(db, world);
            world.lastSeasonStandings = s;
            world.championMembershipId = s.length ? s[0].membershipId : null;
          }
          changed = true;
        } else if (now >= new Date(world.seasonFinishedAt).getTime() + rolloverGapMs(world)) {
          rolloverSeason(db, world); changed = true;
        }
      }
      // AI managers bid while the auction is live (same rules as humans)
      if (world.state === 'AUCTION' && aiTakeTurn(db, world)) changed = true;
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
    // Transfer market: expire stale offers, then AI managers resolve
    // offers made to them and (bounded, one per world) make offers.
    if (expireOffers(db, now)) changed = true;
    for (const world of db.worlds) if (aiTransfers(db, world)) changed = true;
    if (changed) save();
  } finally { ticking = false; }
}
function startScheduler() {
  const ms = parseInt(process.env.SCHEDULER_INTERVAL_MS || '10000', 10);
  setInterval(() => { try { tick(); } catch (e) { console.error('[scheduler]', e); } }, ms);
  console.log(`[scheduler] ticking every ${ms}ms (server time is source of truth)`);
}
module.exports = { tick, startScheduler, settleAuction, openAuctions, startWorld, aiPickTeams, distributeDraft, finishSeason, rolloverSeason, finalStandings, PRIZE_TABLE, ROLLOVER_GAP_MS, AI_WARCHEST_FRACTION, DRAFT_SQUAD_SIZE, DRAFT_MIN_WK, DRAFT_MIN_BOWL, DRAFT_MIN_BAT };
