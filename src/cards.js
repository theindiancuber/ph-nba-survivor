// Joker cards: the deck, packs and hands. Pure data and functions, shared by the
// app, the data script and the tests.
//
// Packs are dealt from a seeded shuffle, so every browser deals the same cards
// and nobody can re-roll. In the real league the seed comes from a secret in the
// database (pack_seeds): you get your own seeds up to the open week and everyone
// else's once a week locks, so nobody can work out a colleague's hand early. The
// database only stores which card you kept from each pack and what you played.
// Hands are rebuilt from that history every time the league is computed.

import { LEAGUE } from './config.js';
import { DIVISIONS, isTeamId } from './teams.js';

const SLOTS = LEAGUE.slots;

export const RARITY = {
  common: { label: 'Common', stars: 1, color: '#c9d3e6' },
  rare: { label: 'Rare', stars: 2, color: '#4d9bff' },
  epic: { label: 'Epic', stars: 3, color: '#b45cff' },
  legendary: { label: 'Legendary', stars: 4, color: '#f2c14e' },
};

export const TYPES = {
  attack: { label: 'Attack', color: '#ef2b4d' },
  prank: { label: 'Prank', color: '#ff5fa2' },
  trap: { label: 'Trap', color: '#1fc8b4' },
  boost: { label: 'Boost', color: '#3d72e0' },
  hindsight: { label: 'Hindsight', color: '#2fd17f' },
  chaos: { label: 'Chaos', color: '#ff8a2a' },
  duel: { label: 'Duel', color: '#d14bff' },
};

// needs: what the play form asks for. comeback: only the bottom half of the standings can pull it.
export const CARDS = {
  jinx: {
    name: 'Jinx', icon: '🪄', rarity: 'common', type: 'attack', needs: ['target', 'player'],
    text: "Name a colleague and a player (or a team). If it's one of their picks this week, that slot scores half.",
  },
  load: {
    name: 'Load Management', icon: '💤', rarity: 'rare', type: 'attack', needs: ['target', 'slot'],
    text: "Pick a colleague and a slot. Their pick's best game of the week is wiped (in Dub, one win comes off).",
  },
  heist: {
    name: 'Heist', icon: '💰', rarity: 'epic', type: 'attack', needs: ['target'], comeback: true,
    text: `Steal ${LEAGUE.cards.heist} points from anyone above you in the standings.`,
  },
  blue_shell: {
    name: 'Blue Shell', icon: '🐢', rarity: 'epic', type: 'attack', needs: [], comeback: true,
    text: 'Homes in on whoever leads the standings at the lock. Their best slot this week scores half.',
  },
  burn_notice: {
    name: 'Burn Notice', icon: '🔥', rarity: 'legendary', type: 'attack', needs: ['target', 'slot', 'player'],
    text: 'Burn one player (or, in Dub, one team) for a colleague in one category, for the rest of the season, starting next week.',
  },
  clown: {
    name: 'Clown Nose', icon: '🤡', rarity: 'common', type: 'prank', needs: ['target'],
    text: "Put a 🤡 on a colleague's name for the week. No effect on points. Pure disrespect.",
  },
  nickname: {
    name: 'Nickname', icon: '🏷️', rarity: 'common', type: 'prank', needs: ['target', 'nickname'],
    text: 'Give a colleague a nickname from the official list. It sits next to their name all week.',
  },
  charge: {
    name: 'Charge Taken', icon: '🛡️', rarity: 'common', type: 'trap', needs: [],
    text: "Set it face-down. The next attack or prank on you is blocked and the attacker's card is wasted.",
  },
  reverse: {
    name: 'Uno Reverse', icon: '🔄', rarity: 'rare', type: 'trap', needs: [],
    text: 'Set it face-down. The next attack or prank on you bounces back onto whoever played it.',
  },
  sixth: {
    name: 'Sixth Man', icon: '🪑', rarity: 'rare', type: 'boost', needs: ['player'],
    text: "Name an extra player. After the week he subs into whichever of Bucket, Glass or Dime he'd earn the most extra rank points in, and burns there.",
  },
  copycat: {
    name: 'Copycat', icon: '🐱', rarity: 'rare', type: 'boost', needs: ['target', 'slot'],
    text: 'Your slot scores whatever your target picked there. Nothing burns for you, and the slot counts 0 toward the survival bars.',
  },
  leech: {
    name: 'Leech', icon: '🦟', rarity: 'rare', type: 'boost', needs: ['target', 'slot'],
    text: "You also collect half of a colleague's rank points in one category. They lose nothing. They just have to watch.",
  },
  switcheroo: {
    name: 'Switcheroo', icon: '🔀', rarity: 'rare', type: 'hindsight', needs: ['swap'],
    text: 'After a week ends, move your player picks between Bucket, Glass and Dime. Each player must be unburned in his new slot, and the burns move with him.',
  },
  garbage: {
    name: 'Garbage Time', icon: '🗑️', rarity: 'common', type: 'hindsight', needs: ['slot'],
    text: "After a week ends, your pick's worst game in one slot is replaced by a copy of his best game (in Dub, one loss becomes a win).",
  },
  embargo: {
    name: 'Embargo', icon: '🚫', rarity: 'rare', type: 'chaos', needs: ['slot', 'player'],
    text: `Nobody can use one player (or, in Dub, one team) in one category this week. Announced the moment it's played. Play it at least ${LEAGUE.cards.embargoHours} hours before the lock.`,
  },
  scout: {
    name: 'Scout Report', icon: '🔭', rarity: 'common', type: 'chaos', needs: ['slot'],
    text: 'See the five most-picked players in one category before the lock, with ownership %. No names attached.',
  },
  duel: {
    name: 'Duel', icon: '⚔️', rarity: 'common', type: 'duel', needs: ['target', 'slot'],
    text: `Challenge a colleague in one category. Winner takes ${LEAGUE.cards.duelStake} points from the loser. If they decline, they wear 🐔 for the week.`,
  },
};

