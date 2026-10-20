import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLeague, rankPoints, autopilotPicks, headToHead, blockedReason } from '../src/league.js';
import { buildWeeks, easternToUtc, monthKey } from '../src/config.js';

const NOW = Date.parse('2027-06-01T00:00:00Z');
const wk = (week, opts = {}) => ({ week, start: '2026-11-02', end: '2026-11-08', mult: 1, lockAt: '2026-11-03T00:00:00Z', final: true, ...opts });
const pick = (user_id, week, slot, player_id, extra = {}) => ({ user_id, week, slot, player_id, alt_id: null, double_down: false, ...extra });
const profiles = ['a', 'b', 'c'].map(id => ({ id, display_name: id.toUpperCase() }));

test('calendar: 23 weeks, double weeks, month buckets, DST-aware lock', () => {
  const weeks = buildWeeks();
  assert.equal(weeks.length, 23);
  assert.deepEqual(weeks.filter(w => w.mult === 2).map(w => w.week), [1, 17]);
  assert.equal(weeks[1].start, '2026-11-02');
  assert.equal(weeks[16].end, '2027-02-28');
  assert.equal(weeks[22].end, '2027-04-11');
  assert.equal(monthKey(weeks[0]), '2026-11');
  assert.equal(monthKey(weeks[22]), '2027-03');
  assert.equal(easternToUtc('2026-10-20', 19, 0), '2026-10-20T23:00:00.000Z');
  assert.equal(easternToUtc('2026-11-02', 19, 0), '2026-11-03T00:00:00.000Z');
});

test('rank points: one per colleague beaten, half per tie', () => {
  assert.deepEqual(rankPoints([10, 20, 20, 5]), [1, 2.5, 2.5, 0]);
});

test('weekly totals score, burns are per category, and double down doubles one slot', () => {
  const weeks = [wk(1), wk(2)];
  const totals = {
    1: { final: true, p: { 1: [3, 90, 30, 25], 2: [4, 110, 20, 10], 3: [2, 40, 25, 8] } },
    2: { final: true, p: { 1: [3, 80, 33, 21] } },
  };
  const picks = [
    pick('a', 1, 'PTS', 2, { double_down: true }), pick('a', 1, 'REB', 1), pick('a', 1, 'AST', 3),
    pick('b', 1, 'PTS', 1), pick('b', 1, 'REB', 3), pick('b', 1, 'AST', 2),
    // Week 2: a reuses player 1 in a different slot (allowed) and player 2 in PTS again (burned).
    pick('a', 2, 'AST', 1), pick('a', 2, 'PTS', 2),
  ];
  const L = computeLeague({ weeks, totals, picks, profiles, now: NOW });
  const r1 = L.weeks[0].results;
  assert.equal(r1.a.slots.PTS.value, 110);
  assert.equal(r1.a.slots.PTS.rank, 2); // beat b (1 point) doubled
  assert.equal(r1.a.score, 2 + 1 + 0);
  assert.equal(r1.b.score, 0 + 0 + 1);
  assert.equal(L.users.a.doubleDownWeek, 1);
  const r2 = L.weeks[1].results.a.slots;
  assert.equal(r2.AST.value, 21);
  assert.equal(r2.PTS.invalid, true);
  assert.equal(r2.PTS.value, 0);
  assert.equal(L.users.a.burns.REB.get(1), 1);
  assert.equal(L.users.a.burns.AST.get(1), 2);
});

test('alternate scores only when the main pick plays zero games', () => {
  const totals = { 1: { final: true, p: { 1: [0, 0, 0, 0], 2: [3, 70, 10, 5] } } };
  const picks = [pick('a', 1, 'PTS', 1, { alt_id: 2 })];
  const L = computeLeague({ weeks: [wk(1)], totals, picks, profiles, now: NOW });
  const s = L.weeks[0].results.a.slots.PTS;
  assert.equal(s.scorer, 2);
  assert.equal(s.usedAlt, true);
  assert.equal(L.users.a.burns.PTS.has(2), true);
  assert.equal(L.users.a.burns.PTS.has(1), false);
});

test('both picks DNP: zero, nothing burned, fumble award', () => {
  const totals = { 1: { final: true, p: { 9: [2, 50, 10, 10] } } };
  const picks = [pick('a', 1, 'PTS', 1, { alt_id: 2 }), pick('b', 1, 'PTS', 9)];
  const L = computeLeague({ weeks: [wk(1)], totals, picks, profiles, now: NOW });
  assert.equal(L.weeks[0].results.a.slots.PTS.fumble, true);
  assert.equal(L.users.a.burns.PTS.size, 0);
  assert.ok(L.weeks[0].awards.some(x => x.key === 'fumble' && x.user === 'a'));
});

