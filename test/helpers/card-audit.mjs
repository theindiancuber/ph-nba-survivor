// Every card, played the way its form plays it, through the real engine: a small league of four
// with two final weeks, where 'c' plays each card in every category it can take. Used by
// cards-all*.test.mjs, once per league (set PHS_SPORT before importing this).
const { LEAGUE } = await import('../../src/config.js');
const { computeLeague, swapMoves, SWAP_SLOTS } = await import('../../src/league.js');
const { CARDS, DECK } = await import('../../src/cards.js');
const { TEAMS } = await import('../../src/teams.js');
const NHL = LEAGUE.sport === 'nhl';
const SL = LEAGUE.slots;
const lockOf = w => new Date(Date.parse('2026-11-03T00:00:00Z') + (w - 1) * 7 * 864e5).toISOString();
const wk = (week, final = true) => ({ week, start: '2026-11-02', end: '2026-11-08', mult: 1, lockAt: lockOf(week), final, gamesByTeam: {}, leftByTeam: {} });
const before = w => new Date(Date.parse(lockOf(w)) - 2 * 864e5).toISOString();
const after = w => new Date(Date.parse(lockOf(w)) + 8 * 864e5).toISOString();
const NOW = Date.parse('2027-06-01T00:00:00Z'); // long after both weeks
const profiles = ['a', 'b', 'c', 'd'].map(id => ({ id, display_name: id.toUpperCase(), created_at: '2026-10-01T00:00:00Z' }));
const T = Object.keys(TEAMS);
const tid = i => TEAMS[T[i]].id;
// Player lines. NBA: [gp, pts, reb, ast, hi x3, lo x3, team]. NHL skater / goalie in the hockey shape.
const nba = (gp, pts, reb, ast, team) => [gp, pts, reb, ast, Math.ceil(pts / gp * 1.4), Math.ceil(reb / gp * 1.4), Math.ceil(ast / gp * 1.4), Math.floor(pts / gp * 0.6), Math.floor(reb / gp * 0.6), Math.floor(ast / gp * 0.6), team];
const sk = (gp, pts, pm, team, fights = 0) => [gp, pts, pm, 0, Math.ceil(pts / gp * 1.5), Math.max(pm, 1), 0, Math.floor(pts / gp * 0.5), Math.min(pm, -1), 0, team, 0, fights, Math.floor(pts / 2), 0];
const gk = (gp, sv, sa, team) => [gp, 0, 0, sv, Math.round(sv / gp) + 3, Math.round(sa / gp), Math.round(1000 * (sv / gp + 3) / (sa / gp)), Math.round(sv / gp) - 4, Math.round(sa / gp), Math.round(1000 * (sv / gp - 4) / (sa / gp)), team, sa, 0, 0, 0];
const P = {};
if (!NHL) [[1, 90, 30, 25], [2, 60, 20, 10], [3, 45, 25, 8], [4, 50, 10, 30], [5, 30, 12, 6], [6, 70, 15, 20], [7, 40, 28, 5], [8, 55, 9, 22], [9, 35, 14, 12]]
  .forEach(([id, a, b, c], i) => { P[id] = nba(3, a, b, c, T[i]); });
else {
  [[1, 7, 3], [2, 5, 2], [3, 4, -1], [4, 6, 1], [5, 3, 4], [6, 8, -2], [7, 2, 2], [8, 5, 0]].forEach(([id, a, b], i) => { P[id] = sk(3, a, b, T[i], id === 7 ? 2 : 0); });
  [[11, 85, 92], [12, 70, 80], [13, 90, 100], [14, 60, 66]].forEach(([id, sv, sa], i) => { P[id] = gk(3, sv, sa, T[i + 10]); });
}
const players = Object.fromEntries(Object.entries(P).map(([id, l]) => [id, { id: +id, name: `P${id}`, team: l[10], pos: NHL && +id > 10 ? 'G' : 'C', avg: [0, 0, 0, 0] }]));
const t = {}; T.slice(0, 8).forEach((tri, i) => { t[tri] = [3, i % 4]; });
// Each user: one pick per slot. Week 2's players are week 1's with 100 added to the id (the same
// lines), so nobody is burned for week 2.
const lineup = NHL
  ? { a: [1, 2, 11, 0], b: [3, 4, 12, 1], c: [5, 6, 13, 2], d: [7, 8, 14, 3] }
  : { a: [1, 3, 4, 0], b: [2, 7, 5, 1], c: [6, 9, 8, 2], d: [3, 1, 2, 3] };
