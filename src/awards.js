// Season awards for the Trophies tab. Every award has a live leader during the
// season and is decided (with a certificate) once its weeks are final.
// Built from final weeks only, so leaders don't flicker during a live week.

import { LEAGUE } from './config.js';
import { fmt, headToHead, unit } from './league.js';

const SLOTS = LEAGUE.slots;
const INFO = LEAGUE.slotInfo;

function personStats(L) {
  const finals = L.weeks.filter(w => w.status === 'final');
  const stats = {};
  for (const u of Object.values(L.users)) {
    stats[u.id] = {
      id: u.id, weeks: 0, scores: [], raw: Object.fromEntries(SLOTS.map(s => [s, 0])), counted: Object.fromEntries(SLOTS.map(s => [s, 0])),
      weeksWon: 0, topPicks: 0, bars: 0, fumbles: 0, saves: 0, autos: 0, iceCold: 0,
      ownSum: 0, ownN: 0, ddPoints: null, bestPick: null,
    };
  }
  for (const w of finals) {
    const ids = w.entrants;
    if (!ids.length) continue;
    const scores = ids.map(id => w.results[id].score);
    const hi = Math.max(...scores), lo = Math.min(...scores);
    const topValue = Object.fromEntries(SLOTS.map(s => [s, Math.max(...ids.map(id => w.results[id].slots[s].value))]));
    for (const id of ids) {
      const r = w.results[id], p = stats[id];
      if (!p) continue;
      p.weeks++;
      p.scores.push({ week: w.week, score: r.score });
      if (r.score === hi && ids.length > 1) p.weeksWon++;
      if (r.score === lo && ids.length > 1) p.iceCold++;
      p.bars += r.cleared;
      for (const s of SLOTS) {
        const x = r.slots[s];
        if (x.missing) continue;
        p.raw[s] += x.value;
        if (x.scorer != null) p.counted[s]++;
        if (x.value > 0 && x.value === topValue[s] && ids.length > 1) p.topPicks++;
        if (x.fumble) p.fumbles++;
        if (x.usedAlt) p.saves++;
        if (x.auto) p.autos++;
        if (x.dd && (p.ddPoints == null || x.rank > p.ddPoints.rank)) p.ddPoints = { rank: x.rank, slot: s, week: w.week, pid: x.scorer, value: x.value };
        if (ids.length > 1 && x.scorer != null) { p.ownSum += (x.owned - 1) / (ids.length - 1); p.ownN++; }
        if (s !== 'WIN' && !INFO[s].signed && !INFO[s].pct && x.scorer != null) {
          const ratio = x.value / LEAGUE.bars[s];
          if (!p.bestPick || ratio > p.bestPick.ratio) p.bestPick = { ratio, slot: s, week: w.week, pid: x.scorer, value: x.value };
        }
      }
    }
  }
  return { stats, finals };
}

const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };

// Ranks people by a metric. `value` returns a number (or null to skip), higher is better unless `low`.
function rank(L, stats, value, { low = false, min = -Infinity } = {}) {
  return Object.values(stats)
    .map(p => ({ id: p.id, v: value(p) }))
    .filter(x => x.v != null && Number.isFinite(x.v) && (low ? true : x.v > min))
    .sort((a, b) => (low ? a.v - b.v : b.v - a.v) || L.users[b.id].counted - L.users[a.id].counted);
}

