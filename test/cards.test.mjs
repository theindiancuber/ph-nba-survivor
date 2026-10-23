import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLeague, blockedReason } from '../src/league.js';
import { dealPack, CARDS, DECK, packOdds, tierFor, standingOdds, standingFor } from '../src/cards.js';
import { LEAGUE } from '../src/config.js';

const NOW = Date.parse('2027-06-01T00:00:00Z');
const lockOf = w => new Date(Date.parse('2026-11-03T00:00:00Z') + (w - 1) * 7 * 86400e3).toISOString();
const wk = (week, opts = {}) => ({ week, start: '2026-11-02', end: '2026-11-08', mult: 1, lockAt: lockOf(week), final: true, ...opts });
const before = w => new Date(Date.parse(lockOf(w)) - 2 * 86400e3).toISOString();
const after = w => new Date(Date.parse(lockOf(w)) + 8 * 86400e3).toISOString();
const pick = (user_id, week, slot, player_id, extra = {}) => ({ user_id, week, slot, player_id, alt_id: null, double_down: false, ...extra });
const profiles = ['a', 'b', 'c', 'd'].map(id => ({ id, display_name: id.toUpperCase() }));

// Everyone's starter pack is [card, clown, charge]; keep index 0 by default (auto-keep).
const dealer = hands => (uid, key) => hands[uid]?.[key] || hands[uid]?.['*'] || ['clown', 'charge', 'scout'];
let n = 0;
// Plays are ordered by time, so each one is stamped a second after the last.
const play = (user_id, week, card, extra = {}) => {
  n++;
  const created_at = new Date(Date.parse(before(week)) + n * 1000).toISOString();
  return { id: `p${String(n).padStart(4, '0')}`, user_id, week, card, card_uid: 'w1:starter', target_id: null, slot: null, player_id: null, params: {}, created_at, ...extra };
};

// Lines: [gp, pts, reb, ast, maxPts, maxReb, maxAst, minPts, minReb, minAst, team]
const line = (gp, pts, reb, ast, hi = [pts, reb, ast], lo = [0, 0, 0], team = 'DEN') => [gp, pts, reb, ast, ...hi, ...lo, team];

function basicWeek() {
  const totals = {
    1: { final: true, p: {
      1: line(3, 90, 30, 25, [40, 12, 10], [20, 8, 7], 'DEN'),
      2: line(3, 60, 20, 10, [30, 9, 5], [10, 5, 2], 'BOS'),
      3: line(3, 45, 25, 8, [20, 10, 4], [10, 7, 1], 'NYK'),
      4: line(2, 50, 10, 30, [30, 6, 18], [20, 4, 12], 'PHI'),
      5: line(3, 30, 12, 6, [12, 5, 3], [8, 3, 1], 'TOR'),
    } },
  };
  const picks = [
    pick('a', 1, 'PTS', 1), pick('a', 1, 'REB', 3), pick('a', 1, 'AST', 4),
    pick('b', 1, 'PTS', 2), pick('b', 1, 'REB', 1), pick('b', 1, 'AST', 5),
    pick('c', 1, 'PTS', 4), pick('c', 1, 'REB', 2), pick('c', 1, 'AST', 1),
  ];
  return { totals, picks };
}

test('packs are deterministic, three different cards, and comeback cards only reach the bottom half', () => {
  const a = dealPack('u1', 'w3:locker', 'locker', 'mid');
  assert.deepEqual(a, dealPack('u1', 'w3:locker', 'locker', 'mid'));
  assert.equal(new Set(a).size, 3);
  assert.notDeepEqual(a, dealPack('u2', 'w3:locker', 'locker', 'mid'));
  for (let i = 0; i < 300; i++) {
    for (const c of dealPack(`x${i}`, 'k', 'locker', 'lead')) assert.equal(CARDS[c].comeback, undefined);
  }
  assert.ok(Array.from({ length: 200 }, (_, i) => dealPack(`y${i}`, 'k', 'locker', 'trail')).flat().some(c => CARDS[c].comeback));
  assert.equal(packOdds('album', 'mid').common, 0);
  assert.equal(DECK.length, 17);
  const snap = { order: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], rank: new Map(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id, i) => [id, i + 1])) };
  assert.equal(tierFor(snap, 'a'), 'lead');
  assert.equal(tierFor(snap, 'c'), 'mid');
  assert.equal(tierFor(snap, 'f'), 'trail');
  assert.equal(tierFor(snap, 'nobody'), 'trail');
});