test('survivor: clear 3 of 4 bars (50 PTS / 18 REB / 15 AST / 1 W, same in double weeks), 3 lives', () => {
  const DEN = 1610612743, OKC = 1610612760, BOS = 1610612738, LAL = 1610612747;
  const weeks = [wk(1, { mult: 2 }), wk(2), wk(3), wk(4)];
  const line = [3, 52, 18, 14]; // clears PTS and REB, misses AST
  const t = { DEN: [3, 2], OKC: [3, 2], BOS: [3, 2], LAL: [3, 0] };
  const totals = Object.fromEntries([1, 2, 3, 4].map(w => [w, { final: true, p: { [w * 10 + 1]: line, [w * 10 + 2]: line, [w * 10 + 3]: line }, t }]));
  const aTeams = [DEN, OKC, BOS, DEN]; // DEN again in week 4: burned, so it scores 0
  const picks = [];
  for (const w of [1, 2, 3, 4]) {
    picks.push(pick('a', w, 'PTS', w * 10 + 1), pick('a', w, 'REB', w * 10 + 2), pick('a', w, 'AST', w * 10 + 3), pick('a', w, 'WIN', aTeams[w - 1]));
    picks.push(pick('b', w, 'PTS', w * 10 + 1), pick('b', w, 'REB', w * 10 + 2), pick('b', w, 'AST', w * 10 + 3), pick('b', w, 'WIN', LAL));
  }
  const L = computeLeague({ weeks, totals, picks, profiles, now: NOW });
  assert.equal(L.weeks[0].results.a.slots.WIN.value, 2);
  assert.equal(L.weeks[0].results.a.cleared, 3);
  assert.equal(L.weeks[0].results.a.survived, true); // double week, same bars
  assert.equal(L.weeks[0].results.b.cleared, 2); // winless team
  assert.equal(L.weeks[3].results.a.slots.WIN.invalid, true);
  assert.equal(L.users.a.burns.WIN.get(DEN), 1);
  assert.equal(L.users.a.lives, 2);
  assert.equal(L.users.b.lives, 0);
  assert.equal(L.users.b.eliminatedWeek, 3);
  assert.equal(L.survivor.winner.id, 'a');
});

test('un-burn frees one player once, then he burns again', () => {
  const weeks = [wk(1), wk(2), wk(3)];
  const totals = { 1: { final: true, p: { 1: [3, 90, 9, 9] } }, 2: { final: true, p: { 1: [3, 95, 9, 9] } }, 3: { final: true, p: { 1: [3, 99, 9, 9] } } };
  const picks = [pick('a', 1, 'PTS', 1), pick('a', 2, 'PTS', 1), pick('a', 3, 'PTS', 1)];
  const L = computeLeague({ weeks, totals, picks, profiles, now: NOW, unburns: [{ user_id: 'a', slot: 'PTS', player_id: 1, week: 2 }] });
  assert.equal(L.weeks[1].results.a.slots.PTS.value, 95);
  assert.equal(L.weeks[2].results.a.slots.PTS.invalid, true);
});

test('open and live weeks: reserved players, hidden from scoring until locked', () => {
  const weeks = [wk(1, { final: false }), wk(2, { lockAt: '2099-01-01T00:00:00Z', final: false })];
  const totals = { 1: { final: false, p: { 1: [1, 30, 5, 5] } } };
  const picks = [pick('a', 1, 'PTS', 1, { alt_id: 2 }), pick('a', 2, 'PTS', 5, { double_down: true })];
  const L = computeLeague({ weeks, totals, picks, profiles, now: NOW });
  assert.equal(L.weeks[0].status, 'live');
  assert.equal(L.openWeek, 2);
  assert.equal(blockedReason(L, 'a', 'PTS', 1), 'Locked in wk 1');
  assert.equal(blockedReason(L, 'a', 'PTS', 2), 'Locked in wk 1');
  assert.equal(blockedReason(L, 'a', 'REB', 1), null);
  assert.equal(L.users.a.plannedDoubleDown, 'PTS');
  assert.equal(L.users.a.lives, 3);
});

test('drops unlock every 6 final weeks', () => {
  const weeks = Array.from({ length: 6 }, (_, i) => wk(i + 1));
  const totals = Object.fromEntries(weeks.map(w => [w.week, { final: true, p: { [w.week]: [1, w.week * 10, 1, 1] } }]));
  const picks = weeks.flatMap(w => [pick('a', w.week, 'PTS', w.week), pick('b', w.week, 'PTS', 100 + w.week)]);
  const L = computeLeague({ weeks, totals, picks, profiles, now: NOW });
  assert.equal(L.dropCount, 1);
  assert.equal(L.users.b.dropped.length, 1);
  assert.equal(L.users.a.counted, 5);
  assert.equal(L.users.a.rank, 1);
});

