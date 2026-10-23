// The league engine: burns, scoring, lives, drops, crowns, awards, autopilot.
// Pure functions over plain data, shared by the browser app and the data script.

import { LEAGUE, monthKey, MONTH_LABELS, slotValue } from './config.js';
import { TEAMS, TEAM_BY_ID } from './teams.js';
import { CardTable } from './cards.js';
import { parseDecree } from './decrees.js';
import { weekRules, seasonRules, applyWeekRules, applySeasonRules } from './settings.js';

const INFO = LEAGUE.slotInfo;
// Each player slot's column in a weekly line (NBA: PTS 1, REB 2, AST 3; NHL: PTS 1, PM 2, SV 3).
const STAT = Object.fromEntries(LEAGUE.playerSlots.map(s => [s, INFO[s].idx]));
const SLOTS = LEAGUE.slots;
const PSLOTS = LEAGUE.playerSlots;
// Bonus slots (NHL's Gloves Off): picked like the others, but not ranked and not counted for the bars.
const BONUS = LEAGUE.pickSlots.filter(s => !SLOTS.includes(s));
// The slots a Switcheroo (NHL: Line Change) can swap between: the player slots, but never a goalie's.
export const SWAP_SLOTS = PSLOTS.filter(s => INFO[s].pos !== 'G');
const EMPTY = [0, 0, 0, 0];

// A player's week: [games, pts, reb, ast, best game pts/reb/ast, worst game pts/reb/ast, team].
// NHL: [games, pts, plus-minus, saves, best game x3, worst game x3, team, shots against, fights, goals,
// Gordie Howe hat tricks]; a goalie's best and worst games are [saves, shots, save %] (src/calendar.js).
export function statLine(totals, week, pid) {
  return totals[week]?.p?.[pid] || EMPTY;
}

// What cards work with: a player's stat line, or a team's [games, wins, losses].
function fullLine(totals, week, slot, id) {
  if (slot === 'WIN') {
    const [g, w] = slotLine(totals, week, slot, id);
    return [g, w, g - w];
  }
  return statLine(totals, week, id);
}

// [games played, value] for a pick in a slot. Player slots read data `p`
// (gp, pts, reb, ast); the WIN slot reads team data `t` (finished games, wins).
export function slotLine(totals, week, slot, id) {
  if (slot === 'WIN') {
    const t = totals[week]?.t?.[TEAM_BY_ID[id]];
    return t ? [t[0], t[1]] : [0, 0];
  }
  const l = totals[week]?.p?.[id];
  if (!l) return [0, 0];
  // Save percentage: a goalie only counts once he's faced enough shots this week.
  if (INFO[slot]?.pct) {
    const shots = l[LEAGUE.line.shots] || 0;
    return [shots >= LEAGUE.minShots ? l[0] : 0, savePct(l[STAT[slot]], shots)];
  }
  return [l[0], l[STAT[slot]]];
}

// Saves over shots, in thousandths (.915 → 915).
export const savePct = (saves, shots) => shots > 0 ? Math.round(1000 * saves / shots) : 0;

export const unit = (slot, v) => slot === 'WIN' ? `${v} win${v === 1 ? '' : 's'}` : INFO[slot]?.pct ? `${slotValue(slot, v)} saves` : `${slotValue(slot, v)} ${INFO[slot].short}`;

// Whether a pick clears its survival bar. A plus-minus or save-percentage pick who never played fails it.
export const clearsBar = (slot, x) => x.base >= LEAGUE.bars[slot] && (!(INFO[slot]?.signed || INFO[slot]?.pct) || x.scorer != null);

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
  return Object.fromEntries(LEAGUE.pickSlots.map(s => [s, new Map()]));
}