test('starter and locker packs, keeping a card, auto-keep at the lock, and the hand limit', () => {
  const weeks = [1, 2, 3, 4, 5, 6].map(w => wk(w));
  const picks = [1, 2, 3, 4, 5].map(w => pick('a', w, 'PTS', 100 + w));
  const totals = {};
  const deal = (uid, key) => key.endsWith('starter') ? ['duel', 'jinx', 'leech'] : ['scout', 'clown', 'charge'];
  const plays = [{ id: 'k1', user_id: 'a', week: 1, card: '_keep', card_uid: 'w1:starter', params: { pick: 1 }, created_at: before(1) }];
  const L = computeLeague({ weeks, totals, picks, plays, profiles, now: NOW, cardsFrom: 1, dealer: deal });
  const c = L.users.a.cards;
  assert.equal(c.packs[0].keep, 1);
  assert.equal(c.packs[0].auto, false);
  assert.equal(c.packs[1].key, 'w2:locker');
  assert.equal(c.packs[1].auto, true);
  // Starter + 5 locker packs (weeks 2–6), plus revenge packs for the lives a lost.
  assert.equal(c.packs.filter(p => p.kind === 'starter' || p.kind === 'locker').length, 6);
  assert.equal(c.packs.filter(p => p.kind === 'revenge').length, 3);
  // Hand limit 4: the oldest cards are discarded first.
  assert.equal(c.hand.length, 4);
  assert.equal(c.discarded[0].uid, 'w1:starter');
  assert.equal(c.discarded[0].card, 'jinx');
  // b never picked: starter pack only.
  assert.equal(L.users.b.cards.packs.length, 1);
});

test('the open week deals packs, keeps wait for a choice, and plays use up the card', () => {
  const weeks = [wk(1), wk(2, { lockAt: '2099-01-01T00:00:00Z', final: false })];
  const deal = () => ['embargo', 'jinx', 'leech'];
  const plays = [
    { id: 'k', user_id: 'a', week: 2, card: '_keep', card_uid: 'w2:starter', params: { pick: 0 }, created_at: before(1) },
    { id: 'e', user_id: 'a', week: 2, card: 'embargo', card_uid: 'w2:starter', slot: 'REB', player_id: 9, params: {}, created_at: after(1) },
  ];
  const L = computeLeague({ weeks, totals: {}, picks: [], plays, profiles, now: NOW, cardsFrom: 2, dealer: deal });
  assert.equal(L.openWeek, 2);
  const cw = L.cards.weeks[2];
  assert.equal(cw.plays[0].ok, true);
  assert.equal(L.users.a.cards.hand.length, 0);
  assert.equal(L.users.b.cards.packs[0].keep, null);
  assert.equal(L.users.b.cards.packs[0].auto, false);
  assert.equal(L.users.b.cards.hand.length, 0); // waiting to be opened
  assert.equal(blockedReason(L, 'b', 'REB', 9), 'Embargoed 🚫');
  assert.equal(blockedReason(L, 'b', 'PTS', 9), null);
});

test('jinx halves a matching pick, misses are air balls, and the Survivor Belt ignores it', () => {
  const { totals, picks } = basicWeek();
  const plays = [
    play('a', 1, 'jinx', { target_id: 'b', player_id: 1, params: { taunt: 0 } }),
    play('c', 1, 'jinx', { target_id: 'b', player_id: 99 }),
  ];
  const L = computeLeague({ weeks: [wk(1)], totals, picks, plays, profiles, now: NOW, cardsFrom: 1, dealer: dealer({ a: { '*': ['jinx', 'clown', 'scout'] }, c: { '*': ['jinx', 'clown', 'scout'] } }) });
  const w = L.weeks[0];
  const b = w.results.b.slots.REB;
  assert.equal(b.value, 15);
  assert.equal(b.base, 30);
  assert.equal(b.fx[0].card, 'jinx');
  assert.deepEqual(w.cards.plays[0].hits, [{ slot: 'REB', before: 30, after: 15 }]);
  assert.deepEqual(w.cards.plays[1].hits, []);
  assert.equal(w.cards.plays[1].outcome, 'landed');
  assert.equal(w.results.b.cleared, 2); // the belt still sees 30 REB, not the jinxed 15
});

