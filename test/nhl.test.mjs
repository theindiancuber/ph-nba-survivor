// The NHL league: the data job's parser, the hockey scoring rules and the generated SQL.
// Each test file runs in its own process, so this one can switch the whole app to hockey.
process.env.PHS_SPORT = 'nhl';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { LEAGUE, slotValue } = await import('../src/config.js');
const { TEAMS } = await import('../src/teams.js');
const { computeLeague, autopilotPicks, savePct } = await import('../src/league.js');
const { parseBox, parseSchedule, buildData } = await import('../scripts/update-nhl.mjs');
const { nhlSql } = await import('../scripts/nhl-sql.mjs');

const L = LEAGUE.line;
const DUB = TEAMS.TOR.id;

test('the NHL league is configured', () => {
  assert.equal(LEAGUE.sport, 'nhl');
  assert.deepEqual(LEAGUE.slots, ['PTS', 'PM', 'SV', 'WIN']);
  assert.deepEqual(LEAGUE.pickSlots, ['PTS', 'PM', 'SV', 'WIN', 'FIGHT']);
  assert.equal(slotValue('SV', 915), '.915');
  assert.equal(slotValue('SV', 1000), '1.000');
  assert.equal(slotValue('PM', 2), '+2');
  assert.equal(slotValue('PM', -3), '−3');
  assert.equal(savePct(29, 31), 935);
});

// A box score and play-by-play in the NHL feed's shape (trimmed to the fields the parser reads).
const box = {
  id: 2026020185, gameState: 'OFF', gameOutcome: { lastPeriodType: 'OT' },
  homeTeam: { abbrev: 'TOR', score: 4 }, awayTeam: { abbrev: 'BOS', score: 3 },
  playerByGameStats: {
    homeTeam: {
      forwards: [
        { playerId: 1, goals: 1, assists: 1, plusMinus: 2, toi: '18:00' },
        { playerId: 2, goals: 0, assists: 0, plusMinus: 0, toi: '00:00' },
      ],
      defense: [{ playerId: 3, goals: 0, assists: 2, plusMinus: -1, toi: '22:10' }],
      goalies: [
        { playerId: 10, saves: 29, shotsAgainst: 31, toi: '60:00' },
        { playerId: 11, saves: 0, shotsAgainst: 0, toi: '00:00' },
      ],
    },
    awayTeam: { forwards: [{ playerId: 4, goals: 1, assists: 0, plusMinus: -2, toi: '15:00' }], defense: [], goalies: [{ playerId: 12, saves: 36, shotsAgainst: 40, toi: '64:00' }] },
  },
};
const pbp = { plays: [
  { typeDescKey: 'penalty', details: { typeCode: 'MAJ', descKey: 'fighting', committedByPlayerId: 1 } },
  { typeDescKey: 'penalty', details: { typeCode: 'MAJ', descKey: 'fighting', committedByPlayerId: 4 } },
  { typeDescKey: 'penalty', details: { typeCode: 'MIN', descKey: 'roughing', committedByPlayerId: 3 } },
  { typeDescKey: 'goal', details: {} },
] };

test('parses a box score, its fights and the schedule', () => {
  const sched = parseSchedule([{ gameWeek: [{ date: '2026-10-26', games: [
    { id: 2026020185, gameType: 2, startTimeUTC: '2026-10-26T23:00:00Z', gameState: 'FUT', homeTeam: { abbrev: 'TOR' }, awayTeam: { abbrev: 'BOS' } },
    { id: 2026010001, gameType: 1, startTimeUTC: '2026-10-26T23:00:00Z', gameState: 'FUT', homeTeam: { abbrev: 'TOR' }, awayTeam: { abbrev: 'BOS' } },
  ] }] }]);
  assert.equal(sched.length, 1, 'preseason games are left out');
  assert.equal(sched[0].status, 1);
  const g = parseBox(box, pbp, sched[0]);
  assert.equal(g.status, 3);
  assert.deepEqual(g.skaters.find(x => x[0] === 2), [2, 'TOR', 0, 0, 0, 0], 'no ice time means he did not play');
  assert.deepEqual(g.goalies.find(x => x[0] === 10), [10, 'TOR', 1, 29, 31]);
  assert.deepEqual(g.fights, { 1: 1, 4: 1 });
});

