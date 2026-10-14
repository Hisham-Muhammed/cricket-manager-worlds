'use strict';
/**
 * Transfer market — manager-to-manager offers for owned players, like a
 * football transfer market. Used in both squad modes once squads exist.
 *
 * An offer carries a fee, an optional signing bonus (paid together with the
 * fee at acceptance), an optional player swap and an optional captaincy
 * promise. Nothing moves when an offer is created: acceptance RE-VALIDATES
 * everything (funds, squad sizes 18–25, ownership) and only then applies
 * the exchange atomically. Offers expire 72h after creation.
 *
 * AI behaviour (driven from the scheduler tick, bounded):
 *  - An AI seller auto-accepts when fee+bonus >= 1.15x the target's base
 *    value AND its squad stays >= 19 after the exchange AND (no swap, or
 *    the incoming swap player is rated at most 2 below the outgoing one);
 *    otherwise it auto-rejects.
 *  - AI buyers make at most one new offer per world per tick: for a player
 *    who fills the AI's weakest role, at 1.1x base value, no swap.
 */
const PLAYERS = require('./players');
const { id, nowISO, emit, notify, news } = require('./db');
const { MIN_SQUAD, MAX_SQUAD, squadCount } = require('./bids');

const OFFER_TTL_MS = 72 * 3600 * 1000;
const PROMISES = ['captain', 'vice_captain'];
const AI_ACCEPT_MULT = 1.15;
const AI_OFFER_MULT = 1.1;

const money = v => Math.round((+v || 0) * 100) / 100;
const tplOfWp = (db, wpId) => {
  const wp = db.worldPlayers.find(p => p.id === wpId);
  return wp ? (PLAYERS.find(p => p.id === wp.templateId) || {}) : {};
};
const offerTotal = o => +((o.fee || 0) + (o.bonus || 0)).toFixed(2);

/** Strip a departed player from a club's XI, tactics and captaincy. */
function cleanClubRefs(m, wpId) {
  if (Array.isArray(m.xi)) m.xi = m.xi.filter(x => x !== wpId);
  if (m.captainId === wpId) m.captainId = null;
  if (m.viceCaptainId === wpId) m.viceCaptainId = null;
  if (m.tactics && typeof m.tactics === 'object') {
    if (Array.isArray(m.tactics.battingOrder)) m.tactics.battingOrder = m.tactics.battingOrder.filter(x => x !== wpId);
    if (m.tactics.bowlingPlan) delete m.tactics.bowlingPlan[wpId];
    if (m.tactics.playerApproach) delete m.tactics.playerApproach[wpId];
  }
}

/**
 * Create an offer. Returns { offer } or { error, status }.
 * Validates: target club exists and is not the buyer, target player is
 * owned by the target club (and not by the buyer -> 400), swap player (if
 * any) is owned by the buyer, fee/bonus >= 0, no duplicate PENDING offer
 * from the buyer for the same player (409).
 */
function createOffer(db, world, buyer, input) {
  input = input || {};
  const fee = money(input.fee), bonus = money(input.bonus);
  if (!Number.isFinite(fee) || fee < 0 || !Number.isFinite(bonus) || bonus < 0)
    return { error: 'Fee and bonus must be non-negative amounts.', status: 400 };
  const promise = input.promise ? input.promise : null;
  if (promise !== null && !PROMISES.includes(promise))
    return { error: `Promise must be one of: ${PROMISES.join(', ')}.`, status: 400 };
  const seller = db.memberships.find(m => m.id === input.toMembershipId && m.worldId === world.id);
  if (!seller) return { error: 'Target club is not a member of this world.', status: 400 };
  if (seller.id === buyer.id) return { error: 'You cannot make an offer to your own club.', status: 400 };
  const target = db.worldPlayers.find(p => p.id === input.worldPlayerId && p.worldId === world.id);
  if (!target) return { error: 'Player not found in this world.', status: 404 };
  if (target.ownerMembershipId === buyer.id) return { error: 'You cannot offer for your own player.', status: 400 };
  if (target.ownerMembershipId !== seller.id) return { error: 'That player is not owned by the target club.', status: 400 };
  let swap = null;
  if (input.swapWorldPlayerId) {
    swap = db.worldPlayers.find(p => p.id === input.swapWorldPlayerId && p.worldId === world.id);
    if (!swap) return { error: 'Swap player not found in this world.', status: 404 };
    if (swap.ownerMembershipId !== buyer.id) return { error: 'The swap player must be one of your own players.', status: 400 };
    if (swap.id === target.id) return { error: 'The swap player cannot be the target player.', status: 400 };
  }
  const dup = db.offers.some(o => o.worldId === world.id && o.fromMembershipId === buyer.id
    && o.worldPlayerId === target.id && o.status === 'PENDING');
  if (dup) return { error: 'You already have a pending offer for this player.', status: 409 };
  const now = Date.now();
  const offer = {
    id: id('off'), worldId: world.id, fromMembershipId: buyer.id, toMembershipId: seller.id,
    worldPlayerId: target.id, fee, bonus, swapWorldPlayerId: swap ? swap.id : null, promise,
    status: 'PENDING', createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + OFFER_TTL_MS).toISOString(), resolvedAt: null
  };
  db.offers.push(offer);
  const t = tplOfWp(db, target.id);
  emit(db, world.id, 'TRANSFER_OFFER_CREATED', { player: t.name, fromClub: buyer.clubName, toClub: seller.clubName, fee, bonus });
  notify(db, seller.userId, world.id, 'TRANSFER_OFFER',
    `${buyer.clubName} offered ₹${offerTotal(offer)} Cr for your player ${t.name}. Review it in Transfers & Offers.`);
  return { offer };
}

