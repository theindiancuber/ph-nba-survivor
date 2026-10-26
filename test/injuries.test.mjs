// The injury report for the picker (scripts/injuries.mjs), on a hand-built payload in the shape of ESPN's public feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInjuries, addInjuries, nameKey, injuryLabel } from '../scripts/injuries.mjs';

const players = {
  1629029: { id: 1629029, name: 'Luka Dončić', team: 'LAL' },
  1630169: { id: 1630169, name: 'Tyrese Haliburton', team: 'IND' },
  1628386: { id: 1628386, name: 'Jarrett Allen', team: 'CLE' },
  203952: { id: 203952, name: 'Andrew Wiggins', team: 'MIA' },
  1641708: { id: 1641708, name: 'Gary Trent Jr.', team: 'MIL' },
};

const feed = { injuries: [
  { id: '13', displayName: 'Los Angeles Lakers', injuries: [
    { status: 'Day-To-Day', athlete: { displayName: 'Luka Doncic' }, details: { type: 'Ankle', side: 'Left' } },
  ] },
  { id: '11', displayName: 'Indiana Pacers', injuries: [
    { status: 'Out', athlete: { displayName: 'Tyrese Haliburton' }, details: { type: 'Achilles', side: 'Right' } },
  ] },
  { id: '15', displayName: 'Milwaukee Bucks', injuries: [
    { status: 'Questionable', athlete: { firstName: 'Gary', lastName: 'Trent' }, details: { type: 'Back', side: 'Not Specified' } },
    { status: 'Out', athlete: { displayName: 'Nobody We Know' } },
  ] },
] };

test('names match across accents, punctuation and suffixes', () => {
  assert.equal(nameKey('Luka Dončić'), nameKey('Luka Doncic'));
  assert.equal(nameKey('Gary Trent Jr.'), nameKey('Gary Trent'));
  assert.equal(nameKey("De'Aaron Fox"), nameKey('DeAaron Fox'));
  assert.equal(injuryLabel('Day-To-Day'), 'Day-to-day');
  assert.equal(injuryLabel('Injured Reserve'), 'IR');
  assert.equal(injuryLabel('Suspension'), 'Suspended');
});

test("ESPN's report tags our players, with what's hurt", () => {
  assert.deepEqual(parseInjuries(feed, players), {
    1629029: ['Day-to-day', 'Left Ankle'],
    1630169: ['Out', 'Right Achilles'],
    1641708: ['Questionable', 'Back'],
  });
  assert.throws(() => parseInjuries({}, players), /no injuries list/);
});

test('a feed that is down keeps the last tags, and a fresh report replaces them', async () => {
  const prev = { 1628386: { id: 1628386, inj: ['Out', 'Knee'] } };
  const down = structuredClone(players);
  assert.equal(await addInjuries({ sport: 'nba', players: down, prev, getJson: async () => { throw new Error('503'); } }), 1);
  assert.deepEqual(down[1628386].inj, ['Out', 'Knee']);

  const up = structuredClone(players);
  let asked;
  await addInjuries({ sport: 'nba', players: up, prev, getJson: async url => { asked = url; return feed; } });
  assert.match(asked, /basketball\/nba\/injuries/);
  assert.equal(up[1628386].inj, undefined, 'healed');
  assert.deepEqual(up[1630169].inj, ['Out', 'Right Achilles']);
});
