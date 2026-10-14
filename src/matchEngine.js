'use strict';
const crypto = require('crypto');
const TEMPLATES = require('./players');
const { withDefaults, eligibleBowler, buildAutoBowlingPlan, KEY_OF_PHASE, TOTAL_OVERS } = require('./tactics');
// Deterministic per-fixture RNG (same fixture => same simulation basis for everyone).
function rng(seed) { let h = crypto.createHash('sha256').update(seed).digest(); let i = 0;
  return () => { if (i >= h.length) { h = crypto.createHash('sha256').update(h).digest(); i = 0; } return h[i++] / 255; }; }

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Preference fit for one team. Compares the manager's tactics against
 * each player's preferences (template prefBatPos / prefOvers):
 * - batting at a position within ±1 of the preferred one = happy;
 *   2-3 away = mild misuse; 4+ away = severe misuse.
 * - a bowler is happy when at least half their overs come in their
 *   preferred phases; a specialist (bowling 78+) given no overs at
 *   all in a manager-set plan is mild misuse ("left unused").
 * Fit is only judged on tactics the manager actually set — with no
 * saved batting order / bowling plan the engine's defaults apply and
 * nobody is blamed. Returns per-player morale/form effects plus the
 * rating penalties the sim applies in this match.
 */
function computeFit(xi, tactics) {
  const orderSet = Array.isArray(tactics.battingOrder) && tactics.battingOrder.length > 0;
  const planSet = tactics.bowlingPlan && Object.keys(tactics.bowlingPlan).length > 0;
  const effects = new Map(); // wpId -> { worldPlayerId, name, moraleDelta, formDelta, misused }
  const fx = p => { if (!effects.has(p.id)) effects.set(p.id, { worldPlayerId: p.id, name: p.name, moraleDelta: 0, formDelta: 0, misused: false }); return effects.get(p.id); };
  const batPen = {}, bowlPen = {};
  // Ranking among the XI's eligible bowlers — only a genuinely
  // first-choice bowler (top 4) counts as "left unused" below; a
  // sixth bowling option sitting out is normal squad rotation.
  const eligibleRanked = xi.filter(p => eligibleBowler(p)).sort((a, b) => (b.bowling || 0) - (a.bowling || 0));
  const bowlRank = new Map(eligibleRanked.map((p, i) => [p.id, i]));
  for (const p of xi) {
    batPen[p.id] = 0; bowlPen[p.id] = 0;
    if (orderSet) {
      const diff = Math.abs(p.batPos - (p.prefBatPos || p.batPos));
      if (diff <= 1) { fx(p).moraleDelta += 2; }
      else if (diff <= 3) { const e = fx(p); e.moraleDelta -= 6; e.formDelta -= 3; e.misused = true; batPen[p.id] = 3; }
      else { const e = fx(p); e.moraleDelta -= 12; e.formDelta -= 6; e.misused = true; batPen[p.id] = 6; }
    }
    if (planSet) {
      const entry = (tactics.bowlingPlan || {})[p.id];
      const total = entry ? (entry.pp || 0) + (entry.mid || 0) + (entry.death || 0) : 0;
      if (total > 0) {
        const prefKeys = (p.prefOvers || []).map(n => KEY_OF_PHASE[n]).filter(Boolean);
        const inPref = prefKeys.reduce((s, k) => s + (entry[k] || 0), 0);
        const share = inPref / total;
        if (share >= 0.5) { fx(p).moraleDelta += 2; }
        else if (share >= 0.25) { const e = fx(p); e.moraleDelta -= 6; e.formDelta -= 3; e.misused = true; bowlPen[p.id] = 3; }
        else { const e = fx(p); e.moraleDelta -= 10; e.formDelta -= 5; e.misused = true; bowlPen[p.id] = 6; }
      } else if (eligibleBowler(p) && (p.bowling || 0) >= 78 && (bowlRank.get(p.id) ?? 99) < 4) {
        const e = fx(p); e.moraleDelta -= 5; e.misused = true; // first-choice bowler left unused
      }
    }
  }
  for (const e of effects.values()) { e.moraleDelta = clamp(e.moraleDelta, -12, 2); e.formDelta = clamp(e.formDelta, -6, 0); }
  return { effects: [...effects.values()].filter(e => e.moraleDelta !== 0 || e.formDelta !== 0),
    misused: [...effects.values()].filter(e => e.misused), batPen, bowlPen };
}

/**
 * Bowling attack strength from a plan: overs-weighted average of the
 * bowlers' effective bowling (misuse-penalised). Overs the plan does
 * not cover are bowled by the remaining eligible XI at their average.
 */
