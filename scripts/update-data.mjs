// Pulls the NBA schedule and box scores, writes the league's data files,
// and (when Supabase secrets are set) syncs pick locks and runs Autopilot.
//
//   node scripts/update-data.mjs
//
// Env (optional): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Writes: data/weeks.json, data/players.json, data/teams.json, data/totals.json, data/games/<id>.json

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEAGUE, buildWeeks, defaultLockAt } from '../src/config.js';
import { computeLeague, autopilotPicks } from '../src/league.js';
import { resolveDecrees, decreeCodes } from '../src/decrees.js';
import { seededDealer } from '../src/cards.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const GAMES = path.join(DATA, 'games');
const CDN = 'https://cdn.nba.com/static/json';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; peakhill-nba-survivor/1.0)',
  Referer: 'https://www.nba.com/',
  Origin: 'https://www.nba.com',
  Accept: 'application/json',
};

// Game id prefixes: 001 preseason, 002 regular season (NBA Cup group and
// knockout games count), 004 playoffs, 005 play-in, 006 Cup final.
export function gameKind(id) {
  return { '001': 'pre', '002': 'reg' }[String(id).slice(0, 3)] || 'other';
}

export function parseSchedule(json) {
  const out = [];
  for (const day of json?.leagueSchedule?.gameDates || []) {
    for (const g of day.games || []) {
      const kind = gameKind(g.gameId);
      if (kind === 'other') continue;
      out.push({
        id: g.gameId,
        kind,
        etDate: String(g.gameDateEst || g.gameDateTimeEst || '').slice(0, 10),
        tipUtc: g.gameDateTimeUTC || null,
        status: Number(g.gameStatus) || 1,
        home: g.homeTeam?.teamTricode,
        away: g.awayTeam?.teamTricode,
      });
    }
  }
  return out;
}

export function parseBox(json, sched) {
  const g = json?.game;
  if (!g) return null;
  const players = [];
  for (const side of ['homeTeam', 'awayTeam']) {
    const t = g[side];
    for (const p of t?.players || []) {
      const s = p.statistics || {};
      players.push([
        p.personId, t.teamTricode, p.played === '1' || p.played === 1 ? 1 : 0,
        s.points || 0, s.reboundsTotal || 0, s.assists || 0,
        p.firstName || '', p.familyName || '', p.position || '', p.jerseyNum || '',
      ]);
    }
  }
  return {
    id: g.gameId, kind: sched.kind, etDate: sched.etDate, tipUtc: sched.tipUtc,
    status: Number(g.gameStatus) || sched.status,
    home: g.homeTeam?.teamTricode, away: g.awayTeam?.teamTricode, players,
  };
}

