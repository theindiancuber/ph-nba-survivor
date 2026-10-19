import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLeague } from '../src/league.js';
import { weekRules, seasonRules, describeChange } from '../src/settings.js';
import { LEAGUE } from '../src/config.js';

const NOW = Date.parse('2027-06-01T00:00:00Z');
const wk = week => ({ week, start: '2026-11-02', end: '2026-11-08', mult: 1, lockAt: `2026-11-0${week + 2}T00:00:00Z`, final: true });
const pick = (user_id, week, slot, player_id) => ({ user_id, week, slot, player_id, alt_id: null, double_down: false });
const profiles = ['a', 'b'].map(id => ({ id, display_name: id.toUpperCase() }));
// a scores 40 PTS, 20 REB and 10 AST each week: only the REB bar clears at the defaults.
const picks = [1, 2].flatMap(w => [pick('a', w, 'PTS', w === 1 ? 1 : 301), pick('a', w, 'REB', 1 + 100 * w), pick('a', w, 'AST', 1 + 200 * w)]);
const totals2 = { 1: { final: true, p: { 1: [3, 40, 20, 10], 101: [3, 0, 20, 0], 201: [3, 0, 0, 10] } }, 2: { final: true, p: { 301: [3, 40, 0, 0], 201: [3, 0, 20, 0], 401: [3, 0, 0, 10] } } };

test('rule changes take effect from their week and stack in order; bad values are ignored', () => {
  const rules = [{ from_week: 3, bars: { PTS: 30 } }, { from_week: 2, bars: { PTS: 40, REB: 'x' }, barsToSurvive: 99 }];
  assert.equal(weekRules(rules, 1).bars.PTS, 50);
  assert.equal(weekRules(rules, 2).bars.PTS, 40);
  assert.equal(weekRules(rules, 2).bars.REB, 18);
  assert.equal(weekRules(rules, 2).barsToSurvive, 3);
  assert.equal(weekRules(rules, 5).bars.PTS, 30);
  assert.deepEqual(describeChange({ from_week: 2, bars: { PTS: 40 }, cards: { handLimit: 5 } }), ['Bucket bar 40 PTS', 'hand limit 5']);
  assert.equal(seasonRules({ lives: 5, commissioner: '  Big Boss ' }).commissioner, 'Big Boss');
  assert.equal(seasonRules({ lives: 500 }).lives, 3);
});

test('a lower bar from Week 2 saves a life in Week 2 but not Week 1', () => {
  const plain = computeLeague({ weeks: [wk(1), wk(2)], totals: totals2, picks, profiles, now: NOW });
  assert.deepEqual([1, 2].map(w => plain.weeks[w - 1].results.a.survived), [false, false]);
  assert.equal(plain.users.a.lives, 1);
  const L = computeLeague({ weeks: [wk(1), wk(2)], totals: totals2, picks, profiles, now: NOW, rules: [{ from_week: 2, bars: { PTS: 40 }, barsToSurvive: 2 }] });
  assert.deepEqual([1, 2].map(w => L.weeks[w - 1].results.a.survived), [false, true]);
  assert.equal(L.users.a.lives, 2);
  // After scoring, LEAGUE holds the latest week's rules; a plain run puts the defaults back.
  assert.equal(LEAGUE.bars.PTS, 40);
  computeLeague({ weeks: [wk(1)], totals: {}, picks: [], profiles, now: NOW });
  assert.equal(LEAGUE.bars.PTS, 50);
  assert.equal(LEAGUE.barsToSurvive, 3);
});

test('season lives, and public point and life adjustments', () => {
  const L = computeLeague({ weeks: [wk(1), wk(2)], totals: totals2, picks, profiles, now: NOW, meta: { lives: 5 } });
  assert.equal(L.users.a.lives, 3);
  const adjustments = [
    { id: 'x', user_id: 'a', week: 1, points: 2.5, lives: 1, reason: 'Stat correction' },
    { id: 'y', user_id: 'a', week: 2, points: 0, lives: -9, reason: 'Test' },
  ];
  const A = computeLeague({ weeks: [wk(1), wk(2)], totals: totals2, picks, profiles, now: NOW, adjustments });
  const r1 = A.weeks[0].results.a;
  assert.deepEqual(r1.adj, [{ commish: true, label: 'Commissioner', pts: 2.5, note: 'Stat correction' }]);
  assert.equal(r1.score, 2.5);
  assert.equal(A.users.a.lives, 0);
  assert.equal(A.users.a.eliminatedWeek, 2);
});
