'use strict';
/**
 * AI manager fill — shared by the creator-start route (server.js) and
 * the scheduler's automatic world start / stuck-world rescue.
 *
 * An AI manager is a normal manager record flagged ai:true, created
 * internally only: it gets a random, unusable password hash and the
 * login route refuses ai accounts outright, so it can never be signed
 * into. Its membership is identical to a human's (₹100 Cr, empty squad).
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { id, nowISO, emit } = require('./db');
const { defaultTactics } = require('./tactics');

const CLUBS = ['Chennai Super Kings','Mumbai Indians','Royal Challengers Bengaluru','Kolkata Knight Riders','Rajasthan Royals','Sunrisers Hyderabad','Delhi Capitals','Punjab Kings','Lucknow Super Giants','Gujarat Titans']; // the original IPL franchises
const START_BUDGET = 100;

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

module.exports = { CLUBS, START_BUDGET, fillAiManagers };
