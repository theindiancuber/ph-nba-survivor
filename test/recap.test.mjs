import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nightStatus, recapNights, recapBoard, recapStats } from '../src/recap.js';
import { totalsThrough } from '../src/calendar.js';
import { computeLeague } from '../src/league.js';
import { makeDemo } from '../src/demo.js';

const sched = [
  ['a', '2026-10-20', '2026-10-20T23:30:00Z', 'NYK', 'BOS', 3, 110, 100],
  ['b', '2026-10-20', '2026-10-21T02:00:00Z', 'LAL', 'GSW', 2, 50, 48],
  ['c', '2026-10-21', '2026-10-21T23:00:00Z', 'DEN', 'OKC', 1, null, null],
];

test('a night is over when every game is final, or by 6am ET the next day', () => {
  const at = Date.parse('2026-10-21T05:00:00Z'); // 1am ET
  assert.deepEqual(nightStatus(sched, '2026-10-20', at), { games: 2, done: 1, live: 1, over: false });
  assert.equal(nightStatus(sched, '2026-10-20', Date.parse('2026-10-21T10:30:00Z')).over, true);
  const done = sched.map(g => g[0] === 'b' ? [...g.slice(0, 5), 3, 111, 99] : g);
  assert.equal(nightStatus(done, '2026-10-20', at).over, true);
  assert.equal(nightStatus(sched, '2026-10-22', at).over, false); // no games
});

test('only nights in locked weeks, up to today, are recapped', () => {
  const weeks = [{ week: 1, start: '2026-10-20', end: '2026-10-20', status: 'live' }, { week: 2, start: '2026-10-21', end: '2026-10-27', status: 'open' }];
  assert.deepEqual(recapNights(sched, weeks, '2026-10-21'), ['2026-10-20']);
});

test('the recap board and fun stats come from the league before and after a night', () => {
  const s = makeDemo();
  const args = { weeks: s.weeks, totals: s.totals, picks: s.picks, unburns: s.unburns, plays: s.plays, profiles: s.profiles, now: s.now, players: s.players, cardsFrom: s.cardsFrom };
  const W = 6;
  const run = date => computeLeague({ ...args, weeks: s.weeks.map(x => x.week === W ? { ...x, final: false } : x), totals: { ...s.totals, [W]: totalsThrough(s.days[W], date) } });
  const after = run('2026-12-01'), before = run('2026-11-30');

  const season = recapBoard(after, before, W, 'season');
  assert.equal(season.length, s.profiles.length);
  for (let i = 1; i < season.length; i++) assert.ok(season[i - 1].season >= season[i].season, 'sorted by season points');
  // Movement adds up: ranks before are rank + move, and they're a valid ranking.
  const prevRanks = season.map(r => r.rank + r.move).sort((a, b) => a - b);
  assert.equal(prevRanks[0], 1);
  for (const r of season) assert.equal(r.tonight, r.week - (before.weeks.find(w => w.week === W).results[r.id]?.score || 0));

  const week = recapBoard(after, before, W, 'week');
  for (let i = 1; i < week.length; i++) assert.ok(week[i - 1].week >= week[i].week, 'sorted by week points');
  // On a week's first night there's no earlier week standing to move from.
  const first = recapBoard(run('2026-11-30'), run('2026-11-29'), W, 'week');
  assert.ok(first.every(r => r.move === null));

  const text = recapStats({ after, before, W, date: '2026-12-01', day: s.days[W]['2026-12-01'], schedule: s.schedule, players: s.players, label: 'Tue, Dec 1' });
  assert.match(text, /^🏀 Peakhill NBA Survivor · Week 6 · Tue, Dec 1/);
  assert.match(text, /Bucket of the night: .+ \d+ PTS/);
  assert.match(text, /👑 Top of the table: /);
});
