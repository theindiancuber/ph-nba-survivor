// Temporary: prints the shape of the NHL feed so the parser can be written against real data.
const API = 'https://api-web.nhle.com/v1';
const get = async p => { const r = await fetch(API + p, { headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error(`${r.status} ${p}`); return r.json(); };
const show = (label, x, n = 3000) => console.log(`\n===== ${label} =====\n` + JSON.stringify(x, null, 1).slice(0, n));
const shape = o => Array.isArray(o) ? [o.length ? shape(o[0]) : null] : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)])) : typeof o;

const sch = await get('/schedule/2026-10-26');
show('schedule keys', shape(sch), 4000);
show('schedule day0 game0', sch.gameWeek?.[0]?.games?.[0]);
const past = await get('/schedule/2026-10-19');
const done = past.gameWeek.flatMap(d => d.games.map(g => ({ ...g, date: d.date }))).filter(g => ['OFF', 'FINAL'].includes(g.gameState));
console.log('\nfinished games 10-19 week:', done.length, done.slice(0, 3).map(g => [g.id, g.gameType, g.gameState, g.date, g.startTimeUTC, g.awayTeam?.abbrev, g.awayTeam?.score, g.homeTeam?.abbrev, g.homeTeam?.score, g.gameOutcome]));
const gid = done[0].id;
const box = await get(`/gamecenter/${gid}/boxscore`);
show('boxscore shape', shape(box), 6000);
show('boxscore forward0', box.playerByGameStats?.homeTeam?.forwards?.[0]);
show('boxscore defense0', box.playerByGameStats?.homeTeam?.defense?.[0]);
show('boxscore goalies', box.playerByGameStats?.homeTeam?.goalies);
show('boxscore top', { id: box.id, gameType: box.gameType, gameDate: box.gameDate, gameState: box.gameState, away: box.awayTeam, home: box.homeTeam, gameOutcome: box.gameOutcome });
// Penalties across the week's games: find fights.
const kinds = {};
let fight = null;
for (const g of done.slice(0, 25)) {
  const pbp = await get(`/gamecenter/${g.id}/play-by-play`);
  for (const p of pbp.plays || []) {
    if (p.typeDescKey !== 'penalty') continue;
    const k = `${p.details?.typeCode}|${p.details?.descKey}|${p.details?.duration}`;
    kinds[k] = (kinds[k] || 0) + 1;
    if (!fight && /fight/i.test(p.details?.descKey || '')) fight = { game: g.id, ...p };
  }
}
show('penalty kinds (25 games)', kinds);
show('a fight event', fight);
const roster = await get('/roster/TOR/current');
show('roster shape', shape(roster));
show('roster forward0', roster.forwards?.[0]);
show('roster goalie0', roster.goalies?.[0]);
const club = await get('/club-schedule-season/TOR/20262027');
const reg = (club.games || []).filter(g => g.gameType === 2);
console.log('\nTOR regular season games:', reg.length, 'first', reg[0]?.gameDate, 'last', reg.at(-1)?.gameDate);
const st = await get('/standings/now');
show('standings row0', st.standings?.[0], 1500);
