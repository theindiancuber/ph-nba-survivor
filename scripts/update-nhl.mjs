// The NHL league's data job: pulls the NHL schedule, box scores, fights and rosters into
// nhl/data/, then syncs pick locks and runs Autopilot in the NHL league's Supabase project.
//
//   PHS_SPORT=nhl node scripts/update-nhl.mjs
//
// Env (optional): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (the shared project's; tables in the nhl schema), LIVE_FLAG
// Writes: nhl/data/weeks.json, players.json, teams.json, totals.json, schedule.json, rosters.json,
// meta.json, nhl/data/days/<week>.json (the Calendar) and nhl/data/games/<id>.json

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPORT, LEAGUE, buildWeeks, defaultLockAt } from '../src/config.js';
import { TEAMS } from '../src/teams.js';
import { addHockeyLine, totalsThrough } from '../src/calendar.js';
import { syncSupabase, gamesActive } from './update-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'nhl', 'data');
const GAMES = path.join(DATA, 'games');
const API = 'https://api-web.nhle.com/v1';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; peakhill-survivor/1.0)', Accept: 'application/json' };

// FUT/PRE scheduled, LIVE/CRIT in progress, FINAL/OFF over: the same 1/2/3 the NBA feed uses.
export const gameStatus = state => ({ LIVE: 2, CRIT: 2, FINAL: 3, OFF: 3 }[state] || 1);

// Regular-season games from /schedule/<date> pages: { id, kind, etDate, tipUtc, status, home, away }.
export function parseSchedule(pages) {
  const out = new Map();
  for (const page of pages) {
    for (const day of page?.gameWeek || []) {
      for (const g of day.games || []) {
        if (g.gameType !== 2) continue;
        out.set(g.id, {
          id: g.id, kind: 'reg', etDate: day.date, tipUtc: g.startTimeUTC || null, status: gameStatus(g.gameState),
          home: g.homeTeam?.abbrev, away: g.awayTeam?.abbrev, hs: g.homeTeam?.score ?? null, as: g.awayTeam?.score ?? null,
        });
      }
    }
  }
  return [...out.values()].sort((a, b) => (a.tipUtc || a.etDate).localeCompare(b.tipUtc || b.etDate));
}

const playedToi = toi => !!toi && toi !== '00:00';

// One game, kept small: skaters [pid, team, played, goals, assists, plus-minus], goalies
// [pid, team, played, saves, shots], and fighting majors per player from the play-by-play.
export function parseBox(box, pbp, sched) {
  if (!box?.playerByGameStats) return null;
  const skaters = [], goalies = [];
  for (const side of ['homeTeam', 'awayTeam']) {
    const team = box[side]?.abbrev;
    const st = box.playerByGameStats[side] || {};
    for (const p of [...(st.forwards || []), ...(st.defense || [])]) {
      skaters.push([p.playerId, team, playedToi(p.toi) ? 1 : 0, p.goals || 0, p.assists || 0, p.plusMinus || 0]);
    }
    for (const p of st.goalies || []) {
      goalies.push([p.playerId, team, playedToi(p.toi) ? 1 : 0, p.saves || 0, p.shotsAgainst || 0]);
    }
  }
  const fights = {};
  for (const e of pbp?.plays || []) {
    const d = e.details || {};
    if (e.typeDescKey === 'penalty' && d.descKey === 'fighting' && d.committedByPlayerId) {
      fights[d.committedByPlayerId] = (fights[d.committedByPlayerId] || 0) + 1;
    }
  }
  return {
    id: box.id, kind: 'reg', etDate: sched.etDate, tipUtc: sched.tipUtc, status: gameStatus(box.gameState),
    home: box.homeTeam?.abbrev, away: box.awayTeam?.abbrev, hs: box.homeTeam?.score ?? 0, as: box.awayTeam?.score ?? 0,
    last: box.gameOutcome?.lastPeriodType || null, skaters, goalies, fights,
  };
}

const pct = (sv, sa) => sa > 0 ? Math.round(1000 * sv / sa) : 0;

