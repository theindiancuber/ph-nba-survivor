// The league engine: burns, scoring, lives, drops, crowns, awards, autopilot.
// Pure functions over plain data, shared by the browser app and the data script.

import { LEAGUE, monthKey, MONTH_LABELS } from './config.js';

const STAT = { PTS: 1, REB: 2, AST: 3 };
const SLOTS = LEAGUE.slots;
const EMPTY = [0, 0, 0, 0];

export function statLine(totals, week, pid) {
  return totals[week]?.p?.[pid] || EMPTY;
}

export function weekStatus(week, now) {
  if (now < Date.parse(week.lockAt)) return 'open';
  return week.final ? 'final' : 'live';
}

function groupPicks(picks) {
  const byWeek = {};
  for (const p of picks) {
    ((byWeek[p.week] ||= {})[p.user_id] ||= {})[p.slot] = p;
  }
  return byWeek;
}

function newBurns() {
  return Object.fromEntries(SLOTS.map(s => [s, new Map()]));
}

// Points for beating everyone: 1 per lower value, ½ per tie.
export function rankPoints(values) {
  return values.map((v, i) => values.reduce((acc, o, j) => acc + (i === j ? 0 : o < v ? 1 : o === v ? 0.5 : 0), 0));
}

// The un-burn frees one player in one slot, once, from the week it was used.
function applyUnburn(u, week) {
  if (!u.unburn || u.unburnApplied || u.unburn.week > week) return;
  u.burns[u.unburn.slot].delete(u.unburn.player_id);
  u.unburnApplied = true;
}

export function computeLeague({ weeks, totals, picks, unburns = [], profiles, now = Date.now(), players = {} }) {
  const byWeek = groupPicks(picks);
  const unburnByUser = Object.fromEntries(unburns.map(u => [u.user_id, u]));
  const users = {};
  for (const pr of profiles) {
    users[pr.id] = {
      id: pr.id, name: pr.display_name, rival: pr.rival_id || null, team: pr.fav_team || null,
      weekly: {}, total: 0, counted: 0, dropped: [], lives: LEAGUE.lives, eliminatedWeek: null,
      burns: newBurns(), reserved: newBurns(), doubleDownWeek: null, plannedDoubleDown: null,
      unburn: unburnByUser[pr.id] || null, monthly: {},
    };
  }

  const out = [];
  let openWeek = null;
  for (const wk of weeks) {
    const status = weekStatus(wk, now);
    if (status === 'open') {
      if (openWeek == null) openWeek = wk.week;
      out.push({ ...wk, status, entrants: [], results: {}, ownership: {} });
      continue;
    }
    const wp = byWeek[wk.week] || {};
    const entrants = Object.keys(wp).filter(id => users[id]);
    const results = {};
    const ownership = Object.fromEntries(SLOTS.map(s => [s, {}]));

    for (const id of entrants) {
      const u = users[id];
      applyUnburn(u, wk.week);
      const usedThisWeek = new Set();
      const slots = {};
      for (const slot of SLOTS) {
        const p = wp[id][slot];
        if (!p) { slots[slot] = { value: 0, missing: true }; continue; }
        const ok = pid => pid != null && !u.burns[slot].has(pid) && !usedThisWeek.has(pid);
        const mainOk = ok(p.player_id);
        if (mainOk) usedThisWeek.add(p.player_id);
        const altOk = p.alt_id != null && p.alt_id !== p.player_id && ok(p.alt_id);
        if (altOk) usedThisWeek.add(p.alt_id);
        const gp = pid => statLine(totals, wk.week, pid)[0];

        let scorer = null, pending = false;
        if (mainOk && gp(p.player_id) > 0) scorer = p.player_id;
        else if (status === 'final') scorer = altOk && gp(p.alt_id) > 0 ? p.alt_id : null;
        else { scorer = mainOk ? p.player_id : altOk ? p.alt_id : null; pending = true; }

        const line = scorer != null ? statLine(totals, wk.week, scorer) : EMPTY;
        const value = line[STAT[slot]];
        let dd = false;
        if (p.double_down && u.doubleDownWeek == null) { u.doubleDownWeek = wk.week; dd = true; }

        if (status === 'final') {
          if (scorer != null) u.burns[slot].set(scorer, wk.week);
        } else {
          for (const pid of [p.player_id, p.alt_id]) if (pid != null) u.reserved[slot].set(pid, wk.week);
        }
        if (scorer != null) ownership[slot][scorer] = (ownership[slot][scorer] || 0) + 1;
        slots[slot] = {
          pid: p.player_id, alt: p.alt_id ?? null, scorer, value, gp: line[0], dd, auto: !!p.auto,
          pending, usedAlt: scorer != null && scorer === p.alt_id && scorer !== p.player_id,
          invalid: !mainOk, fumble: status === 'final' && scorer == null,
        };
      }
      results[id] = { slots };
    }

    for (const slot of SLOTS) {
      // An empty slot ranks below everyone and earns nothing.
      const pts = rankPoints(entrants.map(id => results[id].slots[slot].missing ? -1 : results[id].slots[slot].value));
      entrants.forEach((id, i) => {
        const s = results[id].slots[slot];
        s.rank = s.missing ? 0 : pts[i] * (s.dd ? 2 : 1);
        s.owned = s.scorer != null ? ownership[slot][s.scorer] : 0;
      });
    }

    for (const id of entrants) {
      const r = results[id], u = users[id];
      r.score = SLOTS.reduce((a, s) => a + r.slots[s].rank, 0);
      r.cleared = SLOTS.filter(s => r.slots[s].value >= LEAGUE.bars[s]).length;
      r.survived = r.cleared >= LEAGUE.barsToSurvive;
      u.weekly[wk.week] = r.score;
      if (status === 'final' && u.lives > 0 && !r.survived) {
        u.lives -= 1;
        r.lifeLost = true;
        if (u.lives === 0) u.eliminatedWeek = wk.week;
      }
      const mk = monthKey(wk);
      u.monthly[mk] = (u.monthly[mk] || 0) + r.score;
    }
    out.push({ ...wk, status, entrants, results, ownership });
  }

  // Open week: planned double down, and the un-burn applies to the picker.
  if (openWeek != null) {
    const wp = byWeek[openWeek] || {};
    for (const u of Object.values(users)) {
      applyUnburn(u, openWeek);
      if (u.doubleDownWeek == null) {
        const dd = SLOTS.find(s => wp[u.id]?.[s]?.double_down);
        if (dd) u.plannedDoubleDown = dd;
      }
    }
  }

  const finals = out.filter(w => w.status === 'final');
  const dropCount = Math.min(LEAGUE.drops.max, Math.floor(finals.length / LEAGUE.drops.every));
  for (const u of Object.values(users)) {
    u.total = Object.values(u.weekly).reduce((a, b) => a + b, 0);
    const finalScores = finals.map(w => ({ week: w.week, score: u.weekly[w.week] || 0 }))
      .sort((a, b) => a.score - b.score || a.week - b.week);
    u.dropped = finalScores.slice(0, dropCount).map(x => x.week);
    u.counted = u.total - finalScores.slice(0, dropCount).reduce((a, x) => a + x.score, 0);
  }

  const standings = Object.values(users)
    .sort((a, b) => b.counted - a.counted || b.total - a.total || a.name.localeCompare(b.name));
  standings.forEach((u, i) => { u.rank = i > 0 && standings[i - 1].counted === u.counted ? standings[i - 1].rank : i + 1; });

  for (const w of out) if (w.status === 'final') w.awards = weekAwards(w, users);

  const league = { weeks: out, users, standings, openWeek, dropCount, players };
  league.survivor = survivorLadder(league);
  league.months = monthlyCrowns(league);
  league.champions = champions(league);
  return league;
}