function attackRating(xi, plan, bowlPen) {
  let weighted = 0, covered = 0;
  const assigned = new Set();
  for (const p of xi) {
    const e = plan[p.id]; if (!e) continue;
    const overs = (e.pp || 0) + (e.mid || 0) + (e.death || 0);
    if (overs <= 0) continue;
    weighted += ((p.bowling || 0) - (bowlPen[p.id] || 0)) * overs; covered += overs; assigned.add(p.id);
  }
  if (covered < TOTAL_OVERS) {
    const rest = xi.filter(p => eligibleBowler(p) && !assigned.has(p.id));
    const fill = rest.length ? rest.reduce((s, p) => s + (p.bowling || 0), 0) / rest.length : 50;
    weighted += fill * (TOTAL_OVERS - covered);
  }
  return weighted / TOTAL_OVERS;
}

function teamStrength(db, worldId, membership) {
  if (!membership) return { strength: 55, xi: [], captainBoost: 0, attack: 50, moraleEffects: [], misused: [], oversByPlayer: {} };
  const owned = db.worldPlayers.filter(p => p.worldId === worldId && p.ownerMembershipId === membership.id);
  const byId = Object.fromEntries(owned.map(p => [p.id, p]));
  let xiIds = (membership.xi || []).filter(pid => byId[pid]);
  if (xiIds.length < 11) xiIds = [...xiIds, ...owned.map(p => p.id).filter(x => !xiIds.includes(x))].slice(0, 11);
  const merged = xiIds.map(pid => { const wp = byId[pid]; const t = TEMPLATES.find(x => x.id === wp.templateId) || {}; return { ...t, ...wp, rating: t.rating || 70 }; });
  if (!merged.length) return { strength: 45, xi: [], captainBoost: 0, attack: 45, moraleEffects: [], misused: [], oversByPlayer: {} }; // empty squad = weak, by design
  const tactics = withDefaults(membership.tactics);
  // Batting order: the manager's saved order first (filtered to the
  // XI), then any remaining XI players by batting rating.
  let xi = merged;
  if (Array.isArray(tactics.battingOrder) && tactics.battingOrder.length) {
    const inOrder = tactics.battingOrder.map(pid => merged.find(p => p.id === pid)).filter(Boolean);
    const rest = merged.filter(p => !tactics.battingOrder.includes(p.id)).sort((a, b) => (b.batting || 0) - (a.batting || 0));
    xi = [...inOrder, ...rest];
  } else {
    xi = [...merged].sort((a, b) => (b.batting || 0) - (a.batting || 0));
  }
  xi.forEach((p, i) => { p.batPos = i + 1; });
  const fit = computeFit(xi, tactics);
  // Effective bowling plan: the manager's, or a sensible auto-plan.
  const planSet = tactics.bowlingPlan && Object.keys(tactics.bowlingPlan).length > 0;
  const plan = planSet ? tactics.bowlingPlan : buildAutoBowlingPlan(xi);
  const oversByPlayer = {};
  for (const p of xi) { const e = plan[p.id]; oversByPlayer[p.id] = e ? (e.pp || 0) + (e.mid || 0) + (e.death || 0) : 0; }
  const attack = attackRating(xi, plan, fit.bowlPen);
  xi.forEach(p => { p.effRating = p.rating - (fit.batPen[p.id] || 0); p.approachUsed = (tactics.playerApproach || {})[p.id] || p.approach || 'balanced'; });
  let avg = xi.reduce((s, p) => s + (p.effRating * (p.fitness ?? 100) / 100) * 0.8 + (p.form ?? 50) * 0.04, 0) / xi.length;
  // Per-player approach: aggressive batting scores faster but risks
  // wickets; defensive does the opposite. Balanced is neutral.
  const approachAdj = xi.reduce((s, p) => s + (p.approachUsed === 'aggressive' ? 0.5 : p.approachUsed === 'defensive' ? -0.35 : 0), 0) / xi.length;
  const approachWkts = xi.reduce((s, p) => s + (p.approachUsed === 'aggressive' ? 1 : p.approachUsed === 'defensive' ? -1 : 0), 0) * 0.15;
  // Captaincy is a real modifier: leader rating lifts morale/chemistry.
  let captainBoost = 0;
  const cap = xi.find(p => p.id === membership.captainId);
  if (cap) captainBoost = ((cap.leadership || 60) - 60) * 0.08;
  const vc = xi.find(p => p.id === membership.viceCaptainId);
  if (vc) captainBoost += ((vc.leadership || 60) - 60) * 0.03;
  const tacticBoost = tactics.battingApproach === 'Aggressive' ? 1.2 : tactics.battingApproach === 'Defensive' ? -0.6 : 0;
  return { strength: avg + captainBoost + tacticBoost + approachAdj, xi, captainBoost, attack, approachWkts,
    moraleEffects: fit.effects, misused: fit.misused, oversByPlayer: oversByPlayer };
}

