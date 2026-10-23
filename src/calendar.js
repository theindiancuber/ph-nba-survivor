// Calendar tab helpers: the days of a week, today's date in New York, and a week's
// totals rebuilt up to a given day so the real engine can score the week as it stood then.
import { LEAGUE, addDays } from './config.js';

const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
// Game dates are Eastern: a 10pm ET tip on the 3rd is a game on the 3rd.
export const etDate = ms => ET.format(new Date(ms));

export function weekDays(w) {
  const out = [];
  for (let d = w.start; d <= w.end; d = addDays(d, 1)) out.push(d);
  return out;
}

// NHL lines have the same shape for a day and for a week, so a week is its days added up.
//   skater: [games, pts, +/-, 0, best pts, best +/-, 0, worst pts, worst +/-, 0, team, 0, fights, goals, Gordie Howes]
//   goalie: [games, 0, 0, saves, best game saves, its shots, its sv%, worst game saves, its shots, its sv%, team, shots]
// The sums add up; a skater keeps his best and worst of each stat; a goalie keeps his best and worst
// games whole (by save percentage), so cards can take one out. Returns x (a new line if x is null).
export function addHockeyLine(x, l) {
  if (!x) return [...l];
  for (const i of [0, 1, 2, 3, 11, 12, 13, 14]) x[i] += l[i];
  if (l[3] || l[11]) {
    if (l[6] > x[6]) [x[4], x[5], x[6]] = [l[4], l[5], l[6]];
    if (l[9] < x[9]) [x[7], x[8], x[9]] = [l[7], l[8], l[9]];
  } else {
    for (const i of [4, 5, 6]) x[i] = Math.max(x[i], l[i]);
    for (const i of [7, 8, 9]) x[i] = Math.min(x[i], l[i]);
  }
  x[10] = l[10];
  return x;
}

// days: { date: { p: { pid: [games, pts, reb, ast, team] }, t: { TRI: [finished games, wins] } } }
// (NHL: each player's line for the day in the weekly shape, see addHockeyLine.)
// Returns the week's totals through `date`, in the same shape as totals.json, never final.
// A player plays once a day, so each day's line is one game for the best/worst game columns.
export function totalsThrough(days, date) {
  const p = {}, t = {};
  for (const d of Object.keys(days || {}).sort()) {
    if (d > date) break;
    if (LEAGUE.sport === 'nhl') {
      for (const [pid, l] of Object.entries(days[d].p || {})) p[pid] = addHockeyLine(p[pid], l);
      for (const [tri, [g, w]] of Object.entries(days[d].t || {})) {
        const y = t[tri] ||= [0, 0];
        y[0] += g; y[1] += w;
      }
      continue;
    }
    for (const [pid, [gp, pts, reb, ast, team]] of Object.entries(days[d].p || {})) {
      const x = p[pid] ||= [0, 0, 0, 0, pts, reb, ast, pts, reb, ast, team];
      x[0] += gp; x[1] += pts; x[2] += reb; x[3] += ast;
      [pts, reb, ast].forEach((v, i) => { x[4 + i] = Math.max(x[4 + i], v); x[7 + i] = Math.min(x[7 + i], v); });
      x[10] = team;
    }
    for (const [tri, [g, w]] of Object.entries(days[d].t || {})) {
      const y = t[tri] ||= [0, 0];
      y[0] += g; y[1] += w;
    }
  }
  return { final: false, p, t };
}

// Season points through week W from a league run: every week up to W, less the drops
// the league would have taken by then (lowest final weeks before W).
export function seasonThrough(league, user, W) {
  const before = league.weeks.filter(w => w.week < W && w.status === 'final');
  const drops = Math.min(LEAGUE.drops.max, Math.floor(before.length / LEAGUE.drops.every));
  const scores = before.map(w => user.weekly[w.week] || 0).sort((a, b) => a - b);
  const total = league.weeks.filter(w => w.week <= W).reduce((a, w) => a + (user.weekly[w.week] || 0), 0);
  return total - scores.slice(0, drops).reduce((a, b) => a + b, 0);
}
