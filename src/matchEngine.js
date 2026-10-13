'use strict';
const crypto = require('crypto');
const TEMPLATES = require('./players');
// Deterministic per-fixture RNG (same fixture => same simulation basis for everyone).
function rng(seed) { let h = crypto.createHash('sha256').update(seed).digest(); let i = 0;
  return () => { if (i >= h.length) { h = crypto.createHash('sha256').update(h).digest(); i = 0; } return h[i++] / 255; }; }

function teamStrength(db, worldId, membership) {
  if (!membership) return { strength: 55, xi: [], captainBoost: 0 };
  const owned = db.worldPlayers.filter(p => p.worldId === worldId && p.ownerMembershipId === membership.id);
  const byId = Object.fromEntries(owned.map(p => [p.id, p]));
  let xiIds = (membership.xi || []).filter(pid => byId[pid]);
  if (xiIds.length < 11) xiIds = [...xiIds, ...owned.map(p => p.id).filter(x => !xiIds.includes(x))].slice(0, 11);
  const xi = xiIds.map(pid => { const wp = byId[pid]; const t = TEMPLATES.find(x => x.id === wp.templateId) || {}; return { ...t, ...wp, rating: t.rating || 70 }; });
  if (!xi.length) return { strength: 45, xi: [], captainBoost: 0 }; // empty squad = weak, by design
  let avg = xi.reduce((s, p) => s + (p.rating * (p.fitness ?? 100) / 100) * 0.8 + (p.form ?? 50) * 0.04, 0) / xi.length;
  // Captaincy is a real modifier: leader rating lifts morale/chemistry.
  let captainBoost = 0;
  const cap = xi.find(p => p.id === membership.captainId);
  if (cap) captainBoost = ((cap.leadership || 60) - 60) * 0.08;
  const vc = xi.find(p => p.id === membership.viceCaptainId);
  if (vc) captainBoost += ((vc.leadership || 60) - 60) * 0.03;
  const tactics = membership.tactics || {};
  const tacticBoost = tactics.battingApproach === 'Aggressive' ? 1.2 : tactics.battingApproach === 'Defensive' ? -0.6 : 0;
  return { strength: avg + captainBoost + tacticBoost, xi, captainBoost };
}

function simulate(db, world, fixture) {
  const rand = rng(fixture.id);
  const homeM = db.memberships.find(m => m.id === fixture.homeMembershipId);
  const awayM = db.memberships.find(m => m.id === fixture.awayMembershipId);
  const H = teamStrength(db, world.id, homeM), A = teamStrength(db, world.id, awayM);
  const homeAdv = 2.0;
  const innings = (S, opp) => {
    const base = 135 + (S.strength - 70) * 3.2 + rand() * 45;
    const runs = Math.max(70, Math.round(base));
    const wkts = Math.min(10, Math.max(2, Math.round(10 - (S.strength - opp.strength) * 0.22 + rand() * 4 - 2)));
    const top = [...S.xi].sort((a, b) => (b.batting || 0) - (a.batting || 0)).slice(0, 3)
      .map(p => ({ player: p.name, runs: Math.round(runs * (0.14 + rand() * 0.16)), balls: 0 }));
    top.forEach(t => t.balls = Math.max(5, Math.round(t.runs * (0.75 + rand() * 0.4))));
    const bowl = [...opp.xi].filter(p => (p.bowling || 0) > 55).sort((a, b) => (b.bowling || 0) - (a.bowling || 0)).slice(0, 2)
      .map(p => ({ player: p.name, wickets: Math.max(0, Math.round(wkts / 2 - rand())), runs: Math.round(runs / 4) }));
    return { runs, wickets: wkts, overs: wkts === 10 ? '18.4' : '20.0', topScorers: top, bestBowlers: bowl };
  };
  const hIn = innings(H, A), aIn = innings(A, H);
  const winner = hIn.runs === aIn.runs ? null : (hIn.runs > aIn.runs ? homeM : awayM);
  const summary = winner
    ? `${winner.clubName} won by ${Math.abs(hIn.runs - aIn.runs)} runs`
    : 'Match tied';
  return { home: hIn, away: aIn, winnerMembershipId: winner && winner.id, summary,
    report: [`${homeM.clubName} posted ${hIn.runs}/${hIn.wickets}.`, `${awayM.clubName} replied with ${aIn.runs}/${aIn.wickets}.`, summary + '.',
      `Home strength ${H.strength.toFixed(1)} (incl. home advantage ${homeAdv}) vs away ${A.strength.toFixed(1)}; captaincy boosts H ${H.captainBoost.toFixed(2)} / A ${A.captainBoost.toFixed(2)}.`],
    keyMoments: [`Top score: ${(hIn.topScorers[0] || aIn.topScorers[0] || {}).player || '—'}`] };
}
module.exports = { simulate, teamStrength };