/**
 * Accept an offer. RE-VALIDATES the whole deal first (expiry, funds, squad
 * bounds after the exchange, ownership unchanged) and only then applies it
 * atomically: budgets move, ownership swaps, and a captaincy promise points
 * the buyer's captain/vice-captain at the incoming player.
 * Returns { ok: true } or { error, status } — on failure nothing has moved.
 */
function applyAccept(db, offer) {
  if (offer.status !== 'PENDING') return { error: 'This offer is no longer pending.', status: 409 };
  if (Date.now() >= new Date(offer.expiresAt).getTime()) {
    offer.status = 'EXPIRED'; offer.resolvedAt = nowISO();
    return { error: 'This offer has expired.', status: 409 };
  }
  const world = db.worlds.find(w => w.id === offer.worldId);
  const buyer = db.memberships.find(m => m.id === offer.fromMembershipId);
  const seller = db.memberships.find(m => m.id === offer.toMembershipId);
  if (!world || !buyer || !seller) return { error: 'This offer can no longer be completed.', status: 409 };
  const target = db.worldPlayers.find(p => p.id === offer.worldPlayerId && p.worldId === world.id);
  if (!target || target.ownerMembershipId !== seller.id)
    return { error: 'The player is no longer with the selling club.', status: 409 };
  let swap = null;
  if (offer.swapWorldPlayerId) {
    swap = db.worldPlayers.find(p => p.id === offer.swapWorldPlayerId && p.worldId === world.id);
    if (!swap || swap.ownerMembershipId !== buyer.id)
      return { error: 'The swap player is no longer with the buying club.', status: 409 };
  }
  const total = offerTotal(offer);
  if (buyer.budget < total) return { error: 'The buying club no longer has the funds for this deal.', status: 409 };
  const buyerAfter = squadCount(db, world.id, buyer.id) + 1 - (swap ? 1 : 0);
  const sellerAfter = squadCount(db, world.id, seller.id) - 1 + (swap ? 1 : 0);
  if (buyerAfter < MIN_SQUAD || buyerAfter > MAX_SQUAD)
    return { error: `The deal would leave ${buyer.clubName} with ${buyerAfter} players (squads must stay ${MIN_SQUAD}–${MAX_SQUAD}).`, status: 409 };
  if (sellerAfter < MIN_SQUAD || sellerAfter > MAX_SQUAD)
    return { error: `The deal would leave ${seller.clubName} with ${sellerAfter} players (squads must stay ${MIN_SQUAD}–${MAX_SQUAD}).`, status: 409 };
  // ---- apply (all validations passed) ----
  buyer.budget = +(buyer.budget - total).toFixed(2);
  seller.budget = +(seller.budget + total).toFixed(2);
  cleanClubRefs(seller, target.id);
  target.ownerMembershipId = buyer.id; target.status = 'OWNED';
  if (swap) { cleanClubRefs(buyer, swap.id); swap.ownerMembershipId = seller.id; swap.status = 'OWNED'; }
  if (offer.promise === 'captain') buyer.captainId = target.id;
  if (offer.promise === 'vice_captain') buyer.viceCaptainId = target.id;
  offer.status = 'ACCEPTED'; offer.resolvedAt = nowISO();
  const t = tplOfWp(db, target.id);
  emit(db, world.id, 'TRANSFER_COMPLETED', { player: t.name, fromClub: seller.clubName, toClub: buyer.clubName, fee: offer.fee, bonus: offer.bonus, swap: !!swap });
  news(db, world.id, 'TRANSFER_COMPLETED', 'TRANSFER COMPLETED',
    `${t.name} has joined ${buyer.clubName} from ${seller.clubName} for ₹${total} Cr${swap ? ' plus a player swap' : ''}.`);
  notify(db, buyer.userId, world.id, 'TRANSFER_OFFER', `Your offer for ${t.name} was accepted — they have joined ${buyer.clubName}.`);
  return { ok: true };
}

