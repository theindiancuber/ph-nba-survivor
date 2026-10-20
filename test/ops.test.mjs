import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoBackend } from '../src/backend.js';
import { makeDemo } from '../src/demo.js';
import { LEAGUE } from '../src/config.js';

// DemoBackend persists to localStorage; stub it for node.
globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

async function demoAdmin() {
  const seed = makeDemo();
  const backend = new DemoBackend(seed, () => seed.now);
  await backend.init();
  await backend.signIn();
  return { seed, backend };
}

test('admin check-in returns every member with slot, backup, pack and play flags', async () => {
  const { seed, backend } = await demoAdmin();
  const open = seed.weeks.find(w => seed.now < Date.parse(w.lockAt));
  assert.ok(open, 'demo has an open week');
  const rows = await backend.adminCheckin(open.week);
  assert.equal(rows.length, seed.profiles.length);
  for (const r of rows) {
    assert.ok(r.user_id);
    assert.ok(Number.isInteger(r.slots));
    assert.ok(Number.isInteger(r.backups));
    assert.equal(typeof r.pack_kept, 'boolean');
    assert.equal(typeof r.played, 'boolean');
    assert.ok(r.slots <= LEAGUE.slots.length);
    assert.ok(r.backups <= r.slots);
  }
  // At least someone has started picking in the open week in the demo seed.
  assert.ok(rows.some(r => r.slots > 0));
});

test('admin week rows expose full picks before lock (unlike load())', async () => {
  const { seed, backend } = await demoAdmin();
  const open = seed.weeks.find(w => seed.now < Date.parse(w.lockAt));
  const visible = await backend.load();
  const othersVisible = visible.picks.filter(p => p.week === open.week && p.user_id !== seed.meId);
  assert.equal(othersVisible.length, 0, 'RLS-shaped load hides others pre-lock');

  const rows = await backend.adminWeekRows(open.week);
  const othersAdmin = rows.filter(p => p.user_id !== seed.meId);
  assert.ok(othersAdmin.length > 0, 'office tooling sees other members\' open-week picks');
  for (const r of othersAdmin) {
    assert.ok(LEAGUE.slots.includes(r.slot));
    assert.ok(r.player_id != null);
  }
});

test('admin week plays and pack seeds cover the whole league', async () => {
  const { seed, backend } = await demoAdmin();
  const week = 5; // cards are on from week 5 in the demo
  const plays = await backend.adminWeekPlays(week);
  assert.ok(Array.isArray(plays));
  const seeds = await backend.adminPackSeeds();
  assert.ok(seeds[`${seed.meId}|${week}`]);
  for (const p of seed.profiles) assert.ok(seeds[`${p.id}|1`]);
});

test('admin vote turnout lists voters without choices', async () => {
  const { seed, backend } = await demoAdmin();
  const vote = (seed.decrees || []).find(d => (d.options || []).length > 1);
  assert.ok(vote, 'demo seeds a decree vote');
  const voters = await backend.adminVoteTurnout(vote.week);
  assert.ok(voters.length > 0);
  for (const v of voters) {
    assert.ok(v.user_id);
    assert.equal(v.choice, undefined);
  }
});