test('traps: Uno Reverse bounces a jinx back, and the next attacks land', () => {
  const { totals, picks } = basicWeek();
  const plays = [
    play('b', 1, 'reverse', { created_at: '2026-10-30T00:00:00Z' }),
    play('a', 1, 'jinx', { target_id: 'b', player_id: 1 }), // bounces: a picked 1 for PTS
    play('c', 1, 'clown', { target_id: 'b' }),
    play('d', 1, 'clown', { target_id: 'b' }),
  ];
  const deal = uid => ({ a: ['jinx'], b: ['reverse'], c: ['clown'], d: ['clown'] }[uid]);
  const L = computeLeague({ weeks: [wk(1)], totals, picks, plays, profiles, now: NOW, cardsFrom: 1, dealer: deal });
  const cw = L.weeks[0].cards;
  const [rev, jinx, c1, d1] = cw.plays;
  assert.equal(rev.sprung, 1);
  assert.equal(jinx.outcome, 'reversed');
  assert.equal(L.weeks[0].results.a.slots.PTS.value, 45); // a's own Bucket pick got jinxed
  assert.equal(L.weeks[0].results.b.slots.REB.value, 30);
  assert.equal(c1.outcome, 'landed');
  assert.equal(d1.outcome, 'landed');
  assert.equal(cw.cosmetics.b.clown, 'd');
  assert.equal(L.users.b.cards.armed.length, 0);
});

test('attack cap: a third attack fizzles and the card comes back', () => {
  const { totals, picks } = basicWeek();
  const plays = [
    play('a', 1, 'clown', { target_id: 'd' }),
    play('b', 1, 'clown', { target_id: 'd' }),
    play('c', 1, 'clown', { target_id: 'd' }),
  ];
  const L = computeLeague({ weeks: [wk(1)], totals, picks, plays, profiles, now: NOW, cardsFrom: 1, dealer: () => ['clown'] });
  const cw = L.weeks[0].cards;
  assert.deepEqual(cw.plays.map(p => p.outcome), ['landed', 'landed', 'fizzled']);
  assert.equal(cw.plays[2].why, 'cap');
  assert.equal(L.users.c.cards.hand[0].card, 'clown');
  assert.equal(L.users.a.cards.hand.length, 0);
});

test('Charge Taken wastes the attacker’s card', () => {
  const { totals, picks } = basicWeek();
  const plays = [play('c', 1, 'charge'), play('a', 1, 'load', { target_id: 'c', slot: 'PTS' })];
  const L = computeLeague({ weeks: [wk(1)], totals, picks, plays, profiles, now: NOW, cardsFrom: 1, dealer: (u) => u === 'c' ? ['charge'] : ['load'] });
  const [, load] = L.weeks[0].cards.plays;
  assert.equal(load.outcome, 'blocked');
  assert.equal(L.weeks[0].results.c.slots.PTS.value, 50);
  assert.equal(L.users.a.cards.hand.length, 0);
});

test('load management wipes the best game; garbage time swaps the worst for the best', () => {
  const { totals, picks } = basicWeek();
  const plays = [
    play('a', 1, 'load', { target_id: 'b', slot: 'PTS' }),
    play('c', 1, 'garbage', { slot: 'PTS', created_at: after(1) }),
  ];
  const L = computeLeague({ weeks: [wk(1)], totals, picks, plays, profiles, now: NOW, cardsFrom: 1, dealer: u => u === 'a' ? ['load'] : ['garbage'] });
  const r = L.weeks[0].results;
  assert.equal(r.b.slots.PTS.value, 30); // 60 - 30
  assert.equal(r.c.slots.PTS.value, 60); // 50 - 20 + 30
  assert.equal(L.weeks[0].cards.plays[1].after, 60);
});

