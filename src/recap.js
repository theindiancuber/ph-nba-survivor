// Nightly recap for the commissioner to share: the leaderboard after a night of games and a
// copy-and-paste list of fun stats. Built from two league runs, after the night and before it,
// so everything here is post-lock data the players can already see.

import { LEAGUE, addDays, easternToUtc, slotValue } from './config.js';
import { TEAMS, TEAM_BY_ID } from './teams.js';
import { seasonThrough } from './calendar.js';
import { fmt, clearsBar } from './league.js';

const SLOTS = LEAGUE.slots;
const INFO = LEAGUE.slotInfo;
const HOCKEY = LEAGUE.sport === 'nhl';
const LINE = LEAGUE.line || {};
// A night's total in a slot from a day line (NBA: [games, pts, reb, ast, team]; NHL: see
// addHockeyLine in calendar.js, where a goalie's save percentage is saves over shots).
const pct = (sv, sa) => sa > 0 ? Math.round(1000 * sv / sa) : 0;
const nightValue = (s, l) => INFO[s].pct ? pct(l[INFO[s].idx], l[LINE.shots]) : l[INFO[s].idx];
// Played tonight: a game on the line (a goalie also has to have faced a shot).
const playedIn = (s, l) => !!l?.[0] && (!INFO[s].pct || l[LINE.shots] > 0);

// A night is over when all its games are final, or by 6am ET the next day (a postponed game
// shouldn't hold the recap forever).
export function nightStatus(schedule, date, nowMs) {
  const games = schedule.filter(g => g[1] === date);
  const done = games.filter(g => g[5] === 3).length;
  const live = games.filter(g => g[5] === 2).length;
  const over = games.length > 0 && (done === games.length || nowMs >= Date.parse(easternToUtc(addDays(date, 1), 6, 0)));
  return { games: games.length, done, live, over };
}

// Nights with games in weeks that have locked, up to today, oldest first.
export function recapNights(schedule, weeks, today) {
  const locked = weeks.filter(w => w.status !== 'open');
  const dates = new Set();
  for (const g of schedule) {
    if (g[1] <= today && locked.some(w => g[1] >= w.start && g[1] <= w.end)) dates.add(g[1]);
  }
  return [...dates].sort();
}

const weekOf = (L, W) => L.weeks.find(x => x.week === W);
const pickOf = x => x.copy ? x.copyPid : x.scorer ?? x.pid;
const rankBy = (ids, val) => {
  const order = [...ids].sort((a, b) => val(b) - val(a));
  const out = {};
  order.forEach((id, i) => { out[id] = i && val(order[i - 1]) === val(id) ? out[order[i - 1]] : i + 1; });
  return { order, rank: out };
};

// Leaderboard rows after the night. kind 'season': everyone with points, by season points.
// kind 'week': this week's entrants, by week points. Each row carries tonight's movement.
export function recapBoard(after, before, W, kind = 'season') {
  const A = weekOf(after, W), B = weekOf(before, W);
  const users = Object.values(after.users);
  const ids = kind === 'week' ? A.entrants
    : users.filter(u => A.entrants.includes(u.id) || Object.values(u.weekly).some(v => v)).map(u => u.id);
  const season = (L, id) => seasonThrough(L, L.users[id], W);
  const week = (wk, id) => wk.results[id]?.score || 0;
  const val = kind === 'week' ? id => week(A, id) : id => season(after, id);
  const prev = kind === 'week' ? id => week(B, id) : id => season(before, id);
  const now = rankBy(ids, val), then = rankBy(ids, prev);
  // On a week's first night nobody had week points before, so there's no movement to show.
  const moved = kind === 'season' || ids.some(id => prev(id));
  return now.order.map(id => ({
    id, name: after.users[id].name, rank: now.rank[id],
    move: moved ? then.rank[id] - now.rank[id] : null,
    week: week(A, id), tonight: week(A, id) - week(B, id),
    season: season(after, id), cleared: A.results[id]?.cleared ?? null,
    lives: after.users[id].lives, out: after.users[id].lives <= 0,
  }));
}

