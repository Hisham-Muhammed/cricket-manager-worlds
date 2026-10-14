'use strict';
/**
 * Shared auction bid rules — used by the HTTP bid route AND by the AI
 * managers in the scheduler, so humans and AI play by exactly the same
 * rules:
 *  - a squad holds MIN_SQUAD..MAX_SQUAD players (18..25)
 *  - a bid may not leave the manager unable to afford the cheapest
 *    possible completion of a minimum squad ("budget guard"): nobody
 *    can blow the whole ₹100 Cr on one player and then be unable to
 *    field 18 players.
 * Money is ₹ Cr with 2 decimals throughout.
 */
const PLAYERS = require('./players');
const { id, nowISO, emit, notify } = require('./db');

const MIN_SQUAD = 18;
const MAX_SQUAD = 25;
const AI_SQUAD_TARGET = 20; // AI managers stop bidding once squad + live leads reach this

const tplOf = wp => PLAYERS.find(p => p.id === (wp && wp.templateId)) || {};

/** Valid bids on an auction, best first (amount desc, earliest wins a tie). */
function validBids(db, auctionId) {
  return db.bids.filter(b => b.auctionId === auctionId && b.status === 'VALID')
    .sort((a, b) => b.amount - a.amount || new Date(a.createdAt) - new Date(b.createdAt));
}
function topBid(db, auctionId) { return validBids(db, auctionId)[0] || null; }

/** Players already owned (won) by a membership in a world. */
function squadCount(db, worldId, membershipId) {
  return db.worldPlayers.filter(p => p.worldId === worldId && p.ownerMembershipId === membershipId).length;
}

/** Auctions in this world where the membership currently leads: [{auction, bid}]. */
function leadingList(db, worldId, membershipId) {
  const out = [];
  for (const a of db.auctions.filter(a => a.worldId === worldId && a.status === 'OPEN')) {
    const top = topBid(db, a.id);
    if (top && top.membershipId === membershipId) out.push({ auction: a, bid: top });
  }
  return out;
}

/**
 * Cheapest base price in the world's player pool — the reserve unit for
 * the budget guard. Computed from the world's own auctions (the IPL
 * pool minimum is ₹0.3 Cr), falling back to the global pool.
 */
function cheapestBase(db, worldId) {
  const vals = db.auctions.filter(a => a.worldId === worldId).map(a => a.baseValue);
  return Math.min(...(vals.length ? vals : PLAYERS.map(p => p.baseValue)));
}

/**
 * Squad-size + budget guard. Returns an error string, or null when the
 * bid is allowed. Assumes the basic checks (auction open, amount beats
 * the current top / meets base value) have already passed.
 */
function validateBid(db, membership, auction, amount) {
  const worldId = auction.worldId;
  const squad = squadCount(db, worldId, membership.id);
  const leading = leadingList(db, worldId, membership.id);
  const alreadyLeadingThis = leading.some(l => l.auction.id === auction.id);
  // A raise on an auction you already lead replaces your commitment;
  // any other winning bid adds one, and the squad may never exceed 25.
  if (!alreadyLeadingThis && squad + leading.length >= MAX_SQUAD)
    return `Squad is full (max ${MAX_SQUAD} players).`;
  const othersCommit = leading.filter(l => l.auction.id !== auction.id).reduce((s, l) => s + l.bid.amount, 0);
  const commitments = +(othersCommit + amount).toFixed(2);
  const slotsToFill = Math.max(0, MIN_SQUAD - (squad + leading.filter(l => l.auction.id !== auction.id).length + 1));
  const reserve = +(slotsToFill * cheapestBase(db, worldId)).toFixed(2);
  if (commitments + reserve > membership.budget) {
    if (slotsToFill > 0)
      return `Bid too high — you must keep enough budget to complete a minimum ${MIN_SQUAD}-player squad.`;
    return 'Insufficient transfer funds.';
  }
  return null;
}

/**
 * Place a bid (assumes validation passed). Records the bid, points the
 * auction at it, emits the world event and notifies the outbid leader.
 * An undisclosed bid never leaks its amount or bidder into the public
 * event feed.
 */
function placeBid(db, membership, auction, amount, opts = {}) {
  const prevTop = topBid(db, auction.id);
  const bid = { id: id('bid'), auctionId: auction.id, membershipId: membership.id, amount,
    createdAt: nowISO(), status: 'VALID', undisclosed: !!opts.undisclosed };
  db.bids.push(bid);
  auction.highestBidId = bid.id;
  const wp = db.worldPlayers.find(p => p.id === auction.worldPlayerId);
  const playerName = tplOf(wp).name;
  if (bid.undisclosed) emit(db, auction.worldId, 'BID_PLACED', { player: playerName, undisclosed: true });
  else emit(db, auction.worldId, 'BID_PLACED', { player: playerName, amount, club: membership.clubName });
  if (prevTop && prevTop.membershipId !== membership.id) {
    const out = db.memberships.find(x => x.id === prevTop.membershipId);
    if (out) notify(db, out.userId, auction.worldId, 'BID_PLACED', `Your bid for ${playerName} was outbid.`);
  }
  return bid;
}

module.exports = { MIN_SQUAD, MAX_SQUAD, AI_SQUAD_TARGET, tplOf, validBids, topBid, squadCount, leadingList, cheapestBase, validateBid, placeBid };