// A use in a final week. Most slots burn a player on his first use; some allow more (NHL goalies: 2).
function useUp(u, slot, pid, W) {
  const n = (u.uses[slot].get(pid) || 0) + 1;
  u.uses[slot].set(pid, n);
  if (n >= (INFO[slot]?.burns || 1)) u.burns[slot].set(pid, W);
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

export function computeLeague({ weeks, totals, picks, unburns = [], plays = [], profiles, now = Date.now(), players = {}, cardsFrom = LEAGUE.cards.startWeek, dealer, decrees = {}, rules = [], meta = {}, adjustments = [] }) {
  // Commissioner settings: season-wide ones now, per-week ones as each week is scored.
  applySeasonRules(seasonRules(meta));
  applyWeekRules(weekRules(rules, weeks[0]?.week ?? 1));
  const adjByWeek = {};
  for (const a of adjustments) if (a && Number.isInteger(a.week)) (adjByWeek[a.week] ||= []).push(a);
  const byWeek = groupPicks(picks);
  const unburnByUser = Object.fromEntries(unburns.map(u => [u.user_id, u]));
  const users = {};
  for (const pr of profiles) {
    users[pr.id] = {
      id: pr.id, name: pr.display_name, rival: pr.rival_id || null, team: pr.fav_team || null, joined: pr.created_at || null,
      weekly: {}, total: 0, counted: 0, dropped: [], lives: LEAGUE.lives, eliminatedWeek: null,
      raw: { weekly: {}, total: 0, counted: 0, dropped: [], rank: null },
      burns: newBurns(), uses: newBurns(), reserved: newBurns(), doubleDownWeek: null, plannedDoubleDown: null,
      unburn: unburnByUser[pr.id] || null, monthly: {},
    };
  }
  const table = new CardTable({ users, plays, weeks, byWeek, from: cardsFrom, dealer, decrees });
  // Running season totals after each week, for comeback odds, Blue Shell and Heist.
  const cum = {};
  const snaps = {};

  const out = [];
  let openWeek = null;
  for (const wk of weeks) {
    const status = weekStatus(wk, now);
    const W = wk.week;
    applyWeekRules(weekRules(rules, W));
    const dec = parseDecree(decrees[W]);
    const is = (kind, slot) => dec?.kind === kind && (slot === undefined || dec.slot === slot);
    if (status === 'open') {
      if (openWeek == null) {
        openWeek = W;
        out.push({ ...wk, status, entrants: [], results: {}, ownership: {}, decree: dec, cards: table.begin(wk, status, snaps[W - 2]) });
      } else out.push({ ...wk, status, entrants: [], results: {}, ownership: {}, decree: dec });
      continue;
    }
    const cw = table.begin(wk, status, snaps[W - 2]);
    const wp = byWeek[W] || {};
    const entrants = Object.keys(wp).filter(id => users[id]);
    const results = {};
    const raw = {};
    const ownership = Object.fromEntries(SLOTS.map(s => [s, {}]));

    for (const id of entrants) {
      const u = users[id];
      applyUnburn(u, W);
      const usedThisWeek = new Set();
      const slots = {};
      for (const slot of SLOTS) {
        const copy = cw.copy.get(`${id}|${slot}`);
        if (copy) {
          // Copycat: your own pick here is ignored and nothing burns.
          slots[slot] = { copy: copy.target_id, pid: null, alt: null, scorer: null, value: 0, base: 0, gp: 0, line: EMPTY, burn: [], fx: [] };
          continue;
        }
        const p = wp[id][slot];
        if (!p) { slots[slot] = { value: 0, base: 0, missing: true, burn: [], fx: [] }; continue; }
        const embargoed = pid => cw.embargo[slot].has(pid);
        const ok = pid => pid != null && !u.burns[slot].has(pid) && !usedThisWeek.has(pid) && !embargoed(pid);
        const { mainOk, scorer, pending, line, value } = scorePick(totals, W, slot, status, p, ok, usedThisWeek);
        let dd = false;
        if (p.double_down && u.doubleDownWeek == null) { u.doubleDownWeek = W; dd = true; }
        slots[slot] = {
          pid: p.player_id, alt: p.alt_id ?? null, scorer, value, base: value, line, gp: line[0], dd, auto: !!p.auto,
          pending, usedAlt: scorer != null && scorer === p.alt_id && scorer !== p.player_id,
          invalid: !mainOk, embargoed: embargoed(p.player_id), fumble: status === 'final' && scorer == null,
          burn: scorer != null ? [scorer] : [], fx: [],
        };
      }
      results[id] = { slots, adj: [] };

      // Raw picks: the same picks with no Joker cards at all. Embargoes and Burn Notices don't block
      // a pick, and a Copycat slot scores your own pick. Kept apart from the real results.
      const usedRaw = new Set();
      const okRaw = slot => pid => pid != null && !usedRaw.has(pid) && (!u.burns[slot].has(pid) || u.notices.has(`${slot}:${pid}`));
      const rs = {};
      for (const slot of SLOTS) {
        const p = wp[id][slot];
        if (!p) { rs[slot] = { value: 0, gp: 0, missing: true }; continue; }
        const x = scorePick(totals, W, slot, status, p, okRaw(slot), usedRaw);
        rs[slot] = {
          pid: p.player_id, scorer: x.scorer, value: x.value, gp: x.line[0], pending: x.pending, dd: !!slots[slot].dd, auto: !!p.auto,
          usedAlt: x.scorer != null && x.scorer === p.alt_id && x.scorer !== p.player_id,
        };
      }
      raw[id] = { slots: rs, adj: [] };
    }

    const hits = table.resolveAttacks(cw, snaps[W - 1]);
    playValueCards({ cw, W, status, totals, results, entrants, users, hits, table, players });

    for (const id of entrants) {
      for (const slot of SLOTS) {
        const s = results[id].slots[slot];
        if (s.scorer != null && !s.copy) ownership[slot][s.scorer] = (ownership[slot][s.scorer] || 0) + 1;
      }
    }
    for (const slot of SLOTS) {
      // An empty slot ranks below everyone and earns nothing.
      // Opposite Day: the lowest total wins, but an empty slot or a fumble still ranks last.
      const flip = is('opposite', slot);
      // In a live week: if a pick has played, it's ranked against everyone (a pick still waiting
      // counts as 0, an empty slot as beaten). If it hasn't played yet, it scores 0 for now rather
      // than collecting ½ a point for every other 0 it's tied with. Final weeks rank everyone.
      const played = s => s.copy ? results[s.copy]?.slots[slot]?.gp > 0 : s.gp > 0;
      // Plus-minus: a pick who never played ranks last, below every negative total.
      const sat = s => INFO[slot].signed && s.scorer == null && !s.copy && !s.pending;
      const pts = rankPoints(entrants.map(id => {
        const s = results[id].slots[slot];
        if (s.missing || sat(s)) return -Infinity;
        if (!flip) return s.value;
        return s.scorer == null && !s.copy && !s.pending ? -Infinity : -s.value;
      }));
      entrants.forEach((id, i) => {
        const s = results[id].slots[slot];
        const counts = status === 'final' || played(s);
        s.rank = s.missing || !counts ? 0 : pts[i] * (s.dd ? 2 : 1) * (is('spotlight', slot) ? 2 : 1);
        s.owned = s.scorer != null && !s.copy ? ownership[slot][s.scorer] : 0;
      });
      const rawPts = rankPoints(entrants.map(id => {
        const s = raw[id].slots[slot];
        if (s.missing || sat(s)) return -Infinity;
        if (!flip) return s.value;
        return s.scorer == null && !s.pending ? -Infinity : -s.value;
      }));
      entrants.forEach((id, i) => {
        const s = raw[id].slots[slot];
        s.rank = s.missing || !(status === 'final' || s.gp > 0) ? 0 : rawPts[i] * (s.dd ? 2 : 1) * (is('spotlight', slot) ? 2 : 1);
      });
    }
    playPointCards({ cw, wk, results, hits, table });
    if (LEAGUE.fight) for (const id of entrants) hockeyBonus({ W, totals, players, pick: wp[id], user: users[id], R: [results[id], raw[id]] });

    // Commissioner adjustments: public point corrections, with a reason.
    for (const a of adjByWeek[W] || []) {
      const pts = Number(a.points) || 0;
      if (!pts || !results[a.user_id]) continue;
      const row = { commish: true, label: 'Commissioner', pts, note: a.reason || '' };
      results[a.user_id].adj.push(row);
      raw[a.user_id].adj.push(row);
    }

    if (is('bounty') && entrants.length) {
      for (const R of [results, raw]) {
        const pre = id => SLOTS.reduce((a, s) => a + R[id].slots[s].rank, 0) + R[id].adj.reduce((a, x) => a + x.pts, 0);
        const top = Math.max(...entrants.map(pre));
        for (const id of entrants) if (pre(id) === top) R[id].adj.push({ decree: 'bounty', label: 'Bounty', pts: LEAGUE.decree.bounty });
      }
    }

    for (const id of entrants) {
      const r = results[id], u = users[id];
      r.score = SLOTS.reduce((a, s) => a + r.slots[s].rank, 0) + r.adj.reduce((a, x) => a + x.pts, 0);
      const rr = raw[id];
      rr.score = SLOTS.reduce((a, s) => a + rr.slots[s].rank, 0) + rr.adj.reduce((a, x) => a + x.pts, 0);
      rr.cleared = SLOTS.filter(s => clearsBar(s, { ...rr.slots[s], base: rr.slots[s].value })).length;
      u.raw.weekly[W] = rr.score;
      // The Survivor Belt ignores cards: bars are checked against your own picks' real totals.
      r.cleared = SLOTS.filter(s => clearsBar(s, r.slots[s])).length;
      r.survived = r.cleared >= (is('sudden_death') ? SLOTS.length : LEAGUE.barsToSurvive) || is('mercy');
      u.weekly[W] = r.score;
      cum[id] = (cum[id] || 0) + r.score;
      if (status === 'final' && u.lives > 0 && !r.survived) {
        u.lives -= 1;
        r.lifeLost = true;
        if (u.lives === 0) u.eliminatedWeek = W;
      }
      const mk = monthKey(wk);
      u.monthly[mk] = (u.monthly[mk] || 0) + r.score;

      const six = cw.sixth.get(id);
      // Gloves Off burns only when he fights.
      if (status === 'final' && r.bonus?.fights && !is('amnesty')) u.burns[r.bonus.slot].set(r.bonus.pid, W);
      for (const slot of SLOTS) {
        const s = r.slots[slot];
        if (is('amnesty')) continue;
        if (status === 'final') for (const pid of s.burn) useUp(u, slot, pid, W);
        else {
          if (!s.copy) for (const pid of [s.pid, s.alt]) if (pid != null) u.reserved[slot].set(pid, W);
          if (six && six.outcome !== 'fizzled') u.reserved[slot].set(six.player_id, W);
        }
      }
    }

    // Commissioner adjustments to lives land after the week's own result.
    for (const a of adjByWeek[W] || []) {
      const u = users[a.user_id], n = Math.trunc(Number(a.lives) || 0);
      if (!u || !n) continue;
      u.lives = Math.max(0, u.lives + n);
      if (u.lives > 0) u.eliminatedWeek = null;
      else if (u.eliminatedWeek == null) u.eliminatedWeek = W;
    }

    // Burn Notice lands after the week's own burns, so it bites from next week.
    for (const h of hits) {
      if (h.rec.card !== 'burn_notice') continue;
      const v = users[h.victim];
      const { slot, player_id: pid } = h.rec;
      h.rec.burned = !v.burns[slot].has(pid);
      if (!h.rec.burned) continue;
      v.burns[slot].set(pid, W);
      v.notices.set(`${slot}:${pid}`, { by: h.rec.user_id, week: W, reversed: h.rec.outcome === 'reversed' });
    }

    const order = Object.keys(cum).sort((a, b) => cum[b] - cum[a] || users[a].name.localeCompare(users[b].name));
    const rank = new Map();
    order.forEach((id, i) => rank.set(id, i > 0 && cum[order[i - 1]] === cum[id] ? rank.get(order[i - 1]) : i + 1));
    snaps[W] = { order, rank };

    const w = { ...wk, status, entrants, results, raw, ownership, cards: cw, decree: dec };
    if (status === 'final') w.awards = weekAwards(w);
    table.end(wk, status, { entrants, results, awards: w.awards || [], teamOf: pid => TEAM_BY_ID[pid] || statLine(totals, W, pid)[10] || players[pid]?.team || null });
    out.push(w);
  }

  // From here on (the app, the Rules tab, Autopilot) the rules are the open week's, or the last week's.
  applyWeekRules(weekRules(rules, openWeek ?? weeks[weeks.length - 1]?.week ?? Infinity));

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
  const tally = (t, weekly) => {
    t.total = Object.values(weekly).reduce((a, b) => a + b, 0);
    const finalScores = finals.map(w => ({ week: w.week, score: weekly[w.week] || 0 }))
      .sort((a, b) => a.score - b.score || a.week - b.week);
    t.dropped = finalScores.slice(0, dropCount).map(x => x.week);
    t.counted = t.total - finalScores.slice(0, dropCount).reduce((a, x) => a + x.score, 0);
  };
  for (const u of Object.values(users)) { tally(u, u.weekly); tally(u.raw, u.raw.weekly); }

  const standings = Object.values(users)
    .sort((a, b) => b.counted - a.counted || b.total - a.total || a.name.localeCompare(b.name));
  standings.forEach((u, i) => { u.rank = i > 0 && standings[i - 1].counted === u.counted ? standings[i - 1].rank : i + 1; });
  // The standings from raw picks alone, with no Joker cards.
  const rawStandings = Object.values(users)
    .sort((a, b) => b.raw.counted - a.raw.counted || b.raw.total - a.raw.total || a.name.localeCompare(b.name));
  rawStandings.forEach((u, i) => { const p = rawStandings[i - 1]; u.raw.rank = p && p.raw.counted === u.raw.counted ? p.raw.rank : i + 1; });

  const league = { weeks: out, users, standings, rawStandings, openWeek, dropCount, players, cards: { from: cardsFrom, weeks: table.out, snaps } };
  league.survivor = survivorLadder(league);
  league.months = monthlyCrowns(league);
  league.champions = champions(league);
  return league;
}

// NHL bonuses, added to the week's score like an adjustment (cards never touch them).
// Gloves Off: points per fight by the bonus pick, if he isn't burned there or picked in another slot.
// Gordie Howe hat trick: a goal, an assist and a fight in one game by any skater you picked.
function hockeyBonus({ W, totals, players, pick = {}, user, R }) {
  const slot = BONUS[0];
  const p = pick[slot];
  const others = SLOTS.flatMap(s => [pick[s]?.player_id, pick[s]?.alt_id]).filter(x => x != null);
  const name = pid => players[pid]?.name || '';
  let fightPid = null;
  if (p) {
    const invalid = user.burns[slot].has(p.player_id) || others.includes(p.player_id);
    const fights = invalid ? 0 : statLine(totals, W, p.player_id)[LEAGUE.line.fights] || 0;
    const pts = Math.min(fights, LEAGUE.fight.max) * LEAGUE.fight.points;
    if (!invalid) fightPid = p.player_id;
    for (const r of R) {
      r.bonus = { slot, pid: p.player_id, fights, pts, invalid };
      if (pts) r.adj.push({ bonus: 'fight', label: INFO[slot].name, pts, note: `${name(p.player_id)}, ${fights} fight${fights === 1 ? '' : 's'}` });
    }
  }
  for (const r of R) {
    const skaters = new Set([...PSLOTS.filter(s => INFO[s].pos === 'skater').map(s => r.slots[s].scorer), fightPid].filter(x => x != null));
    for (const pid of skaters) {
      const n = statLine(totals, W, pid)[LEAGUE.line.gordie] || 0;
      if (n) r.adj.push({ bonus: 'gordie', label: 'Gordie Howe hat trick', pts: n * LEAGUE.gordieHowe, note: name(pid) });
    }
  }
}

// Who scores a pick: the main pick if he played, else the backup once the week is final.
// ok says whether a player can score in this slot; used collects the week's players.
function scorePick(totals, W, slot, status, p, ok, used) {
  const mainOk = ok(p.player_id);
  if (mainOk) used.add(p.player_id);
  const altOk = p.alt_id != null && p.alt_id !== p.player_id && ok(p.alt_id);
  if (altOk) used.add(p.alt_id);
  const gp = pid => slotLine(totals, W, slot, pid)[0];

  let scorer = null, pending = false;
  if (mainOk && gp(p.player_id) > 0) scorer = p.player_id;
  else if (status === 'final') scorer = altOk && gp(p.alt_id) > 0 ? p.alt_id : null;
  else { scorer = mainOk ? p.player_id : altOk ? p.alt_id : null; pending = true; }

  // line: the full stat line (players) or [games, wins] (teams); value: what the slot scores.
  const line = scorer != null ? fullLine(totals, W, slot, scorer) : EMPTY;
  const value = scorer != null ? slotLine(totals, W, slot, scorer)[1] : 0;
  return { mainOk, scorer, pending, line, value };
}

// Best and worst single game in a slot. For a team, a game is worth 1 (win) or 0 (loss).
const gameHigh = (line, slot) => slot === 'WIN' ? (line[0] ? (line[1] > 0 ? 1 : 0) : null) : line[3 + STAT[slot]];
const gameLow = (line, slot) => slot === 'WIN' ? (line[0] ? (line[2] > 0 ? 0 : 1) : null) : line[6 + STAT[slot]];

// A goalie's week worked out again without one of his games ([saves, shots] columns of his best or
// worst game, see src/calendar.js), and with another one in its place if given.
function swapGame(line, out, add) {
  const sv = line[3] - line[out[0]] + (add ? line[add[0]] : 0);
  const sa = line[LEAGUE.line.shots] - line[out[1]] + (add ? line[add[1]] : 0);
  return savePct(sv, sa);
}

// Cards that change a slot's weekly total, in order: your own hindsight cards,
// Copycat, Sixth Man, then attacks from other people.
function playValueCards({ cw, W, status, totals, results, entrants, users, hits, table, players = {} }) {
  const line = pid => statLine(totals, W, pid);
  const mine = card => cw.plays.filter(p => p.ok && p.card === card);

  for (const rec of mine('switcheroo')) {
    const r = results[rec.user_id];
    const why = r ? switcheroo(rec, r, users[rec.user_id], cw, line) : 'no-picks';
    if (why) table.refund(rec, why); else rec.outcome = 'played';
  }
  for (const rec of mine('garbage')) {
    const s = results[rec.user_id]?.slots[rec.slot];
    const hi = s && gameHigh(s.line, rec.slot), lo = s && gameLow(s.line, rec.slot);
    if (!s || s.copy || s.scorer == null || s.gp < 2 || hi == null || lo == null) { table.refund(rec, 'one-game'); continue; }
    rec.before = s.value;
    // A save percentage is worked out again with his best game in place of his worst.
    s.value = INFO[rec.slot]?.pct ? swapGame(s.line, [7, 8], [4, 5]) : s.value + hi - lo;
    rec.after = s.value;
    rec.outcome = 'played';
    s.fx.push({ card: 'garbage', note: `${slotValue(rec.slot, lo)} → ${slotValue(rec.slot, hi)}` });
  }
  for (const rec of mine('copycat')) {
    const s = results[rec.user_id]?.slots[rec.slot];
    if (!s) { rec.outcome = 'void'; continue; }
    const t = results[rec.target_id]?.slots[rec.slot];
    const usable = t && !t.copy && !t.missing;
    s.value = usable ? t.value : 0;
    s.copyPid = usable ? t.scorer ?? t.pid : null;
    s.fx.push({ card: 'copycat', who: rec.target_id });
    rec.outcome = 'played';
    rec.value = s.value;
    rec.copyPid = s.copyPid;
  }
  for (const rec of mine('sixth')) {
    const uid = rec.user_id, r = results[uid], u = users[uid], pid = rec.player_id;
    if (!r) { rec.outcome = 'void'; continue; }
    if (SLOTS.some(s => [r.slots[s].pid, r.slots[s].alt, r.slots[s].scorer].includes(pid))) { table.refund(rec, 'already-picked'); continue; }
    const ln = line(pid);
    // His value in a slot. NHL: only slots he can play (goalies in The Wall), only if he played,
    // and a save percentage only once he's faced enough shots.
    const valueIn = s => {
      if (!eligible(players[pid], s)) return null;
      if (!(INFO[s].signed || INFO[s].pct)) return ln[STAT[s]];
      const [gp, v] = slotLine(totals, W, s, pid);
      return gp > 0 ? v : null;
    };
    // Others' picks: an empty slot, or a plus-minus pick who never played, ranks below everything.
    const theirs = (id, s) => { const y = results[id].slots[s]; return y.missing || (INFO[s].signed && y.scorer == null && !y.copy && !y.pending) ? -Infinity : y.value; };
    let best = null;
    for (const s of PSLOTS) {
      const x = r.slots[s];
      if (x.copy || u.burns[s].has(pid) || cw.embargo[s].has(pid)) continue;
      const v = valueIn(s);
      if (v == null) continue;
      const others = entrants.filter(id => id !== uid).map(id => theirs(id, s));
      const rp = v => others.reduce((a, o) => a + (o < v ? 1 : o === v ? 0.5 : 0), 0);
      const gain = rp(v) - (x.missing ? 0 : rp(x.value));
      if (gain > 0 && (!best || gain > best.gain)) best = { slot: s, gain, value: v };
    }
    if (!best) { rec.outcome = 'benched'; continue; }
    const x = r.slots[best.slot];
    rec.outcome = 'played';
    rec.slot = best.slot;
    rec.before = x.missing ? 0 : x.value;
    rec.after = best.value;
    rec.replaced = x.scorer ?? x.pid ?? null;
    r.slots[best.slot] = {
      ...x, missing: false, scorer: pid, replaced: rec.replaced, value: rec.after, line: ln, gp: ln[0],
      usedAlt: false, fumble: false, burn: [...x.burn, pid], fx: [...x.fx, { card: 'sixth' }],
    };
  }

  for (const h of hits) {
    const v = results[h.victim];
    const rec = h.rec;
    const fx = { card: rec.card, who: rec.user_id, reversed: rec.outcome === 'reversed' };
    if (rec.card === 'jinx') {
      rec.hits = [];
      for (const s of SLOTS) {
        const x = v?.slots[s];
        if (!x || x.copy || x.scorer !== rec.player_id) continue;
        const before = x.value;
        // Plus-minus: a plus is halved and a minus doubled. Save percentage: .020 off.
        x.value = INFO[s].pct ? Math.max(0, x.value - 20) : INFO[s].signed && x.value < 0 ? x.value * 2 : Math.floor(x.value / 2);
        x.fx.push(fx);
        rec.hits.push({ slot: s, before, after: x.value });
      }
    } else if (rec.card === 'load') {
      rec.hits = [];
      const x = v?.slots[rec.slot];
      if (!x || x.copy || x.missing || !x.gp) continue;
      const high = gameHigh(x.line, rec.slot) ?? Math.round(x.value / x.gp);
      const before = x.value;
      // Plus-minus: his best game is replaced by his worst. Save percentage: his best game is left out.
      x.value = INFO[rec.slot]?.pct ? swapGame(x.line, [4, 5], null)
        : INFO[rec.slot]?.signed ? x.value - high + (gameLow(x.line, rec.slot) ?? high)
        : Math.max(0, x.value - high);
      x.fx.push(fx);
      rec.hits.push({ slot: rec.slot, before, after: x.value });
    } else if (rec.card === 'clown' || rec.card === 'nickname') {
      const c = cw.cosmetics[h.victim] ||= {};
      if (rec.card === 'clown') c.clown = rec.user_id;
      else c.nickname = { nick: rec.params.nick, by: rec.user_id };
    }
  }

  for (const rec of mine('embargo')) {
    rec.outcome = 'played';
    rec.victims = entrants.filter(id => results[id].slots[rec.slot].embargoed && results[id].slots[rec.slot].pid === rec.player_id);
  }
  for (const rec of [...mine('scout'), ...mine('leech'), ...mine('duel')]) rec.outcome ||= 'played';
  if (status !== 'final') for (const rec of cw.plays) if (rec.ok && rec.outcome === 'played' && ['sixth', 'duel', 'leech'].includes(rec.card)) rec.live = true;
}

function switcheroo(rec, r, u, cw, line) {
  const map = rec.params?.map || {};
  const from = Object.keys(map);
  const to = from.map(f => map[f]);
  if (!from.length || from.some(f => !SWAP_SLOTS.includes(f) || !SWAP_SLOTS.includes(map[f])) || new Set(to).size !== to.length
    || !to.every(t => from.includes(t)) || from.every(f => map[f] === f)) return 'bad-swap';
  const moves = from.map(f => ({ from: f, to: map[f], pid: r.slots[f].scorer }));
  if (moves.some(m => m.pid == null || r.slots[m.from].copy)) return 'bad-swap';
  if (moves.some(m => m.from !== m.to && (u.burns[m.to].has(m.pid) || cw.embargo[m.to].has(m.pid)))) return 'burned';
  const before = Object.fromEntries(from.map(f => [f, r.slots[f]]));
  for (const m of moves) {
    const src = before[m.from], dst = before[m.to];
    const value = line(m.pid)[STAT[m.to]];
    m.before = dst.value;
    m.value = value;
    r.slots[m.to] = {
      ...dst, scorer: m.pid, value, line: src.line, gp: src.gp, usedAlt: src.usedAlt, fumble: false, burn: [m.pid],
      fx: m.from === m.to ? dst.fx : [...dst.fx, { card: 'switcheroo', note: `from ${LEAGUE.slotInfo[m.from].name}` }],
    };
  }
  rec.moves = moves;
  return null;
}

// Cards that move rank points around once the slots are ranked.
function playPointCards({ cw, wk, results, hits, table }) {
  const C = LEAGUE.cards;
  for (const h of hits) {
    const rec = h.rec;
    if (rec.card !== 'blue_shell') continue;
    const v = results[h.victim];
    rec.hits = [];
    if (!v) continue;
    const slot = SLOTS.reduce((b, s) => v.slots[s].rank > v.slots[b].rank ? s : b, SLOTS[0]);
    const x = v.slots[slot];
    if (!x.rank) continue;
    const before = x.rank;
    x.rank /= 2;
    x.fx.push({ card: 'blue_shell', who: rec.user_id, reversed: rec.outcome === 'reversed' });
    rec.hits.push({ slot, before, after: x.rank });
  }
  for (const rec of cw.plays) {
    if (!rec.ok || rec.card !== 'leech') continue;
    const r = results[rec.user_id], t = results[rec.target_id]?.slots[rec.slot];
    if (!r) { rec.outcome = 'void'; continue; }
    rec.pts = t && !t.missing ? t.rank / 2 : 0;
    r.adj.push({ card: 'leech', pts: rec.pts, who: rec.target_id, slot: rec.slot });
  }
  const lockT = Date.parse(wk.lockAt);
  for (const rec of cw.plays) {
    if (!rec.ok || rec.card !== 'duel') continue;
    const reply = table.replies[rec.id];
    const replied = reply && reply.user_id === rec.target_id && reply.week === rec.week && (!reply.created_at || Date.parse(reply.created_at) < lockT);
    if (replied && reply.params?.accept === false) { rec.outcome = 'declined'; cw.chickens.add(rec.target_id); continue; }
    rec.accepted = !!replied;
    const a = results[rec.user_id], b = results[rec.target_id];
    if (!a && !b) { rec.outcome = 'void'; continue; }
    // A plus-minus pick who never played loses to any total, negatives included.
    const val = r => !r || r.slots[rec.slot].missing ? -1
      : INFO[rec.slot].signed && r.slots[rec.slot].scorer == null && !r.slots[rec.slot].copy ? -Infinity : r.slots[rec.slot].value;
    rec.values = [val(a), val(b)];
    if (rec.values[0] === rec.values[1]) { rec.outcome = 'push'; continue; }
    const [win, lose] = rec.values[0] > rec.values[1] ? [rec.user_id, rec.target_id] : [rec.target_id, rec.user_id];
    rec.outcome = win === rec.user_id ? 'won' : 'lost';
    rec.pts = C.duelStake;
    results[win]?.adj.push({ card: 'duel', pts: C.duelStake, who: lose, slot: rec.slot });
    results[lose]?.adj.push({ card: 'duel', pts: -C.duelStake, who: win, slot: rec.slot });
  }
  for (const h of hits) {
    const rec = h.rec;
    if (rec.card !== 'heist') continue;
    const thief = rec.outcome === 'reversed' ? h.by : rec.user_id;
    const mark = h.victim;
    if (!results[thief] || !results[mark]) { rec.pts = 0; continue; }
    rec.pts = C.heist;
    results[mark].adj.push({ card: 'heist', pts: -C.heist, who: thief });
    results[thief].adj.push({ card: 'heist', pts: C.heist, who: mark });
  }
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
function weekAwards(w) {
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
    if (gb.rank > 0) awards.push({ key: 'galaxy', icon: '🧠', title: 'Galaxy Brain', user: gb.id, slot: gb.slot, pid: gb.scorer, text: `${unit(gb.slot, gb.value)}, picked by ${gb.owned === 1 ? 'nobody else' : gb.owned + ' people'}` });
    // Heater is a player award: team wins against a 1-win bar would always top it.
    const heat = scored.filter(p => p.slot !== 'WIN' && !INFO[p.slot].signed && !INFO[p.slot].pct).sort((a, b) => b.value / LEAGUE.bars[b.slot] - a.value / LEAGUE.bars[a.slot])[0];
    if (heat) awards.push({ key: 'heater', icon: '🔥', title: 'Heater', user: heat.id, slot: heat.slot, pid: heat.scorer, text: `${unit(heat.slot, heat.value)} (${(heat.value / LEAGUE.bars[heat.slot]).toFixed(1)}× the bar)` });
  }
  for (const f of all.filter(p => p.fumble)) {
    awards.push({ key: 'fumble', icon: '🪦', title: 'The Fumble', user: f.id, slot: f.slot, pid: f.pid, text: `${LEAGUE.slotInfo[f.slot].name} pick never took the ${LEAGUE.words.surface}` });
  }
  const cold = [...w.entrants].sort((a, b) => w.results[a].score - w.results[b].score)[0];
  awards.push({ key: 'cold', icon: '🧊', title: 'Ice Cold', user: cold, text: `${fmt(w.results[cold].score)} points this week` });
  const chalk = [...w.entrants].map(id => ({ id, owned: SLOTS.reduce((a, s) => a + (w.results[id].slots[s].owned || 0), 0) }))
    .sort((a, b) => b.owned - a.owned)[0];
  const top = SLOTS.every(s => {
    const sc = w.results[chalk.id].slots[s].scorer;
    return sc != null && Math.max(...Object.values(w.ownership[s])) === w.ownership[s][sc];
  });
  if (top) awards.push({ key: 'chalk', icon: '🐐', title: 'Chalk Merchant', user: chalk.id, text: 'Took the most popular pick in every slot' });
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
  if (u.burns[slot].has(pid)) return u.notices?.has(`${slot}:${pid}`) ? 'Burn Notice 🔥' : `Burned wk ${u.burns[slot].get(pid)}`;
  if (u.reserved[slot].has(pid)) return `Locked in wk ${u.reserved[slot].get(pid)}`;
  if (league.cards?.weeks[league.openWeek]?.embargo[slot]?.has(pid)) return 'Embargoed 🚫';
  return null;
}

// Who can be picked in a slot: NHL goalies only in The Wall, skaters everywhere else.
export function eligible(player, slot) {
  const pos = INFO[slot]?.pos;
  if (!pos || !player) return true;
  return pos === 'G' ? player.pos === 'G' : player.pos !== 'G';
}

// A pick's projected week. A save percentage doesn't add up over games: it's his season mark,
// discounted for a goalie who rarely plays.
export function projection(player, slot, games) {
  const avg = player?.avg?.[INFO[slot]?.avg] || 0;
  if (INFO[slot]?.pct) return games ? avg * Math.min(1, (player?.gp || 0) / 5) : 0;
  return avg * (games || 0);
}

// Expected wins this week from the season record (smoothed so 0-0 reads as .500).
export function teamProjection(record, games) {
  const w = record?.w || 0, l = record?.l || 0;
  return (games || 0) * (w + 1) / (w + l + 2);
}

// Autopilot: fill empty slots with the best unburned projected week.
export function autopilotPicks(league, userId, week, current, players, gamesByTeam, teams = {}) {
  const used = new Set(Object.values(current).flatMap(p => [p.player_id, p.alt_id]).filter(x => x != null));
  const chosen = {};
  for (const slot of SLOTS) {
    if (current[slot]) continue;
    const pool = slot === 'WIN'
      ? Object.entries(TEAMS).map(([tri, t]) => ({ id: t.id, proj: teamProjection(teams[tri], gamesByTeam[tri]), tie: 0 }))
      : Object.values(players).filter(pl => eligible(pl, slot)).map(pl => ({ id: pl.id, proj: projection(pl, slot, gamesByTeam[pl.team]), tie: pl.avg?.[INFO[slot].avg] || 0 }));
    const best = pool
      .filter(c => !used.has(c.id) && !blockedReason(league, userId, slot, c.id))
      .sort((a, b) => b.proj - a.proj || b.tie - a.tie || a.id - b.id)[0];
    if (best) { chosen[slot] = best.id; used.add(best.id); }
  }
  return chosen;
}
