// Storage for accounts, picks and jokers. Two implementations with one shape:
// Supabase for the real league, and a local demo league in browser storage.

import { LEAGUE } from './config.js';

const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

export class SupabaseBackend {
  constructor() { this.kind = 'supabase'; this.user = null; }

  async init() {
    const { createClient } = await import(SUPABASE_ESM);
    this.sb = createClient(LEAGUE.supabaseUrl, LEAGUE.supabaseAnonKey);
    const { data } = await this.sb.auth.getSession();
    this.user = data.session?.user || null;
  }

  get userId() { return this.user?.id || null; }

  async signUp({ email, password, name, team, invite }) {
    // Check the code first for a clear message; the database enforces it either way.
    const check = await this.sb.rpc('check_invite', { code: invite || '' });
    if (!check.error && check.data === false) throw new Error("That invite code isn't right. Ask the commissioner for the invite link.");
    const { data, error } = await this.sb.auth.signUp({ email, password, options: { data: { invite_code: (invite || '').trim() } } });
    if (error) throw friendly(error);
    if (!data.session) throw new Error('Account created, but email confirmation is switched on. Ask the commissioner to turn off "Confirm email" in Supabase, then sign in.');
    this.user = data.user;
    await this.createProfile({ name, team });
  }

  async signIn({ email, password }) {
    const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this.user = data.user;
  }

  async signOut() { await this.sb.auth.signOut(); this.user = null; }

  async resetPassword(email) {
    const { error } = await this.sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] });
    if (error) throw error;
  }

  async createProfile({ name, team }) {
    const { error } = await this.sb.from('profiles').insert({ id: this.userId, display_name: name.trim(), fav_team: team || null });
    if (error) throw friendly(error);
  }

  async updateProfile(patch) {
    const { error } = await this.sb.from('profiles').update(patch).eq('id', this.userId);
    if (error) throw friendly(error);
  }

  async all(table, order) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await this.sb.from(table).select('*').order(order).range(from, from + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) return rows;
    }
  }

  async load() {
    const [profiles, picks, unburns, weeks, plays] = await Promise.all([
      this.all('profiles', 'created_at'), this.all('picks', 'week'), this.all('unburns', 'created_at'), this.all('weeks', 'week'),
      // Until supabase/schema.sql is re-run there is no cards table: play without cards.
      this.all('card_plays', 'created_at').catch(() => []),
    ]);
    return { profiles, picks, unburns, plays, locks: Object.fromEntries(weeks.map(w => [w.week, new Date(w.lock_at).toISOString()])) };
  }

  // slots: { PTS: {player_id, alt_id} | null, ... }, dd: slot or null
  async savePicks(week, slots, dd) {
    const uid = this.userId;
    const q = () => this.sb.from('picks');
    let r = await q().update({ double_down: false }).eq('user_id', uid).eq('week', week).eq('double_down', true);
    if (r.error) throw friendly(r.error);
    const rows = Object.entries(slots).filter(([, v]) => v?.player_id)
      .map(([slot, v]) => ({ user_id: uid, week, slot, player_id: v.player_id, alt_id: v.alt_id ?? null, double_down: false, updated_at: new Date().toISOString() }));
    if (rows.length) {
      r = await q().upsert(rows, { onConflict: 'user_id,week,slot' });
      if (r.error) throw friendly(r.error);
    }
    const empty = LEAGUE.slots.filter(s => !slots[s]?.player_id);
    if (empty.length) {
      r = await q().delete().eq('user_id', uid).eq('week', week).in('slot', empty);
      if (r.error) throw friendly(r.error);
    }
    if (dd && slots[dd]?.player_id) {
      r = await q().update({ double_down: true }).eq('user_id', uid).eq('week', week).eq('slot', dd);
      if (r.error) throw friendly(r.error);
    }
  }

  // A card play, a kept card ('_keep'), a duel answer ('_reply') or a gift.
  async savePlay(row) {
    const { error } = await this.sb.from('card_plays').insert({ user_id: this.userId, params: {}, ...row });
    if (error) throw friendly(error);
  }

  async deletePlay(id) {
    const { error } = await this.sb.from('card_plays').delete().eq('id', id).eq('user_id', this.userId);
    if (error) throw friendly(error);
  }

  async scout(week, slot) {
    const { data, error } = await this.sb.rpc('scout_report', { w: week, s: slot });
    if (error) throw friendly(error);
    return data;
  }

  async setUnburn(row) {
    if (row) {
      const { error } = await this.sb.from('unburns').insert({ user_id: this.userId, ...row });
      if (error) throw friendly(error);
    } else {
      const { error } = await this.sb.from('unburns').delete().eq('user_id', this.userId);
      if (error) throw friendly(error);
    }
  }
}