/** Close a pending offer as REJECTED or WITHDRAWN, with event + notification. */
function closeOffer(db, offer, status) {
  offer.status = status; offer.resolvedAt = nowISO();
  const t = tplOfWp(db, offer.worldPlayerId);
  const buyer = db.memberships.find(m => m.id === offer.fromMembershipId);
  const seller = db.memberships.find(m => m.id === offer.toMembershipId);
  if (status === 'REJECTED') {
    emit(db, offer.worldId, 'TRANSFER_OFFER_REJECTED', { player: t.name, fromClub: buyer && buyer.clubName, toClub: seller && seller.clubName });
    if (buyer) notify(db, buyer.userId, offer.worldId, 'TRANSFER_OFFER', `Your offer for ${t.name} was rejected by ${seller ? seller.clubName : 'the club'}.`);
  } else if (status === 'WITHDRAWN') {
    emit(db, offer.worldId, 'TRANSFER_OFFER_WITHDRAWN', { player: t.name, fromClub: buyer && buyer.clubName, toClub: seller && seller.clubName });
    if (seller) notify(db, seller.userId, offer.worldId, 'TRANSFER_OFFER', `${buyer ? buyer.clubName : 'A club'} withdrew their offer for ${t.name}.`);
  }
  return offer;
}

/** Expire every PENDING offer past its expiry. Returns the count expired. */
function expireOffers(db, now = Date.now()) {
  let n = 0;
  for (const o of db.offers) {
    if (o.status !== 'PENDING' || now < new Date(o.expiresAt).getTime()) continue;
    o.status = 'EXPIRED'; o.resolvedAt = nowISO(); n++;
    const t = tplOfWp(db, o.worldPlayerId);
    emit(db, o.worldId, 'TRANSFER_OFFER_EXPIRED', { player: t.name });
    const buyer = db.memberships.find(m => m.id === o.fromMembershipId);
    const seller = db.memberships.find(m => m.id === o.toMembershipId);
    if (buyer) notify(db, buyer.userId, o.worldId, 'TRANSFER_OFFER', `Your offer for ${t.name} expired without an answer.`);
    if (seller) notify(db, seller.userId, o.worldId, 'TRANSFER_OFFER', `An offer for your player ${t.name} expired.`);
  }
  return n;
}

/**
 * AI sellers resolve every pending offer addressed to them (see the rule
 * in the header). Returns true if anything changed.
 */
function aiResolveOffers(db, world) {
  const aiIds = new Set(db.memberships.filter(m => m.worldId === world.id && m.ai).map(m => m.id));
  if (!aiIds.size) return false;
  let changed = false;
  for (const o of db.offers.filter(o => o.worldId === world.id && o.status === 'PENDING' && aiIds.has(o.toMembershipId))) {
    const seller = db.memberships.find(m => m.id === o.toMembershipId);
    const target = db.worldPlayers.find(p => p.id === o.worldPlayerId);
    const t = tplOfWp(db, o.worldPlayerId);
    let accept = !!seller && !!target && target.ownerMembershipId === seller.id
      && offerTotal(o) >= +(AI_ACCEPT_MULT * (t.baseValue || 0)).toFixed(2);
    if (accept) {
      const sellerAfter = squadCount(db, world.id, seller.id) - 1 + (o.swapWorldPlayerId ? 1 : 0);
      if (sellerAfter < 19) accept = false;
    }
    if (accept && o.swapWorldPlayerId) {
      const swapT = tplOfWp(db, o.swapWorldPlayerId);
      if ((swapT.rating || 0) < (t.rating || 0) - 2) accept = false;
    }
    if (accept) { if (!applyAccept(db, o).ok) closeOffer(db, o, 'REJECTED'); }
    else closeOffer(db, o, 'REJECTED');
    changed = true;
  }
  return changed;
}

