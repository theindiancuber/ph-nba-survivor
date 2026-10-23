// NHL demo league: made-up colleagues and simulated games, so the hockey league can be
// explored before it has data (/nhl/?demo). Nothing here is real NHL stats.

import { LEAGUE, buildWeeks, defaultLockAt } from './config.js';
import { TEAMS } from './teams.js';

export const DEMO_NOW = Date.parse('2026-12-02T17:00:00Z'); // Wed of week 6

// Skaters: [id, first, last, team, pos, num, points/game, plus-minus/game, fights/game]
const SKATERS = [
  [8478402, 'Connor', 'McDavid', 'EDM', 'C', '97', 1.55, 0.3, 0],
  [8477934, 'Leon', 'Draisaitl', 'EDM', 'C', '29', 1.35, 0.2, 0],
  [8477492, 'Nathan', 'MacKinnon', 'COL', 'C', '29', 1.45, 0.4, 0],
  [8479318, 'Auston', 'Matthews', 'TOR', 'C', '34', 1.1, 0.3, 0],
  [8476453, 'Nikita', 'Kucherov', 'TBL', 'R', '86', 1.4, 0.3, 0],
  [8477956, 'David', 'Pastrnak', 'BOS', 'R', '88', 1.2, 0.1, 0],
  [8480069, 'Cale', 'Makar', 'COL', 'D', '8', 1.15, 0.5, 0],
  [8480800, 'Quinn', 'Hughes', 'VAN', 'D', '43', 1.0, 0.3, 0],
  [8478420, 'Mikko', 'Rantanen', 'DAL', 'R', '96', 1.15, 0.3, 0],
  [8478550, 'Artemi', 'Panarin', 'NYR', 'L', '10', 1.1, 0.1, 0],
  [8478403, 'Jack', 'Eichel', 'VGK', 'C', '9', 1.15, 0.4, 0],
  [8478864, 'Kirill', 'Kaprizov', 'MIN', 'L', '97', 1.2, 0.3, 0],
  [8471675, 'Sidney', 'Crosby', 'PIT', 'C', '87', 1.05, 0.0, 0],
  [8471214, 'Alex', 'Ovechkin', 'WSH', 'L', '8', 0.9, 0.1, 0],
  [8479314, 'Matthew', 'Tkachuk', 'FLA', 'L', '19', 1.0, 0.3, 0.03],
  [8484801, 'Macklin', 'Celebrini', 'SJS', 'C', '71', 1.0, -0.2, 0],
  [8484144, 'Connor', 'Bedard', 'CHI', 'C', '98', 0.95, -0.3, 0],
  [8475167, 'Victor', 'Hedman', 'TBL', 'D', '77', 0.8, 0.3, 0],
  [8478460, 'Zach', 'Werenski', 'CBJ', 'D', '8', 0.95, 0.1, 0],
  [8481559, 'Jack', 'Hughes', 'NJD', 'C', '86', 1.05, 0.1, 0],
  [8478010, 'Brayden', 'Point', 'TBL', 'C', '21', 0.95, 0.2, 0],
  [8477933, 'Sam', 'Reinhart', 'FLA', 'C', '13', 1.0, 0.4, 0],
  [8478398, 'Kyle', 'Connor', 'WPG', 'L', '81', 1.05, 0.3, 0],
  [8474600, 'Roman', 'Josi', 'NSH', 'D', '59', 0.8, -0.1, 0],
  [8480801, 'Brady', 'Tkachuk', 'OTT', 'L', '7', 0.9, 0.0, 0.09],
  [8476880, 'Tom', 'Wilson', 'WSH', 'R', '43', 0.65, 0.2, 0.12],
  [8471817, 'Ryan', 'Reaves', 'SJS', 'R', '75', 0.15, -0.3, 0.18],
  [8475235, 'Nicolas', 'Deslauriers', 'PHI', 'L', '44', 0.15, -0.2, 0.22],
  [8482460, 'Matt', 'Rempe', 'NYR', 'C', '73', 0.2, 0.0, 0.25],
  [8478434, 'Keegan', 'Kolesar', 'VGK', 'R', '55', 0.3, 0.1, 0.12],
  [8477813, 'Mathieu', 'Olivier', 'CBJ', 'R', '24', 0.35, 0.0, 0.16],
  [8477070, 'Liam', "O'Brien", 'UTA', 'C', '38', 0.12, -0.1, 0.2],
  [8475220, 'Marcus', 'Foligno', 'MIN', 'L', '17', 0.4, 0.2, 0.08],
  [8477903, 'Garnet', 'Hathaway', 'PHI', 'R', '19', 0.3, 0.0, 0.1],
  [8476885, 'Jacob', 'Trouba', 'ANA', 'D', '65', 0.35, 0.1, 0.06],
  [8477073, 'Kurtis', 'MacDermid', 'NJD', 'D', '23', 0.1, 0.0, 0.15],
  [8482109, 'Lane', 'Hutson', 'MTL', 'D', '48', 0.85, 0.0, 0],
  [8481540, 'Cole', 'Caufield', 'MTL', 'R', '22', 0.85, 0.0, 0],
  [8479323, 'Adam', 'Fox', 'NYR', 'D', '23', 0.85, 0.2, 0],
  [8478483, 'Mitch', 'Marner', 'VGK', 'R', '93', 1.1, 0.3, 0],
];

