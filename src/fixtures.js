'use strict';
const { id } = require('./db');
// Circle-method round-robin. Returns rounds; each club plays at most once per round,
// so no club is ever double-booked at the same scheduled time.
function roundRobin(membershipIds) {
  const teams = [...membershipIds];
  if (teams.length % 2) teams.push(null); // bye
  const rounds = [];
  let arr = [...teams];
  for (let r = 0; r < teams.length - 1; r++) {
    const round = [];
    for (let i = 0; i < teams.length / 2; i++) {
      const a = arr[i], b = arr[teams.length - 1 - i];
      if (a && b) round.push(r % 2 ? [b, a] : [a, b]); // alternate home/away
    }
    rounds.push(round);
    arr = [arr[0], arr[arr.length - 1], ...arr.slice(1, -1)];
  }
  return rounds; // leg 1
}
function generateFixtures(db, world) {
  const members = db.memberships.filter(m => m.worldId === world.id);
  if (members.length < 2) return [];
  const legs = world.format && /home.?away|double/i.test(world.format) ? 2 : 2; // league defaults to home & away
  const allRounds = [];
  const leg1 = roundRobin(members.map(m => m.id));
  allRounds.push(...leg1);
  if (legs === 2) allRounds.push(...leg1.map(round => round.map(([h, a]) => [a, h])));
  const start = new Date(world.seasonStartAt || world.startDate);
  const [hh, mm] = (world.matchTime || '20:00').split(':').map(Number);
  const fixtures = [];
  allRounds.forEach((round, idx) => {
    const when = new Date(start); when.setDate(when.getDate() + idx * (world.matchIntervalDays || 3));
    when.setHours(hh, mm || 0, 0, 0);
    for (const [home, away] of round) fixtures.push({
      id: id('fix'), worldId: world.id, round: idx + 1,
      homeMembershipId: home, awayMembershipId: away, competition: 'Premier League',
      scheduledAt: when.toISOString(), timezone: world.timezone || 'Asia/Kolkata',
      tacticalLockAt: new Date(when.getTime() - 30 * 60000).toISOString(),
      status: 'SCHEDULED', result: null
    });
  });
  return fixtures;
}
module.exports = { generateFixtures, roundRobin };
