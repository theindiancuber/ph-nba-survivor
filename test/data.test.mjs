// Pipeline tests on hand-built payloads in the shape of NBA's public CDN JSON
// (staticData/scheduleLeagueV2.json and liveData/boxscore/boxscore_<id>.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, parseBox, buildData, gameKind } from '../scripts/update-data.mjs';

const game = (gameId, date, tip, home, away, gameStatus = 3) => ({
  gameId, gameStatus, gameDateEst: `${date}T00:00:00Z`, gameDateTimeUTC: tip,
  homeTeam: { teamTricode: home }, awayTeam: { teamTricode: away },
});

const schedJson = {
  leagueSchedule: {
    seasonYear: '2026-27',
    gameDates: [
      { games: [game('0012600001', '2026-10-10', '2026-10-10T23:30:00Z', 'DEN', 'OKC')] },
      { games: [game('0022600001', '2026-10-20', '2026-10-20T23:30:00Z', 'NYK', 'PHI'), game('0022600002', '2026-10-21', '2026-10-22T02:00:00Z', 'DEN', 'OKC')] },
      { games: [game('0022600050', '2026-11-03', '2026-11-04T00:00:00Z', 'DEN', 'NYK', 1)] },
      { games: [game('0062600001', '2026-12-11', '2026-12-12T01:00:00Z', 'DEN', 'NYK', 1)] },
      { games: [{ ...game('0022601229', '2026-11-10', '2026-11-10T05:00:00Z', null, null, 1), homeTeam: {}, awayTeam: {} }] },
    ],
  },
};

const pl = (personId, firstName, familyName, played, points, reboundsTotal, assists) =>
  ({ personId, firstName, familyName, position: 'C', jerseyNum: '15', played: played ? '1' : '0', statistics: { points, reboundsTotal, assists } });

const boxJson = (gameId, home, away, homePlayers, awayPlayers) => ({
  game: { gameId, gameStatus: 3, homeTeam: { teamTricode: home, players: homePlayers }, awayTeam: { teamTricode: away, players: awayPlayers } },
});

test('game kinds and schedule parsing skip non-league games', () => {
  assert.equal(gameKind('0022600001'), 'reg');
  assert.equal(gameKind('0042600101'), 'other');
  const s = parseSchedule(schedJson);
  assert.equal(s.length, 5);
  assert.deepEqual(s[1], { id: '0022600001', kind: 'reg', etDate: '2026-10-20', tipUtc: '2026-10-20T23:30:00Z', status: 3, home: 'NYK', away: 'PHI' });
});

test('box scores roll into weekly totals, averages, locks and team game counts', () => {
  const schedule = parseSchedule(schedJson);
  const byId = Object.fromEntries(schedule.map(g => [g.id, g]));
  const boxes = {
    '0012600001': parseBox(boxJson('0012600001', 'DEN', 'OKC', [pl(203999, 'Nikola', 'Jokic', 1, 20, 10, 10)], [pl(1628983, 'Shai', 'Gilgeous-Alexander', 1, 25, 4, 5)]), byId['0012600001']),
    '0012600002': parseBox(boxJson('0012600002', 'DEN', 'RMD', [], [pl(777, 'Guest', 'Player', 1, 12, 3, 2)]), { kind: 'pre', etDate: '2026-10-11', tipUtc: '2026-10-11T18:00:00Z' }),
    '0022600001': parseBox(boxJson('0022600001', 'NYK', 'PHI', [pl(1628973, 'Jalen', 'Brunson', 1, 30, 3, 8)], [pl(1, 'Bench', 'Guy', 0, 0, 0, 0)]), byId['0022600001']),
    '0022600002': parseBox(boxJson('0022600002', 'DEN', 'OKC', [pl(203999, 'Nikola', 'Jokic', 1, 31, 14, 12)], [pl(1628983, 'Shai', 'Gilgeous-Alexander', 1, 35, 5, 6)]), byId['0022600002']),
  };
  const { weeks, players, teams, totals } = buildData({ schedule, boxes, now: Date.parse('2026-11-05T00:00:00Z') });

  assert.equal(weeks[0].lockAt, '2026-10-20T23:30:00.000Z');
  assert.deepEqual(weeks[0].firstGame, { id: '0022600001', away: 'PHI', home: 'NYK', etDate: '2026-10-20', tipUtc: '2026-10-20T23:30:00Z' });
  assert.equal(weeks[0].final, true);
  assert.deepEqual(weeks[0].gamesByTeam, { NYK: 1, PHI: 1, DEN: 1, OKC: 1 });
  assert.equal(weeks[1].final, false);
  assert.deepEqual(weeks[1].leftByTeam, { DEN: 1, NYK: 1 });
  assert.equal(weeks[2].lockAt, '2026-11-10T00:00:00.000Z'); // only a TBD Cup game: 7pm ET default
  assert.deepEqual(weeks[2].gamesByTeam, {});

  assert.deepEqual(totals[1].p[203999], [1, 31, 14, 12, 31, 14, 12, 31, 14, 12, 'DEN']); // preseason excluded
  assert.equal(totals[1].p[1], undefined); // did not play
  assert.equal(players[203999].name, 'Nikola Jokic');
  assert.deepEqual(players[203999].avg, [31, 14, 12]);
  assert.equal(players[1].gp, 0);
  assert.equal(players[1].pre, true);
  assert.equal(players[777], undefined); // preseason guest team, not in the league

  // Team wins come from summed player points: NYK 30–0 PHI, OKC 35–31 DEN. Preseason doesn't count.
  assert.deepEqual(totals[1].t, { NYK: [1, 1], PHI: [1, 0], OKC: [1, 1], DEN: [1, 0] });
  assert.deepEqual(teams, { NYK: { w: 1, l: 0 }, PHI: { w: 0, l: 1 }, OKC: { w: 1, l: 0 }, DEN: { w: 0, l: 1 } });
});

test('games are "active" from 75 minutes before a tip until the game is final (or 5 hours on)', async () => {
  const { gamesActive } = await import('../scripts/update-data.mjs');
  const now = Date.parse('2026-10-21T00:00:00Z');
  const at = mins => new Date(now + mins * 60e3).toISOString();
  const g = (id, tip) => ({ id, tipUtc: tip });
  assert.equal(gamesActive([g('a', at(60))], {}, now), true, 'tips within 75 minutes');
  assert.equal(gamesActive([g('a', at(90))], {}, now), false, 'tips later');
  assert.equal(gamesActive([g('a', at(-30))], { a: { status: 2 } }, now), true, 'in progress');
  assert.equal(gamesActive([g('a', at(-30))], { a: { status: 3 } }, now), false, 'final');
  assert.equal(gamesActive([g('a', at(-6 * 60))], {}, now), false, 'stale: tipped over 5 hours ago');
  assert.equal(gamesActive([{ id: 'a', tipUtc: null }], {}, now), false);
});
