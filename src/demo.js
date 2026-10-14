// Demo league: made-up colleagues and simulated box scores, so the app can be
// explored before the real league has data. Nothing here is real NBA stats.

import { LEAGUE, buildWeeks, defaultLockAt } from './config.js';
import { TEAMS } from './teams.js';

export const DEMO_NOW = Date.parse('2026-12-02T17:00:00Z'); // Wed of week 6

// [personId, first, last, team, pos, num, pts, reb, ast]
const ROSTER = [
  [203999, 'Nikola', 'Jokić', 'DEN', 'C', '15', 29.1, 12.6, 10.2],
  [1628983, 'Shai', 'Gilgeous-Alexander', 'OKC', 'G', '2', 31.4, 5.1, 6.3],
  [203507, 'Giannis', 'Antetokounmpo', 'MIL', 'F', '34', 30.2, 11.8, 6.1],
  [1641705, 'Victor', 'Wembanyama', 'SAS', 'C', '1', 25.6, 11.9, 3.9],
  [1629029, 'Luka', 'Dončić', 'LAL', 'G', '77', 29.8, 8.4, 8.6],
  [1630162, 'Anthony', 'Edwards', 'MIN', 'G', '5', 27.4, 5.6, 4.7],
  [1628369, 'Jayson', 'Tatum', 'BOS', 'F', '0', 25.1, 8.5, 5.0],
  [1628973, 'Jalen', 'Brunson', 'NYK', 'G', '11', 26.9, 3.4, 7.1],
  [1630595, 'Cade', 'Cunningham', 'DET', 'G', '2', 25.7, 6.1, 9.3],
  [1627734, 'Domantas', 'Sabonis', 'SAC', 'C', '10', 19.4, 13.3, 6.2],
  [1629027, 'Trae', 'Young', 'ATL', 'G', '11', 24.0, 3.2, 11.1],
  [2544, 'LeBron', 'James', 'LAL', 'F', '23', 22.8, 7.6, 8.1],
  [201939, 'Stephen', 'Curry', 'GSW', 'G', '30', 25.3, 4.4, 5.9],
  [203954, 'Joel', 'Embiid', 'PHI', 'C', '21', 24.2, 9.0, 4.1],
  [1630169, 'Tyrese', 'Haliburton', 'IND', 'G', '0', 18.9, 3.8, 9.5],
  [1628378, 'Donovan', 'Mitchell', 'CLE', 'G', '45', 26.1, 4.5, 5.2],
  [1630178, 'Tyrese', 'Maxey', 'PHI', 'G', '0', 26.5, 3.6, 6.4],
  [1631094, 'Paolo', 'Banchero', 'ORL', 'F', '5', 24.8, 7.4, 4.8],
  [1626164, 'Devin', 'Booker', 'PHX', 'G', '1', 25.2, 4.1, 6.8],
  [1630578, 'Alperen', 'Şengün', 'HOU', 'C', '28', 20.6, 10.4, 5.3],
  [1628389, 'Bam', 'Adebayo', 'MIA', 'C', '13', 18.7, 10.1, 4.0],
  [1626157, 'Karl-Anthony', 'Towns', 'NYK', 'C', '32', 23.9, 12.4, 3.1],
  [203497, 'Rudy', 'Gobert', 'MIN', 'C', '27', 11.8, 11.6, 1.8],
  [1631096, 'Chet', 'Holmgren', 'OKC', 'C', '7', 17.2, 8.9, 2.4],
  [1631114, 'Jalen', 'Williams', 'OKC', 'F', '8', 20.4, 5.5, 5.1],
  [1630163, 'LaMelo', 'Ball', 'CHA', 'G', '1', 25.6, 5.0, 7.6],
  [202695, 'Kawhi', 'Leonard', 'LAC', 'F', '2', 22.9, 6.2, 3.4],
  [201935, 'James', 'Harden', 'LAC', 'G', '1', 21.8, 5.6, 8.4],
  [1627759, 'Jaylen', 'Brown', 'BOS', 'G', '7', 24.1, 5.9, 4.3],
  [1629630, 'Ja', 'Morant', 'MEM', 'G', '12', 22.3, 4.6, 7.9],
  [1629627, 'Zion', 'Williamson', 'NOP', 'F', '1', 23.4, 6.9, 4.9],
  [1630596, 'Evan', 'Mobley', 'CLE', 'F', '4', 18.9, 9.4, 3.3],
  [1628386, 'Jarrett', 'Allen', 'CLE', 'C', '31', 13.6, 10.3, 1.9],
  [1630567, 'Scottie', 'Barnes', 'TOR', 'F', '4', 19.7, 7.8, 6.1],
  [1630581, 'Josh', 'Giddey', 'CHI', 'G', '3', 15.9, 8.6, 7.8],
  [202696, 'Nikola', 'Vučević', 'CHI', 'C', '9', 17.8, 10.2, 3.2],
  [1627826, 'Ivica', 'Zubac', 'LAC', 'C', '40', 15.1, 12.0, 2.5],
  [203991, 'Clint', 'Capela', 'HOU', 'C', '30', 8.6, 9.0, 1.1],
  [1630552, 'Jalen', 'Johnson', 'ATL', 'F', '1', 19.6, 10.0, 5.4],
  [1630532, 'Franz', 'Wagner', 'ORL', 'F', '22', 22.4, 5.6, 4.9],
  [1628374, 'Lauri', 'Markkanen', 'UTA', 'F', '23', 21.3, 7.1, 1.8],
  [1627750, 'Jamal', 'Murray', 'DEN', 'G', '27', 21.2, 4.1, 6.0],
  [1630217, 'Desmond', 'Bane', 'ORL', 'G', '3', 18.6, 4.7, 4.3],
  [1628401, 'Derrick', 'White', 'BOS', 'G', '9', 16.7, 4.3, 5.1],
  [1628969, 'Mikal', 'Bridges', 'NYK', 'F', '25', 17.8, 3.4, 3.6],
  [1628404, 'Josh', 'Hart', 'NYK', 'G', '3', 12.6, 9.3, 5.8],
  [1626167, 'Myles', 'Turner', 'MIL', 'C', '33', 14.8, 6.8, 1.6],
  [1627783, 'Pascal', 'Siakam', 'IND', 'F', '43', 20.4, 6.9, 3.4],
  [203083, 'Andre', 'Drummond', 'PHI', 'C', '1', 7.4, 9.1, 1.2],
  [1631117, 'Walker', 'Kessler', 'UTA', 'C', '24', 11.0, 10.9, 1.9],
  [1628991, 'Jaren', 'Jackson Jr.', 'MEM', 'F', '13', 21.6, 5.9, 2.0],
  [1630224, 'Jalen', 'Green', 'PHX', 'G', '4', 20.1, 4.4, 3.5],
  [1629636, 'Darius', 'Garland', 'CLE', 'G', '10', 19.8, 2.8, 6.9],
  [1627749, 'Dejounte', 'Murray', 'NOP', 'G', '5', 17.5, 6.0, 7.2],
  [1628368, "De'Aaron", 'Fox', 'SAS', 'G', '4', 22.1, 4.2, 6.4],
  [201950, 'Jrue', 'Holiday', 'POR', 'G', '5', 12.9, 4.6, 4.8],
  [1629028, 'Deandre', 'Ayton', 'LAL', 'C', '5', 14.4, 10.5, 1.6],
  [1630559, 'Austin', 'Reaves', 'LAL', 'G', '15', 20.2, 4.8, 5.8],
  [1641706, 'Brandon', 'Miller', 'CHA', 'F', '24', 20.8, 5.0, 3.4],
  [1630600, 'Isaiah', 'Mobley', 'CLE', 'F', '15', 4.1, 2.0, 0.8],
];