// Commissioner calls: the database returns nothing unless you're in the admins table.
Object.assign(SupabaseBackend.prototype, {
  async isAdmin() {
    if (!this.userId) return false;
    const { data, error } = await this.sb.rpc('is_admin');
    return !error && data === true;
  },
  async adminMembers() {
    const { data, error } = await this.sb.rpc('admin_members');
    if (error) throw error;
    return data;
  },
  async adminPickStatus(week) {
    const { data, error } = await this.sb.rpc('admin_pick_status', { w: week });
    if (error) throw error;
    return data;
  },
  async adminBlocked() {
    const { data, error } = await this.sb.rpc('admin_blocked');
    if (error) throw error;
    return data;
  },
  async adminRemoveMember(id, block) {
    const { error } = await this.sb.rpc('admin_remove_member', { target: id, block });
    if (error) throw error;
  },
  async adminUnblock(email) {
    const { error } = await this.sb.rpc('admin_unblock', { target_email: email });
    if (error) throw error;
  },
  async adminGetInvite() {
    const { data, error } = await this.sb.rpc('admin_get_invite');
    if (error) throw error;
    return data;
  },
  async adminSetInvite(code) {
    const { error } = await this.sb.rpc('admin_set_invite', { code });
    if (error) throw error;
  },
});

function friendly(error) {
  const msg = error?.message || String(error);
  if (/profiles_name_unique/.test(msg)) return new Error('That name is taken. Try adding a last initial.');
  if (/row-level security/.test(msg) && !/card_plays/.test(msg)) return new Error('Picks for this week are locked.');
  if (/picks_one_double_down/.test(msg)) return new Error('You have already used your Double Down this season.');
  if (/Invalid invite code/.test(msg)) return new Error("That invite code isn't right. Ask the commissioner for the invite link.");
  if (/Database error saving new user|removed from the league/.test(msg)) return new Error("Sign-up was refused. Check the invite code, or ask the commissioner.");
  if (/card_plays_once/.test(msg)) return new Error('That card has already been used.');
  if (/card_plays/.test(msg) && /row-level security/.test(msg)) return new Error('Too late for that card this week.');
  if (/unburns_pkey|duplicate key/.test(msg)) return new Error('You have already used your Un-burn this season.');
  return new Error(msg);
}

// ---- Demo league: everything lives in this browser ----

const DEMO_KEY = 'phs-demo-v1';

export class DemoBackend {
  constructor(seed, now) {
    this.kind = 'demo';
    this.now = now;
    this.seed = seed;
    this.state = null;
  }

  async init() {
    try { this.state = JSON.parse(localStorage.getItem(DEMO_KEY)); } catch { this.state = null; }
    if (!this.state || this.state.version !== this.seed.version) {
      this.state = { version: this.seed.version, profiles: this.seed.profiles, picks: this.seed.picks, unburns: this.seed.unburns, plays: this.seed.plays, userId: null };
    }
  }

  persist() { try { localStorage.setItem(DEMO_KEY, JSON.stringify(this.state)); } catch { /* private mode */ } }

  get userId() { return this.state.userId; }
  get user() { return this.state.userId ? { id: this.state.userId } : null; }

  async signIn() { this.state.userId = this.seed.meId; this.persist(); }
  async signUp() { return this.signIn(); }
  async signOut() { this.state.userId = null; this.persist(); }
  async resetPassword() {}

  async createProfile({ name, team }) {
    this.state.profiles.push({ id: this.state.userId, display_name: name, fav_team: team, rival_id: null, created_at: new Date(this.now()).toISOString() });
    this.persist();
  }

  async updateProfile(patch) {
    const p = this.state.profiles.find(x => x.id === this.userId);
    if (patch.display_name && this.state.profiles.some(x => x.id !== p.id && x.display_name.toLowerCase() === patch.display_name.toLowerCase())) {
      throw new Error('That name is taken. Try adding a last initial.');
    }
    Object.assign(p, patch);
    this.persist();
  }

  async load() {
    const locks = Object.fromEntries(this.seed.weeks.map(w => [w.week, w.lockAt]));
    // Same visibility as the real database: other people's picks appear once the week locks.
    const visible = r => r.user_id === this.userId || this.now() >= Date.parse(locks[r.week]);
    const playVisible = r => visible(r) || r.card === 'embargo' || r.card === '_keep' || (['duel', '_reply'].includes(r.card) && r.target_id === this.userId);
    return structuredClone({ profiles: this.state.profiles, picks: this.state.picks.filter(visible), unburns: this.state.unburns.filter(visible), plays: this.state.plays.filter(playVisible), locks });
  }

  // Same windows as card_window() in schema.sql.
  assertCardWindow(card, week) {
    const lock = w => Date.parse(this.seed.weeks.find(x => x.week === w)?.lockAt);
    const t = this.now();
    if (['switcheroo', 'garbage'].includes(card)) {
      if (!(t >= lock(week) && t < lock(week + 1))) throw new Error('Too late for that card this week.');
    } else if (card === 'embargo') {
      if (!(lock(week) > t + 24 * 3600e3)) throw new Error('An Embargo has to be played at least 24 hours before the lock.');
    } else if (!(t < lock(week))) throw new Error('Too late for that card this week.');
  }

