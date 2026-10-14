// Commissioner stats: burn ledger, firepower left, contrarians and season records.
// Built from post-lock data only, so nothing here leaks picks before a lock.

import { LEAGUE } from './config.js';

const SLOTS = LEAGUE.slots;
const IDX = { PTS: 0, REB: 1, AST: 2 };
const avg = (p, s) => p?.avg?.[IDX[s]] || 0;

export function funStats(L, players) {
  const people = {};
  for (const u of Object.values(L.users)) {
    people[u.id] = { id: u.id, picks: 0, autos: 0, saves: 0, fumbles: 0, ownSum: 0, ownN: 0, dd: null };
  }
  const totals = { picks: 0, autos: 0, saves: 0, fumbles: 0, doubleDowns: 0 };
  let best = null, worst = null;

  for (const w of L.weeks) {
    if (w.status === 'open') continue;
    const n = w.entrants.length;
    for (const id of w.entrants) {
      for (const s of SLOTS) {
        const x = w.results[id].slots[s];
        if (x.missing) continue;
        const p = people[id];
        p.picks++; totals.picks++;
        if (x.auto) { p.autos++; totals.autos++; }
        if (x.dd) { totals.doubleDowns++; p.dd = { week: w.week, slot: s, rank: x.rank }; }
        if (n > 1 && x.scorer != null) { p.ownSum += (x.owned - 1) / (n - 1); p.ownN++; }
        if (w.status !== 'final') continue;
        if (x.usedAlt) { p.saves++; totals.saves++; }
        if (x.fumble) { p.fumbles++; totals.fumbles++; }
        if (x.scorer != null) {
          const rec = { id, week: w.week, slot: s, pid: x.scorer, value: x.value, ratio: x.value / (LEAGUE.bars[s] * w.mult) };
          if (!best || rec.ratio > best.ratio) best = rec;
          if (!worst || rec.ratio < worst.ratio) worst = rec;
        }
      }
    }
  }

  // Who burned whom: player → slot → [{ id, week }]
  const ledger = {};
  for (const u of Object.values(L.users)) {
    for (const s of SLOTS) {
      for (const [pid, week] of u.burns[s]) {
        ((ledger[pid] ||= { PTS: [], REB: [], AST: [] })[s]).push({ id: u.id, week });
      }
    }
  }
  const mostBurned = Object.fromEntries(SLOTS.map(s => [s, Object.entries(ledger)
    .map(([pid, v]) => ({ pid: +pid, who: v[s] }))
    .filter(x => x.who.length)
    .sort((a, b) => b.who.length - a.who.length || avg(players[b.pid], s) - avg(players[a.pid], s))
    .slice(0, 8)]));

  const ranked = Object.fromEntries(SLOTS.map(s => [s, Object.values(players).sort((a, b) => avg(b, s) - avg(a, s))]));
  const untouched = Object.fromEntries(SLOTS.map(s => [s, ranked[s].filter(p => !ledger[p.id]?.[s]?.length).slice(0, 6)]));

  // Firepower left: each person's best 5 unburned players per category, measured against the bars.
  const active = Object.values(L.users).filter(u => Object.keys(u.weekly).length);
  const firepower = active.map(u => {
    let score = 0;
    const left = {};
    for (const s of SLOTS) {
      left[s] = ranked[s].slice(0, 60).filter(p => !u.burns[s].has(p.id)).slice(0, 5);
      score += left[s].reduce((a, p) => a + avg(p, s) / LEAGUE.bars[s], 0);
    }
    return { id: u.id, score, left: Object.fromEntries(SLOTS.map(s => [s, left[s].map(p => p.id)])) };
  }).sort((a, b) => b.score - a.score);

  // Contrarian index: on average, what share of the league picked the same player as you.
  const contrarian = active.map(u => people[u.id]).filter(p => p.ownN)
    .map(p => ({ id: p.id, share: p.ownSum / p.ownN }))
    .sort((a, b) => a.share - b.share);

  return { totals, people, best, worst, ledger, mostBurned, untouched, firepower, contrarian };
}
