'use strict';
/**
 * Detailed tactics — shared rules for the API (validation), the match
 * engine (auto bowling plan) and the AI managers (auto tactics).
 *
 * A manager's tactics live on their membership (m.tactics):
 *   battingOrder   [worldPlayerId]     — the XI in batting order 1..11
 *   bowlingPlan    { wpId: {pp, mid, death} } — overs per bowler per
 *                    phase. Phases: pp = powerplay (overs 1-6, max 6),
 *                    mid = middle (7-15, max 9), death = 16-20 (max 5).
 *                    A T20 innings is 20 overs; no bowler may bowl
 *                    more than 4. A partial plan is allowed — the
 *                    engine bowls the remaining overs with the best
 *                    available bowlers.
 *   playerApproach { wpId: 'aggressive'|'balanced'|'defensive' }
 *   homePitch      'batting'|'balanced'|'bowling' — the pitch this
 *                    manager prepares for home fixtures (a fixture may
 *                    override it via fixture.pitch).
 * Player preferences (prefBatPos / prefOvers / approach) live on the
 * player templates (src/players.js); the engine compares the manager's
 * choices against them (see matchEngine.computeFit).
 */
const PLAYERS = require('./players');

const PHASE_CAP = { pp: 6, mid: 9, death: 5 };      // overs available per phase
const PHASE_KEYS = ['pp', 'mid', 'death'];
const PHASE_NAME = { pp: 'powerplay', mid: 'middle', death: 'death' };
const KEY_OF_PHASE = { powerplay: 'pp', middle: 'mid', death: 'death' };
const TOTAL_OVERS = 20;
const MAX_BOWLER_OVERS = 4;
const APPROACHES = ['aggressive', 'balanced', 'defensive'];
const PITCHES = ['batting', 'balanced', 'bowling'];

const defaultTactics = () => ({
  formation: 'Balanced', battingApproach: 'Balanced', bowlingApproach: 'Balanced',
  battingOrder: [], bowlingPlan: {}, playerApproach: {}, homePitch: 'balanced',
});
/** A membership's tactics with every field present (old records predate some fields). */
const withDefaults = t => ({ ...defaultTactics(), ...(t || {}) });

/** Who may bowl: specialist roles, or anyone with a real bowling rating. */
const eligibleBowler = t => !!t && (t.role === 'Bowler' || t.role === 'All-Rounder' || (t.bowling || 0) >= 60);

const tplOf = (db, wp) => PLAYERS.find(p => p.id === (wp && wp.templateId)) || {};

/**
 * Build a sensible 20-over bowling plan for an XI (players are merged
 * template+worldPlayer objects with .id = worldPlayerId). Deterministic:
 * best bowlers first, each bowler's preferred phases filled first, then
 * whatever capacity remains. Used by the engine when a manager has not
 * set a plan, and by the AI managers for their own tactics.
 */
function buildAutoBowlingPlan(xiPlayers) {
  const cap = { ...PHASE_CAP };
  const bowlers = (xiPlayers || []).filter(p => eligibleBowler(p))
    .sort((a, b) => (b.bowling || 0) - (a.bowling || 0));
  const plan = {};
  let assigned = 0;
  for (const b of bowlers) {
    if (assigned >= TOTAL_OVERS) break;
    const entry = { pp: 0, mid: 0, death: 0 };
    let mine = 0;
    const prefKeys = (b.prefOvers || []).map(n => KEY_OF_PHASE[n]).filter(Boolean);
    const order = [...prefKeys, ...PHASE_KEYS.filter(k => !prefKeys.includes(k))
      .sort((x, y) => cap[y] - cap[x])];
    while (mine < MAX_BOWLER_OVERS && assigned < TOTAL_OVERS) {
      const phase = order.find(k => cap[k] > 0);
      if (!phase) break;
      entry[phase]++; cap[phase]--; mine++; assigned++;
    }
    if (mine > 0) plan[b.id] = entry;
  }
  return plan;
}

