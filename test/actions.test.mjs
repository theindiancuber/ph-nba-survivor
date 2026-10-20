import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Every button the app renders with data-act="…" needs an entry in ACTIONS, or the click does
// nothing. A bad merge (#20 into the redesign) once kept the buttons and dropped their handlers.
test('every data-act in the app has a handler', () => {
  const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const start = src.indexOf('const ACTIONS = {');
  assert.ok(start > 0, 'ACTIONS table not found');
  const end = src.indexOf('\n};', start);
  const table = src.slice(start, end);
  const handlers = new Set([...table.matchAll(/^ {2}'?([a-z][\w-]*)'?: /gm)].map(m => m[1]));
  const used = new Set([...src.matchAll(/data-act="([a-z][\w-]*)"/g)].map(m => m[1]));
  const missing = [...used].filter(a => !handlers.has(a));
  assert.deepEqual(missing, [], `buttons with no handler: ${missing.join(', ')}`);
});