// Goalies: [id, first, last, team, num, save percentage (thousandths), share of starts]
const GOALIES = [
  [8476945, 'Connor', 'Hellebuyck', 'WPG', '37', 922, 0.75],
  [8478048, 'Igor', 'Shesterkin', 'NYR', '31', 915, 0.75],
  [8476883, 'Andrei', 'Vasilevskiy', 'TBL', '88', 914, 0.75],
  [8478009, 'Ilya', 'Sorokin', 'NYI', '30', 913, 0.7],
  [8479979, 'Jake', 'Oettinger', 'DAL', '29', 910, 0.7],
  [8475683, 'Sergei', 'Bobrovsky', 'FLA', '72', 905, 0.65],
  [8480280, 'Jeremy', 'Swayman', 'BOS', '1', 908, 0.7],
  [8476932, 'Anthony', 'Stolarz', 'TOR', '41', 912, 0.55],
  [8479496, 'Logan', 'Thompson', 'WSH', '48', 911, 0.6],
  [8474593, 'Jacob', 'Markstrom', 'NJD', '25', 903, 0.6],
  [8478499, 'Adin', 'Hill', 'VGK', '33', 902, 0.6],
  [8479406, 'Filip', 'Gustavsson', 'MIN', '32', 907, 0.6],
  [8477967, 'Thatcher', 'Demko', 'VAN', '35', 909, 0.55],
  [8475809, 'Scott', 'Wedgewood', 'COL', '41', 906, 0.6],
  [8476999, 'Linus', 'Ullmark', 'OTT', '35', 904, 0.6],
  [8479973, 'Stuart', 'Skinner', 'EDM', '74', 896, 0.65],
];

const COLLEAGUES = [
  ['Maya R.', 'TOR'], ['Dev P.', 'EDM'], ['Sam O.', 'MTL'], ['Priya K.', 'VAN'], ['Jordan T.', 'BOS'],
  ['Alex M.', 'NYR'], ['Chris L.', 'COL'], ['Nina S.', 'OTT'], ['Omar H.', 'CGY'], ['Leah B.', 'WPG'],
];