test('switcheroo moves players between slots and the burns follow them', () => {
  const { totals, picks } = basicWeek();
  // a: PTS 1 (90 pts / 25 ast), AST 4 (50 pts / 30 ast). Swap them.
  const plays = [play('a', 1, 'switcheroo', { params: { map: { PTS: 'AST', AST: 'PTS' } }, created_at: after(1) })];
  const L = computeLeague({ weeks: [wk(1)], totals, picks, plays, profiles, now: NOW, cardsFrom: 1, dealer: () => ['switcheroo'] });
  const s = L.weeks[0].results.a.slots;
  assert.equal(s.PTS.scorer, 4);
  assert.equal(s.PTS.value, 50);
  assert.equal(s.AST.scorer, 1);
  assert.equal(s.AST.value, 25);
  assert.equal(L.weeks[0].results.a.cleared, 3); // bars use the original picks
  assert.equal(L.users.a.burns.PTS.has(4), true);
  assert.equal(L.users.a.burns.PTS.has(1), false);
  assert.equal(L.users.a.burns.AST.has(1), true);
});

test('switcheroo onto a burned slot fizzles and refunds', () => {
  const totals = {
    1: { final: true, p: { 1: line(3, 90, 30, 25), 4: line(2, 50, 10, 30) } },
    2: { final: true, p: { 1: line(3, 90, 30, 25), 7: line(2, 50, 10, 30) } },
  };
  const picks = [pick('a', 1, 'AST', 1), pick('a', 2, 'PTS', 1), pick('a', 2, 'AST', 7)];
  const plays = [play('a', 2, 'switcheroo', { card_uid: 'w1:starter', params: { map: { PTS: 'AST', AST: 'PTS' } }, created_at: after(2) })];
  const L = computeLeague({ weeks: [wk(1), wk(2)], totals, picks, plays, profiles, now: NOW, cardsFrom: 1, dealer: () => ['switcheroo'] });
  const p = L.weeks[1].cards.plays[0];
  assert.equal(p.outcome, 'fizzled');
  assert.equal(p.why, 'burned');
  assert.equal(L.users.a.cards.hand.some(h => h.card === 'switcheroo'), true);
});

test('copycat scores the target’s pick without burning; leech takes half their rank points', () => {
  const { totals, picks } = basicWeek();
  const plays = [
    play('d', 1, 'copycat', { target_id: 'a', slot: 'PTS' }),
    play('c', 1, 'leech', { target_id: 'a', slot: 'PTS' }),
  ];
  const picksD = [...picks, pick('d', 1, 'PTS', 2), pick('d', 1, 'REB', 5)];
  const L = computeLeague({ weeks: [wk(1)], totals, picks: picksD, plays, profiles, now: NOW, cardsFrom: 1, dealer: u => u === 'd' ? ['copycat'] : ['leech'] });
  const r = L.weeks[0].results;
  assert.equal(r.d.slots.PTS.value, 90);
  assert.equal(r.d.slots.PTS.copyPid, 1);
  assert.equal(r.d.slots.PTS.base, 0);
  assert.equal(L.users.d.burns.PTS.size, 0);
  // a and d tie at 90 at the top of PTS: a gets 2.5 rank points, c leeches 1.25.
  assert.equal(r.a.slots.PTS.rank, 2.5);
  assert.deepEqual(r.c.adj, [{ card: 'leech', pts: 1.25, who: 'a', slot: 'PTS' }]);
});

test('sixth man subs into the slot where he gains the most and burns there', () => {
  const { totals, picks } = basicWeek();
  // b's Dime pick (5) had 6 assists, last in the league. Player 6 had 28.
  totals[1].p[6] = line(3, 10, 5, 28, [4, 2, 12], [2, 1, 6], 'MIA');
  const plays = [play('b', 1, 'sixth', { player_id: 6 })];
  const L = computeLeague({ weeks: [wk(1)], totals, picks, plays, profiles, now: NOW, cardsFrom: 1, dealer: () => ['sixth'] });
  const s = L.weeks[0].results.b.slots.AST;
  assert.equal(s.scorer, 6);
  assert.equal(s.value, 28);
  assert.equal(s.replaced, 5);
  assert.equal(L.users.b.burns.AST.has(6), true);
  assert.equal(L.users.b.burns.AST.has(5), true);
  assert.equal(L.weeks[0].results.b.cleared, 2); // the belt only sees b's own picks
});

