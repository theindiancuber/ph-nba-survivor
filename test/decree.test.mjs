import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLeague } from '../src/league.js';
import { resolveDecrees, decreeCodes, parseDecree, DECREE_CODES } from '../src/decrees.js';

const NOW = Date.parse('2027-06-01T00:00:00Z');
const wk = (week, opts = {}) => ({ week, start: '2026-11-02', end: '2026-11-08', mult: 1, lockAt: `2026-11-0${week + 2}T00:00:00Z`, final: true, ...opts });
const pick = (user_id, week, slot, player_id) => ({ user_id, week, slot, player_id, alt_id: null, double_down: false });
const profiles = ['a', 'b', 'c'].map(id => ({ id, display_name: id.toUpperCase() }));

// a: PTS 110, REB 30, AST 8. b: PTS 90, REB 25, AST 10. Without a decree a scores 2, b scores 1,
// and both clear 2 of 4 bars, so both lose a life.
const totals = { 1: { final: true, p: { 1: [3, 90, 30, 25], 2: [4, 110, 20, 10], 3: [2, 40, 25, 8] } }, 2: { final: true, p: { 2: [3, 60, 10, 5] } } };
const picks = [
  pick('a', 1, 'PTS', 2), pick('a', 1, 'REB', 1), pick('a', 1, 'AST', 3),
  pick('b', 1, 'PTS', 1), pick('b', 1, 'REB', 3), pick('b', 1, 'AST', 2),
];
const run = (decrees, extra = {}) => computeLeague({ weeks: [wk(1), wk(2)], totals, picks, profiles, now: NOW, decrees, ...extra });

test('decree codes parse, and junk is ignored', () => {
  assert.equal(parseDecree('spotlight:PTS').title, 'Prime Time: Bucket');
  assert.equal(parseDecree('spotlight'), null);
  assert.equal(parseDecree('mercy:PTS'), null);
  assert.equal(parseDecree('nope'), null);
  assert.equal(DECREE_CODES.length, 15);
  const L = run({ 1: 'nope' });
  assert.equal(L.weeks[0].results.a.score, 2);
});

test('Prime Time doubles a category; Opposite Day flips it but a fumble still ranks last', () => {
  assert.equal(run({}).weeks[0].results.a.score, 2);
  const L = run({ 1: 'spotlight:PTS' });
  assert.equal(L.weeks[0].results.a.slots.PTS.rank, 2);
  assert.equal(L.weeks[0].results.a.score, 3);
  assert.equal(L.weeks[0].decree.kind, 'spotlight');

  const o = computeLeague({ weeks: [wk(1)], totals, picks: [...picks, pick('c', 1, 'REB', 99)], profiles, now: NOW, decrees: { 1: 'opposite:REB' } });
  const r = o.weeks[0].results;
  assert.deepEqual([r.b.slots.REB.rank, r.a.slots.REB.rank, r.c.slots.REB.rank], [2, 1, 0]);
});

test('Bounty pays the top scorer; Mercy and Sudden Death change who loses a life', () => {
  const b = run({ 1: 'bounty' }).weeks[0].results;
  assert.deepEqual(b.a.adj, [{ decree: 'bounty', label: 'Bounty', pts: 5 }]);
  assert.equal(b.a.score, 7);
  assert.equal(b.b.adj.length, 0);

  assert.equal(run({}).users.a.lives, 2);
  assert.equal(run({ 1: 'mercy' }).users.a.lives, 3);
  // Week 2: a alone clears 1 bar; with Sudden Death a player clearing 3 of 4 would still fall.
  const sd = computeLeague({ weeks: [wk(1)], totals: { 1: { final: true, p: { 1: [3, 90, 30, 25] } } }, picks: [pick('a', 1, 'PTS', 1)], profiles, now: NOW, decrees: { 1: 'sudden_death' } });
  assert.equal(sd.weeks[0].results.a.survived, false);
});