/**
 * Validate a tactics update against the membership's effective XI.
 * Returns an error string, or null when valid. Only the fields present
 * in `t` are checked. xiIds = the XI the tactics apply to.
 */
function validateTactics(db, membership, xiIds, t) {
  const xi = new Set(xiIds || []);
  if (t.battingOrder !== undefined) {
    if (!Array.isArray(t.battingOrder)) return 'Batting order must be a list of players.';
    if (t.battingOrder.length > 11) return 'Batting order can hold at most 11 players.';
    if (new Set(t.battingOrder).size !== t.battingOrder.length) return 'Batting order contains a player twice.';
    if (t.battingOrder.some(pid => !xi.has(pid))) return 'Batting order can only contain players from your playing XI.';
  }
  if (t.bowlingPlan !== undefined) {
    if (!t.bowlingPlan || typeof t.bowlingPlan !== 'object' || Array.isArray(t.bowlingPlan))
      return 'Bowling plan must be an object of player -> overs per phase.';
    const totals = { pp: 0, mid: 0, death: 0 };
    for (const [pid, e] of Object.entries(t.bowlingPlan)) {
      if (!xi.has(pid)) return 'Bowling plan can only contain players from your playing XI.';
      const wp = db.worldPlayers.find(p => p.id === pid && p.worldId === membership.worldId);
      if (!eligibleBowler(tplOf(db, wp))) return 'Only bowlers and all-rounders (or players with a bowling rating of 60+) can be given overs.';
      if (!e || typeof e !== 'object') return 'Bowling plan entries must be { pp, mid, death } over counts.';
      let mine = 0;
      for (const k of PHASE_KEYS) {
        const v = e[k] === undefined ? 0 : e[k];
        if (!Number.isInteger(v) || v < 0 || v > MAX_BOWLER_OVERS) return `Overs per phase must be whole numbers between 0 and ${MAX_BOWLER_OVERS}.`;
        totals[k] += v; mine += v;
      }
      if (mine > MAX_BOWLER_OVERS) return `No bowler can bowl more than ${MAX_BOWLER_OVERS} overs in a T20 match.`;
    }
    if (totals.pp > PHASE_CAP.pp) return `Powerplay has only ${PHASE_CAP.pp} overs (1-6) — the plan gives ${totals.pp}.`;
    if (totals.mid > PHASE_CAP.mid) return `The middle overs are only ${PHASE_CAP.mid} (7-15) — the plan gives ${totals.mid}.`;
    if (totals.death > PHASE_CAP.death) return `The death overs are only ${PHASE_CAP.death} (16-20) — the plan gives ${totals.death}.`;
    if (totals.pp + totals.mid + totals.death > TOTAL_OVERS) return `A T20 innings is ${TOTAL_OVERS} overs — the plan gives ${totals.pp + totals.mid + totals.death}.`;
  }
  if (t.playerApproach !== undefined) {
    if (!t.playerApproach || typeof t.playerApproach !== 'object' || Array.isArray(t.playerApproach))
      return 'Player approach must be an object of player -> approach.';
    for (const [pid, a] of Object.entries(t.playerApproach)) {
      if (!xi.has(pid)) return 'Player approach can only be set for players in your playing XI.';
      if (!APPROACHES.includes(a)) return `Approach must be one of: ${APPROACHES.join(', ')}.`;
    }
  }
  if (t.homePitch !== undefined && !PITCHES.includes(t.homePitch))
    return `Pitch must be one of: ${PITCHES.join(', ')}.`;
  return null;
}

module.exports = { PHASE_CAP, PHASE_KEYS, PHASE_NAME, KEY_OF_PHASE, TOTAL_OVERS, MAX_BOWLER_OVERS,
  APPROACHES, PITCHES, defaultTactics, withDefaults, eligibleBowler, buildAutoBowlingPlan, validateTactics };