test('builds weekly lines: points, plus-minus, save percentage, fights and Gordie Howes', () => {
  const sched = [{ id: 2026020185, kind: 'reg', etDate: '2026-10-27', tipUtc: '2026-10-27T23:00:00Z', status: 3, home: 'TOR', away: 'BOS' }];
  const g = parseBox(box, pbp, sched[0]);
  const rosters = { TOR: [{ id: 1, first: 'Ann', last: 'One', pos: 'C', num: '9', img: 'x.png' }] };
  const { totals, players, teams, weeks } = buildData({ schedule: sched, boxes: { [g.id]: g }, rosters, now: Date.parse('2026-10-28T12:00:00Z') });
  const p = totals[1].p;
  assert.equal(p[1][0], 1); assert.equal(p[1][1], 2); assert.equal(p[1][2], 2);
  assert.equal(p[1][L.fights], 1); assert.equal(p[1][L.goals], 1);
  assert.equal(p[1][L.gordie], 1, 'goal, assist and a fight in one game');
  assert.equal(p[4][L.gordie], 0, 'a goal and a fight but no assist');
  assert.equal(p[3][2], -1);
  assert.equal(p[2], undefined, 'a scratched skater has no line');
  assert.equal(p[10][3], 29); assert.equal(p[10][L.shots], 31); assert.equal(p[10][6], 935);
  assert.equal(p[11], undefined, 'a backup goalie who never went in has no line');
  assert.deepEqual(totals[1].t, { TOR: [1, 1], BOS: [1, 0] }, 'an overtime loss is a loss');
  assert.deepEqual(teams, { TOR: { w: 1, l: 0 }, BOS: { w: 0, l: 1 } });
  assert.equal(players[1].name, 'Ann One');
  assert.equal(players[1].img, 'x.png');
  assert.deepEqual(players[1].avg, [2, 2, 0, 1]);
  assert.equal(players[10].avg[2], 935);
  assert.equal(weeks[0].lockAt, '2026-10-27T23:00:00.000Z');
});

// ---- Scoring ----

const wk = (week, final = true) => ({ week, start: '2026-10-26', end: '2026-11-08', lockAt: '2026-10-26T23:00:00.000Z', final });
const prof = id => ({ id, display_name: id, created_at: '2026-10-20T00:00:00Z' });
const pick = (user_id, week, slot, player_id, alt_id = null) => ({ user_id, week, slot, player_id, alt_id, double_down: false, auto: false });
// [games, pts, +/-, saves, best x3, worst x3, team, shots, fights, goals, Gordie Howes]
const skater = (gp, pts, pm, { fights = 0, gordie = 0, team = 'TOR' } = {}) => [gp, pts, pm, 0, pts, pm, 0, pts, pm, 0, team, 0, fights, 0, gordie];
const goalie = (gp, saves, shots, team = 'TOR') => [gp, 0, 0, saves, 0, 0, 900, 0, 0, 900, team, shots, 0, 0, 0];
const NOW = Date.parse('2026-12-01T00:00:00Z');

function run({ picks, p, t = {}, weeks = [wk(1)], users = ['a', 'b', 'c'] }) {
  const totals = Object.fromEntries(weeks.map(w => [w.week, { final: true, p: p[w.week] || p, t }]));
  return computeLeague({ weeks, totals, picks, profiles: users.map(prof), now: NOW, cardsFrom: Infinity });
}

test('plus-minus ranks negatives, and a pick who never played ranks last', () => {
  const L1 = run({
    p: { 101: skater(3, 1, -2), 102: skater(3, 2, 1) },
    picks: [pick('a', 1, 'PM', 101), pick('b', 1, 'PM', 102), pick('c', 1, 'PM', 999)],
  });
  const r = L1.weeks[0].results;
  assert.equal(r.b.slots.PM.rank, 2);
  assert.equal(r.a.slots.PM.rank, 1, '−2 still beats a pick who sat all week');
  assert.equal(r.c.slots.PM.rank, 0);
  assert.equal(r.c.slots.PM.fumble, true);
});

test('a plus-minus bar of 0 is not cleared by a pick who never played', () => {
  const L1 = computeLeague({
    weeks: [wk(1)], totals: { 1: { final: true, p: {}, t: {} } }, picks: [pick('a', 1, 'PM', 999)],
    profiles: [prof('a')], now: NOW, cardsFrom: Infinity, rules: [{ from_week: 1, bars: { PM: 0 } }],
  });
  assert.equal(L1.weeks[0].results.a.cleared, 0);
});

test('save percentage: under the shot minimum the backup scores, and percentages rank', () => {
  const L1 = run({
    p: { 201: goalie(1, 9, 10), 202: goalie(2, 55, 60), 203: goalie(3, 80, 90) },
    picks: [pick('a', 1, 'SV', 201, 203), pick('b', 1, 'SV', 202), pick('c', 1, 'SV', 203)],
  });
  const r = L1.weeks[0].results;
  assert.equal(r.a.slots.SV.scorer, 203, '10 shots is under the minimum, so the backup comes in');
  assert.equal(r.a.slots.SV.usedAlt, true);
  assert.equal(r.b.slots.SV.value, 917);
  assert.equal(r.c.slots.SV.value, 889);
  assert.equal(r.b.slots.SV.rank, 2);
  assert.equal(r.b.cleared, 1, '.917 clears the .900 bar');
  assert.equal(r.c.cleared, 0);
});