test('duels: winner takes the stake, a decline earns the chicken, no reply means accepted', () => {
  const { totals, picks } = basicWeek();
  const plays = [
    play('a', 1, 'duel', { id: 'd1', target_id: 'b', slot: 'PTS' }),
    play('c', 1, 'duel', { id: 'd2', target_id: 'b', slot: 'AST' }),
    { id: 'r1', user_id: 'b', week: 1, card: '_reply', target_id: 'c', params: { duel: 'd2', accept: false }, created_at: before(1) },
  ];
  const L = computeLeague({ weeks: [wk(1)], totals, picks, plays, profiles, now: NOW, cardsFrom: 1, dealer: () => ['duel'] });
  const cw = L.weeks[0].cards;
  assert.equal(cw.plays[0].outcome, 'won');
  assert.equal(cw.plays[1].outcome, 'declined');
  assert.equal(cw.chickens.has('b'), true);
  const r = L.weeks[0].results;
  assert.equal(r.a.adj[0].pts, 5);
  assert.equal(r.b.adj[0].pts, -5);
  assert.equal(r.a.score, r.a.slots.PTS.rank + r.a.slots.REB.rank + r.a.slots.AST.rank + 5);
});

test('heist and blue shell use the standings before the week', () => {
  const weeks = [wk(1), wk(2)];
  const { totals, picks } = basicWeek();
  totals[2] = totals[1];
  const picks2 = [...picks, ...picks.map(p => ({ ...p, week: 2, player_id: p.player_id }))];
  // Week 1 standings: a leads. In week 2, b blue-shells (hits a) and c heists a.
  const plays = [
    play('b', 2, 'blue_shell', { card_uid: 'w1:starter' }),
    play('c', 2, 'heist', { card_uid: 'w1:starter', target_id: 'a' }),
    play('a', 2, 'heist', { card_uid: 'w1:starter', target_id: 'c' }), // a is above c: fizzles
  ];
  const deal = u => ({ a: ['heist'], b: ['blue_shell'], c: ['heist'] }[u] || ['clown']);
  const L = computeLeague({ weeks, totals, picks: picks2, plays, profiles, now: NOW, cardsFrom: 1, dealer: deal });
  assert.equal(L.cards.snaps[1].order[0], 'a');
  const cw = L.weeks[1].cards;
  const [shell, heist, back] = cw.plays;
  assert.equal(shell.target, 'a');
  assert.equal(shell.hits.length, 1);
  assert.equal(shell.hits[0].after, shell.hits[0].before / 2);
  assert.equal(heist.pts, 3);
  assert.equal(back.outcome, 'fizzled');
  assert.equal(back.why, 'not-above');
  const r = L.weeks[1].results;
  assert.ok(r.a.adj.some(x => x.card === 'heist' && x.pts === -3));
  assert.ok(r.c.adj.some(x => x.card === 'heist' && x.pts === 3));
});

test('burn notice burns a player for the target from next week', () => {
  const weeks = [wk(1), wk(2)];
  const { totals, picks } = basicWeek();
  totals[2] = totals[1];
  const plays = [play('a', 1, 'burn_notice', { target_id: 'b', slot: 'PTS', player_id: 4 })];
  const picks2 = [...picks, pick('b', 2, 'PTS', 4)];
  const L = computeLeague({ weeks, totals, picks: picks2, plays, profiles, now: NOW, cardsFrom: 1, dealer: () => ['burn_notice'] });
  assert.equal(L.weeks[0].cards.plays[0].burned, true);
  assert.equal(L.weeks[1].results.b.slots.PTS.invalid, true);
  assert.equal(L.weeks[1].results.b.slots.PTS.value, 0);
  assert.equal(L.users.b.notices.get('PTS:4').by, 'a');
});

