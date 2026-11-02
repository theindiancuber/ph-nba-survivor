// Every card plays: each one, in each category it can take, played as its form plays it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { auditCards } = await import('./helpers/card-audit.mjs');
const { DECK } = await import('../src/cards.js');

test('every NBA card, played the way its form plays it, lands or plays (none fizzle or get refused)', () => {
  const results = auditCards();
  assert.deepEqual([...new Set(results.map(r => r.card))].sort(), [...DECK].sort(), 'every card was tried');
  const broken = results.filter(r => r.error || !r.ok || r.outcome === 'fizzled');
  assert.deepEqual(broken, []);
  // The traps spring: Charge Taken blocks the attack, Uno Reverse bounces it back.
  assert.deepEqual(results.filter(r => r.sprung).map(r => [r.card, r.sprung]), [['charge', 'blocked'], ['reverse', 'reversed']]);
});
