// Every hockey card plays: the same check as cards-all.test.mjs, in the NHL league.
process.env.PHS_SPORT = 'nhl';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { auditCards } = await import('./helpers/card-audit.mjs');
const { DECK } = await import('../src/cards.js');

test('every NHL card, played the way its form plays it, lands or plays (none fizzle or get refused)', () => {
  const results = auditCards();
  assert.deepEqual([...new Set(results.map(r => r.card))].sort(), [...DECK].sort(), 'every card was tried');
  const broken = results.filter(r => r.error || !r.ok || r.outcome === 'fizzled');
  assert.deepEqual(broken, []);
  // The traps spring: Charge Taken blocks the attack, Uno Reverse bounces it back.
  assert.deepEqual(results.filter(r => r.sprung).map(r => [r.card, r.sprung]), [['charge', 'blocked'], ['reverse', 'reversed']]);
});
