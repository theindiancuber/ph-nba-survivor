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

// ---- Hockey cards ----

const { CARDS, NICKNAMES } = await import('../src/cards.js');
// [games, pts, +/-, 0, best pts, best +/-, 0, worst pts, worst +/-, 0, team, 0, fights, goals, Gordie Howes]
const sk = (gp, pts, pm, hi = [pts, pm], lo = [pts, pm]) => [gp, pts, pm, 0, ...hi, 0, ...lo, 0, 'TOR', 0, 0, 0, 0];
// [games, 0, 0, saves, best saves, its shots, its sv%, worst saves, its shots, its sv%, team, shots, 0, 0, 0]
const gl = (gp, sv, sa, best = [sv, sa], worst = [sv, sa]) => [gp, 0, 0, sv, ...best, savePct(...best), ...worst, savePct(...worst), 'TOR', sa, 0, 0, 0];
const CARD_P = {
  101: sk(3, 6, -2, [3, 1], [1, -2]), 102: sk(3, 4, 3, [2, 2], [1, 0]), 103: sk(2, 2, 1), 104: sk(3, 9, 4, [4, 3], [2, 0]),
  201: gl(2, 55, 60, [30, 31], [25, 29]), 202: gl(2, 50, 56), 203: gl(3, 85, 90), 204: gl(2, 40, 50),
};
const CARD_PLAYERS = Object.fromEntries(Object.keys(CARD_P).map(id => [id, { id: +id, pos: id >= 200 ? 'G' : 'C', team: 'TOR' }]));
const CARD_PICKS = [
  pick('a', 1, 'PTS', 104), pick('a', 1, 'PM', 102), pick('a', 1, 'SV', 201),
  pick('b', 1, 'PTS', 103), pick('b', 1, 'PM', 101), pick('b', 1, 'SV', 202),
  pick('c', 1, 'PTS', 101), pick('c', 1, 'PM', 103), pick('c', 1, 'SV', 204),
];
let seq = 0;
const cardPlay = (user_id, card, extra = {}, at = '2026-10-25T12:00:00Z') => ({
  id: `h${++seq}`, user_id, week: 1, card, card_uid: 'w1:starter', target_id: null, slot: null, player_id: null, params: {},
  created_at: new Date(Date.parse(at) + seq * 1000).toISOString(), ...extra,
});
const AFTER = '2026-11-10T12:00:00Z';
function cardRun(plays, hands, p = CARD_P) {
  return computeLeague({
    weeks: [wk(1)], totals: { 1: { final: true, p, t: {} } }, picks: CARD_PICKS, plays, profiles: ['a', 'b', 'c'].map(prof),
    now: NOW, players: CARD_PLAYERS, cardsFrom: 1, dealer: uid => [hands[uid] || 'scout', 'clown', 'charge'],
  });
}

test('hockey cards: the same deck under hockey names, with hockey nicknames', () => {
  assert.equal(CARDS.load.name, 'Healthy Scratch');
  assert.equal(CARDS.sixth.name, 'Extra Attacker');
  assert.equal(CARDS.duel.name, 'Faceoff');
  assert.equal(Object.keys(CARDS).length, 17);
  assert.ok(Object.values(CARDS).every(c => c.text.length <= 175), 'card text fits on the card');
  assert.ok(NICKNAMES.includes('Zamboni Driver'));
  assert.equal(LEAGUE.cards.startWeek, 1);
});

test('Jinx: halves points, doubles a minus, and takes .020 off a save percentage', () => {
  const L1 = cardRun([cardPlay('a', 'jinx', { target_id: 'b', player_id: 101 }), cardPlay('c', 'jinx', { target_id: 'a', player_id: 201 })], { a: 'jinx', c: 'jinx' });
  const r = L1.weeks[0].results;
  assert.equal(r.b.slots.PM.value, -4, '−2 doubles to −4');
  assert.equal(r.a.slots.SV.value, 897, '.917 − .020');
  const L2 = cardRun([cardPlay('a', 'jinx', { target_id: 'c', player_id: 101 })], { a: 'jinx' });
  assert.equal(L2.weeks[0].results.c.slots.PTS.value, 3, '6 points score half');
});