test('embargo blocks one player in one slot for everyone, so backups step in', () => {
  const { totals, picks } = basicWeek();
  const picksB = picks.map(p => p.user_id === 'b' && p.slot === 'REB' ? { ...p, alt_id: 3 } : p);
  const plays = [play('d', 1, 'embargo', { slot: 'REB', player_id: 1, created_at: new Date(Date.parse(lockOf(1)) - 30 * 3600e3).toISOString() })];
  const L = computeLeague({ weeks: [wk(1)], totals, picks: picksB, plays, profiles, now: NOW, cardsFrom: 1, dealer: () => ['embargo'] });
  const s = L.weeks[0].results.b.slots.REB;
  assert.equal(s.embargoed, true);
  assert.equal(s.scorer, 3);
  assert.deepEqual(L.weeks[0].cards.plays[0].victims, ['b']);
  // Played inside 24 hours of the lock: doesn't count.
  const late = [play('d', 1, 'embargo', { slot: 'REB', player_id: 1, created_at: new Date(Date.parse(lockOf(1)) - 3600e3).toISOString() })];
  const L2 = computeLeague({ weeks: [wk(1)], totals, picks: picksB, plays: late, profiles, now: NOW, cardsFrom: 1, dealer: () => ['embargo'] });
  assert.equal(L2.weeks[0].cards.plays[0].why, 'late');
});

test('gifts move a card to a colleague from next week; forged cards do nothing', () => {
  const weeks = [wk(1), wk(2)];
  const plays = [
    play('a', 1, 'gift', { target_id: 'b' }),
    play('c', 1, 'blue_shell', { card_uid: 'w1:fake' }),
  ];
  const L = computeLeague({ weeks, totals: {}, picks: [], plays, profiles, now: NOW, cardsFrom: 1, dealer: () => ['heist'] });
  assert.equal(L.users.a.cards.hand.length, 0);
  assert.deepEqual(L.users.b.cards.hand.map(h => h.card), ['heist', 'heist']);
  assert.equal(L.weeks[0].cards.plays[1].why, 'not-in-hand');
});

test('award, revenge and album packs arrive the week after', () => {
  const DIV = ['BOS', 'BKN', 'NYK', 'PHI', 'TOR'];
  const totals = { 1: { final: true, p: {} } };
  DIV.forEach((t, i) => { totals[1].p[10 + i] = line(1, 10 + i, 5, 5, undefined, undefined, t); });
  totals[1].p[20] = line(1, 5, 2, 1, undefined, undefined, 'DEN');
  const picks = [
    pick('a', 1, 'PTS', 10), pick('a', 1, 'REB', 11), pick('a', 1, 'AST', 12),
    pick('b', 1, 'PTS', 20),
  ];
  // a collects BOS, BKN and NYK in week 1, then PHI and TOR in week 2.
  totals[2] = { final: true, p: { 13: line(1, 9, 9, 9, undefined, undefined, 'PHI'), 14: line(1, 9, 9, 9, undefined, undefined, 'TOR') } };
  const weeks3 = [wk(1), wk(2), wk(3, { lockAt: '2099-01-01T00:00:00Z', final: false })];
  const picks2 = [...picks, pick('a', 2, 'PTS', 13), pick('a', 2, 'REB', 14)];
  const L = computeLeague({ weeks: weeks3, totals, picks: picks2, plays: [], profiles, now: NOW, cardsFrom: 1, dealer: () => ['clown', 'jinx', 'scout'] });
  const kinds = L.users.a.cards.packs.map(p => `${p.step}:${p.kind}`);
  assert.ok(kinds.includes('3:album'));
  assert.deepEqual(L.users.a.cards.divisions, ['Atlantic']);
  assert.ok(L.users.b.cards.packs.some(p => p.kind === 'revenge' && p.step === 2));
  assert.ok(L.users.b.cards.packs.some(p => p.kind === 'award' && p.label === 'Ice Cold'));
});

test('one swap per pack before the lock; a late or second swap is ignored', () => {
  const weeks = [wk(1), wk(2)];
  const deal = () => ['embargo', 'jinx', 'leech'];
  const keep = (user_id, uid, pick, at) => ({ id: `${user_id}${uid}${pick}`, user_id, week: 1, card: '_keep', card_uid: uid, params: { pick }, created_at: at });
  const t = s => new Date(Date.parse(before(1)) + s * 1000).toISOString();
  const plays = [
    keep('a', 'pack:w1:starter', 0, t(1)), keep('a', 'repick:w1:starter', 2, t(2)), keep('a', 'repick:w1:starter', 1, t(3)),
    keep('b', 'pack:w1:starter', 0, t(1)), keep('b', 'repick:w1:starter', 1, after(1)),
    keep('c', 'repick:w1:starter', 1, t(1)), // a swap with no first keep
  ];
  const L = computeLeague({ weeks, totals: {}, picks: [], plays, profiles, now: NOW, cardsFrom: 1, dealer: deal });
  const pack = id => L.users[id].cards.packs[0];
  assert.deepEqual([pack('a').first, pack('a').keep, pack('a').repicked], [0, 2, true]);
  assert.equal(L.users.a.cards.hand[0].card, 'leech');
  assert.deepEqual([pack('b').keep, pack('b').repicked], [0, false]);
  assert.deepEqual([pack('c').keep, pack('c').auto, pack('c').repicked], [null, true, false]);
  assert.equal(L.users.c.cards.hand[0].card, 'embargo');
});

