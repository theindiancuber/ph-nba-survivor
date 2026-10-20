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

test('the week board sees nothing of a week before its lock, the commissioner included', async () => {
  const { seed, backend } = await demoAdmin();
  const open = seed.weeks.find(w => seed.now < Date.parse(w.lockAt));
  const visible = await backend.load();
  const othersVisible = visible.picks.filter(p => p.week === open.week && p.user_id !== seed.meId);
  assert.equal(othersVisible.length, 0, 'load() hides others before the lock');

  assert.deepEqual(await backend.adminWeekRows(open.week), [], 'no open-week picks for the commissioner either');
  assert.deepEqual(await backend.adminWeekPlays(open.week), [], 'no open-week card plays');
  const seeds = await backend.adminPackSeeds();
  for (const p of seed.profiles) assert.equal(seeds[`${p.id}|${open.week}`], undefined, 'no open-week pack seeds');
});

test('the week board covers the whole league once a week has locked', async () => {
  const { seed, backend } = await demoAdmin();
  const week = 5; // cards are on from week 5 in the demo, and week 5 is locked
  assert.ok(seed.now >= Date.parse(seed.weeks.find(w => w.week === week).lockAt));
  const rows = await backend.adminWeekRows(week);
  assert.ok(rows.some(r => r.user_id !== seed.meId), 'other members\' locked picks');
  for (const r of rows) {
    assert.ok(LEAGUE.slots.includes(r.slot));
    assert.ok(r.player_id != null);
  }
  assert.ok(Array.isArray(await backend.adminWeekPlays(week)));
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