function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function makeDemo() {
  const rand = rng(20261026);
  const now = DEMO_NOW;
  const poisson = mean => { let k = 0, p = Math.exp(-mean), s = p; const u = rand(); while (u > s && k < 8) { k++; p *= mean / k; s += p; } return k; };
  const img = (team, id) => `https://assets.nhle.com/mugs/nhl/20262027/${team}/${id}.png`;

  const players = {};
  const sim = {};
  for (const [id, first, last, team, pos, num, ppg, pmg, fpg] of SKATERS) {
    players[id] = { id, first, last, name: `${first} ${last}`, team, pos, num, img: img(team, id), gp: 0, avg: [ppg, pmg, 0, 0], pre: false };
    sim[id] = { ppg, pmg, fpg };
  }
  for (const [id, first, last, team, num, sv, share] of GOALIES) {
    players[id] = { id, first, last, name: `${first} ${last}`, team, pos: 'G', num, img: img(team, id), gp: 0, avg: [0, 0, sv, 0], pre: false };
    sim[id] = { sv, share };
  }

  const strength = Object.fromEntries(Object.keys(TEAMS).map(t => [t, 0.35 + rand() * 0.3]));
  const teams = Object.fromEntries(Object.keys(TEAMS).map(t => [t, { w: 0, l: 0 }]));
  const weeks = buildWeeks().map(w => {
    const gamesByTeam = {};
    for (const t of Object.keys(TEAMS)) gamesByTeam[t] = (w.mult === 2 ? 6 : 3) + Math.floor(rand() * 2);
    const ended = now > Date.parse(w.end + 'T12:00:00Z') + 86400e3;
    return { ...w, lockAt: defaultLockAt(w), final: ended, gamesByTeam, leftByTeam: {} };
  });

  const L = LEAGUE.line;
  const totals = {};
  const season = {};
  for (const w of weeks) {
    if (now < Date.parse(w.lockAt)) continue;
    const span = Date.parse(w.end + 'T23:59:00Z') - Date.parse(w.lockAt);
    const frac = w.final ? 1 : Math.max(0, Math.min(1, (now - Date.parse(w.lockAt)) / span));
    const p = {}, t = {};
    for (const tri of Object.keys(TEAMS)) {
      const played = Math.round(w.gamesByTeam[tri] * frac);
      if (!w.final) w.leftByTeam[tri] = w.gamesByTeam[tri] - played;
      let wins = 0;
      for (let g = 0; g < played; g++) if (rand() < strength[tri]) wins++;
      t[tri] = [played, wins];
      teams[tri].w += wins; teams[tri].l += played - wins;
      for (const pl of Object.values(players).filter(x => x.team === tri)) {
        const s = sim[pl.id], acc = season[pl.id] ||= { gp: 0, pts: 0, pm: 0, sv: 0, sa: 0, fights: 0 };
        for (let g = 0; g < played; g++) {
          if (pl.pos === 'G') {
            if (rand() > s.share) continue;
            const sa = 22 + Math.floor(rand() * 14);
            const sv = Math.min(sa, Math.round(sa * (s.sv / 1000 + (rand() - 0.5) * 0.08)));
            const gpct = Math.round(1000 * sv / sa);
            const x = p[pl.id] ||= [0, 0, 0, 0, 0, 0, gpct, 0, 0, gpct, tri, 0, 0, 0, 0];
            x[0]++; x[3] += sv; x[L.shots] += sa;
            x[6] = Math.max(x[6], gpct); x[9] = Math.min(x[9], gpct);
            acc.gp++; acc.sv += sv; acc.sa += sa;
            continue;
          }
          if (rand() < 0.04) continue; // a night off
          const pts = poisson(s.ppg), goals = Math.min(pts, poisson(s.ppg * 0.4));
          const pm = Math.round(s.pmg + (rand() - 0.5) * 3.2);
          const fights = rand() < s.fpg ? 1 : 0;
          const x = p[pl.id] ||= [0, 0, 0, 0, pts, pm, 0, pts, pm, 0, tri, 0, 0, 0, 0];
          x[0]++; x[1] += pts; x[2] += pm;
          x[4] = Math.max(x[4], pts); x[5] = Math.max(x[5], pm); x[7] = Math.min(x[7], pts); x[8] = Math.min(x[8], pm);
          x[L.fights] += fights; x[L.goals] += goals;
          if (goals && pts > goals && fights) x[L.gordie]++;
          acc.gp++; acc.pts += pts; acc.pm += pm; acc.fights += fights;
        }
      }
    }
    totals[w.week] = { final: w.final, p, t };
  }
  for (const [id, a] of Object.entries(season)) {
    const pl = players[id];
    pl.gp = a.gp;
    if (pl.pos === 'G') pl.avg = [0, 0, a.sa ? Math.round(1000 * a.sv / a.sa) : pl.avg[2], 0];
    else pl.avg = [a.gp ? Math.round(a.pts / a.gp * 100) / 100 : pl.avg[0], a.gp ? Math.round(a.pm / a.gp * 100) / 100 : pl.avg[1], 0, a.fights];
  }

  const meId = 'demo-you';
  const profiles = [{ id: meId, display_name: 'You', fav_team: 'TOR', rival_id: 'demo-2', created_at: '2026-10-20T12:00:00Z' }]
    .concat(COLLEAGUES.map(([name, team], i) => ({ id: `demo-${i + 1}`, display_name: name, fav_team: team, rival_id: i % 3 === 0 ? meId : `demo-${((i + 3) % COLLEAGUES.length) + 1}`, created_at: '2026-10-21T12:00:00Z' })));

  // Simulated picks: strong options, a few contrarians, the odd backup, and a fighter most weeks.
  const picks = [];
  const open = weeks.find(x => now < Date.parse(x.lockAt));
  const skaters = Object.values(players).filter(x => x.pos !== 'G');
  const goalies = Object.values(players).filter(x => x.pos === 'G');
  for (const pr of profiles) {
    const used = { PTS: new Map(), PM: new Map(), SV: new Map(), WIN: new Map() };
    for (const w of weeks) {
      const locked = now >= Date.parse(w.lockAt);
      if (!locked && !(w === open && pr.id !== meId && rand() < 0.5)) continue;
      const week = new Set();
      const add = (slot, id, alt = null) => {
        picks.push({ user_id: pr.id, week: w.week, slot, player_id: id, alt_id: alt, double_down: false, auto: false });
        week.add(id); if (alt) week.add(alt);
        if (locked) used[slot]?.set(id, (used[slot].get(id) || 0) + 1);
      };
      const limit = s => LEAGUE.slotInfo[s].burns || 1;
      const choose = (slot, pool, score) => pool
        .filter(x => !week.has(x.id) && (used[slot].get(x.id) || 0) < limit(slot))
        .map(x => ({ x, s: score(x) * (0.7 + rand() * 0.6) })).sort((a, b) => b.s - a.s)[Math.floor(rand() * rand() * 5)]?.x;
      const pts = choose('PTS', skaters, x => x.avg[0] * w.gamesByTeam[x.team]);
      if (pts) add('PTS', pts.id);
      const pm = choose('PM', skaters, x => (x.avg[1] + 1) * w.gamesByTeam[x.team]);
      if (pm) add('PM', pm.id);
      const sv = choose('SV', goalies, x => x.avg[2]);
      const svAlt = rand() < 0.4 ? choose('SV', goalies.filter(x => x.id !== sv?.id), x => x.avg[2]) : null;
      if (sv) add('SV', sv.id, svAlt?.id ?? null);
      const tm = Object.entries(TEAMS).filter(([, x]) => !used.WIN.has(x.id)).map(([tri, x]) => ({ id: x.id, s: strength[tri] * w.gamesByTeam[tri] * (0.7 + rand() * 0.6) })).sort((a, b) => b.s - a.s)[Math.floor(rand() * 3)];
      if (tm) add('WIN', tm.id);
      if (rand() < 0.7) {
        const f = skaters.filter(x => sim[x.id].fpg > 0.05 && !week.has(x.id)).sort(() => rand() - 0.5)[0];
        if (f) add('FIGHT', f.id);
      }
    }
  }
  return { version: 1, now, players, teams, weeks, totals, profiles, picks, unburns: [], plays: [], decrees: [], votes: [], meId, cardsFrom: Infinity, schedule: [], days: {} };
}