// The NHL league plays the same deck under hockey names. The rules follow the slots: a Jinx doubles a
// minus and takes .020 off a save percentage, and Extra Attacker and Line Change respect positions.
const HOCKEY = {
  jinx: { name: 'Jinx', icon: '🪄', text: "Name a colleague and a player (or a team). If it's one of their picks this week: points and wins score half, a minus doubles, and a save % loses .020." },
  load: { name: 'Healthy Scratch', icon: '🍿', text: "Pick a colleague and a slot. Their pick's best game of the week doesn't count (in Shutdown it's swapped for his worst; in Dub, one win comes off)." },
  heist: { name: 'Poke Check', icon: '🏒', text: `Strip ${LEAGUE.cards.heist} points from anyone above you in the standings.` },
  blue_shell: { name: 'Hip Check', icon: '💥', text: 'Lines up whoever leads the standings at the lock. Their best slot this week scores half.' },
  burn_notice: { name: 'Waivers', icon: '📝', text: 'Put one player (or, in Dub, one team) on waivers for a colleague in one category: burned for them for the rest of the season, from next week.' },
  clown: { name: 'Mullet', icon: '💇', text: "Give a colleague a 💇 mullet next to their name for the week. Business in the front. No effect on points." },
  nickname: { name: 'Nickname', icon: '🏷️', text: 'Give a colleague a nickname from the official list. It sits next to their name all week.' },
  charge: { name: 'Shot Block', icon: '🧱', text: "Set it face-down. The next attack or prank on you is blocked and the attacker's card is wasted." },
  reverse: { name: 'Off the Boards', icon: '🔁', text: 'Set it face-down. The next attack or prank on you comes off the boards onto whoever played it.' },
  sixth: { name: 'Extra Attacker', icon: '🥅', text: "Name an extra skater or goalie. After the week he jumps over the boards into whichever slot he can play where he'd earn the most extra rank points, and burns there." },
  copycat: { name: 'Shadow', icon: '👥', text: 'Shadow a colleague: your slot scores whatever they picked there. Nothing burns for you, and the slot counts 0 toward the survival bars.' },
  leech: { name: 'Linemate', icon: '🤝', text: "Ride a colleague's line: you also collect half of their rank points in one category. They lose nothing." },
  switcheroo: { name: 'Line Change', icon: '🔀', text: 'After a week ends, swap your Lamplighter and Shutdown skaters. Each must be unburned in his new slot, and the burns move with him.' },
  garbage: { name: 'Empty Netter', icon: '🚨', text: "After a week ends, your pick's worst game in one slot is replaced by a copy of his best game (in Dub, one loss becomes a win)." },
  embargo: { name: 'Sin Bin', icon: '⏱️', text: `Send one player (or, in Dub, one team) to the box: nobody can use him in one category this week. Everyone sees it right away. Play it at least ${LEAGUE.cards.embargoHours} hours before the lock.` },
  scout: { name: 'Scouting Report', icon: '📋', text: 'See the five most-picked players in one category before the lock, with ownership %. No names attached.' },
  duel: { name: 'Faceoff', icon: '🆚', text: `Take a faceoff against a colleague in one category. Winner takes ${LEAGUE.cards.duelStake} points from the loser. If they decline, they wear 🐔 for the week.` },
};
if (LEAGUE.sport === 'nhl') for (const [k, v] of Object.entries(HOCKEY)) Object.assign(CARDS[k], v);