test('head to head and autopilot', () => {
  const weeks = [wk(1), wk(2, { lockAt: '2099-01-01T00:00:00Z', final: false })];
  const totals = { 1: { final: true, p: { 1: [3, 90, 9, 9], 2: [3, 60, 9, 9] } } };
  const picks = [pick('a', 1, 'PTS', 1), pick('b', 1, 'PTS', 2)];
  const L = computeLeague({ weeks, totals, picks, profiles, now: NOW });
  assert.deepEqual(headToHead(L, 'a', 'b').w, 1);
  const players = {
    1: { id: 1, team: 'DEN', avg: [30, 12, 9] },
    2: { id: 2, team: 'OKC', avg: [32, 5, 6] },
    3: { id: 3, team: 'BOS', avg: [20, 13, 4] },
  };
  const games = { DEN: 4, OKC: 2, BOS: 3 };
  const auto = autopilotPicks(L, 'a', 2, {}, players, games, { DEN: { w: 1, l: 5 }, BOS: { w: 5, l: 1 }, OKC: { w: 6, l: 0 } });
  // a burned 1 on PTS: best PTS is 2 (64) vs 3 (60); REB 1 (48); AST: 3 left (12).
  // WIN: BOS 3 games × 6/8 = 2.25 beats OKC 2 × 7/8 = 1.75 and DEN 4 × 2/8 = 1.
  assert.deepEqual(auto, { PTS: 2, REB: 1, AST: 3, WIN: 1610612738 });
});

test('commissioner stats: burn ledger, firepower, contrarians, records', async () => {
  const { funStats } = await import('../src/stats.js');
  const weeks = [wk(1)];
  const totals = { 1: { final: true, p: { 1: [3, 90, 30, 25], 2: [3, 60, 20, 10], 3: [0, 0, 0, 0] } } };
  const picks = [
    pick('a', 1, 'PTS', 1), pick('b', 1, 'PTS', 1), pick('c', 1, 'PTS', 2),
    pick('a', 1, 'REB', 3, { alt_id: 2 }),
  ];
  const players = {
    1: { id: 1, name: 'One', avg: [30, 10, 8] },
    2: { id: 2, name: 'Two', avg: [20, 7, 3] },
    3: { id: 3, name: 'Three', avg: [10, 12, 2] },
  };
  const L = computeLeague({ weeks, totals, picks, profiles, now: NOW });
  const st = funStats(L, players);
  assert.equal(st.ledger[1].PTS.length, 2);
  assert.equal(st.mostBurned.PTS[0].pid, 1);
  assert.equal(st.people.a.saves, 1);
  assert.deepEqual(st.untouched.PTS.map(p => p.id), [3]);
  assert.equal(st.contrarian[0].id, 'c');
  assert.equal(st.best.pid, 1);
  assert.equal(st.firepower[0].id, 'c'); // c kept player 1 for points
});

test('hindsight: assignment is optimal, perfect week uses three different players', async () => {
  const { perfectPlay, maxAssignment } = await import('../src/stats.js');
  // Greedy would give row 0 → col 0 (10) and row 1 → col 1 (1) = 11; optimal is 9 + 8 = 17.
  const M = [[10, 9], [8, 1]];
  assert.deepEqual(maxAssignment(2, 2, (i, j) => M[i][j]), [1, 0]);

  const weeks = [wk(1), wk(2)];
  // Player 1 is the best scorer both weeks; the perfect season uses him once, in his bigger week.
  const totals = {
    1: { final: true, p: { 1: [3, 100, 20, 10], 2: [3, 90, 5, 5], 3: [3, 20, 25, 3] } },
    2: { final: true, p: { 1: [3, 110, 9, 9], 2: [3, 40, 9, 9], 3: [3, 30, 30, 12] } },
  };
  const picks = [pick('a', 1, 'PTS', 2), pick('a', 2, 'PTS', 1), pick('b', 1, 'PTS', 1), pick('b', 2, 'PTS', 2)];
  const L = computeLeague({ weeks, totals, picks, profiles, now: NOW });
  const pp = perfectPlay(L, totals);
  assert.equal(pp.season.PTS.total, 200);
  assert.deepEqual(pp.season.PTS.plan.map(x => x.pid), [2, 1]);
  const w1 = pp.weeks[0].perfect;
  assert.equal(new Set([w1.PTS.pid, w1.REB.pid, w1.AST.pid]).size, 3);
  assert.equal(pp.people[0].id, 'a'); // a got 90 + 110 = 200 points, the perfect total
});