// Builds weeks, players and weekly totals from the schedule and cached box scores.
export function buildData({ schedule, boxes, now = Date.now() }) {
  const weeks = buildWeeks().map(w => {
    // NBA Cup knockout games are listed before their teams and tip times are
    // set; they can't set a lock or a team's game count until they are.
    const games = schedule.filter(g => g.kind === 'reg' && g.home && g.away && g.etDate >= w.start && g.etDate <= w.end);
    const gamesByTeam = {}, leftByTeam = {};
    let first = null;
    for (const g of games) {
      const done = (boxes[g.id]?.status ?? g.status) === 3;
      for (const t of [g.home, g.away]) {
        gamesByTeam[t] = (gamesByTeam[t] || 0) + 1;
        if (!done) leftByTeam[t] = (leftByTeam[t] || 0) + 1;
      }
      if (g.tipUtc && (!first || g.tipUtc < first.tipUtc)) first = g;
    }
    const allDone = games.length > 0 && games.every(g => (boxes[g.id]?.status ?? g.status) === 3);
    const endPassed = now > Date.parse(w.end + 'T12:00:00Z') + 24 * 3600e3;
    return {
      ...w,
      lockAt: first ? new Date(first.tipUtc).toISOString() : defaultLockAt(w),
      firstGame: first ? { id: first.id, away: first.away, home: first.home, etDate: first.etDate, tipUtc: first.tipUtc } : null,
      games: games.length,
      final: allDone && endPassed,
      gamesByTeam, leftByTeam,
    };
  });

  // Preseason games can include non-NBA opponents: keep only the league's 30 teams.
  const leagueTeams = new Set(schedule.filter(g => g.kind === 'reg').flatMap(g => [g.home, g.away]));
  const ordered = Object.values(boxes).sort((a, b) => (a.tipUtc || a.etDate).localeCompare(b.tipUtc || b.etDate));
  const players = {};
  const acc = {};
  for (const box of ordered) {
    for (const [pid, team, played, pts, reb, ast, first, last, pos, num] of box.players) {
      if (leagueTeams.size && !leagueTeams.has(team)) continue;
      const pl = players[pid] ||= { id: pid };
      Object.assign(pl, { first, last, name: `${first} ${last}`.trim(), team, pos: pos || pl.pos || '', num: num || pl.num || '' });
      const a = acc[pid] ||= { reg: [0, 0, 0, 0], pre: [0, 0, 0, 0] };
      const bucket = box.kind === 'reg' ? a.reg : a.pre;
      if (played) { bucket[0]++; bucket[1] += pts; bucket[2] += reb; bucket[3] += ast; }
    }
  }
  for (const [pid, a] of Object.entries(acc)) {
    const src = a.reg[0] ? a.reg : a.pre;
    const gp = src[0] || 1;
    players[pid].gp = a.reg[0];
    players[pid].pre = !a.reg[0];
    players[pid].avg = [src[1] / gp, src[2] / gp, src[3] / gp].map(x => Math.round(x * 10) / 10);
  }

  // Team results: a finished game's winner is the side whose players scored more.
  const teams = {};
  const result = box => {
    if (box.kind !== 'reg' || box.status !== 3 || !box.home || !box.away) return null;
    const pts = {};
    for (const [, team, , p] of box.players) pts[team] = (pts[team] || 0) + p;
    const h = pts[box.home] || 0, a = pts[box.away] || 0;
    return h === a ? null : { winner: h > a ? box.home : box.away, loser: h > a ? box.away : box.home };
  };
  for (const box of ordered) {
    const r = result(box);
    if (!r) continue;
    (teams[r.winner] ||= { w: 0, l: 0 }).w++;
    (teams[r.loser] ||= { w: 0, l: 0 }).l++;
  }

  const totals = {};
  for (const w of weeks) {
    const p = {}, t = {};
    for (const box of ordered) {
      if (box.kind !== 'reg' || box.etDate < w.start || box.etDate > w.end) continue;
      for (const [pid, team, played, pts, reb, ast] of box.players) {
        if (!played) continue;
        // [games, pts, reb, ast, best game pts/reb/ast, worst game pts/reb/ast, team]
        const x = p[pid] ||= [0, 0, 0, 0, pts, reb, ast, pts, reb, ast, team];
        x[0]++; x[1] += pts; x[2] += reb; x[3] += ast;
        [pts, reb, ast].forEach((v, i) => { x[4 + i] = Math.max(x[4 + i], v); x[7 + i] = Math.min(x[7 + i], v); });
        x[10] = team;
      }
      const r = result(box);
      if (r) {
        (t[r.winner] ||= [0, 0])[0]++; t[r.winner][1]++;
        (t[r.loser] ||= [0, 0])[0]++;
      }
    }
    if (Object.keys(p).length || Object.keys(t).length) totals[w.week] = { final: w.final, p, t };
  }
  return { weeks, players, teams, totals };
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

async function loadBoxes() {
  const boxes = {};
  if (!existsSync(GAMES)) return boxes;
  for (const f of await readdir(GAMES)) {
    if (f.endsWith('.json')) boxes[f.slice(0, -5)] = await readJson(path.join(GAMES, f), null);
  }
  return boxes;
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// ---- Supabase (service role: bypasses row-level security) ----

function supabase() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const call = async (method, route, body, prefer) => {
    const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${route}`, {
      method,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Supabase ${method} ${route}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json().catch(() => null);
  };
  // PostgREST caps responses (1000 rows on Supabase), so page through reads.
  call.all = async route => {
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await call('GET', `${route}&order=${route.startsWith('picks') ? 'week,user_id,slot' : 'created_at'}&limit=1000&offset=${offset}`);
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
  };
  return call;
}

async function syncSupabase({ weeks, players, teams, totals, now }) {
  const sb = supabase();
  if (!sb) { console.log('Supabase secrets not set: skipping lock sync and Autopilot.'); return; }

  // Move upcoming locks to the real first tip-off. Locks that have passed never move.
  const upcoming = weeks.filter(w => Date.parse(w.lockAt) > now).map(w => ({ week: w.week, lock_at: w.lockAt }));
  const serverWeeks = await sb('GET', 'weeks?select=week,lock_at');
  const serverLock = Object.fromEntries(serverWeeks.map(w => [w.week, w.lock_at]));
  const changed = upcoming.filter(w => !serverLock[w.week] || (Date.parse(serverLock[w.week]) > now && Date.parse(serverLock[w.week]) !== Date.parse(w.lock_at)));
  if (changed.length) {
    await sb('POST', 'weeks?on_conflict=week', changed, 'resolution=merge-duplicates');
    console.log(`Synced ${changed.length} week locks.`);
  }

  // Autopilot: within 3 days after a lock, fill every empty slot.
  const merged = weeks.map(w => ({ ...w, lockAt: serverLock[w.week] ? new Date(serverLock[w.week]).toISOString() : w.lockAt }));
  const due = merged.filter(w => Date.parse(w.lockAt) <= now && now - Date.parse(w.lockAt) < 3 * 86400e3);
  if (!due.length) return;
  const [profiles, picks, unburns, plays] = await Promise.all([
    sb.all('profiles?select=id,display_name,rival_id,fav_team,created_at'),
    sb.all('picks?select=*'),
    sb.all('unburns?select=*'),
    sb.all('card_plays?select=*').catch(() => []), // before upgrade-cards.sql adds the cards table
  ]);
  // Commissioner's Decree (Amnesty changes burns, so Autopilot needs it). None before upgrade-decree.sql.
  const decreeRows = await sb.all('decrees?select=*').catch(() => []);
  const tallies = await sb('POST', 'rpc/decree_tally', {}).catch(() => []);
  // Secret pack seeds, so hands (and so Copycat plays) can be checked. No seeds, no cards.
  const seedRows = await sb('POST', 'rpc/pack_seeds', {}).catch(() => null);
  const seeds = seedRows ? Object.fromEntries(seedRows.map(x => [`${x.user_id}|${x.week}`, x.seed])) : null;
  const cardArgs = seeds ? { plays, dealer: seededDealer(seeds) } : { plays: [], cardsFrom: Infinity };
  for (const w of due) {
    const at = Date.parse(w.lockAt) + 1;
    const decrees = decreeCodes(resolveDecrees(decreeRows, tallies || [], Object.fromEntries(merged.map(x => [x.week, x.lockAt])), at));
    const league = computeLeague({ weeks: merged, totals, picks, unburns, profiles, now: at, players, ...cardArgs, decrees });
    const copycats = league.cards.weeks[w.week]?.copy || new Map();
    const rows = [];
    for (const pr of profiles) {
      if (Date.parse(pr.created_at) > Date.parse(w.lockAt)) continue;
      const current = Object.fromEntries(picks.filter(p => p.user_id === pr.id && p.week === w.week).map(p => [p.slot, p]));
      // A Copycat slot is meant to stay empty: nothing to fill.
      for (const slot of LEAGUE.slots) if (!current[slot] && copycats.has(`${pr.id}|${slot}`)) current[slot] = { copycat: true };
      if (Object.keys(current).length === LEAGUE.slots.length) continue;
      const chosen = autopilotPicks(league, pr.id, w.week, current, players, w.gamesByTeam, teams);
      for (const [slot, pid] of Object.entries(chosen)) {
        rows.push({ user_id: pr.id, week: w.week, slot, player_id: pid, alt_id: null, double_down: false, auto: true });
      }
    }
    if (rows.length) {
      await sb('POST', 'picks?on_conflict=user_id,week,slot', rows, 'resolution=ignore-duplicates');
      picks.push(...rows);
      console.log(`Autopilot filled ${rows.length} slots in week ${w.week}.`);
    }
  }
}

async function main() {
  const now = Date.now();
  await mkdir(GAMES, { recursive: true });

  const schedJson = await getJson(`${CDN}/staticData/scheduleLeagueV2.json`);
  const season = schedJson?.leagueSchedule?.seasonYear;
  if (season && season !== LEAGUE.season) console.warn(`Schedule is for ${season}, league is ${LEAGUE.season}.`);
  const schedule = parseSchedule(schedJson);

  const boxes = await loadBoxes();
  const toFetch = schedule.filter(g => g.tipUtc && Date.parse(g.tipUtc) <= now && boxes[g.id]?.status !== 3);
  console.log(`Schedule: ${schedule.length} games. Fetching ${toFetch.length} box scores.`);
  let failed = 0;
  await pool(toFetch, 6, async g => {
    try {
      const box = parseBox(await getJson(`${CDN}/liveData/boxscore/boxscore_${g.id}.json`), g);
      if (box) { boxes[g.id] = box; await writeJson(path.join(GAMES, `${g.id}.json`), box); }
    } catch (e) {
      failed++;
      if (failed <= 5) console.warn(String(e.message || e));
    }
  });

  const { weeks, players, teams, totals } = buildData({ schedule, boxes, now });
  const changed = [
    await writeJson(path.join(DATA, 'weeks.json'), { season: LEAGUE.season, weeks }),
    await writeJson(path.join(DATA, 'players.json'), { season: LEAGUE.season, players }),
    await writeJson(path.join(DATA, 'teams.json'), { season: LEAGUE.season, teams }),
    await writeJson(path.join(DATA, 'totals.json'), { season: LEAGUE.season, weeks: totals }),
  ].some(Boolean);
  // Only bump the timestamp when the data moved, so quiet hours make no commit.
  if (changed || !existsSync(path.join(DATA, 'meta.json'))) {
    await writeJson(path.join(DATA, 'meta.json'), { season: LEAGUE.season, updatedAt: new Date(now).toISOString(), games: Object.keys(boxes).length });
  }
  console.log(`Players: ${Object.keys(players).length}. Weeks with stats: ${Object.keys(totals).length}. Failed fetches: ${failed}.`);

  await syncSupabase({ weeks, players, teams, totals, now });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
