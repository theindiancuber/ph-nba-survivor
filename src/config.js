// League settings. Shared by the browser app and the data script (Node).

export const LEAGUE = {
  name: 'Peakhill NBA Survivor',
  season: '2026-27',
  commissioner: 'The Commissioner',

  // Supabase project (Settings → API). The anon key is public by design;
  // row-level security in supabase/schema.sql is what protects the data.
  supabaseUrl: 'https://miotcbvafwddymqkslyy.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1pb3RjYnZhZndkZHltcWtzbHl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5OTEwMjAsImV4cCI6MjEwNzU2NzAyMH0.dfRVbsAlto2GSnNr5V9VKstymrMc4DV9fAjc017jIys',

  // Three player categories plus one team category (WIN: the team's wins that week).
  slots: ['PTS', 'REB', 'AST', 'WIN'],
  playerSlots: ['PTS', 'REB', 'AST'],
  slotInfo: {
    PTS: { name: 'Bucket', stat: 'Points', short: 'PTS', emoji: '🏀' },
    REB: { name: 'Glass', stat: 'Rebounds', short: 'REB', emoji: '🧱' },
    AST: { name: 'Dime', stat: 'Assists', short: 'AST', emoji: '🎯' },
    WIN: { name: 'Dub', stat: 'Team wins', short: 'W', emoji: '🏆', team: true },
  },

  // Survivor ladder: weekly totals, the same every week (double weeks included).
  // Clear 3 of the 4 bars to keep your lives.
  bars: { PTS: 50, REB: 18, AST: 15, WIN: 1 },
  barsToSurvive: 3,
  lives: 3,

  // Drop your worst weeks: one drop unlocks every `every` final weeks, up to `max`.
  drops: { max: 3, every: 6 },

  // Joker cards. startWeek is the first week packs are dealt. A card played on
  // someone counts as an attack; each person takes at most attackCap a week.
  cards: { startWeek: 1, handLimit: 4, attackCap: 2, duelStake: 5, heist: 3, embargoHours: 24 },
};

// Weeks run Monday–Sunday on US Eastern dates. Week 1 and the All-Star week
// span two calendar weeks (mult 2); the survivor bars stay the same.
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function buildWeeks() {
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