export const DECK = Object.keys(CARDS);

export const isAttack = card => ['attack', 'prank'].includes(CARDS[card]?.type);
export const isTrap = card => CARDS[card]?.type === 'trap';
export const isHindsight = card => CARDS[card]?.type === 'hindsight';
// Plays that use up your one card a week. Traps and gifts don't.
export const countsAsPlay = card => !!CARDS[card] && !isTrap(card);

export const NICKNAMES = LEAGUE.sport === 'nhl' ? [
  'The Pylon', 'Sieve', 'Bender', 'The Plug', 'Press Box', 'Fourth Liner',
  'Zamboni Driver', 'Black Ace', 'Cement Hands', 'Puck Hog', 'Waiver Wire', 'Rink Rat',
] : [
  'The Brick Layer', 'Bench Warmer', 'Captain Autopilot', 'DNP-CD', 'Trade Bait', 'G League Call-Up',
  'Garbage Time Hero', 'The Ball Hog', 'Load Manager', 'Air Ball', 'Two-Way Contract', 'Lottery Ticket',
];

export const TAUNTS = LEAGUE.sport === 'nhl' ? [
  'Keep your head up.', 'Top shelf.', 'Five-hole.', 'Bar down.', 'See you in the box.', 'Off the post and out.',
  'Snipe, snipe, celly.', 'Get pucked.', 'Not in my crease.', 'Nothing personal. Okay, a little personal.',
] : [
  "Ball don't lie.", 'Too small.', 'Wrong building.', 'Night night.', 'Count it.', 'And one.',
  'Get that weak stuff outta here.', 'Cash me in the paint.', 'Respect the process.', 'Nothing personal. Okay, a little personal.',
];

export const PACKS = LEAGUE.sport === 'nhl' ? {
  starter: { name: 'Starter Pack', blurb: 'Welcome to the bench', c1: '#a6192e', c2: '#0b2a5b' },
  locker: { name: 'Locker Room Pack', blurb: 'You picked your own team last week', c1: '#0b2a5b', c2: '#5b8fd6' },
  award: { name: 'Award Pack', blurb: 'Earned on last week’s awards', c1: '#7a5a10', c2: '#e8c35a' },
  revenge: { name: 'Revenge Pack', blurb: 'You lost a life. Drop the gloves.', c1: '#2b0a10', c2: '#d6223a' },
  album: { name: 'Album Pack', blurb: 'You completed a division', c1: '#173e4f', c2: '#7fd3e6' },
  decree: { name: 'Decree Pack', blurb: 'By order of the Commissioner', c1: '#1a1a1a', c2: '#c0c6cf' },
} : {
  starter: { name: 'Starter Pack', blurb: 'Welcome to the card table', c1: '#c8102e', c2: '#1d428a' },
  locker: { name: 'Locker Room Pack', blurb: 'You picked your own team last week', c1: '#0f2a66', c2: '#3d72e0' },
  award: { name: 'Award Pack', blurb: 'Earned on last week’s awards', c1: '#8a5a00', c2: '#f2c14e' },
  revenge: { name: 'Revenge Pack', blurb: 'You lost a life. Get even.', c1: '#3a0710', c2: '#ef2b4d' },
  album: { name: 'Album Pack', blurb: 'You completed a division', c1: '#3b1780', c2: '#1fc8b4' },
  decree: { name: 'Decree Pack', blurb: 'By order of the Commissioner', c1: '#1a1a1a', c2: '#d4af37' },
};