const names = list => list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} +${list.length - 3} more`;
const ord = n => { const v = n % 100; return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th'); };

// The fun stats, as plain lines with emoji, ready to paste into a group chat.
// day: that night's lines { p: { pid: line }, t: { TRI: [games, wins] } } (lines as in calendar.js).
export function recapStats({ after, before, W, date, day, schedule, players, label }) {
  const A = weekOf(after, W), B = weekOf(before, W);
  const user = id => after.users[id]?.name || 'Someone';
  const pname = pid => TEAM_BY_ID[pid] ? `${TEAMS[TEAM_BY_ID[pid]].city} ${TEAMS[TEAM_BY_ID[pid]].name}` : players[pid]?.name || `Player #${pid}`;
  const out = [`${LEAGUE.emoji} ${LEAGUE.name} · Week ${W} · ${label}`, ''];
  const night = schedule.filter(g => g[1] === date);
  const lines = [];

  // Who picked each player (or team) in each slot this week, plus the Gloves Off bonus pick.
  const pickers = {};
  for (const id of A.entrants) {
    for (const s of SLOTS) {
      const x = A.results[id].slots[s];
      if (x.missing || x.copy) continue;
      const pid = pickOf(x);
      if (pid != null) ((pickers[s] ||= {})[pid] ||= []).push(id);
    }
    const b = A.results[id].bonus;
    if (b && !b.invalid) ((pickers[b.slot] ||= {})[b.pid] ||= []).push(id);
  }

  // Best pick of the night in each player slot.
  for (const s of LEAGUE.playerSlots) {
    let best = null;
    for (const [pid, who] of Object.entries(pickers[s] || {})) {
      const l = day?.p?.[pid];
      if (!playedIn(s, l)) continue;
      const v = nightValue(s, l);
      if (!best || v > best.v || (v === best.v && INFO[s].pct && l[LINE.shots] > best.l[LINE.shots])) best = { pid, v, l, who };
    }
    // A minus isn't worth celebrating.
    if (!best || (INFO[s].signed && best.v <= 0)) continue;
    const extra = INFO[s].pct ? ` on ${best.l[LINE.shots]} shots` : '';
    lines.push(`${INFO[s].emoji} ${INFO[s].name} of the night: ${pname(best.pid)}, ${slotValue(s, best.v)} ${INFO[s].short}${extra} (${names(best.who.map(user))})`);
  }

  // Dub picks whose team played tonight.
  const dub = [];
  for (const [pid, who] of Object.entries(pickers.WIN || {})) {
    const tri = TEAM_BY_ID[pid];
    const g = night.find(x => x[5] === 3 && (x[3] === tri || x[4] === tri));
    if (!g) continue;
    const us = g[3] === tri ? g[6] : g[7], them = g[3] === tri ? g[7] : g[6];
    const opp = TEAMS[g[3] === tri ? g[4] : g[3]]?.name || '';
    dub.push(`${us > them ? '✅' : '❌'} ${TEAMS[tri].name} ${us > them ? 'beat' : 'lost to'} the ${opp} ${us}–${them} (${names(who.map(user))})`);
  }
  if (dub.length) lines.push(`${INFO.WIN.emoji} Dub watch:`, ...dub.map(d => `   ${d}`));

  if (HOCKEY) lines.push(...hockeyLines({ pickers, day, user, pname }));
  else {
    // Brick of the night: the picked player furthest under his own average.
    let brick = null;
    for (const s of LEAGUE.playerSlots) {
      for (const [pid, who] of Object.entries(pickers[s] || {})) {
        const l = day?.p?.[pid], avg = players[pid]?.avg?.[INFO[s].avg];
        if (!l?.[0] || !(avg >= 3)) continue;
        const v = l[INFO[s].idx], ratio = v / avg;
        if (ratio < 0.6 && (!brick || ratio < brick.ratio)) brick = { pid, s, v, avg, ratio, who };
      }
    }
    if (brick) lines.push(`🧊 Brick of the night: ${pname(brick.pid)}, ${brick.v} ${INFO[brick.s].short} (averages ${fmt(brick.avg)}). Sorry ${names(brick.who.map(user))}`);
  }

  // Picks who sat while their team played.
  const sat = [];
  for (const s of LEAGUE.playerSlots) {
    for (const [pid, who] of Object.entries(pickers[s] || {})) {
      const tri = players[pid]?.team;
      const played = night.some(g => g[5] === 3 && (g[3] === tri || g[4] === tri));
      if (played && !playedIn(s, day?.p?.[pid])) sat.push(`${pname(pid)} (${names(who.map(user))})`);
    }
  }
  if (sat.length) lines.push(`😴 Did not play: ${[...new Set(sat)].join('; ')}`);

  // Bars cleared tonight.
  const cleared = [];
  for (const id of A.entrants) {
    for (const s of SLOTS) {
      const a = A.results[id].slots[s], b = B.results[id]?.slots[s];
      if (a.missing) continue;
      if (clearsBar(s, a) && !(b && clearsBar(s, b))) cleared.push(`${user(id)} ${INFO[s].emoji}`);
    }
  }
  if (cleared.length) lines.push(`✅ Bars cleared tonight: ${cleared.join(', ')}`);

  // Movement on the leaderboard.
  const board = recapBoard(after, before, W, 'season');
  const best = [...board].sort((a, b) => b.tonight - a.tonight)[0];
  if (best?.tonight > 0) lines.push(`💰 Best night: ${best.name}, +${fmt(best.tonight)} pts`);
  const up = [...board].filter(r => r.move > 0).sort((a, b) => b.move - a.move)[0];
  if (up) lines.push(`🚀 Biggest climb: ${up.name}, up ${up.move} to ${ord(up.rank)}`);
  const down = [...board].filter(r => r.move < 0).sort((a, b) => a.move - b.move)[0];
  if (down) lines.push(`📉 Biggest slide: ${down.name}, down ${-down.move} to ${ord(down.rank)}`);
  const leaders = board.filter(r => r.rank === 1);
  if (leaders.length) lines.push(`👑 Top of the table: ${names(leaders.map(r => r.name))}, ${fmt(leaders[0].season)} pts`);

  // What's still to come this week.
  let waiting = 0;
  for (const id of A.entrants) for (const s of SLOTS) { const x = A.results[id].slots[s]; if (!x.missing && !x.gp) waiting++; }
  const left = A.status === 'final' ? 0 : waiting;
  if (left) lines.push(`⏳ ${left} pick${left === 1 ? " hasn't" : "s haven't"} played yet this week`);

  if (!lines.length) lines.push('No picks played tonight.');
  return out.concat(lines).join('\n');
}

