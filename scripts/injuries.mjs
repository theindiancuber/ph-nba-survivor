// Injury report for the picker: who is out, day-to-day or on injured reserve. Shared by both data
// jobs. The leagues' own feeds have no injury list, so this reads ESPN's public one and matches its
// players to ours by name (and team, when two players share a name).
// The app reads the tags from players.json: players[pid].inj = [label, detail].

import { TEAMS } from '../src/teams.js';

const ESPN = {
  nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries',
  nhl: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries',
};

// A name as both feeds can agree on it: no accents, punctuation, case or suffix.
export const nameKey = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[.'’`-]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/\s+/g, ' ').trim();

// ESPN's status words, shortened for a tag. Anything else ESPN sends is kept as it is.
const LABELS = {
  out: 'Out', 'day-to-day': 'Day-to-day', doubtful: 'Doubtful', questionable: 'Questionable', probable: 'Probable',
  'injured reserve': 'IR', 'long term injured reserve': 'LTIR', 'long-term injured reserve': 'LTIR', suspension: 'Suspended', suspended: 'Suspended',
};
export const injuryLabel = status => {
  const s = String(status || '').trim();
  return LABELS[s.toLowerCase()] || s;
};

// Our team for ESPN's team name ("Los Angeles Lakers", "LA Clippers"): the one whose nickname it ends with.
const teamFor = name => {
  const n = nameKey(name);
  return n ? Object.keys(TEAMS).find(t => n.endsWith(nameKey(TEAMS[t].name))) || null : null;
};

// ESPN's report → { pid: [label, detail] } for our players. detail: what's hurt ("Knee"), or ''.
export function parseInjuries(json, players) {
  const byName = {};
  for (const p of Object.values(players)) (byName[nameKey(p.name)] ||= []).push(p);
  if (!Array.isArray(json?.injuries)) throw new Error('no injuries list in the feed');
  const out = {};
  for (const team of json.injuries) {
    const tri = teamFor(team.displayName);
    for (const e of team.injuries || []) {
      const a = e.athlete || {};
      const label = injuryLabel(e.status || e.type?.description);
      if (!label) continue;
      const found = byName[nameKey(a.displayName || `${a.firstName || ''} ${a.lastName || ''}`)] || [];
      const t = a.team?.abbreviation || tri;
      const p = found.length === 1 ? found[0] : found.find(x => x.team === t);
      if (!p) continue;
      const d = e.details || {};
      out[p.id] = [label, [d.side && d.side !== 'Not Specified' ? d.side : '', d.type || ''].filter(Boolean).join(' ')];
    }
  }
  return out;
}

// Tags players[pid].inj with today's report. If the feed is down, keeps the tags from the last
// players.json (prev) instead of wiping them. Never throws: injuries shouldn't stop the scores.
export async function addInjuries({ sport, players, prev = {}, getJson }) {
  let report;
  try {
    report = parseInjuries(await getJson(ESPN[sport]), players);
  } catch (e) {
    console.warn(`Injury report: ${e.message || e}. Keeping the last one.`);
    report = Object.fromEntries(Object.values(prev).filter(p => p.inj).map(p => [p.id, p.inj]));
  }
  let n = 0;
  for (const [pid, inj] of Object.entries(report)) {
    if (players[pid]) { players[pid].inj = inj; n++; }
  }
  console.log(`Injury report: ${n} players tagged.`);
  return n;
}
