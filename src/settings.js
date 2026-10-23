// League settings the commissioner can change from the Commissioner tab.
//
// Two kinds, stored in the league_config table (see supabase/upgrade-settings.sql):
//  - 'rules': a list of changes, each taking effect from a week ({ from_week, bars, barsToSurvive, cards }).
//    A change never reaches back into weeks before it, so finished weeks keep the rules they were played under.
//  - 'meta': season-wide values (lives, drops, decrees, the commissioner's name, an announcement).
// The engine reads LEAGUE, so these are applied by updating LEAGUE in place before each week is scored.

import { LEAGUE, slotValue } from './config.js';

const clone = x => JSON.parse(JSON.stringify(x));

// What config.js says, before any commissioner changes.
const BASE = clone({
  bars: LEAGUE.bars, barsToSurvive: LEAGUE.barsToSurvive,
  cards: { handLimit: LEAGUE.cards.handLimit, attackCap: LEAGUE.cards.attackCap, duelStake: LEAGUE.cards.duelStake, heist: LEAGUE.cards.heist },
  lives: LEAGUE.lives, drops: LEAGUE.drops,
  decree: { perSeason: LEAGUE.decree.perSeason, bounty: LEAGUE.decree.bounty },
  commissioner: LEAGUE.commissioner,
});
export const DEFAULTS = clone(BASE);

// Allowed ranges, used by the form and to ignore bad stored values.
export const LIMITS = {
  ...Object.fromEntries(LEAGUE.slots.map(s => [`bars.${s}`, LEAGUE.slotInfo[s].barRange])),
  barsToSurvive: [0, LEAGUE.slots.length],
  'cards.handLimit': [1, 10], 'cards.attackCap': [0, 10], 'cards.duelStake': [0, 50], 'cards.heist': [0, 50],
  lives: [1, 10], 'drops.max': [0, 10], 'drops.every': [1, 23],
  'decree.perSeason': [0, 23], 'decree.bounty': [0, 50],
};

const get = (o, path) => path.split('.').reduce((a, k) => a?.[k], o);
function set(o, path, v) {
  const ks = path.split('.');
  let t = o;
  for (const k of ks.slice(0, -1)) t = t[k] ||= {};
  t[ks.at(-1)] = v;
}

// Copies every allowed number from patch onto target.
function mergeNumbers(target, patch, paths) {
  for (const p of paths) {
    const v = get(patch, p);
    if (v == null || v === '') continue;
    const n = Number(v);
    const [lo, hi] = LIMITS[p];
    if (Number.isFinite(n) && n >= lo && n <= hi) set(target, p, n);
  }
  return target;
}

export const WEEK_PATHS = [...LEAGUE.slots.map(s => `bars.${s}`), 'barsToSurvive', 'cards.handLimit', 'cards.attackCap', 'cards.duelStake', 'cards.heist'];
export const SEASON_PATHS = ['lives', 'drops.max', 'drops.every', 'decree.perSeason', 'decree.bounty'];

// The per-week rules in force for a week: config.js, then every change from that week or earlier, in order.
export function weekRules(rules = [], week = Infinity) {
  const r = { bars: clone(BASE.bars), barsToSurvive: BASE.barsToSurvive, cards: clone(BASE.cards) };
  for (const ch of [...rules].filter(x => Number(x.from_week) <= week).sort((a, b) => a.from_week - b.from_week)) mergeNumbers(r, ch, WEEK_PATHS);
  return r;
}

export function seasonRules(meta = {}) {
  const r = mergeNumbers({ lives: BASE.lives, drops: clone(BASE.drops), decree: clone(BASE.decree) }, meta, SEASON_PATHS);
  r.commissioner = typeof meta.commissioner === 'string' && meta.commissioner.trim() ? meta.commissioner.trim().slice(0, 40) : BASE.commissioner;
  return r;
}

export function applyWeekRules(r) {
  Object.assign(LEAGUE.bars, r.bars);
  LEAGUE.barsToSurvive = r.barsToSurvive;
  Object.assign(LEAGUE.cards, r.cards);
}

export function applySeasonRules(r) {
  LEAGUE.lives = r.lives;
  Object.assign(LEAGUE.drops, r.drops);
  Object.assign(LEAGUE.decree, r.decree);
  LEAGUE.commissioner = r.commissioner;
}

// What a rule change changes, in words, for the Rules tab and the Commissioner tab.
export function describeChange(ch, slotInfo = LEAGUE.slotInfo) {
  const out = [];
  for (const s of LEAGUE.slots) if (ch.bars?.[s] != null) out.push(`${slotInfo[s].name} bar ${slotValue(s, ch.bars[s])} ${slotInfo[s].short}`);
  if (ch.barsToSurvive != null) out.push(`clear ${ch.barsToSurvive} of ${LEAGUE.slots.length} bars`);
  const c = ch.cards || {};
  if (c.handLimit != null) out.push(`hand limit ${c.handLimit}`);
  if (c.attackCap != null) out.push(`${c.attackCap} attacks a week max`);
  if (c.duelStake != null) out.push(`duel stake ${c.duelStake}`);
  if (c.heist != null) out.push(`heist ${c.heist} points`);
  return out;
}