// Pitch prepared by the home side: an explicit fixture pitch wins,
// then the home manager's standing homePitch, then 'balanced'.
const PITCH_EFFECT = { batting: { runs: 1.12, wkts: -1 }, balanced: { runs: 1, wkts: 0 }, bowling: { runs: 0.88, wkts: 1.5 } };
function fixturePitch(db, fixture, homeM) {
  if (fixture && fixture.pitch && PITCH_EFFECT[fixture.pitch]) return fixture.pitch;
  const hp = homeM && withDefaults(homeM.tactics).homePitch;
  return PITCH_EFFECT[hp] ? hp : 'balanced';
}

function simulate(db, world, fixture) {
  const rand = rng(fixture.id);
  const homeM = db.memberships.find(m => m.id === fixture.homeMembershipId);
  const awayM = db.memberships.find(m => m.id === fixture.awayMembershipId);
  const H = teamStrength(db, world.id, homeM), A = teamStrength(db, world.id, awayM);
  const homeAdv = 2.0;
  const pitch = fixturePitch(db, fixture, homeM);
  const pe = PITCH_EFFECT[pitch];
  const innings = (S, opp, adv) => {
    const strength = S.strength + (adv || 0);
    const base = 135 + (strength - 70) * 3.2 - (opp.attack - 70) * 0.9 + rand() * 45;
    const runs = Math.max(60, Math.round(base * pe.runs));
    const wkts = Math.min(10, Math.max(2, Math.round(10 - (strength - opp.strength) * 0.22 + (opp.attack - 70) * 0.06 + (S.approachWkts || 0) + pe.wkts + rand() * 4 - 2)));
    // Top scorers come from the top of the actual batting order.
    const top = [...S.xi].slice(0, 6).sort((a, b) => (b.batting || 0) - (a.batting || 0)).slice(0, 3)
      .map(p => ({ player: p.name, runs: Math.round(runs * (0.14 + rand() * 0.16)), balls: 0 }));
    top.forEach(t => t.balls = Math.max(5, Math.round(t.runs * (0.75 + rand() * 0.4))));
    // Bowlers who actually bowled the overs (per the plan) take the wickets.
    const bowl = [...opp.xi].filter(p => (opp.oversByPlayer[p.id] || 0) > 0)
      .sort((a, b) => (opp.oversByPlayer[b.id] - opp.oversByPlayer[a.id]) || (b.bowling || 0) - (a.bowling || 0)).slice(0, 2)
      .map(p => ({ player: p.name, wickets: Math.max(0, Math.round(wkts / 2 - rand())), runs: Math.round(runs / 4) }));
    return { runs, wickets: wkts, overs: wkts === 10 ? '18.4' : '20.0', topScorers: top, bestBowlers: bowl };
  };
  const hIn = innings(H, A, homeAdv), aIn = innings(A, H, 0);
  const winner = hIn.runs === aIn.runs ? null : (hIn.runs > aIn.runs ? homeM : awayM);
  const summary = winner
    ? `${winner.clubName} won by ${Math.abs(hIn.runs - aIn.runs)} runs`
    : 'Match tied';
  const tacLine = (m, T) => {
    if (T.misused.length)
      return `Tactics report: ${m.clubName} used ${T.misused.length} player${T.misused.length === 1 ? '' : 's'} out of position (${T.misused.map(p => p.name).join(', ')}) — morale down in the camp.`;
    if (T.moraleEffects.some(e => e.moraleDelta > 0))
      return `Tactics report: ${m.clubName} played everyone in their preferred roles — morale up.`;
    return `Tactics report: ${m.clubName} — no detailed tactics set; default batting order and bowling plan used.`;
  };
  return { home: hIn, away: aIn, winnerMembershipId: winner && winner.id, summary, pitch,
    tactics: { home: { misused: H.misused.length, players: H.misused.map(p => p.name) },
               away: { misused: A.misused.length, players: A.misused.map(p => p.name) } },
    moraleEffects: [...H.moraleEffects, ...A.moraleEffects],
    report: [`${homeM.clubName} posted ${hIn.runs}/${hIn.wickets}.`, `${awayM.clubName} replied with ${aIn.runs}/${aIn.wickets}.`, summary + '.',
      `Pitch: ${pitch[0].toUpperCase() + pitch.slice(1)}.`,
      tacLine(homeM, H), tacLine(awayM, A),
      `Home strength ${H.strength.toFixed(1)} (incl. home advantage ${homeAdv}) vs away ${A.strength.toFixed(1)}; captaincy boosts H ${H.captainBoost.toFixed(2)} / A ${A.captainBoost.toFixed(2)}.`],
    keyMoments: [`Top score: ${(hIn.topScorers[0] || aIn.topScorers[0] || {}).player || '—'}`] };
}
module.exports = { simulate, teamStrength, fixturePitch, PITCH_EFFECT };