for (const [id, l] of Object.entries({ ...P })) { P[+id + 100] = l; players[+id + 100] = { ...players[id], id: +id + 100, name: `Q${id}` }; }
const picks = [];
for (const W of [1, 2]) for (const [u, ids] of Object.entries(lineup)) SL.forEach((s, i) => {
  const pid = s === 'WIN' ? tid((ids[i] + W) % 8) : ids[i] + (W === 2 ? 100 : 0);
  picks.push({ user_id: u, week: W, slot: s, player_id: pid, alt_id: null, double_down: false });
});
// NHL team ids are small numbers: real player ids are in the millions, so move ours out of their way.
if (NHL) {
  const big = id => +id + 8470000;
  for (const k of Object.keys(P)) { P[big(k)] = P[k]; delete P[k]; players[big(k)] = { ...players[k], id: big(k) }; delete players[k]; }
  for (const p of picks) if (p.slot !== 'WIN') p.player_id = big(p.player_id);
}
const totals = { 1: { final: true, p: P, t }, 2: { final: true, p: P, t } };
const weeks = [wk(1), wk(2), wk(3, false)];

const pickOf = (u, W, s) => picks.find(p => p.user_id === u && p.week === W && p.slot === s)?.player_id;
// What the form would send for each card (me: 'c', a mid-table player).
const me = 'c';
function rows(card) {
  const d = CARDS[card];
  const hind = d.type === 'hindsight';
  const W = hind ? 1 : 2;
  const base = { user_id: me, week: W, card, card_uid: 'w1:starter', target_id: null, slot: null, player_id: null, params: {}, created_at: hind ? after(1) : before(2) };
  const out = [];
  const slots = d.needs.includes('slot') ? SL : [null];
  for (const slot of slots) {
    const r = { ...base, slot };
    if (d.needs.includes('target')) r.target_id = card === 'heist' ? 'a' : 'b';
    if (d.needs.includes('player')) {
      if (card === 'sixth') r.player_id = NHL ? 8470108 : 105;
      else if (card === 'burn_notice') r.player_id = slot === 'WIN' ? tid(5) : pickOf('b', 1, slot);
      else if (card === 'jinx') r.player_id = pickOf('b', 2, 'PTS');
      else r.player_id = slot === 'WIN' ? tid(6) : pickOf('b', 2, slot);
      if (card === 'jinx') { out.push({ ...r }); out.push({ ...r, player_id: pickOf('b', 2, 'WIN'), label: 'team' }); continue; }
    }
    if (d.needs.includes('nickname')) r.params = { nick: 0 };
    if (card === 'switcheroo') {
      const [x, y] = SWAP_SLOTS;
      const map = Object.fromEntries(SWAP_SLOTS.map(s => [s, s])); map[x] = y; map[y] = x;
      const m = swapMoves(map);
      if (m.error) throw new Error(`Switcheroo form: ${m.error}`);
      r.params = { map: m.moved };
    }
    out.push(r);
  }
  return out.length ? out : [base];
}

const id = (() => { let n = 0; return () => `p${++n}`; })();
// One result per play: did the engine accept it (ok), and what happened (outcome, why). A trap also
// reports what became of the attack it met (sprung: 'blocked' or 'reversed').
export function auditCards() {
  const results = [];
  for (const card of DECK) {
    for (const row of rows(card)) {
      const plays = [{ ...row, id: id() }];
      const trap = card === 'charge' || card === 'reverse';
      // Two-step cards: a duel needs an answer, and a trap needs an attack to spring on ('b' arms it, 'c' attacks).
      if (card === 'duel') plays.push({ id: id(), user_id: 'b', week: 2, card: '_reply', card_uid: null, target_id: me, slot: null, player_id: null, params: { accept: true, duel: plays[0].id }, created_at: new Date(Date.parse(before(2)) + 1000).toISOString() });
      if (trap) { plays[0].user_id = 'b'; plays.push({ id: id(), user_id: me, week: 2, card: 'clown', card_uid: 'w1:starter', target_id: 'b', slot: null, player_id: null, params: {}, created_at: new Date(Date.parse(before(2)) + 2000).toISOString() }); }
      const holds = uid => trap ? uid === 'b' : uid === me;
      const dealer = uid => holds(uid) ? [card, 'scout', 'nickname'] : trap && uid === me ? ['clown', 'scout', 'nickname'] : ['scout', 'nickname', 'clown'];
      let L;
      try { L = computeLeague({ weeks, totals, picks, plays, profiles, now: NOW, players, cardsFrom: 1, dealer }); }
      catch (e) { results.push({ card, slot: row.slot, label: row.label, error: e.message }); continue; }
      const recs = L.weeks.find(w => w.week === row.week).cards.plays;
      const rec = recs.find(p => p.id === plays[0].id);
      const sprung = trap ? recs.find(p => p.id === plays[1].id)?.outcome : undefined;
      results.push({ card, slot: row.slot, label: row.label, ok: rec.ok, outcome: rec.outcome, why: rec.why, ...(trap ? { sprung } : {}) });
    }
  }
  return results;
}