test('goalies can be used twice in The Wall; skaters burn on first use', () => {
  const weeks = [wk(1), { ...wk(2), start: '2026-11-09', end: '2026-11-15', lockAt: '2026-11-10T00:00:00.000Z' }];
  const p = { 1: { 201: goalie(2, 55, 60), 101: skater(3, 3, 1) }, 2: { 201: goalie(2, 55, 60) } };
  const one = run({ weeks: [weeks[0]], p: { 1: p[1] }, picks: [pick('a', 1, 'SV', 201), pick('a', 1, 'PTS', 101)], users: ['a'] });
  assert.equal(one.users.a.burns.SV.has(201), false, 'one use of two');
  assert.equal(one.users.a.uses.SV.get(201), 1);
  assert.equal(one.users.a.burns.PTS.has(101), true);
  const two = run({ weeks, p, picks: [pick('a', 1, 'SV', 201), pick('a', 2, 'SV', 201)], users: ['a'] });
  assert.equal(two.weeks[1].results.a.slots.SV.invalid, false, 'the second use still scores');
  assert.equal(two.users.a.burns.SV.get(201), 2, 'burned after the second use');
});

test('Gloves Off: +5 a fight up to 2, burns only on a fight, and a Gordie Howe adds +5', () => {
  const L1 = run({
    p: { 301: skater(3, 0, 0, { fights: 3 }), 302: skater(3, 0, 0), 101: skater(3, 3, 1, { fights: 1, gordie: 1 }) },
    picks: [pick('a', 1, 'FIGHT', 301), pick('b', 1, 'FIGHT', 302), pick('c', 1, 'PTS', 101), pick('c', 1, 'FIGHT', 101)],
  });
  const r = L1.weeks[0].results;
  assert.equal(r.a.bonus.pts, 10, 'three fights count as two');
  assert.equal(r.a.adj.find(x => x.bonus === 'fight').pts, 10);
  assert.equal(r.a.score, 10);
  assert.equal(L1.users.a.burns.FIGHT.has(301), true);
  assert.equal(r.b.bonus.pts, 0);
  assert.equal(L1.users.b.burns.FIGHT.has(302), false, 'no fight, no burn');
  assert.equal(r.c.bonus.invalid, true, 'already picked in another slot');
  assert.equal(r.c.adj.find(x => x.bonus === 'gordie').pts, 5);
  assert.equal(r.a.slots.PTS.missing, true, 'Gloves Off is not a ranked slot');
});

test('Autopilot only picks goalies for The Wall and skaters elsewhere, and leaves Gloves Off empty', () => {
  const players = {
    101: { id: 101, pos: 'C', team: 'TOR', avg: [1.5, 0.5, 0, 0], gp: 10 },
    201: { id: 201, pos: 'G', team: 'TOR', avg: [0, 0, 920, 0], gp: 10 },
  };
  const L1 = computeLeague({ weeks: [{ ...wk(1, false), lockAt: '2027-01-01T00:00:00.000Z' }], totals: {}, picks: [], profiles: [prof('a')], now: NOW, cardsFrom: Infinity });
  const chosen = autopilotPicks(L1, 'a', 1, {}, players, { TOR: 3 }, { TOR: { w: 5, l: 2 } });
  assert.equal(chosen.SV, 201);
  assert.equal(chosen.PTS, 101);
  assert.equal(chosen.PM, undefined, 'the only skater is already the Lamplighter');
  assert.equal(chosen.WIN, DUB);
  assert.equal('FIGHT' in chosen, false);
});

test('supabase/nhl/setup.sql is up to date with the NBA SQL files (run PHS_SPORT=nhl node scripts/nhl-sql.mjs)', async () => {
  const files = ['schema', 'admin', 'upgrade-dub-invite', 'upgrade-onboarding', 'upgrade-cards', 'upgrade-decree', 'upgrade-settings', 'upgrade-commissioner-ops', 'harden'];
  const sources = {};
  for (const f of files) sources[f] = await readFile(new URL(`../supabase/${f}.sql`, import.meta.url), 'utf8');
  const committed = await readFile(new URL('../supabase/nhl/setup.sql', import.meta.url), 'utf8');
  assert.equal(nhlSql(sources), committed);
  assert.match(committed, /picks_slot_check check \(slot in \('PTS', 'PM', 'SV', 'WIN', 'FIGHT'\)\)/);
  assert.match(committed, /\(23, '2027-04-05T23:00:00.000Z'\)/);
});
