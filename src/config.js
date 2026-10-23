// League settings. Shared by the browser app and the data script (Node).
//
// One site runs several leagues (Peakhill Survivor Leagues). Each page says which one it is:
// <html data-sport="nhl"> on nhl/index.html; the root page is the NBA league. The data job and
// the tests pick one with PHS_SPORT=nhl. The leagues share one Supabase project, so one account
// signs in to both; each league keeps its tables in its own Postgres schema (dbSchema).
export const SPORT = (typeof document !== 'undefined' && document.documentElement?.dataset?.sport)
  || (typeof process !== 'undefined' && process.env?.PHS_SPORT) || 'nba';

export const SITE = 'Peakhill Survivor Leagues';

const NBA = {
  sport: 'nba', short: 'NBA', emoji: '🏀',
  name: 'Peakhill NBA Survivor',
  season: '2026-27',
  commissioner: 'The Commissioner',

  // Supabase project (Settings → API). The anon key is public by design;
  // row-level security in supabase/schema.sql is what protects the data.
  // The URL is also in the Content-Security-Policy in index.html: change both together.
  supabaseUrl: 'https://miotcbvafwddymqkslyy.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1pb3RjYnZhZndkZHltcWtzbHl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5OTEwMjAsImV4cCI6MjEwNzU2NzAyMH0.dfRVbsAlto2GSnNr5V9VKstymrMc4DV9fAjc017jIys',

  // Three player categories plus one team category (WIN: the team's wins that week).
  // pickSlots adds any bonus slot (outside the rankings and the bars) to the ranked slots.
  slots: ['PTS', 'REB', 'AST', 'WIN'],
  playerSlots: ['PTS', 'REB', 'AST'],
  pickSlots: ['PTS', 'REB', 'AST', 'WIN'],
  // idx: the stat's column in a weekly line (best game at idx + 3, worst at idx + 6); avg: its
  // column in a player's season averages; barRange: what the Commissioner tab allows for its bar.
  slotInfo: {
    PTS: { name: 'Bucket', stat: 'Points', short: 'PTS', emoji: '🏀', idx: 1, avg: 0, barRange: [0, 400] },
    REB: { name: 'Glass', stat: 'Rebounds', short: 'REB', emoji: '🧱', idx: 2, avg: 1, barRange: [0, 150] },
    AST: { name: 'Dime', stat: 'Assists', short: 'AST', emoji: '🎯', idx: 3, avg: 2, barRange: [0, 120] },
    WIN: { name: 'Dub', stat: 'Team wins', short: 'W', emoji: '🏆', team: true, barRange: [0, 8] },
  },
  // Words that differ between sports.
  words: { start: 'tip-off', startShort: 'tip', surface: 'floor', source: 'box scores from NBA.com', sourceShort: 'NBA.com', pure: 'Pure Hoops' },

  // Survivor ladder: weekly totals, the same every week (double weeks included).
  // Clear 3 of the 4 bars to keep your lives.
  bars: { PTS: 50, REB: 18, AST: 15, WIN: 1 },
  barsToSurvive: 3,
  lives: 3,

  // Drop your worst weeks: one drop unlocks every `every` final weeks, up to `max`.
  drops: { max: 3, every: 6 },

  // Joker cards. startWeek is the first week packs are dealt. A card played on
  // someone counts as an attack; each person takes at most attackCap a week.
  // swapsThroughWeek: packs up to this week could swap their kept card once (a learning week). Later kept cards are final.
  // oddsFrom: packs from this week on use the sliding odds (standingOdds in cards.js). Earlier packs keep the
  // table they were dealt with, because packs are re-dealt from their seeds and must come out the same.
  cards: { startWeek: 1, handLimit: 4, attackCap: 2, duelStake: 5, heist: 3, embargoHours: 24, swapsThroughWeek: 1, oddsFrom: 3 },

  // Commissioner's Decree: a one-week rule twist, posted at least noticeHours before
  // the lock (votes close then too). perSeason must match supabase/upgrade-decree.sql.
  decree: { perSeason: 3, noticeHours: 24, bounty: 5 },
};

