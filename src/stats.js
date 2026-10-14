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
          const rec = { id, week: w.week, slot: s, pid: x.scorer, value: x.value, ratio: x.value / LEAGUE.bars[s] };
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

// Hindsight: the best strategy each week and over the season, from final weeks only.
export function perfectPlay(L, totals) {
  const finals = L.weeks.filter(w => w.status === 'final');
  const valueOf = (week, pid, s) => totals[week]?.p?.[pid]?.[IDX[s] + 1] || 0;
  const topFor = (week, s, n) => Object.keys(totals[week]?.p || {})
    .map(pid => ({ pid: +pid, value: valueOf(week, pid, s) }))
    .sort((a, b) => b.value - a.value || a.pid - b.pid)
    .slice(0, n);

  // Perfect week: three different players, best combined result against the bars.
  const weeks = finals.map(w => {
    const top = Object.fromEntries(SLOTS.map(s => [s, topFor(w.week, s, 4)]));
    let perfect = null;
    for (const a of top.PTS) for (const b of top.REB) for (const c of top.AST) {
      if (a.pid === b.pid || a.pid === c.pid || b.pid === c.pid) continue;
      const score = a.value / LEAGUE.bars.PTS + b.value / LEAGUE.bars.REB + c.value / LEAGUE.bars.AST;
      if (!perfect || score > perfect.score) perfect = { score, PTS: a, REB: b, AST: c };
    }
    const bestActual = Object.fromEntries(SLOTS.map(s => {
      let m = null;
      for (const id of w.entrants) {
        const x = w.results[id].slots[s];
        if (!x.missing && (!m || x.value > m.value)) m = { id, pid: x.scorer ?? x.pid, value: x.value };
      }
      return [s, m];
    }));
    const winner = [...w.entrants].sort((a, b) => w.results[b].score - w.results[a].score)[0] || null;
    return { week: w.week, perfect, bestActual, winner, winnerScore: winner ? w.results[winner].score : 0 };
  });

  // Perfect season: per category, the best use of each player once across the weeks.
  // Only a week's top-N players can be in the optimal plan (N = number of weeks).
  const season = {};
  for (const s of SLOTS) {
    const cand = [...new Set(finals.flatMap(w => topFor(w.week, s, finals.length).map(x => x.pid)))];
    while (cand.length < finals.length) cand.push(null);
    const pick = maxAssignment(finals.length, cand.length, (i, j) => cand[j] == null ? 0 : valueOf(finals[i].week, cand[j], s));
    const plan = finals.map((w, i) => ({ week: w.week, pid: cand[pick[i]], value: cand[pick[i]] == null ? 0 : valueOf(w.week, cand[pick[i]], s) }));
    season[s] = { plan, total: plan.reduce((a, x) => a + x.value, 0) };
  }

  // How close each person's actual picks came to the perfect season, category by category.
  const people = Object.values(L.users).filter(u => finals.some(w => w.results[u.id])).map(u => {
    const got = Object.fromEntries(SLOTS.map(s => [s, finals.reduce((a, w) => a + (w.results[u.id]?.slots[s]?.value || 0), 0)]));
    const pct = SLOTS.reduce((a, s) => a + (season[s].total ? got[s] / season[s].total : 0), 0) / SLOTS.length;
    return { id: u.id, got, pct };
  }).sort((a, b) => b.pct - a.pct);

  return { weeks, season, people, finals: finals.length };
}

// Maximum-weight assignment of n rows to distinct columns (n <= m), Hungarian method.
export function maxAssignment(n, m, val) {
  if (!n) return [];
  const INF = Number.MAX_VALUE;
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = -val(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const rowToCol = new Array(n);
  for (let j = 1; j <= m; j++) if (p[j]) rowToCol[p[j] - 1] = j - 1;
  return rowToCol;
}