test('Amnesty: that week\'s picks don\'t burn', () => {
  const p2 = [...picks, pick('a', 2, 'PTS', 2)];
  const plain = computeLeague({ weeks: [wk(1), wk(2)], totals, picks: p2, profiles, now: NOW });
  assert.equal(plain.weeks[1].results.a.slots.PTS.invalid, true);
  const am = computeLeague({ weeks: [wk(1), wk(2)], totals, picks: p2, profiles, now: NOW, decrees: { 1: 'amnesty' } });
  assert.equal(am.weeks[1].results.a.slots.PTS.value, 60);
  assert.equal(am.users.a.burns.PTS.get(2), 2);
});

test('Pack Day deals a bonus pack; Ceasefire voids card plays; Free-for-all allows two', () => {
  const dealer = () => ['jinx', 'clown', 'charge'];
  const keep = (key, week, at) => ({ id: `k${key}`, user_id: 'a', week, card: '_keep', card_uid: `pack:${key}`, params: { pick: 0 }, created_at: at });
  const jinx = (id, uid, week, at) => ({ id, user_id: 'a', week, card: 'jinx', card_uid: uid, target_id: 'b', slot: 'PTS', player_id: 1, params: {}, created_at: at });
  const base = { cardsFrom: 1, dealer };
  const pd = run({ 1: 'pack_day' }, { ...base, plays: [] });
  assert.deepEqual(pd.users.a.cards.packs.filter(p => p.step === 1).map(p => p.key), ['w1:starter', 'w1:decree']);

  // Week 1: two packs on Pack Day, two jinxes, but only one counts.
  const p1 = [keep('w1:starter', 1, '2026-11-01T00:00:00Z'), keep('w1:decree', 1, '2026-11-01T00:00:00Z'),
    jinx('j1', 'w1:starter', 1, '2026-11-02T00:00:00Z'), jinx('j2', 'w1:decree', 1, '2026-11-02T01:00:00Z')];
  const why = (L, w) => L.cards.weeks[w].plays.map(p => p.why);
  assert.deepEqual(why(run({ 1: 'pack_day' }, { ...base, plays: p1 }), 1), [null, 'limit']);
  assert.deepEqual(why(run({ 1: 'ceasefire' }, { ...base, plays: p1 }), 1), ['ceasefire', 'ceasefire']);

  // Week 2: a holds the starter card and a Locker Room card. Free-for-all lets both count.
  const p2 = [keep('w1:starter', 1, '2026-11-01T00:00:00Z'), keep('w2:locker', 2, '2026-11-03T01:00:00Z'),
    jinx('j3', 'w1:starter', 2, '2026-11-03T02:00:00Z'), jinx('j4', 'w2:locker', 2, '2026-11-03T03:00:00Z')];
  assert.deepEqual(why(run({}, { ...base, plays: p2 }), 2), [null, 'limit']);
  assert.deepEqual(why(run({ 2: 'free_for_all' }, { ...base, plays: p2 }), 2), [null, null]);
});

test('votes: most votes wins once voting closes; ties go to the first option', () => {
  const locks = { 3: '2026-11-20T00:00:00Z', 4: '2026-11-27T00:00:00Z' };
  const rows = [{ week: 3, options: ['mercy', 'bounty', 'pack_day'] }, { week: 4, options: ['amnesty'] }];
  const tallies = [{ week: 3, choice: 1, votes: 2 }, { week: 3, choice: 2, votes: 2 }];
  const before = resolveDecrees(rows, tallies, locks, Date.parse('2026-11-18T00:00:00Z'));
  assert.equal(before[3].closed, false);
  assert.equal(before[3].code, null);
  assert.deepEqual(before[3].votes, [0, 2, 2]);
  assert.equal(before[4].code, 'amnesty');
  const after = resolveDecrees(rows, tallies, locks, Date.parse('2026-11-19T01:00:00Z'));
  assert.equal(after[3].code, 'bounty');
  assert.deepEqual(decreeCodes(after), { 3: 'bounty', 4: 'amnesty' });
  assert.equal(resolveDecrees(rows, [], locks, Date.parse('2026-11-19T01:00:00Z'))[3].code, 'mercy');
});