test('Healthy Scratch: plus-minus swaps his best game for his worst; save % leaves his best game out', () => {
  const L1 = cardRun([cardPlay('b', 'load', { target_id: 'a', slot: 'PM' }), cardPlay('c', 'load', { target_id: 'a', slot: 'SV' })], { b: 'load', c: 'load' });
  const r = L1.weeks[0].results.a.slots;
  assert.equal(r.PM.value, 1, '+3, less his +2 night, plus his 0 night');
  assert.equal(r.SV.value, savePct(25, 29), '55/60 without his 30/31 game');
});

test('Empty Netter: a goalie\'s worst game is replaced by his best, and the save % is worked out again', () => {
  const L1 = cardRun([cardPlay('a', 'garbage', { slot: 'SV' }, AFTER), cardPlay('b', 'garbage', { slot: 'PM' }, AFTER)], { a: 'garbage', b: 'garbage' });
  const r = L1.weeks[0].results;
  assert.equal(r.a.slots.SV.value, savePct(60, 62), '55/60, less 25/29, plus 30/31');
  assert.equal(r.b.slots.PM.value, 1, '−2, less his −2 night, plus his +1 night');
});

test('Extra Attacker: a goalie only goes into The Wall, and a skater who never played stays on the bench', () => {
  const L1 = cardRun([cardPlay('b', 'sixth', { player_id: 203 })], { b: 'sixth' });
  const r = L1.weeks[0].results.b.slots;
  assert.equal(r.SV.scorer, 203, 'into The Wall, not Shutdown where his 0 would beat −2');
  assert.equal(r.SV.value, savePct(85, 90));
  assert.equal(r.PM.scorer, 101);
  const L2 = cardRun([cardPlay('b', 'sixth', { player_id: 999 })], { b: 'sixth' });
  assert.equal(L2.weeks[0].cards.plays[0].outcome, 'benched', 'no games, no value, even against a minus');
});

test('Line Change swaps Lamplighter and Shutdown, but never The Wall', () => {
  const L1 = cardRun([cardPlay('a', 'switcheroo', { params: { map: { PTS: 'PM', PM: 'PTS' } } }, AFTER)], { a: 'switcheroo' });
  const s = L1.weeks[0].results.a.slots;
  assert.equal(s.PTS.scorer, 102); assert.equal(s.PTS.value, 4);
  assert.equal(s.PM.scorer, 104); assert.equal(s.PM.value, 4);
  const L2 = cardRun([cardPlay('a', 'switcheroo', { params: { map: { PTS: 'SV', SV: 'PTS' } } }, AFTER)], { a: 'switcheroo' });
  assert.equal(L2.weeks[0].cards.plays[0].why, 'bad-swap');
  assert.equal(L2.weeks[0].results.a.slots.SV.scorer, 201);
});

test('Faceoff: a plus-minus pick who never played loses, even to a minus', () => {
  const picks = [pick('a', 1, 'PM', 101), pick('b', 1, 'PM', 999)];
  const L1 = computeLeague({
    weeks: [wk(1)], totals: { 1: { final: true, p: CARD_P, t: {} } }, picks, profiles: ['a', 'b'].map(prof), now: NOW, players: CARD_PLAYERS, cardsFrom: 1,
    plays: [cardPlay('a', 'duel', { target_id: 'b', slot: 'PM' })], dealer: uid => uid === 'a' ? ['duel', 'clown', 'charge'] : ['scout', 'clown', 'charge'],
  });
  assert.equal(L1.weeks[0].cards.plays[0].outcome, 'won');
});

test('supabase/nhl/setup.sql is up to date with the NBA SQL files (run PHS_SPORT=nhl node scripts/nhl-sql.mjs)', async () => {
  const files = ['schema', 'admin', 'upgrade-dub-invite', 'upgrade-onboarding', 'upgrade-cards', 'upgrade-decree', 'upgrade-settings', 'upgrade-commissioner-ops', 'harden'];
  const sources = {};
  for (const f of files) sources[f] = await readFile(new URL(`../supabase/${f}.sql`, import.meta.url), 'utf8');
  const committed = await readFile(new URL('../supabase/nhl/setup.sql', import.meta.url), 'utf8');
  assert.equal(nhlSql(sources), committed);
  assert.match(committed, /picks_slot_check check \(slot in \('PTS', 'PM', 'SV', 'WIN', 'FIGHT'\)\)/);
  assert.match(committed, /\(1, '2026-10-26T23:00:00.000Z'\)/);
  assert.match(committed, /\(24, '2027-04-05T23:00:00.000Z'\)/);
  // Shared accounts: everything is in the nhl schema, and the only trigger on auth.users is the NBA league's.
  const own = committed.slice(0, committed.indexOf('-- ======== sign-ups'));
  assert.doesNotMatch(own, /\bpublic\./, 'every NHL object is in the nhl schema');
  assert.doesNotMatch(own, /create trigger [^;]* on auth\.users|delete from auth\.users/, 'the NHL league never touches accounts');
  assert.match(committed, /to_regclass\('nhl\.league_settings'\)/);
});