// Hockey's own lines: the worst goalie night, the worst plus-minus, hat tricks, fights and
// Gordie Howe hat tricks by picked players.
function hockeyLines({ pickers, day, user, pname }) {
  const out = [];
  const who = list => names(list.map(user));
  let sieve = null;
  for (const [pid, ids] of Object.entries(pickers.SV || {})) {
    const l = day?.p?.[pid];
    if (!playedIn('SV', l) || l[LINE.shots] < 10) continue;
    const v = nightValue('SV', l);
    if (v < 880 && (!sieve || v < sieve.v)) sieve = { pid, v, l, ids };
  }
  if (sieve) {
    const ga = sieve.l[LINE.shots] - sieve.l[INFO.SV.idx];
    out.push(`🧀 Sieve of the night: ${pname(sieve.pid)}, ${slotValue('SV', sieve.v)} (${ga} goal${ga === 1 ? '' : 's'} on ${sieve.l[LINE.shots]} shots). Sorry ${who(sieve.ids)}`);
  }
  let minus = null;
  for (const [pid, ids] of Object.entries(pickers.PM || {})) {
    const l = day?.p?.[pid];
    if (l?.[0] && l[INFO.PM.idx] <= -2 && (!minus || l[INFO.PM.idx] < minus.v)) minus = { pid, v: l[INFO.PM.idx], ids };
  }
  if (minus) out.push(`🧊 Rough night: ${pname(minus.pid)}, ${slotValue('PM', minus.v)}. Sorry ${who(minus.ids)}`);

  // Any skater pick, in any slot.
  const skaters = {};
  for (const s of LEAGUE.pickSlots) {
    if (INFO[s].pos !== 'skater') continue;
    for (const [pid, ids] of Object.entries(pickers[s] || {})) ids.forEach(id => (skaters[pid] ||= new Set()).add(id));
  }
  const tagged = (i, min = 1) => Object.entries(skaters).filter(([pid]) => (day?.p?.[pid]?.[i] || 0) >= min);
  const hats = tagged(LINE.goals, 3);
  if (hats.length) out.push(`🎩 Hat trick: ${hats.map(([pid, ids]) => `${pname(pid)}, ${day.p[pid][LINE.goals]} goals (${who([...ids])})`).join('; ')}`);
  const fights = tagged(LINE.fights);
  if (fights.length) out.push(`${INFO.FIGHT.emoji} Gloves off: ${fights.map(([pid, ids]) => `${pname(pid)} (${who([...ids])})`).join('; ')}`);
  const gordie = tagged(LINE.gordie);
  if (gordie.length) out.push(`🎯 Gordie Howe hat trick: ${gordie.map(([pid, ids]) => `${pname(pid)} (${who([...ids])})`).join('; ')}`);
  return out;
}