// Survivor: sorted by lives, then how long they lasted, then points.
function survivorLadder(league) {
  const all = Object.values(league.users).filter(u => league.weeks.some(w => w.results[u.id]));
  const order = [...all].sort((a, b) =>
    b.lives - a.lives || (b.eliminatedWeek ?? 99) - (a.eliminatedWeek ?? 99) || b.total - a.total);
  const alive = all.filter(u => u.lives > 0);
  const seasonOver = league.weeks.every(w => w.status === 'final');
  let winner = null;
  if (all.length >= 2 && (alive.length <= 1 || seasonOver)) {
    if (alive.length >= 1) winner = order[0];
    else {
      const lastWeek = Math.max(...all.map(u => u.eliminatedWeek));
      winner = all.filter(u => u.eliminatedWeek === lastWeek).sort((a, b) => b.total - a.total)[0];
    }
  }
  return { order, alive: alive.length, winner };
}

function monthlyCrowns(league) {
  const months = {};
  for (const w of league.weeks) {
    const k = monthKey(w);
    (months[k] ||= { key: k, label: MONTH_LABELS[k] || k, weeks: [], complete: true });
    months[k].weeks.push(w.week);
    if (w.status !== 'final') months[k].complete = false;
  }
  return Object.values(months).map(m => {
    const ranked = Object.values(league.users).filter(u => m.key in u.monthly)
      .sort((a, b) => b.monthly[m.key] - a.monthly[m.key]);
    return { ...m, ranked, winner: m.complete && ranked.length ? ranked[0] : null };
  });
}

function champions(league) {
  const list = [];
  const seasonOver = league.weeks.length && league.weeks.every(w => w.status === 'final');
  if (seasonOver && league.standings.length) {
    const u = league.standings[0];
    list.push({ title: 'Season Champion', user: u, detail: `${fmt(u.counted)} points after ${league.dropCount} dropped weeks` });
  }
  if (league.survivor.winner) {
    const u = league.survivor.winner;
    list.push({ title: 'Survivor Belt', user: u, detail: u.lives > 0 ? `Last one standing with ${u.lives} ${u.lives === 1 ? 'life' : 'lives'} left` : `Outlasted the field (out in week ${u.eliminatedWeek})` });
  }
  for (const m of league.months) {
    if (m.winner) list.push({ title: `Monthly Crown · ${m.label}`, user: m.winner, detail: `${fmt(m.winner.monthly[m.key])} points across weeks ${m.weeks[0]}–${m.weeks[m.weeks.length - 1]}` });
  }
  return list;
}

