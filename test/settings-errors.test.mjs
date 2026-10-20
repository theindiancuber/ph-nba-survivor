import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsError } from '../src/backend.js';

test('a missing settings table points at upgrade-settings.sql and keeps the database message', () => {
  for (const msg of [
    'relation "public.league_config" does not exist',
    "Could not find the table 'public.league_config' in the schema cache",
  ]) {
    const e = settingsError({ message: msg });
    assert.match(e.message, /upgrade-settings\.sql/);
    assert.ok(e.message.includes(msg));
  }
});

test('other "does not exist" errors are no longer blamed on upgrade-settings.sql', () => {
  assert.match(settingsError({ message: 'function public.is_admin() does not exist' }).message, /admin\.sql/);
  const odd = settingsError({ message: 'column "updated_at" of relation "x" does not exist' });
  assert.equal(odd.message, 'column "updated_at" of relation "x" does not exist');
});

test('a policy refusal says only commissioners can save', () => {
  assert.match(settingsError({ message: 'new row violates row-level security policy for table "league_config"' }).message, /Only commissioners/);
});