  async savePlay(row) {
    this.assertCardWindow(row.card, row.week);
    const uid = this.userId;
    if (row.card_uid && this.state.plays.some(p => p.user_id === uid && p.card_uid === row.card_uid)) throw new Error('That card has already been used.');
    this.state.plays.push({ params: {}, target_id: null, slot: null, player_id: null, card_uid: null, ...row, user_id: uid, id: `demo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, created_at: new Date(this.now()).toISOString() });
    this.persist();
  }

  async deletePlay(id) {
    const p = this.state.plays.find(x => x.id === id && x.user_id === this.userId);
    if (!p) return;
    if (p.card === '_keep') throw new Error("A kept card can't be swapped.");
    this.assertCardWindow(p.card, p.week);
    this.state.plays = this.state.plays.filter(x => x !== p);
    this.persist();
  }

  async scout(week, slot) {
    if (!this.state.plays.some(p => p.user_id === this.userId && p.week === week && p.card === 'scout' && p.slot === slot)) return [];
    const rows = this.state.picks.filter(p => p.week === week);
    const counts = {};
    for (const p of rows.filter(p => p.slot === slot)) counts[p.player_id] = (counts[p.player_id] || 0) + 1;
    const entries = new Set(rows.map(p => p.user_id)).size;
    return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 5).map(([pid, n]) => ({ player_id: +pid, picks: n, entries }));
  }

  assertOpen(week) {
    const w = this.seed.weeks.find(x => x.week === week);
    if (!w || this.now() >= Date.parse(w.lockAt)) throw new Error('Picks for this week are locked.');
  }

  async savePicks(week, slots, dd) {
    this.assertOpen(week);
    const uid = this.userId;
    if (dd && this.state.picks.some(p => p.user_id === uid && p.double_down && p.week !== week)) {
      throw new Error('You have already used your Double Down this season.');
    }
    this.state.picks = this.state.picks.filter(p => !(p.user_id === uid && p.week === week));
    for (const [slot, v] of Object.entries(slots)) {
      if (v?.player_id) this.state.picks.push({ user_id: uid, week, slot, player_id: v.player_id, alt_id: v.alt_id ?? null, double_down: dd === slot, auto: false });
    }
    this.persist();
  }

  async setUnburn(row) {
    const uid = this.userId;
    const existing = this.state.unburns.find(u => u.user_id === uid);
    if (row) {
      if (existing) throw new Error('You have already used your Un-burn this season.');
      this.assertOpen(row.week);
      this.state.unburns.push({ user_id: uid, ...row });
    } else {
      if (existing) this.assertOpen(existing.week);
      this.state.unburns = this.state.unburns.filter(u => u.user_id !== uid);
    }
    this.persist();
  }

  reset() { localStorage.removeItem(DEMO_KEY); }

  // In the demo, "You" are the commissioner.
  async isAdmin() { return this.userId === this.seed.meId; }

  async adminMembers() {
    return this.state.profiles.map(p => ({
      user_id: p.id, display_name: p.display_name, joined_at: p.created_at,
      email: `${p.display_name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/\.$/, '')}@peakhill.example`,
      last_sign_in_at: new Date(this.now() - (p.id.length * 7 % 5) * 86400e3).toISOString(),
    }));
  }

  async adminBlocked() { return this.state.blocked || []; }

  async adminRemoveMember(id, block) {
    if (id === this.userId) throw new Error("You can't remove yourself.");
    const p = this.state.profiles.find(x => x.id === id);
    if (block && p) (this.state.blocked ||= []).unshift({ email: (await this.adminMembers()).find(m => m.user_id === id).email, blocked_at: new Date(this.now()).toISOString() });
    this.state.profiles = this.state.profiles.filter(x => x.id !== id).map(x => x.rival_id === id ? { ...x, rival_id: null } : x);
    this.state.picks = this.state.picks.filter(x => x.user_id !== id);
    this.state.unburns = this.state.unburns.filter(x => x.user_id !== id);
    this.state.plays = this.state.plays.filter(x => x.user_id !== id && x.target_id !== id);
    this.persist();
  }

  async adminGetInvite() { return 'invite' in this.state ? this.state.invite : 'DEMO42'; }
  async adminSetInvite(code) { this.state.invite = (code || '').trim() || null; this.persist(); }

  async adminUnblock(email) {
    this.state.blocked = (this.state.blocked || []).filter(b => b.email !== email);
    this.persist();
  }

  async adminPickStatus(week) {
    const by = {};
    for (const p of this.state.picks.filter(x => x.week === week)) {
      const r = by[p.user_id] ||= { user_id: p.user_id, slots: 0, backups: 0, last_saved: new Date(this.now() - 3600e3).toISOString() };
      r.slots++;
      if (p.alt_id != null) r.backups++;
    }
    return Object.values(by);
  }
}