test('kept cards are final after Week 1: a swap on a later pack is ignored', () => {
  const weeks = [wk(1), wk(2)];
  const deal = () => ['embargo', 'jinx', 'leech'];
  const keep = (uid, pick, at) => ({ id: `a${uid}${pick}`, user_id: 'a', week: 2, card: '_keep', card_uid: uid, params: { pick }, created_at: at });
  const t = s => new Date(Date.parse(before(2)) + s * 1000).toISOString();
  // Cards start in week 2 here, so the Starter Pack is a week-2 pack.
  const plays = [keep('pack:w2:starter', 0, t(1)), keep('repick:w2:starter', 2, t(2))];
  const L = computeLeague({ weeks, totals: {}, picks: [], plays, profiles, now: NOW, cardsFrom: 2, dealer: deal });
  const pack = L.users.a.cards.packs[0];
  assert.equal(pack.step, 2);
  assert.deepEqual([pack.first, pack.keep, pack.repicked], [0, 0, false]);
  assert.equal(L.users.a.cards.hand[0].card, 'embargo');
});

test('sliding odds: Burn Notice climbs as you fall and as the season goes on; leaders never pull comeback cards', () => {
  const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
  for (const pos of [0, 0.25, 0.5, 0.75, 1]) for (const season of [0, 0.5, 1]) {
    const o = standingOdds('locker', { pos, season });
    assert.ok(Math.abs(sum(o) - 100) < 1e-9);
    if (pos <= 0.5) assert.equal(o.epic, 0);
  }
  assert.equal(standingOdds('locker', { pos: 0, season: 1 }).legendary, 0.1);
  assert.equal(standingOdds('locker', { pos: 1, season: 1 }).legendary, 0.6);
  assert.ok(standingOdds('revenge', { pos: 1, season: 1 }).legendary <= 1);
  assert.ok(standingOdds('album', { pos: 1, season: 1 }).legendary <= 1.5);
  const leg = (pos, season) => standingOdds('locker', { pos, season }).legendary;
  assert.ok(leg(0, 0.5) < leg(0.5, 0.5) && leg(0.5, 0.5) < leg(1, 0.5));
  assert.ok(leg(1, 0) < leg(1, 0.5) && leg(1, 0.5) < leg(1, 1));
  for (let i = 0; i < 300; i++) {
    for (const c of dealPack(`x${i}`, 'k', 'locker', { pos: 0, season: 1 })) assert.equal(CARDS[c].comeback, undefined);
  }
  const snap = { order: ['a', 'b', 'c', 'd', 'e'], rank: new Map([['a', 1], ['b', 2], ['c', 2], ['d', 4], ['e', 5]]) };
  assert.deepEqual(standingFor(snap, 'a', 1, 23), { pos: 0, season: 0 });
  assert.deepEqual(standingFor(snap, 'c', 12, 23), { pos: 0.25, season: 0.5 });
  assert.deepEqual(standingFor(snap, 'e', 23, 23), { pos: 1, season: 1 });
  assert.equal(standingFor({ order: ['a'], rank: new Map() }, 'a', 5, 23).pos, 0.5);
});