test('one account, two leagues: the NHL league uses the NBA project, in its own schema', () => {
  assert.equal(LEAGUE.dbSchema, 'nhl');
  assert.match(LEAGUE.supabaseUrl, /miotcbvafwddymqkslyy/);
});

test('24 single weeks, Oct 26 to Apr 11', async () => {
  const { buildWeeks } = await import('../src/config.js');
  const w = buildWeeks();
  assert.equal(w.length, 24);
  assert.deepEqual([w[0].start, w[0].end, w[0].mult], ['2026-10-26', '2026-11-01', 1]);
  assert.equal(w.at(-1).end, '2027-04-11');
  assert.ok(w.every(x => x.mult === 1));
});

test('the Calendar: day lines add back up to the week, and the week can be scored through any day', async () => {
  const { totalsThrough } = await import('../src/calendar.js');
  const mk = (id, etDate, hs, as, sk, go, fights = {}) => ({ id, kind: 'reg', etDate, tipUtc: `${etDate}T23:00:00Z`, status: 3, home: 'TOR', away: 'BOS', hs, as, skaters: sk, goalies: go, fights });
  const boxes = {
    1: mk(1, '2026-10-27', 4, 3, [[1, 'TOR', 1, 1, 1, 2], [3, 'TOR', 1, 0, 0, -1]], [[10, 'TOR', 1, 29, 31]], { 1: 1 }),
    2: mk(2, '2026-10-29', 1, 2, [[1, 'TOR', 1, 0, 0, -3], [3, 'TOR', 1, 0, 2, 1]], [[10, 'TOR', 1, 18, 20]]),
  };
  const sched = Object.values(boxes).map(b => ({ id: b.id, kind: 'reg', etDate: b.etDate, tipUtc: b.tipUtc, status: 3, home: 'TOR', away: 'BOS' }));
  const { totals, days } = buildData({ schedule: sched, boxes, now: Date.parse('2026-11-03T12:00:00Z') });
  assert.deepEqual(Object.keys(days[1]), ['2026-10-27', '2026-10-29']);
  assert.deepEqual(days[1]['2026-10-27'].p[1], [1, 2, 2, 0, 2, 2, 0, 2, 2, 0, 'TOR', 0, 1, 1, 1], 'one game: a goal, an assist and a fight');
  assert.deepEqual(totals[1].p, totalsThrough(days[1], '2026-11-01').p, 'the week is its days added up');
  const w = totals[1].p;
  assert.deepEqual(w[1].slice(0, 10), [2, 2, -1, 0, 2, 2, 0, 0, -3, 0], 'sums, best game and worst game');
  assert.deepEqual([w[10][3], w[10][L.shots], w[10][6], w[10][9]], [47, 51, 935, 900], 'goalie saves, shots, best and worst nights');
  assert.deepEqual(totals[1].t, { TOR: [2, 1], BOS: [2, 1] });
  // Through the first day only: what the Calendar scores for "after Tue".
  const tue = totalsThrough(days[1], '2026-10-27');
  assert.deepEqual([tue.p[1][0], tue.p[1][2], tue.p[10][3], tue.p[10][L.shots]], [1, 2, 29, 31]);
  assert.equal(tue.final, false);
});

test('the NHL demo has a schedule whose days add up to its weekly totals', async () => {
  const { makeDemo } = await import('../src/demo-nhl.js');
  const { totalsThrough } = await import('../src/calendar.js');
  const d = makeDemo();
  assert.ok(d.schedule.some(g => g[5] === 3) && d.schedule.some(g => g[5] === 1));
  for (const w of d.weeks.filter(x => d.days[x.week])) {
    assert.deepEqual(totalsThrough(d.days[w.week], w.end).p, d.totals[w.week].p, `week ${w.week}`);
  }
});