export function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// Weekly awards for a final week.
function weekAwards(w, users) {
  if (w.entrants.length < 2) return [];
  const all = [];
  for (const id of w.entrants) for (const slot of SLOTS) {
    const s = w.results[id].slots[slot];
    if (!s.missing) all.push({ id, slot, ...s });
  }
  const awards = [];
  const scored = all.filter(p => p.scorer != null && p.value > 0);
  if (scored.length) {
    const gb = [...scored].sort((a, b) => a.owned - b.owned || b.rank - a.rank)[0];
    if (gb.rank > 0) awards.push({ key: 'galaxy', icon: '🧠', title: 'Galaxy Brain', user: gb.id, slot: gb.slot, pid: gb.scorer, text: `${gb.value} ${LEAGUE.slotInfo[gb.slot].short}, picked by ${gb.owned === 1 ? 'nobody else' : gb.owned + ' people'}` });
    const heat = [...scored].sort((a, b) => b.value / LEAGUE.bars[b.slot] - a.value / LEAGUE.bars[a.slot])[0];
    awards.push({ key: 'heater', icon: '🔥', title: 'Heater', user: heat.id, slot: heat.slot, pid: heat.scorer, text: `${heat.value} ${LEAGUE.slotInfo[heat.slot].short} (${(heat.value / LEAGUE.bars[heat.slot]).toFixed(1)}× the bar)` });
  }
  for (const f of all.filter(p => p.fumble)) {
    awards.push({ key: 'fumble', icon: '🪦', title: 'The Fumble', user: f.id, slot: f.slot, pid: f.pid, text: `${LEAGUE.slotInfo[f.slot].name} pick never took the floor` });
  }
  const cold = [...w.entrants].sort((a, b) => w.results[a].score - w.results[b].score)[0];
  awards.push({ key: 'cold', icon: '🧊', title: 'Ice Cold', user: cold, text: `${fmt(w.results[cold].score)} points this week` });
  const chalk = [...w.entrants].map(id => ({ id, owned: SLOTS.reduce((a, s) => a + (w.results[id].slots[s].owned || 0), 0) }))
    .sort((a, b) => b.owned - a.owned)[0];
  const top = SLOTS.every(s => {
    const sc = w.results[chalk.id].slots[s].scorer;
    return sc != null && Math.max(...Object.values(w.ownership[s])) === w.ownership[s][sc];
  });
  if (top) awards.push({ key: 'chalk', icon: '🐐', title: 'Chalk Merchant', user: chalk.id, text: 'Took the most popular player in all three slots' });
  return awards;
}

// Head-to-head over weeks where both played.
export function headToHead(league, a, b) {
  const rec = { w: 0, l: 0, t: 0, weeks: [] };
  for (const wk of league.weeks) {
    const ra = wk.results[a], rb = wk.results[b];
    if (!ra || !rb) continue;
    const res = ra.score > rb.score ? 'W' : ra.score < rb.score ? 'L' : 'T';
    if (wk.status === 'final') rec[res.toLowerCase()]++;
    rec.weeks.push({ week: wk.week, me: ra.score, them: rb.score, res, status: wk.status });
  }
  return rec;
}

// Why a player can't be picked in a slot for the open week (null = available).
export function blockedReason(league, userId, slot, pid) {
  const u = league.users[userId];
  if (!u) return null;
  if (u.burns[slot].has(pid)) return `Burned wk ${u.burns[slot].get(pid)}`;
  if (u.reserved[slot].has(pid)) return `Locked in wk ${u.reserved[slot].get(pid)}`;
  return null;
}

export function projection(player, slot, games) {
  return (player?.avg?.[STAT[slot] - 1] || 0) * (games || 0);
}

// Autopilot: fill empty slots with the best unburned projected week.
export function autopilotPicks(league, userId, week, current, players, gamesByTeam) {
  const used = new Set(Object.values(current).flatMap(p => [p.player_id, p.alt_id]).filter(x => x != null));
  const chosen = {};
  for (const slot of SLOTS) {
    if (current[slot]) continue;
    const best = Object.values(players)
      .filter(pl => !used.has(pl.id) && !blockedReason(league, userId, slot, pl.id))
      .map(pl => ({ pl, proj: projection(pl, slot, gamesByTeam[pl.team]) }))
      .sort((a, b) => b.proj - a.proj || (b.pl.avg?.[STAT[slot] - 1] || 0) - (a.pl.avg?.[STAT[slot] - 1] || 0) || a.pl.id - b.pl.id)[0];
    if (best) { chosen[slot] = best.pl.id; used.add(best.pl.id); }
  }
  return chosen;
}