// Builds weeks, players, team records and weekly totals from the schedule, box scores and rosters.
export function buildData({ schedule, boxes, rosters = {}, now = Date.now() }) {
  const done = g => (boxes[g.id]?.status ?? g.status) === 3;
  const weeks = buildWeeks().map(w => {
    const games = schedule.filter(g => g.home && g.away && g.etDate >= w.start && g.etDate <= w.end);
    const gamesByTeam = {}, leftByTeam = {};
    let first = null;
    for (const g of games) {
      for (const t of [g.home, g.away]) {
        gamesByTeam[t] = (gamesByTeam[t] || 0) + 1;
        if (!done(g)) leftByTeam[t] = (leftByTeam[t] || 0) + 1;
      }
      if (g.tipUtc && (!first || g.tipUtc < first.tipUtc)) first = g;
    }
    const allDone = games.length > 0 && games.every(done);
    const endPassed = now > Date.parse(w.end + 'T12:00:00Z') + 24 * 3600e3;
    return {
      ...w,
      lockAt: first ? new Date(first.tipUtc).toISOString() : defaultLockAt(w),
      firstGame: first ? { id: first.id, away: first.away, home: first.home, etDate: first.etDate, tipUtc: first.tipUtc } : null,
      games: games.length, final: allDone && endPassed, gamesByTeam, leftByTeam,
    };
  });

  const ordered = Object.values(boxes).filter(Boolean).sort((a, b) => (a.tipUtc || a.etDate).localeCompare(b.tipUtc || b.etDate));

  // Players: everyone on a current roster, plus anyone who has played (traded or sent down since).
  const players = {};
  const onRoster = new Set();
  for (const [tri, list] of Object.entries(rosters)) {
    for (const r of list) {
      players[r.id] = { id: r.id, first: r.first, last: r.last, name: `${r.first} ${r.last}`.trim(), team: tri, pos: r.pos, num: r.num, img: r.img };
      onRoster.add(r.id);
    }
  }
  const acc = {};
  for (const box of ordered) {
    for (const [pid, team, played, g, a, pm] of box.skaters) {
      if (!players[pid]) players[pid] = { id: pid, first: '', last: `#${pid}`, name: `Player #${pid}`, team, pos: '', num: '' };
      if (!onRoster.has(pid)) players[pid].team = team;
      const x = acc[pid] ||= { gp: 0, pts: 0, pm: 0, sv: 0, sa: 0, fights: 0 };
      if (played) { x.gp++; x.pts += g + a; x.pm += pm; }
      x.fights += box.fights[pid] || 0;
    }
    for (const [pid, team, played, sv, sa] of box.goalies) {
      if (!players[pid]) players[pid] = { id: pid, first: '', last: `#${pid}`, name: `Goalie #${pid}`, team, pos: 'G', num: '' };
      const x = acc[pid] ||= { gp: 0, pts: 0, pm: 0, sv: 0, sa: 0, fights: 0 };
      if (played) { x.gp++; x.sv += sv; x.sa += sa; }
    }
  }
  for (const pl of Object.values(players)) {
    const x = acc[pl.id] || { gp: 0, pts: 0, pm: 0, sv: 0, sa: 0, fights: 0 };
    const per = v => x.gp ? Math.round(v / x.gp * 100) / 100 : 0;
    pl.gp = x.gp;
    pl.pre = false;
    // [points per game, plus-minus per game, season save percentage (thousandths), fights this season]
    pl.avg = [per(x.pts), per(x.pm), pct(x.sv, x.sa), x.fights];
  }

  // Team records from final scores. Overtime and shootout losses count as losses.
  const teams = {};
  for (const box of ordered) {
    if (box.status !== 3 || box.hs === box.as) continue;
    const [win, lose] = box.hs > box.as ? [box.home, box.away] : [box.away, box.home];
    (teams[win] ||= { w: 0, l: 0 }).w++;
    (teams[lose] ||= { w: 0, l: 0 }).l++;
  }

  // Day by day, per week: each player's line for the day and each team's [finished games, wins], for
  // the Calendar. A week's totals are its days added up, so the two always agree.
  const days = {};
  for (const w of weeks) {
    for (const box of ordered) {
      if (box.etDate < w.start || box.etDate > w.end) continue;
      const d = ((days[w.week] ||= {})[box.etDate] ||= { p: {}, t: {} });
      for (const [pid, team, played, g, a, pm] of box.skaters) {
        if (!played) continue;
        const fights = box.fights[pid] || 0;
        // [games, pts, +/-, saves, best pts/+/-/sv%, worst pts/+/-/sv%, team, shots against, fights, goals, Gordie Howes]
        d.p[pid] = addHockeyLine(d.p[pid], [1, g + a, pm, 0, g + a, pm, 0, g + a, pm, 0, team, 0, fights, g, g && a && fights ? 1 : 0]);
      }
      for (const [pid, team, played, sv, sa] of box.goalies) {
        if (!played) continue;
        const gp = pct(sv, sa);
        d.p[pid] = addHockeyLine(d.p[pid], [1, 0, 0, sv, 0, 0, gp, 0, 0, gp, team, sa, 0, 0, 0]);
      }
      if (box.status === 3 && box.hs !== box.as) {
        const [win, lose] = box.hs > box.as ? [box.home, box.away] : [box.away, box.home];
        (d.t[win] ||= [0, 0])[0]++; d.t[win][1]++;
        (d.t[lose] ||= [0, 0])[0]++;
      }
    }
  }
  const totals = {};
  for (const w of weeks) {
    if (!days[w.week]) continue;
    const { p, t } = totalsThrough(days[w.week], w.end);
    if (Object.keys(p).length || Object.keys(t).length) totals[w.week] = { final: w.final, p, t };
  }

  // The season's calendar: [id, ET date, start (UTC), home, away, status, home goals, away goals].
  const calendar = schedule.map(g => {
    const box = boxes[g.id];
    const status = box?.status ?? g.status;
    return [g.id, g.etDate, g.tipUtc, g.home, g.away, status, status >= 2 ? box?.hs ?? g.hs ?? 0 : null, status >= 2 ? box?.as ?? g.as ?? 0 : null];
  });
  return { weeks, players, teams, totals, calendar, days };
}

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJson(file, value) {
  const text = JSON.stringify(value);
  const prev = existsSync(file) ? await readFile(file, 'utf8') : null;
  if (prev === text) return false;
  await writeFile(file, text);
  return true;
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

const addDaysIso = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// The whole season's schedule, a week per request. Refetched in full every 6 hours; in between,
// only the weeks around today (scores and start times move there).
async function loadSchedule(now) {
  const cached = await readJson(path.join(DATA, 'schedule.json'), null);
  const fresh = cached?.fetchedAt && now - Date.parse(cached.fetchedAt) < 6 * 3600e3;
  const pages = [];
  if (fresh) {
    const today = new Date(now).toISOString().slice(0, 10);
    for (const d of [addDaysIso(today, -7), today]) pages.push(await getJson(`${API}/schedule/${d}`));
    const known = new Map(cached.games.map(([id, etDate, tipUtc, home, away, status, hs, as]) => [id, { id, kind: 'reg', etDate, tipUtc, home, away, status, hs, as }]));
    for (const g of parseSchedule(pages)) known.set(g.id, g);
    return { schedule: [...known.values()].sort((a, b) => (a.tipUtc || a.etDate).localeCompare(b.tipUtc || b.etDate)), fetchedAt: cached.fetchedAt };
  }
  const first = await getJson(`${API}/schedule/${buildWeeks()[0].start}`);
  const end = first.regularSeasonEndDate || buildWeeks().at(-1).end;
  let date = first.regularSeasonStartDate || buildWeeks()[0].start;
  for (let i = 0; i < 40 && date <= end; i++) {
    const page = await getJson(`${API}/schedule/${date}`);
    pages.push(page);
    const next = page.nextStartDate;
    date = next && next > date ? next : addDaysIso(date, 7);
  }
  return { schedule: parseSchedule(pages), fetchedAt: new Date(now).toISOString() };
}

// Current rosters for names, positions, numbers and headshots. Refreshed once a day.
async function loadRosters(now) {
  const file = path.join(DATA, 'rosters.json');
  const cached = await readJson(file, null);
  if (cached?.fetchedAt && now - Date.parse(cached.fetchedAt) < 24 * 3600e3) return cached.teams;
  const teams = {};
  await pool(Object.keys(TEAMS), 4, async tri => {
    try {
      const r = await getJson(`${API}/roster/${tri}/current`);
      teams[tri] = [...(r.forwards || []), ...(r.defensemen || []), ...(r.goalies || [])].map(p => ({
        id: p.id, first: p.firstName?.default || '', last: p.lastName?.default || '', pos: p.positionCode || '',
        num: p.sweaterNumber != null ? String(p.sweaterNumber) : '', img: p.headshot || '',
      }));
    } catch (e) { console.warn(`Roster ${tri}: ${e.message || e}`); }
  });
  // Keep yesterday's roster for a team that failed today.
  for (const tri of Object.keys(TEAMS)) if (!teams[tri] && cached?.teams?.[tri]) teams[tri] = cached.teams[tri];
  await writeJson(file, { season: LEAGUE.season, fetchedAt: new Date(now).toISOString(), teams });
  return teams;
}

async function loadBoxes() {
  const boxes = {};
  if (!existsSync(GAMES)) return boxes;
  for (const f of await readdir(GAMES)) {
    if (f.endsWith('.json')) boxes[f.slice(0, -5)] = await readJson(path.join(GAMES, f), null);
  }
  return boxes;
}

async function main() {
  if (SPORT !== 'nhl') throw new Error('Run with PHS_SPORT=nhl.');
  const now = Date.now();
  await mkdir(GAMES, { recursive: true });

  const { schedule, fetchedAt } = await loadSchedule(now);
  const rosters = await loadRosters(now);
  const boxes = await loadBoxes();
  const toFetch = schedule.filter(g => g.tipUtc && Date.parse(g.tipUtc) <= now && boxes[g.id]?.status !== 3);
  console.log(`Schedule: ${schedule.length} games. Fetching ${toFetch.length} box scores.`);
  let failed = 0;
  await pool(toFetch, 6, async g => {
    try {
      const [box, pbp] = await Promise.all([getJson(`${API}/gamecenter/${g.id}/boxscore`), getJson(`${API}/gamecenter/${g.id}/play-by-play`)]);
      const parsed = parseBox(box, pbp, g);
      if (parsed) { boxes[g.id] = parsed; await writeJson(path.join(GAMES, `${g.id}.json`), parsed); }
    } catch (e) {
      failed++;
      if (failed <= 5) console.warn(String(e.message || e));
    }
  });

  const { weeks, players, teams, totals, calendar, days } = buildData({ schedule, boxes, rosters, now });
  const season = LEAGUE.season;
  await mkdir(path.join(DATA, 'days'), { recursive: true });
  const dayFiles = await Promise.all(Object.entries(days).map(([w, d]) => writeJson(path.join(DATA, 'days', `${w}.json`), { season, week: +w, days: d })));
  const changed = [
    ...dayFiles,
    await writeJson(path.join(DATA, 'schedule.json'), { season, fetchedAt, games: calendar }),
    await writeJson(path.join(DATA, 'weeks.json'), { season, weeks }),
    await writeJson(path.join(DATA, 'players.json'), { season, players }),
    await writeJson(path.join(DATA, 'teams.json'), { season, teams }),
    await writeJson(path.join(DATA, 'totals.json'), { season, weeks: totals }),
  ].some(Boolean);
  if (changed || !existsSync(path.join(DATA, 'meta.json'))) {
    await writeJson(path.join(DATA, 'meta.json'), { season, updatedAt: new Date(now).toISOString(), games: Object.keys(boxes).length });
  }
  console.log(`Players: ${Object.keys(players).length}. Weeks with stats: ${Object.keys(totals).length}. Failed fetches: ${failed}.`);

  await syncSupabase({ weeks, players, teams, totals, now });

  const active = gamesActive(schedule, boxes, now);
  console.log(active ? 'Games on (or starting within 75 minutes): keep refreshing.' : 'No games on.');
  if (process.env.LIVE_FLAG) await writeFile(process.env.LIVE_FLAG, active ? 'live' : '');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