test('the nightly recap works for hockey: save percentage, plus-minus, fights and the hockey extras', async () => {
  const { makeDemo } = await import('../src/demo-nhl.js');
  const { totalsThrough } = await import('../src/calendar.js');
  const { recapBoard, recapStats } = await import('../src/recap.js');
  const s = makeDemo();
  const args = { weeks: s.weeks, totals: s.totals, picks: s.picks, unburns: s.unburns, plays: s.plays, profiles: s.profiles, now: s.now, players: s.players, cardsFrom: s.cardsFrom };
  const W = 6;
  const run = date => computeLeague({ ...args, weeks: s.weeks.map(x => x.week === W ? { ...x, final: false } : x), totals: { ...s.totals, [W]: totalsThrough(s.days[W], date) } });
  const dates = Object.keys(s.days[W]).sort();
  const [prev, date] = dates;
  const after = run(date), before = run(prev);
  const board = recapBoard(after, before, W, 'season');
  assert.equal(board.length, s.profiles.length);

  // A night where a picked goalie, a plus-minus pick and a fighter all show up, made up on top of the demo's.
  const pick = slot => Object.keys(after.weeks.find(w => w.week === W).results).map(id => after.weeks.find(w => w.week === W).results[id].slots[slot]).find(x => x.scorer != null)?.scorer;
  const goalie = pick('SV'), pm = pick('PM'), pts = pick('PTS');
  const day = structuredClone(s.days[W][date]);
  day.p[goalie] = [1, 0, 0, 40, 40, 42, 952, 40, 42, 952, s.players[goalie].team, 42, 0, 0, 0];
  day.p[pm] = [1, 1, 3, 0, 1, 3, 0, 1, 3, 0, s.players[pm].team, 0, 0, 0, 0];
  day.p[pts] = [1, 4, 1, 0, 4, 1, 0, 4, 1, 0, s.players[pts].team, 0, 1, 3, 1];
  const text = recapStats({ after, before, W, date, day, schedule: s.schedule, players: s.players, label: 'Tue' });
  assert.match(text, /^🏒 Peakhill NHL Survivor · Week 6 · Tue/);
  assert.match(text, /The Wall of the night: .+, \.952 SV% on 42 shots/);
  assert.match(text, /Shutdown of the night: .+, \+3 \+\/-/);
  assert.match(text, /Lamplighter of the night: .+, 4 PTS/);
  assert.match(text, /🎩 Hat trick: .+, 3 goals/);
  assert.match(text, /🥊 Gloves off: /);
  assert.match(text, /Gordie Howe hat trick: /);
  assert.doesNotMatch(text, /undefined|NaN/);

  // A bad night in net and a minus night.
  day.p[goalie] = [1, 0, 0, 20, 20, 26, 769, 20, 26, 769, s.players[goalie].team, 26, 0, 0, 0];
  day.p[pm] = [1, 0, -3, 0, 0, -3, 0, 0, -3, 0, s.players[pm].team, 0, 0, 0, 0];
  const bad = recapStats({ after, before, W, date, day, schedule: s.schedule, players: s.players, label: 'Tue' });
  assert.match(bad, /🧀 Sieve of the night: .+, \.769 \(6 goals on 26 shots\)/);
  assert.match(bad, /🧊 Rough night: .+, −3/);
});

test('the injury report is matched to NHL players by name, and kept when the feed is down', async () => {
  const { parseInjuries, addInjuries } = await import('../scripts/injuries.mjs');
  const players = {
    1: { id: 1, name: 'Auston Matthews', team: 'TOR' },
    2: { id: 2, name: 'Sebastian Aho', team: 'CAR' },
    3: { id: 3, name: 'Sebastian Aho', team: 'NYI' },
  };
  const feed = { injuries: [
    { displayName: 'Toronto Maple Leafs', injuries: [{ status: 'Day-To-Day', athlete: { displayName: 'Auston Matthews' }, details: { type: 'Upper Body' } }] },
    { displayName: 'New York Islanders', injuries: [{ status: 'Injured Reserve', athlete: { displayName: 'Sebastian Aho' } }] },
  ] };
  assert.deepEqual(parseInjuries(feed, players), { 1: ['Day-to-day', 'Upper Body'], 3: ['IR', ''] });
  const fresh = structuredClone(players);
  await addInjuries({ sport: 'nhl', players: fresh, prev: { 1: { id: 1, inj: ['Out', ''] } }, getJson: async () => { throw new Error('down'); } });
  assert.deepEqual(fresh[1].inj, ['Out', '']);
  assert.equal(fresh[2].inj, undefined);
});