export function seasonAwards(L, pname = id => `#${id}`) {
  const { stats, finals } = personStats(L);
  const seasonOver = L.weeks.length > 0 && L.weeks.every(w => w.status === 'final');
  const regulars = p => p.weeks >= Math.max(3, Math.ceil(finals.length / 2));
  const award = (def, ranked, fmtValue) => ({
    ...def,
    ranked,
    leader: ranked[0] || null,
    leaderText: ranked[0] ? fmtValue(ranked[0]) : null,
    format: fmtValue,
    decided: def.decided ?? (seasonOver && !!ranked[0]),
  });

  // ---- The big one ----
  const champRanked = L.standings.filter(u => Object.keys(u.weekly).length).map(u => ({ id: u.id, v: u.counted }));
  const champion = award(
    { key: 'champion', icon: '🏆', title: 'Season Champion', kind: 'champion', how: `Most points across the season after dropped weeks. Decided after Week ${L.weeks.length}.` },
    champRanked, x => `${fmt(x.v)} points${L.dropCount ? ` after ${L.dropCount} dropped week${L.dropCount > 1 ? 's' : ''}` : ''}`,
  );

  // ---- Title belts ----
  const sv = L.survivor;
  const belt = {
    key: 'belt', icon: '🥊', title: 'Survivor Belt', kind: 'champion',
    how: 'Last person with a life left.',
    ranked: sv.order.map(u => ({ id: u.id, v: u.lives })),
    leader: sv.winner ? { id: sv.winner.id, v: sv.winner.lives } : null,
    leaderText: sv.winner ? (sv.winner.lives > 0 ? `Last one standing with ${sv.winner.lives} ${sv.winner.lives === 1 ? 'life' : 'lives'} left` : `Outlasted the field (out in week ${sv.winner.eliminatedWeek})`) : null,
    status: sv.winner ? null : sv.order.length ? `${sv.alive} of ${sv.order.length} still alive` : 'Starts at the Week 1 lock',
    format: x => `${x.v} ${x.v === 1 ? 'life' : 'lives'} left`,
    decided: !!sv.winner,
  };
  const catTitles = {
    PTS: ['Scoring Champion', 'Most points from Bucket picks across the season.'],
    REB: ['Rebounding Champion', 'Most rebounds from Glass picks across the season.'],
    AST: ['Assists Champion', 'Most assists from Dime picks across the season.'],
    WIN: ['Dub Champion', 'Most team wins from Dub picks across the season.'],
    ...(LEAGUE.sport === 'nhl' ? {
      PTS: ['Lamplighter Champion', 'Most points from Lamplighter picks across the season.'],
      PM: ['Shutdown Champion', 'Best plus-minus from Shutdown picks across the season.'],
      SV: ['Brick Wall Champion', 'Best average save percentage from Wall picks across the season (at least 5 weeks).'],
    } : {}),
  };
  // Save percentage doesn't add up over weeks: rank by the average instead.
  const catValue = s => INFO[s].pct ? p => p.counted[s] >= 5 ? Math.round(p.raw[s] / p.counted[s]) : null : p => p.raw[s];
  // The standings from raw picks alone, as if the card game never happened.
  const pureRanked = L.rawStandings.filter(u => Object.keys(u.weekly).length).map(u => ({ id: u.id, v: u.raw.counted }));
  const pure = award(
    { key: 'pure', icon: '🕊️', title: `${LEAGUE.words.pure} Champion`, kind: 'champion', how: `Top of the standings from your picks alone, with no ${LEAGUE.sport === 'nhl' ? 'cards' : 'Joker cards'} at all.` },
    pureRanked, x => `${fmt(x.v)} points from raw picks`,
  );
  const titles = [pure, belt, ...SLOTS.map(s => award(
    { key: `cat-${s}`, icon: INFO[s].emoji, title: catTitles[s][0], kind: 'champion', how: catTitles[s][1] },
    rank(L, stats, catValue(s), { min: INFO[s].signed ? -Infinity : 0 }), x => `${INFO[s].pct ? `${unit(s, x.v)} on average` : unit(s, x.v)} from ${INFO[s].name} picks`,
  ))];

  // ---- Monthly crowns ----
  const monthly = L.months.map(m => ({
    key: `month-${m.key}`, icon: '👑', title: `Monthly Crown · ${m.label}`, kind: 'champion',
    how: `Most points in weeks ${m.weeks[0]}–${m.weeks[m.weeks.length - 1]}.`,
    ranked: m.ranked.map(u => ({ id: u.id, v: u.monthly[m.key] })),
    leader: m.ranked[0] ? { id: m.ranked[0].id, v: m.ranked[0].monthly[m.key] } : null,
    leaderText: m.ranked[0] ? `${fmt(m.ranked[0].monthly[m.key])} points across weeks ${m.weeks[0]}–${m.weeks[m.weeks.length - 1]}` : null,
    format: x => `${fmt(x.v)} points`,
    decided: !!m.winner,
  }));

  // ---- Hall of Fame ----
  const fame = [
    award({ key: 'weeks-won', icon: '📅', title: 'Week Winner', kind: 'award', how: 'Most weeks with the top score in the league.' },
      rank(L, stats, p => p.weeksWon, { min: 0 }), x => `Topped the league in ${x.v} week${x.v === 1 ? '' : 's'}`),
    award({ key: 'top-picks', icon: '🎯', title: 'Category Killer', kind: 'award', how: 'Most times holding the single best pick in a category for the week.' },
      rank(L, stats, p => p.topPicks, { min: 0 }), x => `Best pick in a category ${x.v} time${x.v === 1 ? '' : 's'}`),
    award({ key: 'heater', icon: '🔥', title: 'Heater of the Year', kind: 'award', how: 'The single best player pick of the season, measured against the survivor bar.' },
      rank(L, stats, p => p.bestPick?.ratio ?? null, { min: 0 }), x => { const b = stats[x.id].bestPick; return `${pname(b.pid)}: ${unit(b.slot, b.value)} in week ${b.week} (${b.ratio.toFixed(1)}× the bar)`; }),
    award({ key: 'iron', icon: '❤️', title: 'Iron Man', kind: 'award', how: 'Most survivor bars cleared across the season.' },
      rank(L, stats, p => p.bars, { min: 0 }), x => `${x.v} bars cleared`),
    award({ key: 'galaxy', icon: '🧠', title: 'Galaxy Brain', kind: 'award', how: 'Most contrarian: the lowest overlap with everyone else\'s picks (plays at least half the weeks).' },
      rank(L, stats, p => regulars(p) && p.ownN ? p.ownSum / p.ownN : null, { low: true }), x => `Only ${Math.round(x.v * 100)}% overlap with the league`),
    award({ key: 'steady', icon: '📏', title: 'Mr. Consistent', kind: 'award', how: 'The steadiest weekly scores (smallest swings, plays at least half the weeks).' },
      rank(L, stats, p => regulars(p) && p.scores.length >= 3 ? sd(p.scores.map(s => s.score)) : null, { low: true }), x => `Weekly scores within ±${fmt(Math.round(x.v * 10) / 10)} points`),
    award({ key: 'improved', icon: '📈', title: 'Most Improved', kind: 'award', how: 'Biggest jump in average weekly score from the first half of the season to the second.' },
      rank(L, stats, p => {
        if (finals.length < 6 || !regulars(p)) return null;
        const mid = finals[Math.floor(finals.length / 2)].week;
        const a = p.scores.filter(s => s.week < mid).map(s => s.score), b = p.scores.filter(s => s.week >= mid).map(s => s.score);
        return a.length && b.length ? mean(b) - mean(a) : null;
      }, { min: 0 }), x => `+${fmt(Math.round(x.v * 10) / 10)} points a week in the second half`),
    award({ key: 'insurance', icon: '🛟', title: 'Insurance Agent', kind: 'award', how: 'Most weeks saved by a backup.' },
      rank(L, stats, p => p.saves, { min: 0 }), x => `${x.v} backup save${x.v === 1 ? '' : 's'}`),
    award({ key: 'joker', icon: '🃏', title: 'Joker Smoker', kind: 'award', how: 'The biggest Double Down of the season, in rank points.' },
      rank(L, stats, p => p.ddPoints?.rank ?? null, { min: 0 }), x => { const d = stats[x.id].ddPoints; return `${fmt(d.rank)} points from doubling ${pname(d.pid)} (${unit(d.slot, d.value)}) in week ${d.week}`; }),
    award({ key: 'slayer', icon: '🥊', title: 'Rival Slayer', kind: 'award', how: 'Best record against the rival you chose (at least 3 weeks head to head).' },
      rank(L, stats, p => {
        const u = L.users[p.id];
        if (!u.rival || !L.users[u.rival]) return null;
        const h = headToHead(L, u.id, u.rival);
        const n = h.w + h.l + h.t;
        return n >= 3 ? (h.w + h.t / 2) / n + h.w / 1000 : null;
      }, { min: 0 }), x => { const u = L.users[x.id]; const h = headToHead(L, u.id, u.rival); return `${h.w}–${h.l}${h.t ? `–${h.t}` : ''} against ${L.users[u.rival].name}`; }),
  ];

  // ---- Hall of Shame (all in good fun) ----
  const shame = [
    award({ key: 'fumble', icon: '🪦', title: 'Fumble King', kind: 'shame', how: 'Most picks who never took the floor all week (backup included).' },
      rank(L, stats, p => p.fumbles, { min: 0 }), x => `${x.v} pick${x.v === 1 ? '' : 's'} that never played`),
    award({ key: 'asleep', icon: '😴', title: 'Asleep at the Wheel', kind: 'shame', how: 'Most slots filled by Autopilot.' },
      rank(L, stats, p => p.autos, { min: 0 }), x => `${x.v} slot${x.v === 1 ? '' : 's'} left to Autopilot`),
    award({ key: 'ice', icon: '🧊', title: 'Ice Cold', kind: 'shame', how: 'Most weeks with the lowest score in the league.' },
      rank(L, stats, p => p.iceCold, { min: 0 }), x => `Bottom of the league in ${x.v} week${x.v === 1 ? '' : 's'}`),
    award({ key: 'chalk', icon: '🐐', title: 'Chalk Merchant', kind: 'shame', how: 'Least original: the highest overlap with everyone else\'s picks (plays at least half the weeks).' },
      rank(L, stats, p => regulars(p) && p.ownN ? p.ownSum / p.ownN : null, { min: 0 }), x => `${Math.round(x.v * 100)}% overlap with the league`),
  ];

  return { champion, titles, monthly, fame, shame, seasonOver, finals: finals.length };
}