// Awards that hand out a pack. Ice Cold and The Fumble are pity packs.
export const AWARD_PACKS = { galaxy: 'Galaxy Brain', heater: 'Heater', cold: 'Ice Cold', fumble: 'Fumble' };

// Weeks 1–2 (before cards.oddsFrom): three fixed tiers. Kept as they were so those packs re-deal identically.
const ODDS = {
  lead: { common: 68, rare: 29, epic: 0, legendary: 3 },
  mid: { common: 58, rare: 36, epic: 0, legendary: 6 },
  trail: { common: 44, rare: 32, epic: 18, legendary: 6 },
};

// From cards.oddsFrom on, odds slide with your standing and the point in the season.
//   pos:    0 for the leader … 1 for last place (from the standings two weeks back)
//   season: 0 in Week 1 … 1 in the last week
// Standing counts for 40% of its full effect at the start of the season and 100% at the end.
// Legendary (Burn Notice, kept ultra rare) runs 0.1% → 0.6% a card, Rare 20% → 30%; the comeback Epics
// (Heist, Blue Shell) only reach the bottom half, up to 16% for last place late in the season.
export function standingOdds(kind, { pos, season }) {
  const weight = 0.4 + 0.6 * season;
  const need = pos * weight;
  if (kind === 'revenge') return { common: 47, rare: 28, epic: 24, legendary: 1 };
  if (kind === 'album') return pos > 0.5 ? { common: 0, rare: 75.5, epic: 23, legendary: 1.5 } : { common: 0, rare: 98.5, epic: 0, legendary: 1.5 };
  const legendary = 0.1 + 0.5 * need;
  const rare = 20 + 10 * need;
  const epic = 16 * Math.max(0, 2 * pos - 1) * weight;
  return { common: 100 - legendary - rare - epic, rare, epic, legendary };
}

// Where you stand for pack odds: pos 0 (leader) … 1 (last), season 0 … 1. Ties share a place.
// Nobody is placed before four people have a score; then everyone counts as halfway.
export function standingFor(snap, id, week, weeks) {
  const n = snap?.order.length || 0;
  const season = weeks > 1 ? Math.min(1, Math.max(0, (week - 1) / (weeks - 1))) : 0;
  if (n < 4) return { pos: 0.5, season };
  const r = snap.rank.get(id);
  return { pos: r == null ? 1 : (r - 1) / (n - 1), season };
}