test('packs before cards.oddsFrom re-deal exactly as before; later packs use the sliding odds', () => {
  assert.equal(LEAGUE.cards.oddsFrom, 3);
  const weeks = [wk(1), wk(2), wk(3), wk(4, { lockAt: '2099-01-01T00:00:00Z', final: false })];
  const L = computeLeague({ weeks, totals: {}, picks: [], plays: [], profiles, now: NOW, cardsFrom: 1 });
  const packs = L.users.a.cards.packs;
  const starter = packs.find(p => p.step === 1);
  assert.equal(starter.tier, 'mid');
  assert.deepEqual(starter.cards, dealPack('a', 'w1:starter', 'starter', 'mid'));
  // Cards from week 3: the standing object drives the odds.
  const late = computeLeague({ weeks, totals: {}, picks: [], plays: [], profiles, now: NOW, cardsFrom: 3 }).users.a.cards.packs.find(p => p.step === 3);
  assert.deepEqual(late.tier, { pos: 0.5, season: 2 / 3 });
  assert.deepEqual(late.cards, dealPack('a', 'w3:starter', 'starter', { pos: 0.5, season: 2 / 3 }));
});

test('raw picks: the standings as if no card was played, kept apart from the real results', async () => {
  const { seasonAwards } = await import('../src/awards.js');
  const people = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, display_name: id.toUpperCase() }));
  const weeks = [wk(1), wk(2)];
  const { totals, picks } = basicWeek();
  totals[2] = totals[1];
  // Week 2, Bucket only: a 60, b 50 (burned for b by the Burn Notice), c 45.
  const picks2 = [...picks, pick('a', 2, 'PTS', 2), pick('b', 2, 'PTS', 4), pick('c', 2, 'PTS', 3)];
  const plays = [
    play('a', 1, 'jinx', { target_id: 'b', player_id: 1 }),
    play('b', 1, 'leech', { target_id: 'a', slot: 'AST' }),
    play('c', 1, 'copycat', { target_id: 'a', slot: 'PTS' }),
    play('d', 1, 'burn_notice', { target_id: 'b', slot: 'PTS', player_id: 4 }),
    play('e', 2, 'embargo', { slot: 'PTS', player_id: 2 }),
    play('b', 2, 'blue_shell', { card_uid: 'w2:locker' }),
  ];
  const deal = (u, key) => key === 'w2:locker' ? ['blue_shell'] : { a: ['jinx'], b: ['leech'], c: ['copycat'], d: ['burn_notice'], e: ['embargo'] }[u];
  const args = { weeks, totals, picks: picks2, profiles: people, now: NOW, cardsFrom: 1, dealer: deal };
  const L = computeLeague({ ...args, plays });
  const L0 = computeLeague({ ...args, plays: [] });

  const [w1, w2] = L.weeks;
  assert.equal(w1.results.b.slots.REB.value, 15); // jinxed
  assert.equal(w1.raw.b.slots.REB.value, 30);
  assert.equal(w1.results.c.slots.PTS.value, 90); // copied a
  assert.equal(w1.raw.c.slots.PTS.value, 50); // c's own pick
  assert.equal(w2.results.a.slots.PTS.value, 0); // embargoed
  assert.equal(w2.raw.a.slots.PTS.value, 60);
  assert.equal(w2.results.b.slots.PTS.invalid, true); // Burn Notice
  assert.equal(w2.raw.b.slots.PTS.value, 50);
  assert.deepEqual(w1.raw.b.adj, []); // no leech
  for (const w of [0, 1]) for (const id of ['a', 'b', 'c']) {
    const rw = L.weeks[w].raw[id], real0 = L0.weeks[w].results[id];
    assert.equal(rw.score, real0.score, `${id} wk ${w + 1}`);
    assert.equal(rw.cleared, real0.cleared, `${id} wk ${w + 1} bars`);
    for (const s of ['PTS', 'REB', 'AST']) if (!rw.slots[s].missing) assert.equal(rw.slots[s].pid, real0.slots[s].pid);
  }
  for (const id of ['a', 'b', 'c']) {
    assert.equal(L.users[id].raw.counted, L0.users[id].counted, id);
    assert.equal(L.users[id].raw.rank, L0.users[id].rank, id);
  }
  assert.deepEqual(L.rawStandings.map(u => u.id), L0.standings.map(u => u.id));
  assert.notDeepEqual(L.standings.map(u => u.counted), L0.standings.map(u => u.counted));
  const pure = seasonAwards(L).titles.find(t => t.key === 'pure');
  assert.equal(pure.decided, true);
  assert.equal(pure.leader.id, L0.standings[0].id);
  assert.equal(pure.leader.v, L0.standings[0].counted);
});