/**
 * AI buyers: at most ONE new offer per world per call — the first AI club
 * that can move buys the best player filling its weakest role (fewest
 * players in the role, tie-break lowest summed rating) at 1.1x base value.
 */
function aiMakeOffer(db, world) {
  const members = db.memberships.filter(m => m.worldId === world.id);
  const ais = members.filter(m => m.ai);
  if (!ais.length) return false;
  const owned = db.worldPlayers.filter(p => p.worldId === world.id && p.ownerMembershipId);
  if (!owned.length) return false;
  for (const buyer of ais) {
    const mine = owned.filter(p => p.ownerMembershipId === buyer.id);
    if (mine.length >= MAX_SQUAD) continue;
    const byRole = {};
    for (const p of mine) {
      const t = tplOfWp(db, p.id);
      (byRole[t.role] = byRole[t.role] || []).push(t.rating || 0);
    }
    const weakestFirst = ['Wicket-Keeper', 'Bowler', 'All-Rounder', 'Batsman']
      .map(r => ({ role: r, count: (byRole[r] || []).length, sum: (byRole[r] || []).reduce((s, x) => s + x, 0) }))
      .sort((a, b) => a.count - b.count || a.sum - b.sum);
    const pendingTargets = new Set(db.offers.filter(o => o.worldId === world.id
      && o.fromMembershipId === buyer.id && o.status === 'PENDING').map(o => o.worldPlayerId));
    for (const { role } of weakestFirst) {
      const candidates = owned.filter(p => p.ownerMembershipId !== buyer.id && !pendingTargets.has(p.id))
        .map(p => ({ p, t: tplOfWp(db, p.id) })).filter(x => x.t.role === role)
        .sort((a, b) => (b.t.rating || 0) - (a.t.rating || 0));
      if (!candidates.length) continue;
      const { p, t } = candidates[0];
      const fee = +(AI_OFFER_MULT * (t.baseValue || 0)).toFixed(2);
      if (buyer.budget < fee) return false;
      const r = createOffer(db, world, buyer, { toMembershipId: p.ownerMembershipId, worldPlayerId: p.id, fee });
      if (r.offer) return true;
      return false;
    }
  }
  return false;
}

/** One scheduler-tick pass over a world's transfer market. */
function aiTransfers(db, world) {
  const a = aiResolveOffers(db, world);
  const b = aiMakeOffer(db, world);
  return a || b;
}

/** API view of an offer with player/club names resolved for the viewer. */
function offerView(db, o, viewerMembershipId) {
  const from = db.memberships.find(m => m.id === o.fromMembershipId);
  const to = db.memberships.find(m => m.id === o.toMembershipId);
  const playerOf = wpId => {
    if (!wpId) return null;
    const t = tplOfWp(db, wpId);
    return { worldPlayerId: wpId, name: t.name, role: t.role, rating: t.rating, baseValue: t.baseValue };
  };
  return {
    id: o.id, worldId: o.worldId, status: o.status,
    fee: o.fee, bonus: o.bonus, total: offerTotal(o), promise: o.promise,
    createdAt: o.createdAt, expiresAt: o.expiresAt, resolvedAt: o.resolvedAt || null,
    direction: o.fromMembershipId === viewerMembershipId ? 'out' : 'in',
    fromMembershipId: o.fromMembershipId, toMembershipId: o.toMembershipId,
    fromClub: from ? from.clubName : '', toClub: to ? to.clubName : '',
    player: playerOf(o.worldPlayerId), swapPlayer: playerOf(o.swapWorldPlayerId)
  };
}

module.exports = {
  OFFER_TTL_MS, PROMISES, AI_ACCEPT_MULT, AI_OFFER_MULT,
  createOffer, applyAccept, closeOffer, expireOffers,
  aiResolveOffers, aiMakeOffer, aiTransfers, offerView, offerTotal, cleanClubRefs
};