test('season awards: category titles, fun and shame awards, decided at season end', async () => {
  const { seasonAwards } = await import('../src/awards.js');
  const DEN = 1610612743, BOS = 1610612738;
  const weeks = [wk(1), wk(2)];
  const totals = {
    1: { final: true, p: { 1: [3, 90, 30, 25], 2: [3, 60, 20, 10], 3: [0, 0, 0, 0] }, t: { DEN: [3, 3], BOS: [3, 1] } },
    2: { final: true, p: { 4: [3, 80, 12, 9], 5: [3, 70, 11, 8] }, t: { DEN: [3, 2], BOS: [3, 2] } },
  };
  const picks = [
    pick('a', 1, 'PTS', 1), pick('a', 1, 'WIN', DEN), pick('b', 1, 'PTS', 2), pick('b', 1, 'WIN', BOS, { auto: true }),
    pick('a', 2, 'PTS', 4), pick('b', 2, 'PTS', 5), pick('b', 2, 'REB', 3),
  ];
  const L = computeLeague({ weeks, totals, picks, profiles, now: NOW });
  const A = seasonAwards(L, id => `#${id}`);
  const t = Object.fromEntries(A.titles.map(x => [x.key, x]));
  assert.equal(t['cat-PTS'].leader.id, 'a'); // 90 + 80 = 170 vs 130
  assert.equal(t['cat-PTS'].leader.v, 170);
  assert.equal(t['cat-WIN'].leader.id, 'a');
  assert.equal(t['cat-PTS'].decided, true); // every week final
  const fame = Object.fromEntries(A.fame.map(x => [x.key, x]));
  assert.equal(fame['weeks-won'].leader.id, 'a');
  assert.match(fame.heater.leaderText, /#1: 90 PTS in week 1/);
  const shame = Object.fromEntries(A.shame.map(x => [x.key, x]));
  assert.equal(shame.asleep.leader.id, 'b');
  assert.equal(shame.fumble.leader.id, 'b'); // player 3 never played
  assert.equal(A.champion.leader.id, 'a');
  // Nobody qualifies for awards with a zero count.
  assert.equal(fame.insurance.leader, null);
});

test('a live week pays nothing in a category until a pick in it has played', () => {
  const live = wk(1, { final: false, lockAt: '2026-10-20T19:00:00Z', start: '2026-10-20', end: '2026-11-01' });
  const now = Date.parse('2026-10-20T20:00:00Z');
  const picks = [
    pick('a', 1, 'PTS', 1, { double_down: true }), pick('a', 1, 'REB', 2),
    pick('b', 1, 'PTS', 3), pick('b', 1, 'REB', 4),
    pick('c', 1, 'PTS', 5), pick('c', 1, 'REB', 6),
  ];
  // Nothing played yet: everyone ties at 0 but nobody collects tie points, Double Down included.
  let L = computeLeague({ weeks: [live], totals: {}, picks, profiles, now });
  assert.equal(L.weeks[0].status, 'live');
  for (const id of ['a', 'b', 'c']) assert.equal(L.weeks[0].results[id].score, 0);

  // Two rebounders have played: they rank against each other; the one still waiting scores 0 for now.
  L = computeLeague({ weeks: [live], totals: { 1: { final: false, p: { 4: [1, 2, 9, 1], 6: [1, 2, 5, 1] } } }, picks, profiles, now });
  const r = L.weeks[0].results;
  assert.equal(r.b.slots.REB.rank, 1);
  assert.equal(r.c.slots.REB.rank, 0);
  assert.equal(r.a.slots.REB.rank, 0, 'a pick that has not played earns nothing yet, even tied at 0');
  for (const id of ['a', 'b', 'c']) assert.equal(r[id].slots.PTS.rank, 0);
});

test('a live week: a played pick beats an empty slot, but not a pick still waiting to play', () => {
  const live = wk(1, { final: false, lockAt: '2026-10-20T19:00:00Z', start: '2026-10-20', end: '2026-11-01' });
  const now = Date.parse('2026-10-20T23:00:00Z');
  const picks = [pick('a', 1, 'PTS', 1), pick('a', 1, 'REB', 9), pick('b', 1, 'REB', 2), pick('c', 1, 'REB', 3)];
  const totals = { 1: { final: false, p: { 1: [1, 20, 2, 1] } } };
  const r = computeLeague({ weeks: [live], totals, picks, profiles, now }).weeks[0].results;
  // b and c left Bucket empty: a's played pick beats both. Nobody's REB pick has played yet.
  assert.equal(r.a.slots.PTS.rank, 2);
  for (const id of ['a', 'b', 'c']) assert.equal(r[id].slots.REB.rank, 0);
});

test('a final week still pays ½ per tie, even at 0', () => {
  const totals = { 1: { final: true, p: { 1: [2, 0, 0, 0], 3: [2, 0, 0, 0] } } };
  const picks = [pick('a', 1, 'PTS', 1), pick('b', 1, 'PTS', 3)];
  const L = computeLeague({ weeks: [wk(1)], totals, picks, profiles, now: NOW });
  assert.equal(L.weeks[0].results.a.slots.PTS.rank, 0.5);
  assert.equal(L.weeks[0].results.b.slots.PTS.rank, 0.5);
});