// tier: 'lead' | 'mid' | 'trail' for the early fixed tables, or a { pos, season } standing.
export function packOdds(kind, tier) {
  if (tier && typeof tier === 'object') return standingOdds(kind, tier);
  if (kind === 'revenge') return { common: 30, rare: 40, epic: 22, legendary: 8 };
  if (kind === 'album') return tier === 'trail' ? { common: 0, rare: 62, epic: 23, legendary: 15 } : { common: 0, rare: 85, epic: 0, legendary: 15 };
  return ODDS[tier] || ODDS.mid;
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function weighted(rand, odds) {
  const total = Object.values(odds).reduce((a, b) => a + b, 0);
  let x = rand() * total;
  for (const [k, v] of Object.entries(odds)) { if ((x -= v) < 0) return k; }
  return 'common';
}

// Three different cards. You keep one.
export function dealPack(userId, key, kind, tier, rand = rng(hash(`${LEAGUE.season}|${userId}|${key}`))) {
  const odds = packOdds(kind, tier);
  const out = [];
  for (let tries = 0; out.length < 3 && tries < 60; tries++) {
    const r = weighted(rand, odds);
    const pool = DECK.filter(c => CARDS[c].rarity === r);
    const c = pool[Math.floor(rand() * pool.length)];
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

// Pack keys start with the week they're dealt in: "w7:locker", "w7:album:Pacific".
export const packWeek = key => +(/^w(\d+):/.exec(key)?.[1] ?? NaN);

// Deals from the league's secret seeds (seeds['<user>|<week>'] from the database).
// Without a seed, which is someone else's pack before its week locks, the pack
// stays face-down: the dealer returns null and the hand rebuilds without it.
export function seededDealer(seeds) {
  return (userId, key, kind, tier) => {
    const sd = seeds[`${userId}|${packWeek(key)}`];
    return sd ? dealPack(userId, key, kind, tier, rng(hash(`${sd}|${key}`))) : null;
  };
}

const RANK = { common: 0, rare: 1, epic: 2, legendary: 3 };
export const bestRarity = cards => cards.reduce((b, c) => RANK[CARDS[c].rarity] > RANK[b] ? CARDS[c].rarity : b, 'common');

// Bottom half trails, top quarter leads. Nobody is ranked before a few people have played.
export function tierFor(snap, id) {
  const n = snap?.order.length || 0;
  if (n < 4) return 'mid';
  const r = snap.rank.get(id);
  if (r == null || r > n / 2) return 'trail';
  return r <= Math.max(1, Math.floor(n / 4)) ? 'lead' : 'mid';
}

const byTime = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id ?? '').localeCompare(String(b.id ?? ''));

function newSlotMaps() { return Object.fromEntries(SLOTS.map(s => [s, new Map()])); }

// Rebuilds everyone's packs and hands week by week, and decides which plays are valid.
// A '_keep' row's card_uid is `pack:<pack key>`; the card it keeps then goes by the pack key.
// Packs up to LEAGUE.cards.swapsThroughWeek allowed one change of mind before the lock: a second '_keep'
// row with `repick:<pack key>`. After that, kept cards are final and repick rows are ignored.
// The league engine calls begin() before scoring a week and end() after it.
export class CardTable {
  constructor({ users, plays, weeks, byWeek, from, dealer, decrees = {} }) {
    this.users = users;
    this.byWeek = byWeek;
    this.from = from;
    this.weeks = weeks;
    this.deal = dealer || dealPack;
    this.decrees = decrees;
    this.keeps = {};
    this.repicks = {};
    this.replies = {};
    this.rows = {};
    for (const p of [...plays].sort(byTime)) {
      if (!users[p.user_id]) continue;
      if (p.card === '_keep') {
        const uid = String(p.card_uid);
        if (uid.startsWith('repick:')) this.repicks[`${p.user_id}|${uid.slice(7)}`] ||= p;
        else this.keeps[`${p.user_id}|${uid.replace(/^pack:/, '')}`] ||= p;
        continue;
      }
      if (p.card === '_reply') { const d = p.params?.duel; if (d != null) this.replies[d] ||= p; continue; }
      (this.rows[p.week] ||= []).push(p);
    }
    this.bonus = {};
    this.giftsIn = {};
    this.out = {};
    for (const u of Object.values(users)) {
      u.cards = { hand: [], armed: [], packs: [], album: new Set(), divisions: [], discarded: [], refunds: [] };
      u.notices = new Map();
    }
  }

  joinStep(u) {
    if (!u.joined) return 1;
    const t = Date.parse(u.joined);
    return this.weeks.find(w => Date.parse(w.lockAt) > t)?.week ?? Infinity;
  }

  pickedOwn(week, id) {
    const slots = this.byWeek[week]?.[id];
    return !!slots && Object.values(slots).some(p => !p.auto);
  }

  begin(wk, status, snapPrev2) {
    const W = wk.week;
    const cw = { week: W, status, plays: [], embargo: newSlotMaps(), copy: new Map(), sixth: new Map(), cosmetics: {}, chickens: new Set() };
    this.out[W] = cw;
    if (W < this.from) return cw;
    const locked = status !== 'open';
    const lockT = Date.parse(wk.lockAt);

    for (const u of Object.values(this.users)) {
      const c = u.cards;
      const stubs = [];
      if (W === Math.max(this.from, this.joinStep(u))) stubs.push({ key: `w${W}:starter`, kind: 'starter' });
      if (W > this.from && this.pickedOwn(W - 1, u.id)) stubs.push({ key: `w${W}:locker`, kind: 'locker' });
      stubs.push(...(this.bonus[W]?.[u.id] || []));
      if (this.decrees[W] === 'pack_day' && W >= this.joinStep(u)) stubs.push({ key: `w${W}:decree`, kind: 'decree' });
      for (const st of stubs) {
        const tier = W >= LEAGUE.cards.oddsFrom ? standingFor(snapPrev2, u.id, W, this.weeks.length)
          : st.kind === 'revenge' ? 'trail' : tierFor(snapPrev2, u.id);
        const cards = this.deal(u.id, st.key, st.kind, tier);
        if (!cards) continue; // face-down: someone else's pack before its week locks
        const valid = k => k && k.week === W && Number.isInteger(k.params?.pick) && k.params.pick >= 0 && k.params.pick < cards.length
          && (!k.created_at || Date.parse(k.created_at) < lockT);
        const k = this.keeps[`${u.id}|${st.key}`], r = this.repicks[`${u.id}|${st.key}`];
        const first = valid(k) ? k.params.pick : null;
        const repicked = W <= LEAGUE.cards.swapsThroughWeek && first != null && valid(r) && byTime(k, r) <= 0;
        const keep = repicked ? r.params.pick : first;
        c.packs.push({ ...st, step: W, tier, cards, keep, first, repicked, auto: keep == null && locked });
        if (keep != null || locked) c.hand.push({ uid: st.key, card: cards[keep ?? 0], step: W, from: st.kind });
      }
      for (const g of this.giftsIn[W]?.[u.id] || []) c.hand.push(g);
    }

    const used = {};
    for (const p of this.rows[W] || []) {
      const u = this.users[p.user_id];
      const rec = { ...p, ok: false, why: null, outcome: null };
      cw.plays.push(rec);
      const why = this.check(p, wk, status, lockT, used);
      if (why) { rec.why = why; continue; }
      const i = u.cards.hand.findIndex(h => h.uid === p.card_uid && (p.card === 'gift' || h.card === p.card));
      if (i < 0) { rec.why = 'not-in-hand'; continue; }
      const [inst] = u.cards.hand.splice(i, 1);
      rec.ok = true;
      rec.inst = inst;
      if (p.card === 'gift') {
        rec.gift = inst.card;
        ((this.giftsIn[W + 1] ||= {})[p.target_id] ||= []).push({ uid: `gift:${p.id}`, card: inst.card, step: W + 1, from: 'gift', by: p.user_id });
        continue;
      }
      if (isTrap(p.card)) { u.cards.armed.push({ ...inst, armedWeek: W, play: rec }); continue; }
      used[p.user_id] = (used[p.user_id] || 0) + 1;
      if (p.card === 'embargo') cw.embargo[p.slot].set(p.player_id, rec);
      if (p.card === 'copycat') cw.copy.set(`${p.user_id}|${p.slot}`, rec);
      if (p.card === 'sixth') cw.sixth.set(p.user_id, rec);
    }
    return cw;
  }

  // Why a play doesn't count (null = it does).
  check(p, wk, status, lockT, used) {
    if (p.card === 'gift') return this.users[p.target_id] && p.target_id !== p.user_id ? null : 'target';
    const def = CARDS[p.card];
    if (!def) return 'unknown';
    const t = p.created_at ? Date.parse(p.created_at) : null;
    if (def.type === 'hindsight') {
      if (status !== 'final') return 'not-final';
    } else if (t != null && t >= lockT) return 'late';
    if (p.card === 'embargo' && t != null && t > lockT - LEAGUE.cards.embargoHours * 3600e3) return 'late';
    if (def.needs.includes('target') && (!this.users[p.target_id] || p.target_id === p.user_id)) return 'target';
    if (def.needs.includes('slot') && !SLOTS.includes(p.slot)) return 'slot';
    if (def.needs.includes('player') && p.player_id == null) return 'player';
    // In a named slot the pick has to fit it: a team for Dub, a player anywhere else.
    if (def.needs.includes('player') && def.needs.includes('slot') && (p.slot === 'WIN') !== isTeamId(p.player_id)) return 'player';
    if (p.card === 'sixth' && isTeamId(p.player_id)) return 'player';
    if (def.needs.includes('nickname') && !NICKNAMES[p.params?.nick]) return 'nickname';
    const decree = this.decrees[wk.week];
    if (decree === 'ceasefire' && p.week === wk.week) return 'ceasefire';
    if (countsAsPlay(p.card) && (used[p.user_id] || 0) >= (decree === 'free_for_all' ? 2 : 1)) return 'limit';
    return null;
  }

  refund(rec, why) {
    rec.outcome = 'fizzled';
    rec.why = why;
    this.users[rec.user_id].cards.refunds.push(rec.inst);
  }

  // Attacks and pranks meet traps first, then the weekly cap. Returns what landed and on whom.
  resolveAttacks(cw, snapPrev) {
    const landed = {};
    const hits = [];
    const leader = snapPrev?.order[0] ?? null;
    for (const rec of cw.plays) {
      if (!rec.ok || !isAttack(rec.card)) continue;
      const target = rec.card === 'blue_shell' ? leader : rec.target_id;
      if (!target || target === rec.user_id) { this.refund(rec, rec.card === 'blue_shell' && target ? 'you-lead' : 'no-target'); continue; }
      if (rec.card === 'heist' && !((snapPrev?.rank.get(target) ?? Infinity) < (snapPrev?.rank.get(rec.user_id) ?? Infinity))) { this.refund(rec, 'not-above'); continue; }
      rec.target = target;
      const armed = this.users[target].cards.armed;
      const ti = armed.findIndex(a => a.armedWeek <= cw.week);
      if (ti >= 0) {
        const [trap] = armed.splice(ti, 1);
        trap.play.sprung = cw.week;
        rec.trap = trap.card;
        if (trap.card === 'charge') { rec.outcome = 'blocked'; continue; }
        rec.outcome = 'reversed';
        hits.push({ rec, victim: rec.user_id, by: target });
        continue;
      }
      if ((landed[target] || 0) >= LEAGUE.cards.attackCap) { this.refund(rec, 'cap'); continue; }
      landed[target] = (landed[target] || 0) + 1;
      rec.outcome = 'landed';
      hits.push({ rec, victim: target, by: rec.user_id });
    }
    return hits;
  }

  end(wk, status, { entrants = [], results = {}, awards = [], teamOf = () => null } = {}) {
    const W = wk.week;
    for (const u of Object.values(this.users)) {
      const c = u.cards;
      if (c.refunds.length) { c.hand.push(...c.refunds); c.refunds = []; }
      if (W >= this.from) while (c.hand.length > LEAGUE.cards.handLimit) c.discarded.push({ ...c.hand.shift(), week: W });
    }
    if (status !== 'final' || W < this.from) return;

    const add = (id, key, kind, label) => {
      const list = ((this.bonus[W + 1] ||= {})[id] ||= []);
      if (!list.some(x => x.key === key)) list.push({ key, kind, label });
    };
    for (const a of awards) if (AWARD_PACKS[a.key]) add(a.user, `w${W}:${a.key}`, 'award', AWARD_PACKS[a.key]);
    for (const id of entrants) {
      const r = results[id];
      if (r.lifeLost) add(id, `w${W}:revenge`, 'revenge', 'Revenge');
      // Sticker album: every player who scored for you puts his team in your album.
      const c = this.users[id].cards;
      for (const s of SLOTS) {
        const x = r.slots[s];
        if (x.copy) continue;
        for (const pid of [x.scorer, x.replaced]) {
          const team = pid != null ? teamOf(pid) : null;
          if (team) c.album.add(team);
        }
      }
      for (const [div, teams] of Object.entries(DIVISIONS)) {
        if (c.divisions.includes(div) || !teams.every(t => c.album.has(t))) continue;
        c.divisions.push(div);
        add(id, `w${W}:album:${div}`, 'album', div);
      }
    }
  }
}