function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const COLLEAGUES = [
  ['Maya R.', 'BOS'], ['Dev P.', 'GSW'], ['Sam O.', 'NYK'], ['Priya K.', 'LAL'], ['Jordan T.', 'CHI'],
  ['Alex M.', 'MIA'], ['Chris L.', 'DEN'], ['Nina S.', 'TOR'], ['Omar H.', 'OKC'], ['Leah B.', 'PHX'],
  ['Raj V.', 'SAC'], ['Tess W.', 'MIL'], ['Ben C.', 'CLE'], ['Kofi A.', 'ATL'],
];

export function makeDemo() {
  const rand = rng(20261020);
  const now = DEMO_NOW;
  const players = {};
  for (const [id, first, last, team, pos, num, pts, reb, ast] of ROSTER) {
    players[id] = { id, first, last, name: `${first} ${last}`, team, pos, num, gp: 0, avg: [pts, reb, ast], pre: false };
  }

  const weeks = buildWeeks().map(w => {
    const lockAt = defaultLockAt(w);
    const gamesByTeam = {};
    for (const t of Object.keys(TEAMS)) gamesByTeam[t] = (w.mult === 2 ? 5 : 2) + Math.floor(rand() * (w.mult === 2 ? 4 : 3));
    const ended = now > Date.parse(w.end + 'T12:00:00Z') + 86400e3;
    return { ...w, lockAt, final: ended, gamesByTeam, leftByTeam: {} };
  });

  const totals = {};
  const seasonAcc = {};
  for (const w of weeks) {
    if (now < Date.parse(w.lockAt)) continue;
    const span = (Date.parse(w.end + 'T23:59:00Z') - Date.parse(w.lockAt));
    const frac = w.final ? 1 : Math.max(0, Math.min(1, (now - Date.parse(w.lockAt)) / span));
    const p = {};
    for (const pl of Object.values(players)) {
      const games = w.gamesByTeam[pl.team];
      const played = Math.round(games * frac);
      if (!w.final) w.leftByTeam[pl.team] = games - played;
      if (rand() < 0.05) continue; // sat out the week
      const line = [0, 0, 0, 0];
      for (let g = 0; g < played; g++) {
        line[0]++;
        pl.avg.forEach((a, i) => { line[i + 1] += Math.max(0, Math.round(a * (0.55 + rand() * 0.9))); });
      }
      if (line[0]) {
        p[pl.id] = line;
        const acc = seasonAcc[pl.id] ||= [0, 0, 0, 0];
        line.forEach((v, i) => { acc[i] += v; });
      }
    }
    totals[w.week] = { final: w.final, p };
  }
  for (const [id, acc] of Object.entries(seasonAcc)) {
    players[id].gp = acc[0];
    players[id].avg = [acc[1] / acc[0], acc[2] / acc[0], acc[3] / acc[0]].map(x => Math.round(x * 10) / 10);
  }

  const meId = 'demo-you';
  const profiles = [{ id: meId, display_name: 'You', fav_team: 'NYK', rival_id: 'demo-2', created_at: '2026-10-15T12:00:00Z' }]
    .concat(COLLEAGUES.map(([name, team], i) => ({ id: `demo-${i + 1}`, display_name: name, fav_team: team, rival_id: i % 3 === 0 ? meId : `demo-${((i + 3) % COLLEAGUES.length) + 1}`, created_at: '2026-10-16T12:00:00Z' })));

  // Simulated picks: strong options early, with some contrarians and a few backups.
  const picks = [];
  const STAT = { PTS: 0, REB: 1, AST: 2 };
  for (const pr of profiles) {
    const burned = { PTS: new Set(), REB: new Set(), AST: new Set() };
    const ddWeek = 2 + Math.floor(rand() * 6);
    for (const w of weeks) {
      if (now >= Date.parse(w.lockAt) || w.week === weeks.find(x => now < Date.parse(x.lockAt))?.week && pr.id !== meId && rand() < 0.5) {
        const usedWeek = new Set();
        const lockedWeek = now >= Date.parse(w.lockAt);
        for (const slot of LEAGUE.slots) {
          const ranked = Object.values(players)
            .filter(pl => !burned[slot].has(pl.id) && !usedWeek.has(pl.id))
            .map(pl => ({ pl, score: pl.avg[STAT[slot]] * w.gamesByTeam[pl.team] * (0.7 + rand() * 0.6) }))
            .sort((a, b) => b.score - a.score);
          const choice = ranked[Math.floor(rand() * rand() * 6)]?.pl;
          if (!choice) continue;
          const alt = rand() < 0.35 ? ranked.find(r => r.pl.id !== choice.id)?.pl : null;
          usedWeek.add(choice.id);
          if (alt) usedWeek.add(alt.id);
          picks.push({ user_id: pr.id, week: w.week, slot, player_id: choice.id, alt_id: alt?.id ?? null, double_down: lockedWeek && w.week === ddWeek && slot === 'PTS', auto: false });
          if (lockedWeek) {
            const gp = totals[w.week]?.p?.[choice.id]?.[0] || 0;
            burned[slot].add(gp > 0 || !alt ? choice.id : alt.id);
          }
        }
      }
    }
  }
  const unburns = [{ user_id: 'demo-4', slot: 'REB', player_id: 203999, week: 5 }];
  return { version: 3, now, players, weeks, totals, profiles, picks, unburns, meId };
}
