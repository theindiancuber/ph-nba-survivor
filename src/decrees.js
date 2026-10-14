// Commissioner's Decree: a one-week rule twist, announced ahead of time.
// The commissioner either imposes one or puts two or three to a league vote.
// A decree is stored as a code: 'mercy', or 'spotlight:PTS' for one that names a slot.

import { LEAGUE } from './config.js';

const SLOTS = LEAGUE.slots;
const slotName = s => LEAGUE.slotInfo[s]?.name || s;

export const DECREES = {
  spotlight: { name: 'Prime Time', icon: '📺', slot: true, text: s => `${slotName(s)} rank points count double for everyone.` },
  opposite: { name: 'Opposite Day', icon: '🙃', slot: true, text: s => `In ${slotName(s)}, the lowest total wins the rank points. Survivor bars work as normal.` },
  bounty: { name: 'Bounty', icon: '💰', text: () => `The week's top scorer gets +${LEAGUE.decree.bounty} points.` },
  mercy: { name: 'Mercy Rule', icon: '🕊️', text: () => 'Nobody loses a life this week.' },
  sudden_death: { name: 'Sudden Death', icon: '💀', text: () => `Clear all ${SLOTS.length} bars or lose a life.` },
  amnesty: { name: 'Amnesty', icon: '🗝️', text: () => "This week's picks don't burn." },
  ceasefire: { name: 'Ceasefire', icon: '🏳️', text: () => 'No cards can be played this week. Gifts still go through and armed traps stay armed.' },
  free_for_all: { name: 'Free-for-all', icon: '🃏', text: () => 'Everyone can play 2 cards this week.' },
  pack_day: { name: 'Pack Day', icon: '📦', text: () => 'Everyone gets a bonus Decree Pack this week.' },
};

// Every code the database accepts, in display order.
export const DECREE_CODES = Object.entries(DECREES).flatMap(([k, d]) => d.slot ? SLOTS.map(s => `${k}:${s}`) : [k]);

export function parseDecree(code) {
  if (!code) return null;
  const [kind, slot = null] = String(code).split(':');
  const d = DECREES[kind];
  if (!d || (d.slot ? !SLOTS.includes(slot) : slot)) return null;
  return { code, kind, slot, name: d.name, icon: d.icon, text: d.text(slot), title: d.slot ? `${d.name}: ${slotName(slot)}` : d.name };
}

// Votes close (and a decree can no longer be changed) this long before the week locks.
export const closesAt = lockAt => Date.parse(lockAt) - LEAGUE.decree.noticeHours * 3600e3;

// rows: [{ week, options }], tallies: [{ week, choice, votes }], locks: { week: ISO }.
// Returns { week: { week, options, votes, vote, closesAt, closed, code } }. code is the decree
// in force: the only option, or the vote winner once voting closes (ties go to the earlier option).
export function resolveDecrees(rows = [], tallies = [], locks = {}, now = Date.now()) {
  const out = {};
  for (const r of rows) {
    if (!locks[r.week] || !Array.isArray(r.options) || !r.options.length) continue;
    const votes = r.options.map((_, i) => tallies.filter(t => t.week === r.week && t.choice === i).reduce((a, t) => a + Number(t.votes || 0), 0));
    const close = closesAt(locks[r.week]);
    const vote = r.options.length > 1;
    const closed = now >= close;
    let code = null;
    if (!vote) code = r.options[0];
    else if (closed) code = r.options[votes.indexOf(Math.max(...votes))];
    out[r.week] = { week: r.week, options: r.options, votes, vote, closesAt: close, closed, code, decree: parseDecree(code) };
  }
  return out;
}

// What the engine needs: { week: code } for every decree in force.
export const decreeCodes = resolved => Object.fromEntries(Object.values(resolved).filter(d => d.code).map(d => [d.week, d.code]));