const NHL = {
  sport: 'nhl', short: 'NHL', emoji: '🏒',
  name: 'Peakhill NHL Survivor',
  season: '2026-27',
  commissioner: 'The Commissioner',

  // The NBA league's Supabase project (one account for both leagues), with the NHL league's tables in
  // the nhl schema (supabase/nhl/setup.sql). The URL is also in the Content-Security-Policy in nhl/index.html.
  supabaseUrl: 'https://miotcbvafwddymqkslyy.supabase.co',
  supabaseAnonKey: NBA.supabaseAnonKey,
  dbSchema: 'nhl',

  // Four ranked slots, plus Gloves Off: a fight bonus that isn't ranked and doesn't count for the bars.
  // pos: who can be picked ('skater' or 'G'). signed: the total can go below zero, and a pick who
  // plays no games ranks last. pct: a save percentage in thousandths (915 = .915). burns: how many
  // times a player can be used in the slot in a season.
  slots: ['PTS', 'PM', 'SV', 'WIN'],
  playerSlots: ['PTS', 'PM', 'SV'],
  pickSlots: ['PTS', 'PM', 'SV', 'WIN', 'FIGHT'],
  slotInfo: {
    PTS: { name: 'Lamplighter', stat: 'Points', short: 'PTS', emoji: '🚨', idx: 1, avg: 0, pos: 'skater', barRange: [0, 30] },
    PM: { name: 'Shutdown', stat: 'Plus-minus', short: '+/-', emoji: '🛡️', idx: 2, avg: 1, pos: 'skater', signed: true, barRange: [-10, 20] },
    SV: { name: 'The Wall', stat: 'Save percentage', short: 'SV%', emoji: '🥅', idx: 3, avg: 2, pos: 'G', pct: true, burns: 2, barRange: [0, 1000] },
    WIN: { name: 'Dub', stat: 'Team wins', short: 'W', emoji: '🏆', team: true, barRange: [0, 8] },
    FIGHT: { name: 'Gloves Off', stat: 'Fights', short: 'fights', emoji: '🥊', avg: 3, pos: 'skater', bonus: true },
  },
  words: { start: 'puck drop', startShort: 'puck drop', surface: 'ice', source: 'stats from NHL.com', sourceShort: 'NHL.com', pure: 'Pure Hockey' },

  // A goalie's week counts only once he's faced this many shots (starts and relief added together).
  // Weekly line columns past the team (10): shots against, fights, goals, Gordie Howe hat tricks.
  minShots: 20,
  line: { shots: 11, fights: 12, goals: 13, gordie: 14 },
  // Gloves Off: points per fight, fights counted a week. Gordie Howe hat trick: a goal, an assist
  // and a fight in one game by any of your skater picks.
  fight: { points: 5, max: 2 },
  gordieHowe: 5,

  bars: { PTS: 3, PM: 1, SV: 900, WIN: 2 },
  barsToSurvive: 3,
  lives: 3,
  drops: { max: 3, every: 6 },
  // The same card game under hockey names (see HOCKEY in src/cards.js). Infinity as startWeek would
  // hide the Cards tab and every card feature.
  cards: { startWeek: 1, handLimit: 4, attackCap: 2, duelStake: 5, heist: 3, embargoHours: 24, swapsThroughWeek: 1, oddsFrom: 3 },
  decree: { perSeason: 3, noticeHours: 24, bounty: 5 },
};

export const LEAGUE = SPORT === 'nhl' ? NHL : NBA;

// Formats a slot's total: +2 for plus-minus, .915 for a save percentage.
export function slotValue(slot, v) {
  const info = LEAGUE.slotInfo[slot];
  if (info?.pct) return v >= 1000 ? '1.000' : `.${String(Math.max(0, Math.round(v))).padStart(3, '0')}`;
  if (info?.signed) return v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0';
  return String(v);
}

// Weeks run Monday–Sunday on US Eastern dates. Week 1 and the All-Star week
// span two calendar weeks (mult 2); the survivor bars stay the same.
export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function buildWeeks() {
  if (SPORT === 'nhl') return nhlWeeks();
  const weeks = [{ week: 1, start: '2026-10-20', end: '2026-11-01', mult: 2 }];
  let start = '2026-11-02';
  for (let w = 2; w <= 16; w++) {
    weeks.push({ week: w, start, end: addDays(start, 6), mult: 1 });
    start = addDays(start, 7);
  }
  weeks.push({ week: 17, start: '2027-02-15', end: '2027-02-28', mult: 2 });
  start = '2027-03-01';
  for (let w = 18; w <= 23; w++) {
    weeks.push({ week: w, start, end: addDays(start, 6), mult: 1 });
    start = addDays(start, 7);
  }
  return weeks;
}

// NHL: Monday to Sunday from Mon Oct 26, 2026 until the regular season ends (Sat Apr 10, 2027).
function nhlWeeks() {
  const weeks = [];
  let start = '2026-10-26';
  for (let w = 1; w <= 24; w++) {
    weeks.push({ week: w, start, end: addDays(start, 6), mult: 1 });
    start = addDays(start, 7);
  }
  return weeks;
}

// Converts an Eastern wall-clock time to a UTC ISO string (handles DST).
export function easternToUtc(isoDate, hh = 19, mm = 0) {
  const guess = Date.UTC(+isoDate.slice(0, 4), +isoDate.slice(5, 7) - 1, +isoDate.slice(8, 10), hh, mm);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  for (const offset of [4, 5]) {
    const t = guess + offset * 3600e3;
    const parts = Object.fromEntries(fmt.formatToParts(new Date(t)).map(p => [p.type, p.value]));
    if (+parts.hour % 24 === hh && +parts.minute === mm && `${parts.year}-${parts.month}-${parts.day}` === isoDate) {
      return new Date(t).toISOString();
    }
  }
  return new Date(guess + 5 * 3600e3).toISOString();
}

// Fallback lock: 7pm ET on the first day of the week. The data script
// replaces it with the real first tip-off once the schedule is loaded.
export function defaultLockAt(week) {
  return easternToUtc(week.start, 19, 0);
}

// Month buckets for the Monthly Crown, by the week's end date. April folds into March.
export function monthKey(week) {
  const m = week.end.slice(0, 7);
  return m.endsWith('-04') ? m.slice(0, 5) + '03' : m;
}

export const MONTH_LABELS = {
  '2026-11': 'November', '2026-12': 'December', '2027-01': 'January',
  '2027-02': 'February', '2027-03': 'March/April',
};
