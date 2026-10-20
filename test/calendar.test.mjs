import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekDays, totalsThrough, etDate } from '../src/calendar.js';
import { makeDemo } from '../src/demo.js';

const days = {
  '2026-11-03': { p: { 1: [1, 30, 5, 2, 'DEN'] }, t: { DEN: [1, 1], NYK: [1, 0] } },
  '2026-11-05': { p: { 1: [1, 12, 9, 7, 'DEN'], 2: [1, 8, 1, 1, 'NYK'] }, t: { DEN: [1, 0], NYK: [1, 1] } },
};

test('a week has a date for each day, and dates are New York dates', () => {
  assert.deepEqual(weekDays({ start: '2026-11-02', end: '2026-11-08' }), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
  assert.equal(etDate(Date.parse('2026-11-04T03:30:00Z')), '2026-11-03'); // 10:30pm ET on the 3rd
});

test('totals through a day add up the days so far, with best and worst games', () => {
  assert.deepEqual(totalsThrough(days, '2026-11-02'), { final: false, p: {}, t: {} });
  assert.deepEqual(totalsThrough(days, '2026-11-04').p[1], [1, 30, 5, 2, 30, 5, 2, 30, 5, 2, 'DEN']);
  const all = totalsThrough(days, '2026-11-08');
  assert.deepEqual(all.p[1], [2, 42, 14, 9, 30, 9, 7, 12, 5, 2, 'DEN']);
  assert.deepEqual(all.t, { DEN: [2, 1], NYK: [2, 1] });
});

test("the demo calendar's days add back up to the demo's weekly totals", () => {
  const d = makeDemo();
  assert.ok(d.schedule.length > 500);
  for (const [W, t] of Object.entries(d.totals)) {
    const rebuilt = totalsThrough(d.days[W], '2099-01-01');
    for (const [pid, line] of Object.entries(t.p)) assert.deepEqual(rebuilt.p[pid].slice(0, 4), line.slice(0, 4), `week ${W} player ${pid}`);
    for (const [tri, line] of Object.entries(t.t)) assert.deepEqual(rebuilt.t[tri] || [0, 0], line, `week ${W} ${tri}`);
  }
});
