// Cards on the Dub slot, and dealing from secret seeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLeague } from '../src/league.js';
import { seededDealer, packWeek } from '../src/cards.js';

const NOW = Date.parse('2027-06-01T00:00:00Z');
const lockOf = w => new Date(Date.parse('2026-11-03T00:00:00Z') + (w - 1) * 7 * 86400e3).toISOString();
const wk = (week, opts = {}) => ({ week, start: '2026-11-02', end: '2026-11-08', mult: 1, lockAt: lockOf(week), final: true, ...opts });
const before = w => new Date(Date.parse(lockOf(w)) - 2 * 86400e3).toISOString();
const after = w => new Date(Date.parse(lockOf(w)) + 8 * 86400e3).toISOString();
const pick = (user_id, week, slot, player_id) => ({ user_id, week, slot, player_id, alt_id: null, double_down: false });
const profiles = ['a', 'b', 'c'].map(id => ({ id, display_name: id.toUpperCase() }));
let n = 0;
const play = (user_id, week, card, extra = {}) => {
  n++;
  return { id: `d${n}`, user_id, week, card, card_uid: 'w1:starter', target_id: null, slot: null, player_id: null, params: {}, created_at: new Date(Date.parse(before(week)) + n * 1000).toISOString(), ...extra };
};
const DEN = 1610612743, BOS = 1610612738;
const line = (gp, pts, reb, ast, team = 'DEN') => [gp, pts, reb, ast, pts, reb, ast, 0, 0, 0, team];

function dubWeek() {
  const totals = { 1: { final: true, p: { 1: line(3, 90, 30, 25), 2: line(3, 60, 20, 10, 'BOS') }, t: { DEN: [4, 3], BOS: [3, 1] } } };
  const picks = [
    pick('a', 1, 'PTS', 1), pick('a', 1, 'WIN', DEN),
    pick('b', 1, 'PTS', 2), pick('b', 1, 'WIN', BOS),
  ];
  return { totals, picks };
}

test('Load Management on Dub takes off a win; Garbage Time turns a loss into a win', () => {
  const { totals, picks } = dubWeek();
  const plays = [
    play('b', 1, 'load', { target_id: 'a', slot: 'WIN' }),
    play('a', 1, 'garbage', { slot: 'WIN', created_at: after(1) }),
  ];
  const L = computeLeague({ weeks: [wk(1)], totals, picks, plays, profiles, now: NOW, cardsFrom: 1, dealer: u => u === 'b' ? ['load'] : ['garbage'] });
  const s = L.weeks[0].results.a.slots.WIN;
  // DEN went 3–1: Garbage Time makes it 4, then Load Management takes one off.
  assert.equal(s.value, 3);
  assert.equal(s.base, 3); // the survival bar still sees the real 3 wins
  assert.deepEqual(L.weeks[0].cards.plays.filter(p => p.ok).map(p => p.outcome).sort(), ['landed', 'played']);
});

test('Dub plays must name a team; Sixth Man and Switcheroo stay in the player slots', () => {
  const { totals, picks } = dubWeek();
  const plays = [
    play('a', 1, 'embargo', { slot: 'WIN', player_id: 1, created_at: new Date(Date.parse(lockOf(1)) - 3 * 86400e3).toISOString() }),
    play('b', 1, 'sixth', { player_id: DEN }),
    play('c', 1, 'switcheroo', { params: { map: { PTS: 'WIN', WIN: 'PTS' } }, created_at: after(1) }),
  ];
  const L = computeLeague({ weeks: [wk(1)], totals, picks: [...picks, pick('c', 1, 'PTS', 1), pick('c', 1, 'WIN', DEN)], plays, profiles, now: NOW, cardsFrom: 1,
    dealer: u => ({ a: ['embargo'], b: ['sixth'], c: ['switcheroo'] })[u] });
  const byCard = Object.fromEntries(L.weeks[0].cards.plays.map(p => [p.card, p]));
  assert.equal(byCard.embargo.why, 'player'); // a player can't be embargoed out of Dub
  assert.equal(byCard.sixth.why, 'player'); // a team can't come off the bench
  assert.equal(byCard.switcheroo.outcome, 'fizzled');
  assert.equal(byCard.switcheroo.why, 'bad-swap');
});

test('an Embargo on a team in Dub blocks it for everyone', () => {
  const { totals, picks } = dubWeek();
  const plays = [play('c', 1, 'embargo', { slot: 'WIN', player_id: DEN, created_at: new Date(Date.parse(lockOf(1)) - 3 * 86400e3).toISOString() })];
  const L = computeLeague({ weeks: [wk(1)], totals, picks, plays, profiles, now: NOW, cardsFrom: 1, dealer: () => ['embargo'] });
  assert.equal(L.weeks[0].results.a.slots.WIN.embargoed, true);
  assert.equal(L.weeks[0].results.a.slots.WIN.value, 0);
});

test('secret seeds: same seed, same pack; no seed, the pack stays face-down', () => {
  assert.equal(packWeek('w7:album:Pacific'), 7);
  const deal = seededDealer({ 'a|1': 'seed-a1', 'b|1': 'seed-b1' });
  const p1 = deal('a', 'w1:starter', 'starter', 'mid');
  assert.equal(p1.length, 3);
  assert.deepEqual(p1, seededDealer({ 'a|1': 'seed-a1' })('a', 'w1:starter', 'starter', 'mid'));
  assert.equal(deal('a', 'w2:locker', 'locker', 'mid'), null);
  // A different secret deals different packs (across a handful of keys).
  const other = seededDealer({ 'a|1': 'another-secret' });
  assert.ok(['w1:starter', 'w1:x', 'w1:y', 'w1:z'].some(k => JSON.stringify(deal('a', k, 'starter', 'mid')) !== JSON.stringify(other('a', k, 'starter', 'mid'))));

  // In the league: without b's week-2 seed, b's open-week packs simply aren't in b's hand yet.
  const weeks = [wk(1), wk(2, { lockAt: '2099-01-01T00:00:00Z', final: false })];
  const picks = [pick('a', 1, 'PTS', 1), pick('b', 1, 'PTS', 2)];
  const totals = { 1: { final: true, p: { 1: line(3, 90, 30, 25), 2: line(3, 60, 20, 10) } } };
  const seeds = { 'a|1': 's1', 'b|1': 's2', 'a|2': 's3' };
  const L = computeLeague({ weeks, totals, picks, profiles, now: NOW, cardsFrom: 1, dealer: seededDealer(seeds) });
  assert.ok(L.users.a.cards.packs.some(p => p.key === 'w2:locker'));
  assert.ok(!L.users.b.cards.packs.some(p => p.key === 'w2:locker'));
  assert.ok(L.users.b.cards.packs.some(p => p.key === 'w1:starter'));
});
