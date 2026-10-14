import { LEAGUE, buildWeeks, defaultLockAt, MONTH_LABELS } from './config.js';
import { computeLeague, headToHead, blockedReason, projection, teamProjection, fmt } from './league.js';
import { TEAMS, TEAM_BY_ID, DIVISIONS, isTeamId, teamLogo, headshot } from './teams.js';
import { SupabaseBackend, DemoBackend } from './backend.js';
import { downloadCertificate } from './certificate.js';
import { funStats, perfectPlay } from './stats.js';
import { UPDATES, LATEST_UPDATE } from './updates.js';
import { seasonAwards } from './awards.js';
import { CARDS, RARITY, TYPES, NICKNAMES, TAUNTS, isTrap, isHindsight, countsAsPlay, dealPack, seededDealer } from './cards.js';
import { cardFace, cardBack, packArt, openPack, initHolo } from './pack.js';

const SLOTS = LEAGUE.slots;
const INFO = LEAGUE.slotInfo;
const STAT_IDX = { PTS: 0, REB: 1, AST: 2 };
const VIEWS = [
  ['week', 'This Week'], ['cards', 'Cards'], ['standings', 'Standings'], ['survivor', 'Survivor'], ['results', 'Results'],
  ['burns', 'Burn Book'], ['rivals', 'Rivals'], ['trophies', 'Trophies'], ['rules', 'Rules'],
];

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo') || !LEAGUE.supabaseUrl;

const S = {
  backend: null, clockOffset: 0,
  data: { weeks: [], players: {}, totals: {}, meta: null },
  db: { profiles: [], picks: [], unburns: [], plays: [], locks: {} },
  league: null, me: null,
  view: 'week', resultsWeek: null, burnUser: null, month: null,
  draft: null, picker: null, play: null, cardsWeek: null, authMode: 'signup', busy: false,
};

const now = () => Date.now() + S.clockOffset;
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const player = pid => S.data.players[pid] || null;
// The Dub slot picks teams; their ids are NBA team ids, which never collide with player ids.
const team = id => { const tri = TEAM_BY_ID[id]; return tri ? { tri, ...TEAMS[tri], record: S.data.teams?.[tri] || { w: 0, l: 0 } } : null; };
const pname = pid => { const t = team(pid); if (t) return `${t.city} ${t.name}`; return player(pid)?.name || (pid != null ? `Player #${pid}` : '—'); };
const shortName = pid => { const t = team(pid); if (t) return t.name; const p = player(pid); return p ? `${p.first?.[0] ? p.first[0] + '. ' : ''}${p.last || p.name}` : pname(pid); };
const record = t => `${t.record.w}–${t.record.l}`;
const userName = id => S.league?.users[id]?.name || 'Someone';
const myId = () => S.backend?.userId || null;
const meU = () => S.league?.users[myId()] || null;

// ---------- Boot ----------

async function boot() {
  try {
    if (DEMO) {
      const { makeDemo } = await import('./demo.js');
      const seed = makeDemo();
      S.clockOffset = seed.now - Date.now();
      S.backend = new DemoBackend(seed, now);
      S.data = { weeks: seed.weeks, players: seed.players, teams: seed.teams, totals: seed.totals, cardsFrom: seed.cardsFrom, meta: { updatedAt: new Date(seed.now).toISOString(), demo: true } };
      $('#demo-banner').innerHTML = `<div class="demo-banner">Demo league · made-up colleagues and simulated stats, frozen in early December. <button data-act="demo-reset">Reset demo</button></div>`;
    } else {
      S.backend = new SupabaseBackend();
      S.data = await loadData();
    }
    await S.backend.init();
    initHolo();
    S.view = viewFromHash();
    await refresh();
  } catch (e) {
    console.error(e);
    $('#app').innerHTML = `<div class="panel empty-state"><div class="ic">⚠️</div><b>Couldn't load the league.</b><p class="muted">${esc(e.message || e)}</p></div>`;
  }
  window.addEventListener('hashchange', () => { closeModal(); S.view = viewFromHash(); render(); window.scrollTo({ top: 0 }); });
  window.addEventListener('beforeunload', e => { if (S.draft?.dirty) { e.preventDefault(); e.returnValue = ''; } });
  setInterval(tick, 1000);
  if (!DEMO) {
    setInterval(async () => { S.data = await loadData().catch(() => S.data); refresh(); }, 5 * 60e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }
}

function viewFromHash() {
  const v = location.hash.slice(1);
  return v === 'admin' || VIEWS.some(([k]) => k === v) ? v : 'week';
}

function views() {
  return S.isAdmin ? [...VIEWS, ['admin', 'Commissioner']] : VIEWS;
}

async function loadData() {
  const get = async f => {
    const r = await fetch(`data/${f}.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`data/${f}.json: ${r.status}`);
    return r.json();
  };
  const [weeks, players, teams, totals, meta] = await Promise.all([
    get('weeks').catch(() => null), get('players').catch(() => null), get('teams').catch(() => null), get('totals').catch(() => null), get('meta').catch(() => null),
  ]);
  return {
    weeks: weeks?.weeks || buildWeeks().map(w => ({ ...w, lockAt: defaultLockAt(w), final: false, gamesByTeam: {}, leftByTeam: {} })),
    players: players?.players || {},
    teams: teams?.teams || {},
    totals: totals?.weeks || {},
    meta,
  };
}

async function refresh() {
  S.db = await S.backend.load();
  const weeks = S.data.weeks.map(w => ({ ...w, lockAt: S.db.locks[w.week] || w.lockAt }));
  S.league = computeLeague({
    weeks, totals: S.data.totals, picks: S.db.picks, unburns: S.db.unburns, plays: S.db.plays || [], profiles: S.db.profiles,
    now: now(), players: S.data.players,
    // The real league deals from the database's secret seeds; without them (cards SQL not run yet) cards stay off.
    cardsFrom: DEMO ? (S.data.cardsFrom ?? LEAGUE.cards.startWeek) : S.db.seeds ? LEAGUE.cards.startWeek : Infinity,
    dealer: S.db.seeds ? seededDealer(S.db.seeds) : undefined,
  });
  S.me = S.db.profiles.find(p => p.id === myId()) || null;
  if (S.adminFor !== myId()) {
    S.adminFor = myId();
    S.greeted = false;
    S.isAdmin = S.me ? await S.backend.isAdmin().catch(() => false) : false;
    S.adminData = null;
  }
  if (!S.draft || !S.draft.dirty || S.draft.week !== S.league.openWeek) resetDraft();
  render();
  greet();
}

function resetDraft() {
  const wk = S.league.openWeek;
  const slots = {};
  let dd = null;
  for (const s of SLOTS) {
    const p = S.db.picks.find(x => x.user_id === myId() && x.week === wk && x.slot === s);
    slots[s] = p ? { player_id: p.player_id, alt_id: p.alt_id } : null;
    if (p?.double_down) dd = s;
  }
  S.draft = { week: wk, slots, dd, dirty: false };
}

function weekObj(n) { return S.league.weeks.find(w => w.week === n); }
function liveWeek() { return [...S.league.weeks].reverse().find(w => w.status === 'live') || null; }
function lockedWeeks() { return S.league.weeks.filter(w => w.status !== 'open'); }

// ---------- Formatting ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dshort(iso) { return `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`; }
function weekRange(w) { return `${dshort(w.start)} – ${dshort(w.end)}`; }
function lockText(iso) {
  return new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function ago(iso) {
  const m = Math.round((now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hr ago` : `${Math.round(h / 24)} days ago`;
}
function initials(name) { return String(name || '?').split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase(); }
function hearts(n) { return `<span class="hearts" aria-label="${n} lives">${Array.from({ length: LEAGUE.lives }, (_, i) => `<span class="${i < n ? '' : 'off'}">❤️</span>`).join('')}</span>`; }

function avatar(id, cls = '') {
  const u = S.league.users[id];
  const c = TEAMS[u?.team]?.c1 || '#1d428a';
  return `<span class="avatar ${cls}" style="--c:${c}">${esc(initials(u?.name))}</span>`;
}

function thumb(pid, cls = '') {
  const t = team(pid);
  if (t) return `<div class="thumb team ${cls}" style="--tc1:${t.c1}"><span class="mini">${t.tri}</span><img src="${teamLogo(t.tri)}" alt="" loading="lazy" onerror="this.remove()"></div>`;
  const p = player(pid);
  const c = TEAMS[p?.team]?.c1 || '#1d3361';
  return `<div class="thumb ${cls}" style="--tc1:${c}"><span class="mini">${esc(initials(p?.name))}</span>${pid != null ? `<img src="${headshot(pid)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div>`;
}

function gchip(n) {
  return `<span class="gchip ${n >= 4 ? 'g4' : n <= 2 ? 'g2' : ''}">${n}G</span>`;
}

// ---------- Render ----------

function render() {
  if (!S.league) return;
  renderTop();
  renderTabs();
  renderTicker();
  renderFooter();
  const signedIn = !!myId();
  let html;
  if (signedIn && !S.me) html = viewProfileSetup();
  else if (!signedIn && (S.view === 'week' || S.view === 'rivals' || S.view === 'cards')) html = viewAuth();
  else if (S.view === 'admin') html = S.isAdmin ? viewAdmin() : viewWeek();
  else html = ({ week: viewWeek, cards: viewCards, standings: viewStandings, survivor: viewSurvivor, results: viewResults, burns: viewBurns, rivals: viewRivals, trophies: viewTrophies, rules: viewRules })[S.view]();
  $('#app').innerHTML = html;
  tick();
}

function renderTop() {
  const el = $('#topbar-right');
  if (S.me) {
    el.innerHTML = `<button class="me-chip" data-act="profile-open" aria-label="Your profile">${avatar(S.me.id)}<span class="nm">${esc(S.me.display_name)}</span></button>`;
  } else {
    el.innerHTML = `<a class="btn small" href="#week">${myId() ? 'Finish sign-up' : 'Sign in'}</a>`;
  }
}

function needsPicks() {
  if (!S.me || S.league.openWeek == null) return false;
  return SLOTS.some(s => !S.db.picks.some(p => p.user_id === myId() && p.week === S.league.openWeek && p.slot === s));
}

function renderTabs() {
  $('#tabs').innerHTML = views().map(([k, label]) => {
    const cardsDot = k === 'cards' && S.me && (waitingPacks().length || unansweredDuels().length);
    const dot = (k === 'week' && needsPicks()) || (k === 'results' && liveWeek()) || cardsDot ? '<span class="dot"></span>' : '';
    return `<a class="tab" role="tab" href="#${k}" aria-selected="${S.view === k}">${label}${dot}</a>`;
  }).join('');
  const sel = $('#tabs [aria-selected="true"]');
  if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderTicker() {
  const items = [];
  const L = S.league;
  const open = L.openWeek != null ? weekObj(L.openWeek) : null;
  if (open) items.push(`<b>WEEK ${open.week} PICKS</b> lock ${esc(lockText(open.lockAt))}`);
  const lw = liveWeek();
  if (lw && lw.entrants.length) {
    for (const s of SLOTS) {
      const best = lw.entrants.map(id => ({ id, r: lw.results[id].slots[s] })).sort((a, b) => b.r.value - a.r.value)[0];
      if (best?.r.scorer != null) items.push(`${INFO[s].emoji} <b>${INFO[s].name.toUpperCase()} LEADER</b> ${esc(userName(best.id))} · ${esc(shortName(best.r.scorer))} ${best.r.value} ${INFO[s].short}`);
    }
  }
  const lastFinal = [...L.weeks].reverse().find(w => w.status === 'final');
  for (const a of lastFinal?.awards || []) {
    if (a.key === 'fumble') continue;
    items.push(`${a.icon} <b>${a.title.toUpperCase()}</b> ${esc(userName(a.user))}${a.pid ? ` · ${esc(shortName(a.pid))}` : ''} · ${esc(a.text)}`);
  }
  const lastLocked = [...lockedWeeks()].pop();
  if (lastLocked) {
    const drama = (L.cards.weeks[lastLocked.week]?.plays || []).filter(p => p.ok && (p.outcome === 'reversed' || p.outcome === 'blocked' || p.hits?.length || p.burned || ['won', 'lost', 'declined'].includes(p.outcome)));
    for (const p of drama.slice(0, 4)) {
      const st = playStory(p, lastLocked);
      items.push(`${st.icon} <b>CARD TABLE</b> ${st.text} · ${st.res}`);
    }
  }
  if (L.survivor.order.length) items.push(`❤️ <b>SURVIVOR</b> ${L.survivor.alive} of ${L.survivor.order.length} still alive`);
  if (L.standings[0] && lockedWeeks().length) items.push(`🏆 <b>TOP OF THE TABLE</b> ${esc(L.standings[0].name)} · ${fmt(L.standings[0].counted)} pts`);
  const t = $('#ticker');
  if (!items.length) { t.classList.add('hide'); return; }
  t.classList.remove('hide');
  const row = items.map(x => `<span>${x}</span><span class="sep">●</span>`).join('');
  t.innerHTML = `<div class="ticker-label">${lw ? 'Live' : 'League'}</div><div class="ticker-track">${row}${row}</div>`;
}

function renderFooter() {
  const m = S.data.meta;
  const stamp = m?.demo ? 'Demo data · simulated stats' : m?.updatedAt ? `Stats updated ${ago(m.updatedAt)} · box scores from NBA.com` : 'Waiting for the first stats sync';
  $('#footer').innerHTML = `<span>${esc(LEAGUE.name)} · ${LEAGUE.season} · free to play, bragging rights only · <button class="link" data-act="whats-new">What's new</button></span><span>${stamp}</span>`;
}

function tick() {
  for (const el of document.querySelectorAll('[data-countdown]')) {
    let ms = Math.max(0, Date.parse(el.dataset.countdown) - now());
    const d = Math.floor(ms / 864e5); ms -= d * 864e5;
    const h = Math.floor(ms / 36e5); ms -= h * 36e5;
    const m = Math.floor(ms / 6e4); ms -= m * 6e4;
    const s = Math.floor(ms / 1e3);
    const cells = el.querySelectorAll('b');
    [d, h, m, s].forEach((v, i) => { if (cells[i]) cells[i].textContent = String(v).padStart(2, '0'); });
    if (Date.parse(el.dataset.countdown) <= now() && !el.dataset.done) { el.dataset.done = '1'; setTimeout(refresh, 1500); }
  }
}

function clock(iso) {
  return `<div class="clock num" data-countdown="${iso}">${['Days', 'Hrs', 'Min', 'Sec'].map(l => `<div><b>--</b><small>${l.toUpperCase()}</small></div>`).join('')}</div>`;
}

// ---------- This Week ----------

function viewWeek() {
  const L = S.league;
  const open = L.openWeek != null ? weekObj(L.openWeek) : null;
  const lw = liveWeek();
  const parts = [];

  if (open) {
    const picked = SLOTS.filter(s => S.db.picks.some(p => p.user_id === myId() && p.week === open.week && p.slot === s)).length;
    parts.push(`
      <section class="hero">
        <div class="hero-row">
          <div>
            <span class="badge open">Picks open</span> ${open.mult === 2 ? '<span class="badge gold">Double week</span>' : ''}
            <h1>Week ${open.week}</h1>
            <div class="sub">${weekRange(open)} · ${picked}/${SLOTS.length} picks saved</div>
          </div>
          <div class="lock-box">
            <div class="kicker" style="color:#dbe4f7">Locks at first tip · ${esc(lockText(open.lockAt))}</div>
            ${clock(open.lockAt)}
          </div>
        </div>
        <div class="bars-strip">
          ${SLOTS.map(s => `<span class="bar-pill">${INFO[s].emoji} Survive: <b>${LEAGUE.bars[s]} ${INFO[s].short}</b></span>`).join('')}
          <span class="bar-pill">Clear <b>${LEAGUE.barsToSurvive} of ${SLOTS.length}</b> to keep your lives · ${hearts(meU()?.lives ?? LEAGUE.lives)}</span>
        </div>
      </section>`);
  } else {
    parts.push(`<section class="hero"><span class="badge final">Season complete</span><h1>That's a wrap</h1><div class="sub">Head to Trophies for the champions and their certificates.</div></section>`);
  }

  if (S.me) parts.push(weekCallouts());
  if (lw) parts.push(viewLive(lw));
  if (open) parts.push(viewPicks(open));
  return `<div class="grid">${parts.join('')}</div>`;
}

function viewLive(w) {
  const r = w.results[myId()];
  const ranked = [...w.entrants].sort((a, b) => w.results[b].score - w.results[a].score);
  const pos = ranked.indexOf(myId()) + 1;
  if (!r) {
    return `<section class="panel"><div class="panel-title"><h2>Week ${w.week} <span class="badge live">Live</span></h2><span class="muted">${weekRange(w)}</span></div>
      <p class="muted">You weren't in this week. Your first week is Week ${S.league.openWeek ?? '—'}.</p></section>`;
  }
  const cards = SLOTS.map(s => {
    const x = r.slots[s];
    const pid = x.copy ? x.copyPid : x.scorer ?? x.pid;
    const bar = LEAGUE.bars[s];
    const pct = Math.min(100, (x.base / bar) * 100);
    const team = isTeamId(pid) ? TEAM_BY_ID[pid] : player(pid)?.team;
    const left = w.leftByTeam?.[team] ?? 0;
    return `<div class="live-slot" data-slot="${s}">
      <div class="live-top">${thumb(pid)}<div><div class="kicker">${INFO[s].emoji} ${INFO[s].name}</div><b>${x.copy ? `🐱 Copying ${esc(userName(x.copy))}` : esc(pname(pid))}</b>
        <div class="dim" style="font-size:12px">${x.copy ? esc(pname(pid)) : `${esc(team || '')} · ${x.gp} played${left ? ` · ${left} left` : ''}${x.usedAlt ? ' · backup in' : ''}${x.auto ? ' · autopilot' : ''}`}</div></div></div>
      <div class="big-num">${x.value}<small>${INFO[s].short}</small>${fxIcons(x)}</div>
      <div class="meter ${x.base >= bar ? 'ok' : ''}"><i style="width:${pct}%"></i></div>
      <div class="meter-cap"><span>Survival bar ${bar}${x.base !== x.value ? ` · your pick has ${x.base}` : ''}</span><span>${x.base >= bar ? 'Cleared ✓' : `${bar - x.base} to go`}</span></div>
      <div class="meter-cap"><span>${fmt(x.rank)} rank pts${x.dd ? ' · 🔥 Double Down' : ''}</span><span>${x.owned > 1 ? `${x.owned} picked him` : 'Unique pick'}</span></div>
    </div>`;
  }).join('');
  const onTrack = r.cleared >= LEAGUE.barsToSurvive;
  return `<section class="panel">
    <div class="panel-title"><h2>Week ${w.week} <span class="badge live">Live</span></h2><a class="btn small" href="#results">Full board →</a></div>
    <div class="scoreline">
      <div class="stat"><b>${fmt(r.score)}</b><small>Points so far</small></div>
      <div class="stat"><b>${pos}<span class="muted" style="font-size:15px">/${w.entrants.length}</span></b><small>Place this week</small></div>
      <div class="stat"><b style="color:${onTrack ? 'var(--green)' : 'var(--orange)'}">${r.cleared}/${SLOTS.length}</b><small>${onTrack ? 'Bars cleared · safe' : 'Bars cleared · in danger'}</small></div>
    </div>
    <div class="live-grid">${cards}</div>
    ${liveCards(w)}
  </section>`;
}

// The card plays that touch you this week.
function liveCards(w) {
  const rows = cardTableRows(w, p => p.user_id === myId() || p.target_id === myId() || p.target === myId());
  const adj = w.results[myId()]?.adj || [];
  if (!rows.length && !adj.length) return '';
  return `<h3 class="kicker" style="margin:16px 0 8px">Cards in play</h3><div class="ct-list">${rows.join('')}</div>`;
}

function viewPicks(open) {
  const u = meU();
  const d = S.draft;
  const cards = SLOTS.map(s => slotCard(s, open, u, d)).join('');
  const complete = SLOTS.every(s => d.slots[s]?.player_id);
  const status = d.dirty ? '<b>Unsaved changes</b>' : complete ? '<b>All four picks saved ✓</b> You can change them until the lock.' : 'Fill all four slots. Empty slots go to Autopilot at the lock.';
  return `<section>
    <div class="panel-title" style="margin-top:4px"><h2>Your Week ${open.week} picks</h2><span class="muted">Each pick scores its total for the week</span></div>
    <div class="slots">${cards}</div>
    <div class="savebar"><span class="state">${status}</span><button class="btn primary" data-act="save" ${d.dirty && !S.busy ? '' : 'disabled'}>${S.busy ? 'Saving…' : 'Save picks'}</button></div>
    <div class="panel section-gap">
      <div class="panel-title"><h2>Jokers</h2><span class="muted">One of each per season</span></div>
      <div class="jokers">${jokerDouble(u, d)}${jokerUnburn(u, open)}</div>
    </div>
  </section>`;
}

function slotCard(s, open, u, d) {
  const sel = d.slots[s];
  const head = `<div class="slot-head"><b>${INFO[s].emoji} ${INFO[s].name}</b><span>${INFO[s].stat}</span></div>`;
  const copy = (openCw()?.plays || []).find(p => p.ok && p.user_id === myId() && p.card === 'copycat' && p.slot === s);
  if (copy) {
    return `<div class="slot-card" data-slot="${s}">${head}
      <div class="slot-empty"><div><div style="font-size:46px">🐱</div><b class="display" style="font-size:20px">Copying ${esc(userName(copy.target_id))}</b>
        <p class="muted" style="font-size:13px;margin:6px 0 0">This slot scores whatever they picked here. Nothing burns, and it counts 0 toward the survival bars.${sel?.player_id ? ' Your own pick here is ignored.' : ''}</p></div></div>
    </div>`;
  }
  if (!sel?.player_id) {
    return `<div class="slot-card" data-slot="${s}">${head}
      <div class="slot-empty"><button class="add-big" data-act="pick" data-slot="${s}" data-which="main"><span class="plus">+</span><b>Choose your ${INFO[s].name.toLowerCase()} pick</b><span>Best ${INFO[s].stat.toLowerCase()} total this week</span></button></div>
    </div>`;
  }
  const ddUsed = u?.doubleDownWeek != null;
  const ddOn = d.dd === s;
  const ddButton = `<button class="dd-toggle" data-act="dd" data-slot="${s}" aria-pressed="${ddOn}" ${ddUsed ? 'disabled' : ''}><span class="x2">×2</span>${ddUsed ? `Double Down used in week ${u.doubleDownWeek}` : ddOn ? 'Double Down is on for this slot' : 'Double Down this slot'}</button>`;
  const actions = `<div class="row-actions"><button class="btn small" data-act="pick" data-slot="${s}" data-which="main">Change pick</button><button class="btn small ghost" data-act="clear-main" data-slot="${s}">Clear</button></div>`;
  if (INFO[s].team) {
    const t = team(sel.player_id);
    const games = open.gamesByTeam?.[t?.tri] ?? 0;
    return `<div class="slot-card" data-slot="${s}">${head}
      <div class="player-stage" style="--tc1:${t?.c1 || '#1d3361'}">
        <span class="mono">${esc(t?.tri || '')}</span>
        ${t ? `<img class="team-logo-big" src="${teamLogo(t.tri)}" alt="" onerror="this.remove()">` : ''}
      </div>
      <div class="player-info"><div class="pname">${esc(pname(sel.player_id))}</div><div class="pmeta">${t ? `${record(t)} this season` : ''}</div></div>
      <div class="statline">
        <div><b>${t ? record(t) : '—'}</b><small>Record</small></div>
        <div><b>${games}</b><small>Games</small></div>
        <div><b>${fmt(Math.round(teamProjection(t?.record, games) * 10) / 10)}</b><small>Proj wins</small></div>
      </div>
      <div class="slot-foot">
        <div class="alt-row"><span class="lbl">Backup</span><span class="dim">Not needed</span></div>
        ${ddButton}${actions}
      </div>
    </div>`;
  }
  const p = player(sel.player_id);
  const t = TEAMS[p?.team];
  const games = open.gamesByTeam?.[p?.team] ?? 0;
  const avg = p?.avg?.[STAT_IDX[s]] ?? 0;
  return `<div class="slot-card" data-slot="${s}">${head}
    <div class="player-stage" style="--tc1:${t?.c1 || '#1d3361'}">
      <span class="jersey">${esc(p?.num || '')}</span>
      ${t ? `<img class="logo" src="${teamLogo(p.team)}" alt="${esc(t.name)}" onerror="this.remove()">` : ''}
      <span class="mono">${esc(initials(p?.name))}</span>
      <img class="shot" src="${headshot(sel.player_id)}" alt="" onerror="this.remove()">
    </div>
    <div class="player-info"><div class="pname">${esc(pname(sel.player_id))}</div><div class="pmeta">${esc(t ? `${t.city} ${t.name}` : p?.team || '')}${p?.pos ? ` · ${esc(p.pos)}` : ''}</div>
      ${openCw()?.embargo[s].has(sel.player_id) ? `<div class="err" style="margin-top:6px">🚫 Embargoed this week by ${esc(userName(openCw().embargo[s].get(sel.player_id).user_id))}. He can't score here: change the pick or add a backup.</div>` : ''}</div>
    <div class="statline">
      <div><b>${fmt(avg)}</b><small>${INFO[s].short}/game</small></div>
      <div><b>${games}</b><small>Games</small></div>
      <div><b>${Math.round(avg * games)}</b><small>Projected</small></div>
    </div>
    <div class="slot-foot">
      <div class="alt-row"><span class="lbl">Backup</span>${sel.alt_id ? `${thumb(sel.alt_id, 'sm')}<span>${esc(shortName(sel.alt_id))}</span><button class="link danger" data-act="clear-alt" data-slot="${s}">Remove</button>` : `<span class="dim">If he sits all week</span><button class="link" data-act="pick" data-slot="${s}" data-which="alt">+ Add</button>`}</div>
      ${ddButton}${actions}
    </div>
  </div>`;
}

function jokerDouble(u, d) {
  let text;
  if (u?.doubleDownWeek != null) text = `Used in week ${u.doubleDownWeek}.`;
  else if (d.dd) text = `Set on your ${INFO[d.dd].name} pick this week. ${d.dirty ? 'Save to lock it in.' : 'It fires when the week locks.'}`;
  else text = 'Double the rank points from one slot in one week. Turn it on from any pick card.';
  return `<div class="joker"><div class="joker-card ${u?.doubleDownWeek != null ? 'used' : ''}">×2</div><div><h4>Double Down</h4><p>${text}</p></div></div>`;
}

function jokerUnburn(u, open) {
  const ub = u?.unburn;
  let body;
  if (ub) {
    const pending = ub.week >= open.week;
    body = `<p>${esc(pname(ub.player_id))} is back in your ${INFO[ub.slot].name} pool${pending ? ' from this week.' : ` (used in week ${ub.week}).`}</p>
      ${pending ? '<button class="link danger" data-act="unburn-undo">Undo</button>' : ''}`;
  } else {
    const any = u && SLOTS.some(s => u.burns[s].size);
    body = `<p>Get one burned player back in one category.</p>${any ? '<button class="link" data-act="unburn-open">Use Un-burn →</button>' : '<p class="dim">Nothing burned yet.</p>'}`;
  }
  return `<div class="joker"><div class="joker-card blue ${ub && ub.week < open.week ? 'used' : ''}">↺</div><div><h4>Un-burn</h4>${body}</div></div>`;
}

// ---------- Picker ----------

function openPicker(slot, which) {
  S.picker = { slot, which, q: '', team: '', sort: 'proj' };
  renderPicker();
  setTimeout(() => $('#picker-q')?.focus(), 30);
}

function renderPicker() {
  const P = S.picker;
  const open = weekObj(S.league.openWeek);
  const title = P.which === 'alt' ? `Backup ${INFO[P.slot].name}` : `${INFO[P.slot].emoji} ${INFO[P.slot].name} pick`;
  const teamMode = !!INFO[P.slot].team;
  const sorts = teamMode
    ? [['proj', 'Projected wins'], ['avg', 'Best record'], ['games', 'Most games'], ['name', 'Name']]
    : [['proj', 'Projected week'], ['avg', `${INFO[P.slot].short} per game`], ['games', 'Most games'], ['name', 'Name']];
  $('#modal-root').innerHTML = `<div class="modal-bg" data-act="close-modal-bg"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head">
      <div class="ttl"><div><div class="kicker">Week ${open.week} · ${INFO[P.slot].stat} total</div><h3>${esc(title)}</h3></div><button class="close-x" data-act="close-modal" aria-label="Close">×</button></div>
      <div class="filters">
        <input id="picker-q" class="input" type="search" placeholder="Search ${teamMode ? 'teams' : 'players'}" value="${esc(P.q)}" autocomplete="off">
        <select id="picker-team" class="input ${teamMode ? 'hide' : ''}"><option value="">All teams</option>${Object.keys(TEAMS).sort().map(t => `<option value="${t}" ${P.team === t ? 'selected' : ''}>${t} · ${TEAMS[t].name}</option>`).join('')}</select>
      </div>
      <div class="pills">${sorts.map(([k, l]) => `<button class="pill" data-act="picker-sort" data-sort="${k}" aria-pressed="${P.sort === k}">${l}</button>`).join('')}</div>
    </div>
    <div class="modal-body" id="picker-list">${pickerRows()}</div>
  </div></div>`;
  $('#picker-q').addEventListener('input', e => { P.q = e.target.value; $('#picker-list').innerHTML = pickerRows(); });
  $('#picker-team').addEventListener('change', e => { P.team = e.target.value; $('#picker-list').innerHTML = pickerRows(); });
}

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function pickerRows() {
  const P = S.picker;
  const open = weekObj(S.league.openWeek);
  if (INFO[P.slot].team) return teamRows(P, open);
  const list = Object.values(S.data.players);
  if (!list.length) return `<div class="empty-state"><div class="ic">⏳</div>The player list arrives with the first stats sync.</div>`;
  const q = norm(P.q);
  const d = S.draft;
  const others = new Map();
  for (const s of SLOTS) {
    const v = d.slots[s];
    if (!v) continue;
    if (v.player_id && !(s === P.slot && P.which === 'main')) others.set(v.player_id, s === P.slot ? 'Your pick here' : `In your ${INFO[s].name}`);
    if (v.alt_id && !(s === P.slot && P.which === 'alt')) others.set(v.alt_id, s === P.slot ? 'Your backup here' : `${INFO[s].name} backup`);
  }
  const rows = list
    .filter(p => (!q || norm(p.name).includes(q) || norm(p.team).includes(q)) && (!P.team || p.team === P.team))
    .map(p => {
      const games = open.gamesByTeam?.[p.team] ?? 0;
      const avg = p.avg?.[STAT_IDX[P.slot]] ?? 0;
      return { p, games, avg, proj: projection(p, P.slot, games), why: blockedReason(S.league, myId(), P.slot, p.id) || others.get(p.id) || null };
    })
    .sort((a, b) => {
      if (P.sort === 'name') return a.p.last.localeCompare(b.p.last);
      if (P.sort === 'avg') return b.avg - a.avg;
      if (P.sort === 'games') return b.games - a.games || b.proj - a.proj;
      return b.proj - a.proj || b.avg - a.avg;
    })
    .slice(0, 150);
  if (!rows.length) return `<div class="empty-state">No players match.</div>`;
  return rows.map(({ p, games, avg, proj, why }) => `
    <button class="prow" data-act="choose" data-pid="${p.id}" ${why ? 'disabled' : ''}>
      ${thumb(p.id)}
      <div><div class="nm">${esc(p.name)}</div>
        <div class="mt">${teamLogo(p.team) ? `<img src="${teamLogo(p.team)}" alt="" onerror="this.remove()">` : ''}${esc(p.team)}${p.pos ? ` · ${esc(p.pos)}` : ''} ${gchip(games)} <span>${fmt(avg)} ${INFO[P.slot].short}/g${p.pre ? ' (preseason)' : ''}</span>${why ? ` <span class="blocked">${esc(why)}</span>` : ''}</div></div>
      <div class="proj"><b>${Math.round(proj)}</b><small>Proj</small></div>
    </button>`).join('');
}

function teamRows(P, open) {
  const q = norm(P.q);
  const pct = r => r.w / Math.max(1, r.w + r.l);
  const rows = Object.entries(TEAMS)
    .map(([tri, t]) => {
      const rec = S.data.teams?.[tri] || { w: 0, l: 0 };
      const games = open.gamesByTeam?.[tri] ?? 0;
      return { tri, t, rec, games, proj: teamProjection(rec, games), why: blockedReason(S.league, myId(), P.slot, t.id) };
    })
    .filter(r => !q || norm(`${r.t.city} ${r.t.name} ${r.tri}`).includes(q))
    .sort((a, b) => {
      if (P.sort === 'name') return a.t.city.localeCompare(b.t.city);
      if (P.sort === 'avg') return pct(b.rec) - pct(a.rec) || b.rec.w - a.rec.w;
      if (P.sort === 'games') return b.games - a.games || b.proj - a.proj;
      return b.proj - a.proj || pct(b.rec) - pct(a.rec);
    });
  if (!rows.length) return `<div class="empty-state">No teams match.</div>`;
  return rows.map(r => `
    <button class="prow" data-act="choose" data-pid="${r.t.id}" ${r.why ? 'disabled' : ''}>
      ${thumb(r.t.id)}
      <div><div class="nm">${esc(r.t.city)} ${esc(r.t.name)}</div>
        <div class="mt">${r.rec.w}–${r.rec.l} ${gchip(r.games)}${r.why ? ` <span class="blocked">${esc(r.why)}</span>` : ''}</div></div>
      <div class="proj"><b>${fmt(Math.round(r.proj * 10) / 10)}</b><small>Proj W</small></div>
    </button>`).join('');
}

function choose(pid) {
  const { slot, which } = S.picker;
  const d = S.draft;
  const cur = d.slots[slot] || { player_id: null, alt_id: null };
  if (which === 'alt') cur.alt_id = pid; else cur.player_id = pid;
  if (cur.alt_id === cur.player_id) cur.alt_id = null;
  d.slots[slot] = cur;
  d.dirty = true;
  closeModal();
  render();
}

function closeModal() { $('#modal-root').innerHTML = ''; S.picker = null; S.play = null; }

async function save() {
  const d = S.draft;
  const ids = SLOTS.flatMap(s => [d.slots[s]?.player_id, d.slots[s]?.alt_id]).filter(x => x != null);
  if (new Set(ids).size !== ids.length) return toast('A player can only fill one spot per week.', true);
  for (const s of SLOTS) if (!d.slots[s]?.player_id && d.slots[s]?.alt_id) return toast(`Add a main ${INFO[s].name} pick before a backup.`, true);
  S.busy = true; render();
  try {
    await S.backend.savePicks(d.week, d.slots, d.dd && d.slots[d.dd]?.player_id ? d.dd : null);
    d.dirty = false;
    toast('Picks saved. Good luck.');
  } catch (e) {
    toast(e.message || 'Could not save picks.', true);
  }
  S.busy = false;
  await refresh();
}

// ---------- Un-burn ----------

function openUnburn() {
  const u = meU();
  const cols = SLOTS.map(s => {
    const items = [...u.burns[s].entries()].sort((a, b) => a[1] - b[1]);
    return `<div class="burn-col" data-slot="${s}"><h3>${INFO[s].emoji} ${INFO[s].name}</h3>${items.length ? items.map(([pid, wk]) => `
      <button class="prow" data-act="unburn-choose" data-slot="${s}" data-pid="${pid}">${thumb(pid)}<div><div class="nm">${esc(pname(pid))}</div><div class="mt">Burned in week ${wk}</div></div><div class="proj"><b>↺</b></div></button>`).join('') : '<p class="dim">Nothing burned.</p>'}</div>`;
  }).join('');
  $('#modal-root').innerHTML = `<div class="modal-bg" data-act="close-modal-bg"><div class="modal" role="dialog" aria-modal="true" aria-label="Un-burn">
    <div class="modal-head"><div class="ttl"><div><div class="kicker">Once a season</div><h3>Un-burn a player</h3></div><button class="close-x" data-act="close-modal" aria-label="Close">×</button></div>
    <p class="muted" style="margin:0">He becomes available again in that category from Week ${S.league.openWeek}. Pick him again and he burns again.</p></div>
    <div class="modal-body pad"><div class="burn-cols">${cols}</div></div></div></div>`;
}

async function unburn(slot, pid) {
  try {
    await S.backend.setUnburn({ slot, player_id: pid, week: S.league.openWeek });
    closeModal();
    toast(`${pname(pid)} is back in your ${INFO[slot].name} pool.`);
  } catch (e) { toast(e.message, true); }
  await refresh();
}

// ---------- Cards ----------

const cardName = c => CARDS[c]?.name || c;
const cardMini = c => CARDS[c] ? `<span class="card-mini r-${CARDS[c].rarity}">${CARDS[c].icon} ${esc(CARDS[c].name)}</span>` : '';
const slotName = s => s ? `${INFO[s].emoji} ${INFO[s].name}` : '';
const byName = (a, b) => a.name.localeCompare(b.name);
const you = (id, cap = false) => id === myId() ? (cap ? 'You' : 'you') : userName(id);
function cw(week) { return S.league.cards.weeks[week] || null; }
function openCw() { return S.league.openWeek != null ? cw(S.league.openWeek) : null; }

function waitingPacks() {
  const u = meU(), ow = S.league.openWeek;
  return u?.cards && ow != null ? u.cards.packs.filter(p => p.step === ow && p.keep == null && !p.auto) : [];
}
function myMainPlay(week) { return (cw(week)?.plays || []).find(p => p.user_id === myId() && p.ok && countsAsPlay(p.card)); }
function hindsightWeek() {
  const ow = S.league.openWeek;
  const w = ow != null ? weekObj(ow - 1) : null;
  return w && w.status === 'final' && w.week >= S.league.cards.from ? w : null;
}
function replyTo(duelId) { return S.db.plays.find(p => p.card === '_reply' && p.user_id === myId() && p.params?.duel === duelId); }
function incomingDuels() { return (openCw()?.plays || []).filter(p => p.ok && p.card === 'duel' && p.target_id === myId()); }
function unansweredDuels() { return incomingDuels().filter(p => !replyTo(p.id)); }
// Season-points order before this week: what Blue Shell and Heist look at.
function pointsOrder() { return Object.values(S.league.users).filter(u => Object.keys(u.weekly).length).sort((a, b) => b.total - a.total || byName(a, b)); }

// Whether a card in your hand can be played now, and on which week.
function cardUse(inst) {
  const ow = S.league.openWeek;
  if (ow == null) return { why: 'The season is over.' };
  const c = inst.card;
  if (isHindsight(c)) {
    const hw = hindsightWeek();
    if (!hw) return { why: `Works on a finished week. Week ${ow - 1} isn't final yet.` };
    if (inst.step > hw.week) return { why: `New this week, so it can rewrite Week ${ow} once that's final.` };
    const used = myMainPlay(hw.week);
    if (used) return { why: `You already played ${cardName(used.card)} on Week ${hw.week}.` };
    if (!weekObj(hw.week).results[myId()]) return { why: `You had no picks in Week ${hw.week}.` };
    return { week: hw.week };
  }
  if (countsAsPlay(c)) {
    const used = myMainPlay(ow);
    if (used) return { why: `One card a week: you've played ${cardName(used.card)}.` };
  }
  if (c === 'embargo' && Date.parse(weekObj(ow).lockAt) - now() < LEAGUE.cards.embargoHours * 3600e3) return { why: `An Embargo needs ${LEAGUE.cards.embargoHours} hours' notice before the lock.` };
  return { week: ow };
}

function fxTitle(f) {
  return `${CARDS[f.card]?.name || ''}${f.who ? ` · ${userName(f.who)}` : ''}${f.reversed ? ' (bounced back)' : ''}${f.note ? ` · ${f.note}` : ''}`;
}
function fxIcons(x) {
  return (x.fx || []).map(f => `<span class="fx" title="${esc(fxTitle(f))}">${CARDS[f.card]?.icon || ''}</span>`).join('');
}
function adjChip(r) {
  if (!r.adj?.length) return '';
  const sum = r.adj.reduce((a, x) => a + x.pts, 0);
  const title = r.adj.map(x => `${CARDS[x.card].name} ${x.pts > 0 ? '+' : ''}${fmt(x.pts)}${x.who ? ` (${userName(x.who)})` : ''}`).join(', ');
  return `<span class="adj ${sum >= 0 ? 'up' : 'down'}" title="${esc(title)}">${sum > 0 ? '+' : ''}${fmt(sum)} 🃏</span>`;
}
// Clown nose, nickname and the duel chicken, for one week.
function decor(id, week, inline = false) {
  const c = cw(week);
  if (!c) return '';
  const cos = c.cosmetics[id];
  let h = '';
  if (cos?.clown) h += `<span class="cos" title="Clown Nose from ${esc(userName(cos.clown))}">🤡</span>`;
  if (c.chickens.has(id)) h += '<span class="cos" title="Ducked a duel">🐔</span>';
  if (cos?.nickname) h += `<span class="nick" ${inline ? 'style="display:inline;margin-left:6px"' : ''} title="Nickname from ${esc(userName(cos.nickname.by))}">“${esc(NICKNAMES[cos.nickname.nick])}”</span>`;
  return h;
}

const FIZZ = {
  cap: 'Fizzled: they were already hit twice. Card returned',
  'not-above': "Fizzled: they weren't above you. Card returned",
  'you-lead': 'Fizzled: you were the leader. Card returned',
  'no-target': 'Fizzled: no target. Card returned',
  burned: 'Fizzled: a player was burned in his new slot. Card returned',
  'bad-swap': 'Fizzled. Card returned',
  'one-game': 'Fizzled: needs a pick with 2+ games. Card returned',
  'already-picked': 'Fizzled: he was already one of your picks. Card returned',
};

// One line of the card table: what was played, on whom, and what happened.
function playStory(p, w) {
  const d = CARDS[p.card];
  const A = `<b>${esc(you(p.user_id, true))}</b>`;
  const T = id => `<b>${esc(you(id))}</b>`;
  const Tp = id => `<b>${esc(id === myId() ? 'your' : `${userName(id)}'s`)}</b>`;
  const P = pid => `<b>${esc(pname(pid))}</b>`;
  const hit = h => `${INFO[h.slot].name} ${fmt(h.before)} → ${fmt(h.after)}`;
  if (p.why === 'not-in-hand') return { icon: '🚨', text: `${A} tried to play ${esc(d?.name || p.card)} without holding it. Nice try.`, res: 'No effect', cls: 'bad' };
  if (p.card === 'gift') return { icon: '🎁', text: `${A} gifted ${T(p.target_id)} ${cardMini(p.gift)}`, res: w.status === 'open' ? 'Arrives next week' : 'Delivered', cls: 'good' };
  const text = {
    jinx: () => `${A} jinxed ${Tp(p.target_id)} ${P(p.player_id)}`,
    load: () => `${A} put ${Tp(p.target_id)} ${slotName(p.slot)} pick on load management`,
    heist: () => `${A} pulled a heist on ${T(p.target_id)}`,
    blue_shell: () => `${A} fired a Blue Shell${p.target ? ` at the leader, ${T(p.target)}` : ''}`,
    burn_notice: () => `${A} served ${T(p.target_id)} a Burn Notice: ${P(p.player_id)} in ${slotName(p.slot)}`,
    clown: () => `${A} put a clown nose on ${T(p.target_id)}`,
    nickname: () => `${A} renamed ${T(p.target_id)} “${esc(NICKNAMES[p.params?.nick] || '')}”`,
    sixth: () => `${A} brought ${P(p.player_id)} off the bench`,
    copycat: () => `${A} copied ${Tp(p.target_id)} ${slotName(p.slot)} pick`,
    leech: () => `${A} latched onto ${Tp(p.target_id)} ${slotName(p.slot)}`,
    switcheroo: () => `${A} pulled a Switcheroo`,
    garbage: () => `${A} called Garbage Time on ${slotName(p.slot)}`,
    embargo: () => `${A} embargoed ${P(p.player_id)} in ${slotName(p.slot)} for everyone`,
    scout: () => `${A} scouted the ${slotName(p.slot)} board`,
    duel: () => `${A} challenged ${T(p.target_id)} to a duel on ${slotName(p.slot)}`,
    charge: () => `${A} has a trap set`,
    reverse: () => `${A} has a trap set`,
  }[p.card]?.() || `${A} played ${esc(d?.name)}`;

  let res = '', cls = '';
  const live = w.status === 'live' ? ' (so far)' : '';
  if (w.status === 'open') res = p.card === 'embargo' ? 'Live now' : p.card === 'duel' ? 'Settles after the week' : 'Revealed at the lock';
  else if (p.outcome === 'blocked') { res = `🛡️ ${esc(userName(p.target))} took the charge`; cls = 'gold'; }
  else if (p.outcome === 'fizzled') res = FIZZ[p.why] || 'Fizzled';
  else {
    const rev = p.outcome === 'reversed' ? `🔄 Bounced back by ${esc(you(p.target))}! ` : '';
    if (rev) cls = 'gold';
    switch (p.card) {
      case 'jinx': res = p.hits?.length ? `${rev}Hit · ${p.hits.map(hit).join(', ')}` : `${rev}Air ball`; cls ||= p.hits?.length ? 'bad' : ''; break;
      case 'load': res = p.hits?.length ? `${rev}${hit(p.hits[0])}` : `${rev}No effect`; cls ||= p.hits?.length ? 'bad' : ''; break;
      case 'heist': res = p.pts ? `${rev}${p.pts} pts stolen` : `${rev}Came up empty`; cls ||= 'bad'; break;
      case 'blue_shell': res = p.hits?.length ? `${rev}${INFO[p.hits[0].slot].name} ${fmt(p.hits[0].before)} → ${fmt(p.hits[0].after)} rank pts` : `${rev}Missed`; cls ||= 'bad'; break;
      case 'burn_notice': res = p.burned ? `${rev}Burned for the season` : `${rev}He was already burned`; cls ||= p.burned ? 'bad' : ''; break;
      case 'clown': case 'nickname': res = rev ? `${rev}They wear it` : 'Landed'; break;
      case 'sixth': res = p.outcome === 'played' ? `Subbed into ${INFO[p.slot].name}: ${fmt(p.before)} → ${fmt(p.after)}${live}` : 'Stayed on the bench'; cls = p.outcome === 'played' ? 'good' : ''; break;
      case 'copycat': res = `${fmt(p.value ?? 0)} ${INFO[p.slot].short}${live}`; cls = 'good'; break;
      case 'leech': res = `+${fmt(p.pts || 0)} pts${live}`; cls = 'good'; break;
      case 'switcheroo': res = (p.moves || []).filter(m => m.from !== m.to).map(m => `${esc(shortName(m.pid))} → ${INFO[m.to].name} (${m.value})`).join(', '); cls = 'good'; break;
      case 'garbage': res = `${fmt(p.before)} → ${fmt(p.after)}`; cls = 'good'; break;
      case 'embargo': res = `${p.victims?.length || 0} pick${p.victims?.length === 1 ? '' : 's'} blocked`; break;
      case 'scout': res = 'Intel gathered'; break;
      case 'duel':
        res = p.outcome === 'declined' ? '🐔 Declined' : p.outcome === 'push' ? 'Push' : p.outcome === 'void' ? 'No contest'
          : `${esc(you(p.outcome === 'won' ? p.user_id : p.target_id, true))} ${(p.outcome === 'won' ? p.user_id : p.target_id) === myId() ? 'take' : 'takes'} ${p.pts}${live}`;
        cls = p.outcome === 'declined' ? 'gold' : ''; break;
    }
  }
  return { icon: d?.icon || '🃏', text, res, cls };
}

function cardTableRows(w, filter = () => true) {
  const c = cw(w.week);
  if (!c) return [];
  return c.plays.filter(p => {
    if (!filter(p)) return false;
    if (p.why === 'not-in-hand') return w.status !== 'open';
    if (!p.ok || isTrap(p.card)) return false; // traps show up with the attack they stopped
    if (w.status === 'open') return p.user_id === myId() || p.card === 'embargo' || (p.card === 'duel' && p.target_id === myId());
    return true;
  }).map(p => {
    const st = playStory(p, w);
    const taunt = p.params?.taunt != null && TAUNTS[p.params.taunt] ? `<q>${esc(TAUNTS[p.params.taunt])}</q>` : '';
    const me = [p.user_id, p.target_id, p.target].includes(myId());
    return `<div class="ct-row ${me ? 'me' : ''}"><div class="ic">${st.icon}</div><div class="txt">${st.text}${taunt}</div><div class="res ${st.cls}">${st.res}</div></div>`;
  });
}

function cardTablePanel(w) {
  if (w.week < S.league.cards.from) return '';
  const rows = cardTableRows(w);
  return `<section class="panel"><div class="panel-title"><h2>Card table · Week ${w.week}</h2><span class="muted">${w.status === 'live' ? 'Live: points can still swing' : 'Every card played, and what it did'}</span></div>
    ${rows.length ? `<div class="ct-list">${rows.join('')}</div>` : '<p class="muted" style="margin:0">Nobody played a card this week. Suspiciously peaceful.</p>'}</section>`;
}

function weekCallouts() {
  const out = [];
  const packs = waitingPacks();
  if (packs.length) out.push(`<div class="callout gold"><span class="ic">📦</span><div class="txt"><b>${packs.length} pack${packs.length > 1 ? 's' : ''} waiting.</b> Open ${packs.length > 1 ? 'them' : 'it'} before the lock, or the first card is kept for you.</div><a class="btn small gold" href="#cards">Open</a></div>`);
  for (const d of unansweredDuels()) out.push(`<div class="callout purple"><span class="ic">⚔️</span><div class="txt"><b>${esc(userName(d.user_id))}</b> challenged you to a duel on ${slotName(d.slot)}. No answer by the lock means you accepted.</div><a class="btn small" href="#cards">Answer</a></div>`);
  const emb = (openCw()?.plays || []).filter(p => p.ok && p.card === 'embargo');
  if (emb.length) out.push(`<div class="callout red"><span class="ic">🚫</span><div class="txt">Embargo this week: ${emb.map(e => `<b>${esc(pname(e.player_id))}</b> can't be used for ${INFO[e.slot].name} (thanks, ${esc(userName(e.user_id))})`).join('; ')}.</div></div>`);
  return out.length ? `<div class="grid" style="gap:10px">${out.join('')}</div>` : '';
}

function viewCards() {
  const L = S.league, u = meU(), ow = L.openWeek;
  const packs = waitingPacks();
  const hand = u.cards.hand;
  const main = ow != null ? myMainPlay(ow) : null;
  const parts = [];
  const dex = collected(u);
  const albumN = u.cards.album.size;
  const ownPicked = ow != null && S.db.picks.some(p => p.user_id === myId() && p.week === ow && !p.auto);
  const slotsHtml = Array.from({ length: LEAGUE.cards.handLimit }, (_, i) => `<i class="${i < hand.length ? 'on' : ''}"></i>`).join('');
  parts.push(`<section class="hero cards-hero hud">
    <div class="hud-head"><span class="badge gold">Joker cards</span><h1>The card table</h1></div>
    <div class="hud-row">
      <div class="hud-tile"><small>Hand</small><div class="hand-slots">${slotsHtml}</div><b>${hand.length}/${LEAGUE.cards.handLimit}</b></div>
      <div class="hud-tile ${main ? 'used' : 'ready'}"><small>This week's play</small><b>${main ? `✓ ${esc(cardName(main.card))}` : ow != null ? '⚡ Ready' : '—'}</b></div>
      <div class="hud-tile"><small>Traps armed</small><b>${u.cards.armed.length ? '🛡️'.repeat(u.cards.armed.length) : '0'}</b></div>
      <div class="hud-tile"><small>Card Dex</small><b>${dex.size}/${Object.keys(CARDS).length}</b><span class="hud-bar"><i style="width:${dex.size / Object.keys(CARDS).length * 100}%"></i></span></div>
      <div class="hud-tile"><small>Album</small><b>${albumN}/30</b><span class="hud-bar"><i style="width:${albumN / 30 * 100}%"></i></span></div>
    </div>
    ${L.cards.from === Infinity ? `<p class="sub" style="margin:12px 0 0">Cards switch on once the commissioner finishes setting them up. Everyone gets a Starter Pack then.</p>`
      : ow != null && ow < L.cards.from ? `<p class="sub" style="margin:12px 0 0">Cards switch on in Week ${L.cards.from}. Everyone gets a Starter Pack then.</p>`
      : ow != null ? `<div class="next-pack ${ownPicked ? 'done' : ''}">${ownPicked ? `✓ Next week's Locker Room Pack is secured.` : `🎁 Save your own Week ${ow} picks to earn next week's Locker Room Pack.`}</div>` : ''}
    ${packs.length ? `<div class="packs-row">${packs.map(p => `<button class="pack-mini" data-act="pack-open" data-key="${esc(p.key)}" aria-label="Open pack"><div class="shell">${packArt(p)}</div><span class="btn small gold">Open</span></button>`).join('')}</div>` : ''}
    ${DEMO ? '<div style="margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn small" data-act="pack-practice">Rip a practice pack</button><span style="font-size:12px;color:#dbe4f7">Demo only. Nothing is saved.</span></div>' : ''}
  </section>`);

  parts.push(primerPanel(u));

  const over = hand.length - LEAGUE.cards.handLimit;
  parts.push(`<section class="panel"><div class="panel-title"><h2>Your hand</h2><span class="muted">Tap a card to play or gift it</span></div>
    ${over > 0 ? `<div class="callout red" style="margin-bottom:14px"><span class="ic">⚠️</span><div class="txt">You're over the ${LEAGUE.cards.handLimit}-card limit. At the lock your oldest ${over === 1 ? 'card is' : `${over} cards are`} discarded, so play or gift something first.</div></div>` : ''}
    ${hand.length ? `<div class="hand">${hand.map(h => {
      const use = cardUse(h);
      const note = use.why || (isTrap(h.card) ? 'Ready to arm' : isHindsight(h.card) ? `Ready for Week ${use.week}` : 'Ready to play');
      return `<button class="hand-card" data-act="card-open" data-uid="${esc(h.uid)}">${cardFace(h.card, { cls: 'tilt' })}<span class="why">${esc(note)}${h.from === 'gift' ? ` · 🎁 from ${esc(userName(h.by))}` : ''}</span></button>`;
    }).join('')}</div>`
      : `<div class="empty-state"><div class="ic">🃏</div>${packs.length ? 'Open a pack to get started.' : 'No cards yet. You get a Locker Room Pack every week you make your own picks.'}</div>`}
    ${u.cards.armed.length ? `<div class="armed">${u.cards.armed.map(a => `<div class="armed-item">${cardBack()}<div><b>${esc(cardName(a.card))}</b><div class="dim">Armed face-down since Week ${a.armedWeek}. Springs on the next attack or prank.</div></div></div>`).join('')}</div>` : ''}
  </section>`);

  if (ow != null) parts.push(thisWeekCards(ow));

  parts.push(achievementsPanel(u, dex));

  const weeks = lockedWeeks().filter(w => w.week >= L.cards.from);
  if (weeks.length) {
    const w = weeks.find(x => x.week === S.cardsWeek) || weeks[weeks.length - 1];
    const rows = cardTableRows(w);
    parts.push(`<section class="panel"><div class="panel-title"><h2>The reveal</h2>
        <div class="pills">${weeks.map(x => `<button class="pill ${x.status === 'live' ? 'live' : ''}" data-act="cards-week" data-week="${x.week}" aria-pressed="${x.week === w.week}">Wk ${x.week}</button>`).join('')}</div></div>
      ${rows.length ? `<div class="ct-list">${rows.join('')}</div>` : '<p class="muted" style="margin:0">Nobody played a card that week.</p>'}</section>`);
  }
  parts.push(albumPanel(u));
  parts.push(deckPanel());
  return `<div class="grid">${parts.join('')}</div>`;
}

function thisWeekCards(ow) {
  const c = openCw();
  const hw = hindsightWeek();
  const mine = [...(c?.plays || []), ...(hw ? cw(hw.week)?.plays || [] : [])].filter(p => p.user_id === myId() && (p.week === ow || isHindsight(p.card)));
  const rows = mine.map(p => {
    const st = playStory(p, weekObj(p.week));
    const note = p.ok ? '' : ` <span class="dim">(${p.why === 'limit' ? "doesn't count: one card a week" : p.why === 'not-in-hand' ? 'card not in your hand' : 'not valid'})</span>`;
    const extra = p.card === 'scout' && p.ok ? `<button class="btn small" data-act="scout-view" data-week="${p.week}" data-slot="${p.slot}">See report</button>` : '';
    const what = isTrap(p.card) ? `You armed ${esc(cardName(p.card))} face-down${p.sprung ? `. It sprang in Week ${p.sprung}` : ''}` : st.text;
    return `<div class="ct-row me"><div class="ic">${st.icon}</div><div class="txt">${what}${note}</div><div style="display:flex;gap:8px;align-items:center">${extra}${p.card === 'scout' ? '' : `<button class="link danger" data-act="play-undo" data-id="${esc(p.id)}">Take back</button>`}</div></div>`;
  });
  const duels = incomingDuels().map(p => {
    const r = replyTo(p.id);
    const taunt = p.params?.taunt != null ? ` <i class="muted">“${esc(TAUNTS[p.params.taunt])}”</i>` : '';
    return `<div class="duel-card"><span style="font-size:26px">⚔️</span><div class="txt"><b>${esc(userName(p.user_id))}</b> challenged you on ${slotName(p.slot)}. Winner takes ${LEAGUE.cards.duelStake} points.${taunt}</div>
      ${r ? `<span class="tag ${r.params?.accept ? 'green' : 'gold'}">${r.params?.accept ? 'Accepted' : 'Declined 🐔'}</span><button class="link" data-act="play-undo" data-id="${esc(r.id)}">Change</button>`
        : `<button class="btn small gold" data-act="duel-reply" data-id="${esc(p.id)}" data-to="${p.user_id}" data-accept="1">Accept</button><button class="btn small" data-act="duel-reply" data-id="${esc(p.id)}" data-to="${p.user_id}" data-accept="0">Decline 🐔</button>`}</div>`;
  });
  const embargoes = (c?.plays || []).filter(p => p.ok && p.card === 'embargo' && p.user_id !== myId())
    .map(p => `<div class="callout red"><span class="ic">🚫</span><div class="txt"><b>${esc(userName(p.user_id))}</b> embargoed <b>${esc(pname(p.player_id))}</b> in ${slotName(p.slot)}. Nobody can use him there this week.</div></div>`);
  return `<section class="panel"><div class="panel-title"><h2>Week ${ow} at the table</h2><span class="muted">Locks ${esc(lockText(weekObj(ow).lockAt))}. You can take a card back until then.</span></div>
    <div class="grid" style="gap:10px">${duels.join('')}${embargoes.join('')}
    ${rows.length ? `<div class="ct-list">${rows.join('')}</div>` : `<p class="muted" style="margin:0">You haven't played a card this week.${hw ? ` Hindsight cards can still rewrite Week ${hw.week}.` : ''}</p>`}</div>
  </section>`;
}

function albumPanel(u) {
  const album = u.cards.album;
  return `<section class="panel"><div class="panel-title"><h2>Sticker album</h2><span class="muted">Every player who scores for you adds his team. Finish a division for an Album Pack.</span></div>
    <div class="album">${Object.entries(DIVISIONS).map(([div, teams]) => {
      const done = u.cards.divisions.includes(div);
      return `<div class="album-div ${done ? 'done' : ''}"><h4><span>${div}</span><span class="${done ? '' : 'dim'}">${done ? '✓ Pack earned' : `${teams.filter(t => album.has(t)).length}/5`}</span></h4>
        <div class="stickers">${teams.map(t => `<span class="sticker ${album.has(t) ? '' : 'off'}" title="${esc(`${TEAMS[t].city} ${TEAMS[t].name}`)}"><img src="${teamLogo(t)}" alt="${t}" loading="lazy" onerror="this.outerHTML='${t}'"></span>`).join('')}</div></div>`;
    }).join('')}</div></section>`;
}

// Every card you've held: kept from packs, gifted to you, in your hand or played.
function collected(u) {
  const set = new Set();
  for (const p of u.cards.packs) if (p.cards && (p.keep != null || p.auto)) set.add(p.cards[p.keep ?? 0]);
  for (const h of [...u.cards.hand, ...u.cards.armed, ...u.cards.discarded]) set.add(h.card);
  for (const c of Object.values(S.league.cards.weeks)) for (const p of c.plays || []) if (p.user_id === myId() && p.ok && CARDS[p.card]) set.add(p.card);
  return set;
}

// The short version. Open until you've played a card; every detail is one tap away in the Card Dex.
function primerPanel() {
  const C = LEAGUE.cards;
  const played = S.db.plays?.some(p => p.user_id === myId() && p.card !== '_keep');
  const open = S.primerOpen ?? !played;
  return `<section class="panel primer" id="primer">
    <details ${open ? 'open' : ''} data-primer>
      <summary><span class="primer-badge">FYI</span><span class="primer-title">How cards work</span><span class="chev">▾</span></summary>
      <div class="primer-body">
        <div class="primer-quick">
          <div><b>1</b><span>Earn packs</span><small>Make your own picks each week</small></div>
          <div><b>2</b><span>Keep 1 of 3</span><small>Up to ${C.handLimit} in your hand</small></div>
          <div><b>3</b><span>Play 1 a week</span><small>Before the lock</small></div>
          <div><b>4</b><span>The reveal</span><small>Everything shows at the lock</small></div>
        </div>
        <ul class="primer-list">
          <li>🎁 <b>Bonus packs</b> for weekly awards, losing a life and finishing an album division.</li>
          <li>🛡️ <b>Traps and gifts are free</b>: they don't use up your weekly play.</li>
          <li>🚦 Nobody can be hit by more than <b>${C.attackCap} attacks a week</b>. Extras fizzle and the card goes back to its owner.</li>
          <li>❤️ Cards move points, <b>never lives</b>.</li>
        </ul>
        <p class="note" style="margin:10px 0 0">Tap any card in the <button class="link" data-act="dex-scroll">Card Dex</button> to see exactly what it does.</p>
      </div>
    </details>
  </section>`;
}

function achievementsPanel(u, dex) {
  const mine = Object.values(S.league.cards.weeks).flatMap(c => (c.plays || []).filter(p => p.user_id === myId() && p.ok));
  const duelsWon = Object.values(S.league.cards.weeks).flatMap(c => c.plays || [])
    .filter(p => p.ok && p.card === 'duel' && ((p.user_id === myId() && p.outcome === 'won') || (p.target_id === myId() && p.outcome === 'lost'))).length;
  const played = mine.filter(p => countsAsPlay(p.card)).length;
  const kinds = new Set([...dex].map(c => CARDS[c].type)).size;
  const opened = u.cards.packs.filter(p => p.keep != null || p.auto).length;
  const list = [
    { icon: '🎴', name: 'Pack Rat', how: 'Open your first pack', n: opened, of: 1 },
    { icon: '🃏', name: 'Card Shark', how: 'Play 5 cards', n: played, of: 5 },
    { icon: '🎯', name: 'First Blood', how: 'Land an attack', n: mine.filter(p => ['attack'].includes(CARDS[p.card]?.type) && p.outcome === 'landed').length, of: 1 },
    { icon: '🪤', name: "It's a Trap", how: 'Spring a trap', n: mine.filter(p => isTrap(p.card) && p.sprung).length, of: 1 },
    { icon: '⚔️', name: 'Duelist', how: 'Win a duel', n: duelsWon, of: 1 },
    { icon: '🎁', name: 'Secret Santa', how: 'Gift a card', n: mine.filter(p => p.card === 'gift').length, of: 1 },
    { icon: '📒', name: 'Collector', how: 'Finish an album division', n: u.cards.divisions.length, of: 1 },
    { icon: '💎', name: 'Shiny', how: 'Hold a legendary', n: [...dex].filter(c => CARDS[c].rarity === 'legendary').length, of: 1 },
    { icon: '🌈', name: 'Full Spectrum', how: 'Hold every kind of card', n: kinds, of: Object.keys(TYPES).length },
    { icon: '👑', name: 'Card Master', how: 'Complete the Card Dex', n: dex.size, of: Object.keys(CARDS).length },
  ];
  const done = list.filter(a => a.n >= a.of).length;
  return `<section class="panel"><div class="panel-title"><h2>Achievements</h2><span class="muted">${done} of ${list.length} unlocked</span></div>
    <div class="badges">${list.map(a => {
      const ok = a.n >= a.of;
      return `<div class="badge-tile ${ok ? 'on' : ''}" title="${esc(a.how)}"><span class="ic">${a.icon}</span><b>${esc(a.name)}</b><small>${esc(a.how)}</small>
        ${ok ? '<span class="got">Unlocked</span>' : a.of > 1 ? `<span class="hud-bar"><i style="width:${Math.min(100, a.n / a.of * 100)}%"></i></span><span class="prog">${Math.min(a.n, a.of)}/${a.of}</span>` : '<span class="prog">Locked</span>'}</div>`;
    }).join('')}</div></section>`;
}

const CARD_TIPS = {
  jinx: 'Best when you can guess their pick, like a star with four games this week.',
  load: 'Hits hardest on a pick who had one monster game.',
  heist: 'Only works on someone above you in season points.',
  blue_shell: "Always finds the leader at the lock. Fizzles if that's you.",
  burn_notice: "It lasts all season, so pick a player they'd want later.",
  clown: 'No effect on points. Maximum disrespect.',
  nickname: 'No effect on points. The name sticks all week.',
  charge: "Free to arm. It doesn't use up your weekly play.",
  reverse: "Free to arm. It doesn't use up your weekly play.",
  sixth: "Name someone with a big week. He only subs in if it helps.",
  copycat: 'Nothing burns for you, but the slot counts 0 toward survival.',
  leech: "They lose nothing, so pick whoever's hottest.",
  switcheroo: 'Play it after a week ends, before the next lock.',
  garbage: 'Needs a pick who played at least two games.',
  embargo: 'Everyone sees it straight away and can change their picks.',
  scout: "Can't be taken back once you've read it.",
  duel: 'Declining earns a 🐔 for the week. No answer counts as accepted.',
};

function cardWhen(c) {
  if (c === 'embargo') return `At least ${LEAGUE.cards.embargoHours} hours before the lock`;
  return { trap: 'Arm any time. Springs on the next attack or prank on you', hindsight: 'After a week ends, before the next lock' }[CARDS[c].type] || 'Any time before the lock';
}

function deckPanel() {
  const order = Object.keys(RARITY);
  const list = Object.keys(CARDS).sort((a, b) => order.indexOf(CARDS[a].rarity) - order.indexOf(CARDS[b].rarity));
  const dex = collected(meU());
  return `<section class="panel dex-panel" id="dex"><div class="panel-title dex-title"><h2>Card Dex</h2><span class="muted">${dex.size} of ${list.length} collected · tap a card to see what it does</span></div>
    <div class="deck">${list.map(c => `<button class="dex-slot ${dex.has(c) ? 'got' : 'unseen'}" data-act="dex-open" data-card="${c}" aria-label="${esc(CARDS[c].name)}">${cardFace(c, { cls: 'tilt' })}${dex.has(c) ? '' : '<span class="dex-q">?</span>'}</button>`).join('')}</div>
  </section>`;
}

function openDex(c) {
  const d = CARDS[c], r = RARITY[d.rarity], t = TYPES[d.type];
  const held = meU()?.cards.hand.filter(h => h.card === c) || [];
  const got = collected(meU()).has(c);
  $('#modal-root').innerHTML = `<div class="modal-bg" data-act="close-modal-bg"><div class="modal dex-modal" role="dialog" aria-modal="true" aria-label="${esc(d.name)}">
    <button class="close-x dex-x" data-act="close-modal" aria-label="Close">×</button>
    <div class="dex-layout">
      <div class="dex-big">${cardFace(c)}</div>
      <div class="dex-info">
        <div class="kicker"><span class="type-chip" style="--tc:${t.color}">${esc(t.label)}</span> <span style="color:${r.color}">${'★'.repeat(r.stars)} ${esc(r.label)}</span></div>
        <h3>${d.icon} ${esc(d.name)}</h3>
        <p class="dex-text">${esc(d.text)}</p>
        <dl class="dex-facts">
          <dt>When</dt><dd>${esc(cardWhen(c))}</dd>
          <dt>Uses your weekly play</dt><dd>${countsAsPlay(c) ? 'Yes' : "No, it's free"}</dd>
          <dt>Revealed</dt><dd>${c === 'embargo' ? 'Straight away, to everyone' : c === 'duel' ? 'To your opponent straight away, to everyone at the lock' : isTrap(c) ? 'When it springs' : 'At the lock'}</dd>
          ${d.comeback ? '<dt>Who can pull it</dt><dd>The bottom half of the standings, or a Revenge Pack</dd>' : ''}
        </dl>
        <p class="dex-tip">💡 ${esc(CARD_TIPS[c] || '')}</p>
        ${held.length ? `<div class="dex-own"><span class="tag green">In your hand${held.length > 1 ? ` ×${held.length}` : ''}</span><button class="btn primary" data-act="card-open" data-uid="${esc(held[0].uid)}">Play or gift it</button></div>`
          : `<p class="muted" style="margin:0">${got ? "You've had this one before." : `Not collected yet. It's ${r.label.toLowerCase()}, so keep opening packs.`}</p>`}
      </div>
    </div>
  </div></div>`;
}

// ---------- Opening packs ----------

async function openWaitingPack(key) {
  const pack = waitingPacks().find(p => p.key === key);
  if (!pack) return;
  const kept = await openPack({
    pack, cards: pack.cards,
    onKeep: pick => S.backend.savePlay({ week: pack.step, card: '_keep', card_uid: `pack:${pack.key}`, params: { pick } }),
  });
  if (kept != null) toast(`${cardName(pack.cards[kept])} is in your hand.`);
  await refresh();
}

async function practicePack() {
  const kinds = ['starter', 'locker', 'award', 'revenge', 'album'];
  const kind = kinds[Math.floor(Math.random() * kinds.length)];
  const pack = { key: 'practice', kind, step: S.league.openWeek ?? 1, label: kind === 'album' ? 'Atlantic' : 'Heater' };
  const cards = dealPack(`practice-${Date.now()}-${Math.random()}`, 'practice', Math.random() < 0.4 ? 'album' : 'revenge', 'trail');
  await openPack({ pack, cards, practice: true, onKeep: async () => {} });
}

// ---------- Playing a card ----------

function openPlay(uid) {
  const inst = meU()?.cards.hand.find(h => h.uid === uid);
  if (!inst) return;
  S.play = { uid, card: inst.card, inst, mode: 'play', target: '', slot: '', player: null, q: '', nick: '', taunt: '', map: { PTS: 'PTS', REB: 'REB', AST: 'AST' }, giftTo: '' };
  renderPlay();
}

function renderPlay() {
  const P = S.play;
  const d = CARDS[P.card];
  const use = cardUse(P.inst);
  const gift = P.mode === 'gift';
  const body = gift ? giftForm() : use.why ? `<p style="margin:0;color:#c7d3ee">${esc(d.text)}</p><div class="callout"><span class="ic">⏳</span><div class="txt">${esc(use.why)}</div></div>` : playForm(use);
  $('#modal-root').innerHTML = `<div class="modal-bg" data-act="close-modal-bg"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(d.name)}">
    <div class="modal-head"><div class="ttl"><div><div class="kicker">${TYPES[d.type].label} · ${RARITY[d.rarity].label}</div><h3>${d.icon} ${esc(d.name)}</h3></div><button class="close-x" data-act="close-modal" aria-label="Close">×</button></div>
      <div class="seg" style="margin:0"><button data-act="play-mode" data-mode="play" aria-pressed="${!gift}">${isTrap(P.card) ? 'Arm it' : 'Play it'}</button><button data-act="play-mode" data-mode="gift" aria-pressed="${gift}">Gift it</button></div></div>
    <div class="modal-body pad"><div class="play-wrap">${cardFace(P.card, { cls: 'tilt' })}<div class="play-form">${body}<div class="err" id="play-err"></div></div></div></div>
  </div></div>`;
}

function giftForm() {
  const P = S.play;
  const others = Object.values(S.league.users).filter(u => u.id !== myId()).sort(byName);
  return `<p style="margin:0;color:#c7d3ee">Give this card to a colleague. It lands in their hand next week, and it doesn't use up your card for the week. Alliances are allowed. Betrayal is encouraged.</p>
    <label class="field">Who gets it<select class="input" data-change="play-gift"><option value="">Choose…</option>${others.map(u => `<option value="${u.id}" ${P.giftTo === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
    <button class="btn primary" data-act="play-submit">Gift ${esc(CARDS[P.card].name)}</button>`;
}

function playForm(use) {
  const P = S.play, d = CARDS[P.card], L = S.league;
  const f = [`<p style="margin:0;color:#c7d3ee">${esc(d.text)}</p>`];
  if (isTrap(P.card)) f.push('<p class="note" style="margin:0">Arming is free: it doesn\'t use up your card for the week. Nobody sees it until it springs.</p>');
  if (isHindsight(P.card)) f.push(`<p class="note" style="margin:0">This rewrites <b>Week ${use.week}</b>, which is final. You can take it back until the Week ${use.week + 1} lock.</p>`);
  if (P.card === 'blue_shell') {
    const leader = pointsOrder()[0];
    f.push(`<div class="callout"><span class="ic">🐢</span><div class="txt">It homes in on whoever leads the season points at the lock. Right now that's <b>${esc(leader?.name || 'nobody')}</b>${leader?.id === myId() ? '. That\'s you: it fizzles if you still lead' : ''}.</div></div>`);
  }
  if (d.needs.includes('target')) {
    let list = Object.values(L.users).filter(u => u.id !== myId()).sort(byName);
    let label = { heist: 'Who to rob (above you in season points)', copycat: 'Whose pick to copy', leech: 'Who to leech off', duel: 'Who to challenge', burn_notice: 'Who gets the notice' }[P.card] || 'Target';
    if (P.card === 'heist') {
      const order = pointsOrder();
      const mine = meU().total;
      list = order.filter(u => u.id !== myId() && u.total > mine);
    }
    f.push(`<label class="field">${label}<select class="input" data-change="play-target"><option value="">Choose…</option>${list.map(u => `<option value="${u.id}" ${P.target === u.id ? 'selected' : ''}>${esc(u.name)}${P.card === 'heist' ? ` · ${fmt(u.total)} pts` : ''}</option>`).join('')}</select></label>`);
    if (P.card === 'heist' && !list.length) f.push('<p class="note" style="margin:0">Nobody is above you. Hold onto it.</p>');
  }
  if (d.needs.includes('slot')) {
    const note = s => {
      if (P.card !== 'garbage') return '';
      const x = weekObj(use.week).results[myId()]?.slots[s];
      if (s === 'WIN') return x?.scorer != null && x.gp > 1 ? (x.line[2] && x.line[1] ? ' · a loss → a win' : ' · n/a') : ' · n/a';
      const hi = x?.line?.[4 + STAT_IDX[s]], lo = x?.line?.[7 + STAT_IDX[s]];
      return x?.scorer != null && x.gp > 1 && hi != null ? ` · ${lo} → ${hi}` : ' · n/a';
    };
    f.push(`<div class="field">${P.card === 'garbage' ? `Which Week ${use.week} pick (worst → best game)` : 'Category'}<div class="pills">${SLOTS.map(s => `<button class="pill" data-act="play-slot" data-slot="${s}" aria-pressed="${P.slot === s}">${INFO[s].emoji} ${INFO[s].name}${note(s)}</button>`).join('')}</div></div>`);
  }
  if (d.needs.includes('player')) {
    f.push(`<div class="field">${P.card === 'sixth' ? 'Your sixth man' : P.slot === 'WIN' ? 'Team' : P.card === 'jinx' ? 'Player or team' : 'Player'}${P.player != null
      ? `<div class="chip-pick">${thumb(P.player, 'sm')}<span>${esc(pname(P.player))}</span><button class="link" data-act="play-player-clear">Change</button></div>`
      : `<input id="play-q" class="input" type="search" placeholder="Search ${P.slot === 'WIN' ? 'teams' : 'players'}" value="${esc(P.q)}" autocomplete="off" data-input="play-q"><div class="play-list" id="play-list">${playPlayerRows()}</div>`}</div>`);
  }
  if (d.needs.includes('nickname')) {
    f.push(`<label class="field">Nickname<select class="input" data-change="play-nick"><option value="">Choose…</option>${NICKNAMES.map((n, i) => `<option value="${i}" ${P.nick === String(i) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>`);
  }
  if (P.card === 'switcheroo') f.push(swapForm(use.week));
  if (['attack', 'prank', 'duel'].includes(d.type)) {
    f.push(`<label class="field">Taunt (optional, shown at the reveal)<select class="input" data-change="play-taunt"><option value="">No taunt</option>${TAUNTS.map((t, i) => `<option value="${i}" ${P.taunt === String(i) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`);
  }
  if (P.card === 'embargo') f.push('<p class="note" style="margin:0">Everyone sees an Embargo the moment you play it, so they can change their picks.</p>');
  const verb = isTrap(P.card) ? 'Arm' : 'Play';
  f.push(`<button class="btn primary" data-act="play-submit">${verb} ${esc(d.name)}</button>`);
  return f.join('');
}

function swapForm(week) {
  const P = S.play;
  const r = weekObj(week).results[myId()];
  const u = meU();
  const rows = LEAGUE.playerSlots.map(s => {
    const x = r.slots[s];
    if (x.scorer == null || x.copy) return `<div class="swap-row"><span class="dim">${slotName(s)}: nothing to move</span><span></span></div>`;
    const line = S.data.totals[week]?.p?.[x.scorer] || [];
    const opts = LEAGUE.playerSlots.map(t => {
      const burned = t !== s && (u.burns[t].get(x.scorer) ?? Infinity) < week;
      return `<option value="${t}" ${P.map[s] === t ? 'selected' : ''} ${burned ? 'disabled' : ''}>${INFO[t].name}: ${line[STAT_IDX[t] + 1] ?? 0} ${INFO[t].short}${burned ? ' (burned)' : ''}</option>`;
    }).join('');
    return `<div class="swap-row"><span>${slotName(s)}: <b>${esc(shortName(x.scorer))}</b> <span class="dim">${x.value} ${INFO[s].short}</span></span><select class="input" style="width:auto" data-change="play-swap" data-from="${s}">${opts}</select></div>`;
  }).join('');
  return `<div class="field">Move each player to his new slot<div style="display:grid;gap:8px">${rows}</div></div>`;
}

function playPlayerRows() {
  const P = S.play, L = S.league;
  const q = norm(P.q);
  const slot = P.slot || 'PTS';
  const d = S.draft;
  const mine = new Set(SLOTS.flatMap(s => [d?.slots[s]?.player_id, d?.slots[s]?.alt_id]).filter(x => x != null));
  // Dub takes a team; a Jinx can name a team too.
  const teamRows = (P.slot === 'WIN' || P.card === 'jinx') && P.card !== 'sixth' ? Object.entries(TEAMS)
    .filter(([tri, t]) => !q || norm(`${t.city} ${t.name} ${tri}`).includes(q))
    .map(([tri, t]) => {
      let why = null;
      if (P.card === 'burn_notice') {
        if (!P.target) why = 'Pick a target first';
        else if (L.users[P.target]?.burns.WIN.has(t.id)) why = 'Already burned for them';
      }
      const rec = S.data.teams?.[tri] || { w: 0, l: 0 };
      return `<button class="prow" data-act="play-player" data-pid="${t.id}" ${why ? 'disabled' : ''}>${thumb(t.id)}<div><div class="nm">${esc(t.city)} ${esc(t.name)}</div><div class="mt">${rec.w}–${rec.l}${why ? ` <span class="blocked">${esc(why)}</span>` : ''}</div></div><div></div></button>`;
    }) : [];
  if (P.slot === 'WIN') return teamRows.join('') || '<div class="empty-state">No teams match.</div>';
  const rows = Object.values(S.data.players)
    .filter(p => !q || norm(p.name).includes(q) || norm(p.team).includes(q))
    .sort((a, b) => (b.avg?.[STAT_IDX[slot]] || 0) - (a.avg?.[STAT_IDX[slot]] || 0))
    .slice(0, 30)
    .map(p => {
      let why = null;
      if (P.card === 'burn_notice') {
        if (!P.target || !P.slot) why = 'Pick a target and category first';
        else if (L.users[P.target]?.burns[P.slot].has(p.id)) why = 'Already burned for them';
      }
      if (P.card === 'embargo' && !P.slot) why = 'Pick a category first';
      if (P.card === 'sixth') {
        if (mine.has(p.id)) why = 'Already one of your picks';
        else if (LEAGUE.playerSlots.every(s => blockedReason(L, myId(), s, p.id))) why = 'Burned everywhere';
      }
      return `<button class="prow" data-act="play-player" data-pid="${p.id}" ${why ? 'disabled' : ''}>${thumb(p.id)}<div><div class="nm">${esc(p.name)}</div><div class="mt">${esc(p.team)} · ${LEAGUE.playerSlots.map(s => `${fmt(p.avg?.[STAT_IDX[s]] || 0)} ${INFO[s].short}`).join(' / ')}${why ? ` <span class="blocked">${esc(why)}</span>` : ''}</div></div><div></div></button>`;
    });
  return [...rows, ...(q ? teamRows : [])].join('') || '<div class="empty-state">No players match.</div>';
}

async function submitPlay(btn) {
  const P = S.play, d = CARDS[P.card];
  const err = m => { $('#play-err').textContent = m; };
  let row, msg;
  if (P.mode === 'gift') {
    if (!P.giftTo) return err('Choose who gets it.');
    if (S.league.openWeek == null) return err('The season is over.');
    row = { week: S.league.openWeek, card: 'gift', card_uid: P.uid, target_id: P.giftTo };
    msg = `${d.name} is on its way to ${userName(P.giftTo)}. It arrives next week.`;
  } else {
    const use = cardUse(P.inst);
    if (use.why) return err(use.why);
    if (d.needs.includes('target') && !P.target) return err('Choose a colleague.');
    if (d.needs.includes('slot') && !P.slot) return err('Choose a category.');
    if (d.needs.includes('player') && P.player == null) return err('Choose a player.');
    if (d.needs.includes('nickname') && P.nick === '') return err('Choose a nickname.');
    row = { week: use.week, card: P.card, card_uid: P.uid, target_id: P.target || null, slot: P.slot || null, player_id: P.player ?? null, params: {} };
    if (P.card === 'nickname') row.params.nick = +P.nick;
    if (P.taunt !== '') row.params.taunt = +P.taunt;
    if (P.card === 'switcheroo') {
      const moved = Object.fromEntries(SLOTS.filter(s => P.map[s] !== s).map(s => [s, P.map[s]]));
      const to = Object.values(moved);
      if (!to.length) return err('Move at least one player.');
      if (new Set(to).size !== to.length || !to.every(t => t in moved)) return err('Each slot needs exactly one player. Swap them in pairs or rotate all three.');
      row.params.map = moved;
    }
    msg = isTrap(P.card) ? `${d.name} is armed. Nobody can see it.`
      : P.card === 'embargo' ? 'Embargo is live. Everyone can see it now.'
      : P.card === 'duel' ? `Challenge sent to ${userName(P.target)}.`
      : isHindsight(P.card) ? `Week ${use.week} rewritten.`
      : P.card === 'scout' ? null
      : `${d.name} played. It's revealed at the lock.`;
  }
  btn.disabled = true;
  try {
    await S.backend.savePlay(row);
    closeModal();
    if (msg) toast(msg);
  } catch (e) {
    btn.disabled = false;
    return err(e.message || String(e));
  }
  await refresh();
  if (row.card === 'scout') showScout(row.week, row.slot);
}

async function showScout(week, slot) {
  let rows;
  try { rows = await S.backend.scout(week, slot); } catch (e) { return toast(e.message || String(e), true); }
  const n = rows[0]?.entries || 0;
  $('#modal-root').innerHTML = `<div class="modal-bg" data-act="close-modal-bg"><div class="modal narrow" role="dialog" aria-modal="true" aria-label="Scout report">
    <div class="modal-head"><div class="ttl"><div><div class="kicker">🔭 Scout report · Week ${week}</div><h3>${slotName(slot)} board</h3></div><button class="close-x" data-act="close-modal" aria-label="Close">×</button></div></div>
    <div class="modal-body pad">${rows.length ? rows.map(r => `<div class="scout-row">${thumb(r.player_id, 'sm')}<div><div style="font-weight:600">${esc(pname(r.player_id))}</div><div class="own-bar"><i style="width:${(r.picks / Math.max(1, n)) * 100}%"></i></div></div><b class="num">${Math.round((r.picks / Math.max(1, n)) * 100)}%</b></div>`).join('')
      : '<p class="muted">Nobody has picked this slot yet.</p>'}
      <p class="note" style="margin:10px 0 0">Based on the ${n} ${n === 1 ? 'person' : 'people'} with picks saved so far. Picks can change until the lock. Check again any time this week.</p></div></div></div>`;
}

// ---------- Standings ----------

function viewStandings() {
  const L = S.league;
  const lw = [...lockedWeeks()].pop();
  const rival = meU()?.rival;
  const rows = L.standings.filter(u => Object.keys(u.weekly).length || u.id === myId()).map(u => `
    <tr class="${u.id === myId() ? 'me' : ''}">
      <td class="rank ${u.rank <= 3 ? 'top' : ''}">${u.rank}</td>
      <td><div class="who">${avatar(u.id)}<div><b>${esc(u.name)}</b>${lw ? decor(u.id, lw.week, true) : ''}${u.id === myId() ? '<span class="tag blue">You</span>' : ''}${u.id === rival ? '<span class="tag">Rival</span>' : ''}${u.lives === 0 ? '<span class="tag gold">Out of lives</span>' : ''}
        <div class="dim" style="font-size:12px">${u.team ? esc(u.team) + ' fan' : ''}</div></div></div></td>
      <td class="hide-sm">${hearts(u.lives)}</td>
      ${lw ? `<td class="r num">${u.weekly[lw.week] != null ? fmt(u.weekly[lw.week]) : '—'}${lw.status === 'live' ? ' <span class="dim">·live</span>' : ''}</td>` : ''}
      ${L.dropCount ? `<td class="r num hide-sm">${fmt(u.total)}</td>` : ''}
      <td class="r"><span class="pts">${fmt(u.counted)}</span></td>
    </tr>`).join('');
  return `<div class="grid">
    <section class="panel">
      <div class="panel-title"><h2>Season standings</h2><span class="muted">${L.dropCount ? `Worst ${L.dropCount} week${L.dropCount > 1 ? 's' : ''} dropped` : 'Drops unlock after weeks 6, 12 and 18'}</span></div>
      ${rows ? `<div class="table-wrap"><table class="board"><thead><tr><th>#</th><th>Player</th><th class="hide-sm">Lives</th>${lw ? `<th class="r">Wk ${lw.week}</th>` : ''}${L.dropCount ? '<th class="r hide-sm">Total</th>' : ''}<th class="r">${L.dropCount ? 'Counted' : 'Points'}</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="empty-state"><div class="ic">📋</div>Standings appear once the first week locks.</div>'}
      <p class="note" style="margin:12px 0 0">Each week, every category: 1 point for each colleague whose pick you beat, ½ for a tie. Double Down doubles one slot.</p>
    </section>
    ${monthlyPanel()}
  </div>`;
}

function monthlyPanel() {
  const months = S.league.months.filter(m => S.league.weeks.some(w => m.weeks.includes(w.week) && w.status !== 'open'));
  if (!months.length) return '';
  const cur = months.find(m => m.key === S.month) || months.find(m => !m.complete) || months[months.length - 1];
  const rows = cur.ranked.slice(0, 8).map((u, i) => `<tr class="${u.id === myId() ? 'me' : ''}"><td class="rank ${i === 0 ? 'top' : ''}">${i + 1}</td><td><div class="who">${avatar(u.id)}<b>${esc(u.name)}</b></div></td><td class="r"><span class="pts">${fmt(u.monthly[cur.key])}</span></td></tr>`).join('');
  return `<section class="panel"><div class="panel-title"><h2>Monthly Crown</h2>
    <div class="pills">${months.map(m => `<button class="pill" data-act="month" data-key="${m.key}" aria-pressed="${m.key === cur.key}">${esc(MONTH_LABELS[m.key] || m.key)}${m.complete ? ' 👑' : ''}</button>`).join('')}</div></div>
    <p class="muted" style="margin:-4px 0 10px;font-size:13px">Weeks ${cur.weeks[0]}–${cur.weeks[cur.weeks.length - 1]} · ${cur.complete ? `Crowned: <b style="color:var(--gold)">${esc(cur.winner?.name || '—')}</b>` : 'Race in progress'}</p>
    <div class="table-wrap"><table class="board"><tbody>${rows}</tbody></table></div></section>`;
}

// ---------- Survivor ----------

function viewSurvivor() {
  const L = S.league;
  const open = L.openWeek != null ? weekObj(L.openWeek) : null;
  const order = L.survivor.order;
  const alive = order.filter(u => u.lives > 0);
  const out = order.filter(u => u.lives === 0).sort((a, b) => b.eliminatedWeek - a.eliminatedWeek);
  const card = u => `<div class="surv-card ${u.id === myId() ? 'me' : ''} ${u.lives ? '' : 'out'}">${avatar(u.id)}<div><b>${esc(u.name)}</b><div>${u.lives ? hearts(u.lives) : `<span class="dim">Out in week ${u.eliminatedWeek}</span>`}</div></div></div>`;
  return `<div class="grid">
    <section class="hero">
      <span class="badge">Survivor Belt</span>
      <h1>${L.survivor.winner ? `${esc(L.survivor.winner.name)} wins the belt` : `${alive.length} still standing`}</h1>
      <div class="sub">Everyone starts with ${LEAGUE.lives} lives. Each week, clear at least ${LEAGUE.barsToSurvive} of the ${SLOTS.length} bars with your weekly totals or lose one. Last one standing takes the belt.</div>
    </section>
    <section class="panel"><div class="panel-title"><h2>The bars</h2><span class="muted">The same every week, all season</span></div>
      <div class="ladder-bars">${SLOTS.map(s => `<div class="ladder-bar" data-slot="${s}"><div class="kicker">${INFO[s].emoji} ${INFO[s].name}</div><b>${LEAGUE.bars[s]}</b><div class="muted" style="font-size:12px">${INFO[s].stat.toLowerCase()} in the week</div></div>`).join('')}</div>
    </section>
    <section class="panel"><div class="panel-title"><h2>Still alive</h2><span class="muted">${alive.length} of ${order.length}</span></div>
      ${alive.length ? `<div class="surv-grid">${alive.map(card).join('')}</div>` : '<p class="muted">Nobody yet. The ladder starts when Week 1 locks.</p>'}
    </section>
    ${out.length ? `<section class="panel"><div class="panel-title"><h2>The graveyard 🪦</h2></div><div class="surv-grid">${out.map(card).join('')}</div></section>` : ''}
  </div>`;
}

// ---------- Results ----------

function viewResults() {
  const weeks = lockedWeeks();
  if (!weeks.length) return `<section class="panel empty-state"><div class="ic">🔒</div><b>Nothing to show yet.</b><p>Everyone's picks are revealed when Week 1 locks.</p></section>`;
  const w = weekObj(S.resultsWeek) && weekObj(S.resultsWeek).status !== 'open' ? weekObj(S.resultsWeek) : weeks[weeks.length - 1];
  const rows = [...w.entrants].sort((a, b) => w.results[b].score - w.results[a].score);
  let prevScore = null, rank = 0;
  const body = rows.map((id, i) => {
    const r = w.results[id];
    if (r.score !== prevScore) rank = i + 1;
    prevScore = r.score;
    const cells = SLOTS.map(s => {
      const x = r.slots[s];
      if (x.missing) return '<td><span class="dim">—</span></td>';
      const pid = x.copy ? x.copyPid : x.scorer ?? x.pid;
      const bar = LEAGUE.bars[s];
      return `<td><div class="cell-pick">${thumb(pid, 'sm')}<div><div class="v" style="color:${x.base >= bar ? 'var(--text)' : 'var(--muted)'}">${x.value}${x.dd ? ' 🔥' : ''}${fxIcons(x)}</div><div class="n">${x.copy ? `🐱 ${esc(userName(x.copy))}'s` : esc(shortName(pid))}${x.usedAlt ? ' (B)' : ''}${x.auto ? ' · auto' : ''}</div><div class="rp">+${fmt(x.rank)}</div></div></div></td>`;
    }).join('');
    const surv = w.status === 'final' ? (r.survived ? '<span class="trend-up">✓</span>' : '<span class="trend-down">✗ ❤️</span>') : `<span class="dim">${r.cleared}/${SLOTS.length}</span>`;
    return `<tr class="${id === myId() ? 'me' : ''}"><td class="rank ${rank <= 3 ? 'top' : ''}">${rank}</td><td><div class="who">${avatar(id)}<div><b>${esc(userName(id))}</b>${decor(id, w.week)}</div></div></td>${cells}<td class="r"><span class="pts">${fmt(r.score)}</span>${adjChip(r)}</td><td class="c">${surv}</td></tr>`;
  }).join('');
  return `<div class="grid">
    <section class="panel">
      <div class="panel-title"><h2>Week ${w.week} ${w.status === 'live' ? '<span class="badge live">Live</span>' : '<span class="badge final">Final</span>'}</h2>
        <div class="pills">${weeks.map(x => `<button class="pill ${x.status === 'live' ? 'live' : ''}" data-act="results-week" data-week="${x.week}" aria-pressed="${x.week === w.week}">Wk ${x.week}</button>`).join('')}</div></div>
      <p class="muted" style="margin:-6px 0 12px;font-size:13px">${weekRange(w)} · bars ${SLOTS.map(s => `${LEAGUE.bars[s]} ${INFO[s].short}`).join(' / ')} · (B) backup scored · 🔥 Double Down · card icons show what hit a pick (hover for who)</p>
      <div class="table-wrap"><table class="board"><thead><tr><th>#</th><th>Player</th>${SLOTS.map(s => `<th>${INFO[s].emoji} ${INFO[s].name}</th>`).join('')}<th class="r">Pts</th><th class="c">Bars</th></tr></thead><tbody>${body}</tbody></table></div>
    </section>
    ${cardTablePanel(w)}
    ${ownershipPanel(w)}
    ${w.awards?.length ? `<section class="panel"><div class="panel-title"><h2>Week ${w.week} awards</h2></div><div class="awards">${w.awards.map(a => `
      <div class="award"><div class="ic">${a.icon}</div><h4>${esc(a.title)}</h4><div class="who-line">${esc(userName(a.user))}${a.pid ? ` · ${esc(pname(a.pid))}` : ''}</div><p>${esc(a.text)}</p></div>`).join('')}</div></section>` : ''}
  </div>`;
}

function ownershipPanel(w) {
  const n = w.entrants.length;
  if (!n) return '';
  const cols = SLOTS.map(s => {
    const counts = {};
    for (const id of w.entrants) { const pid = w.results[id].slots[s].pid; if (pid != null) counts[pid] = (counts[pid] || 0) + 1; }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return `<div style="--sc:var(--slot-${s})"><h3 class="kicker" style="margin:0 0 10px">${INFO[s].emoji} ${INFO[s].name}</h3>${top.map(([pid, c]) => `
      <div class="own-row">${thumb(+pid, 'sm')}<div><div style="font-weight:600">${esc(shortName(+pid))}</div><div class="own-bar"><i style="width:${(c / n) * 100}%"></i></div></div><b class="num">${Math.round((c / n) * 100)}%</b></div>`).join('')}</div>`;
  }).join('');
  return `<section class="panel"><div class="panel-title"><h2>Lock reveal</h2><span class="muted">Most-picked players · ${n} entr${n === 1 ? 'y' : 'ies'}</span></div><div class="own-cols">${cols}</div></section>`;
}

// ---------- Burn book ----------

function viewBurns() {
  const L = S.league;
  const people = L.standings.filter(u => Object.keys(u.weekly).length || u.id === myId());
  if (!people.length) return `<section class="panel empty-state"><div class="ic">📓</div>Burn books fill up once Week 1 is final.</section>`;
  const id = S.burnUser && L.users[S.burnUser] ? S.burnUser : (meU() ? myId() : people[0].id);
  const u = L.users[id];
  const total = L.weeks.length;
  const cols = SLOTS.map(s => {
    const burned = [...u.burns[s].entries()].sort((a, b) => a[1] - b[1]);
    const reserved = [...u.reserved[s].entries()].filter(([pid]) => !u.burns[s].has(pid));
    const freed = u.unburn && u.unburn.slot === s && u.unburnApplied ? u.unburn : null;
    const items = burned.map(([pid, wk]) => `<div class="burn-item">${thumb(pid, 'sm')}<span class="nm">${esc(pname(pid))}</span><span class="wk">WK ${wk}</span></div>`)
      .concat(reserved.map(([pid, wk]) => `<div class="burn-item reserved">${thumb(pid, 'sm')}<span class="nm">${esc(pname(pid))}</span><span class="wk" style="color:#ffb0bf">WK ${wk} · LIVE</span></div>`))
      .concat(freed ? [`<div class="burn-item freed">${thumb(freed.player_id, 'sm')}<span class="nm">${esc(pname(freed.player_id))}</span><span class="wk" style="color:var(--green)">UN-BURNED</span></div>`] : []);
    return `<div class="burn-col" data-slot="${s}"><h3>${INFO[s].emoji} ${INFO[s].name}<small>${burned.length} used · ${Math.max(0, total - burned.length)} weeks left</small></h3>${items.join('') || '<p class="dim">Clean sheet.</p>'}</div>`;
  }).join('');
  return `<section class="panel">
    <div class="panel-title"><h2>Burn book</h2>
      <select class="input" style="width:auto;min-width:200px" data-change="burn-user" aria-label="Whose burn book">${people.map(p => `<option value="${p.id}" ${p.id === id ? 'selected' : ''}>${esc(p.name)}${p.id === myId() ? ' (you)' : ''}</option>`).join('')}</select></div>
    <p class="muted" style="margin:-4px 0 14px;font-size:13px">A player you use is gone from that category for the season, but still available in the other two.</p>
    <div class="burn-cols">${cols}</div>
  </section>`;
}

// ---------- Rivals ----------

function viewRivals() {
  const L = S.league;
  const me = meU();
  const options = Object.values(L.users).filter(u => u.id !== myId()).sort((a, b) => a.name.localeCompare(b.name));
  const gunning = options.filter(u => u.rival === myId());
  const picker = `<select class="input" style="width:auto;min-width:220px" data-change="rival" aria-label="Choose your rival"><option value="">Choose a rival…</option>${options.map(u => `<option value="${u.id}" ${me.rival === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>`;
  let body = '<div class="empty-state"><div class="ic">🥊</div>Pick a coworker to track your head-to-head record every week.</div>';
  if (me.rival && L.users[me.rival]) {
    const them = L.users[me.rival];
    const h = headToHead(L, myId(), them.id);
    const max = Math.max(1, ...h.weeks.flatMap(x => [x.me, x.them]));
    body = `<div class="versus">
        <div class="side">${avatar(myId(), 'lg')}<b>${esc(me.name)}</b><span class="muted">${fmt(me.counted)} pts · ${hearts(me.lives)}</span></div>
        <div class="rec">${h.w}–${h.l}${h.t ? `–${h.t}` : ''}<small>HEAD TO HEAD</small></div>
        <div class="side">${avatar(them.id, 'lg')}<b>${esc(them.name)}</b><span class="muted">${fmt(them.counted)} pts · ${hearts(them.lives)}</span></div>
      </div>
      ${h.weeks.length ? h.weeks.map(x => `<div class="h2h-row"><span class="kicker">WK ${x.week}</span>
        <div style="display:flex;align-items:center;gap:8px"><span class="num" style="width:34px;text-align:right">${fmt(x.me)}</span><div class="h2h-bar" style="flex:1"><i style="width:${(x.me / max) * 100}%"></i></div></div>
        <span class="res ${x.res}">${x.status === 'live' ? '<span class="dim">LIVE</span>' : x.res}</span>
        <div style="display:flex;align-items:center;gap:8px"><div class="h2h-bar them" style="flex:1"><i style="width:${(x.them / max) * 100}%"></i></div><span class="num" style="width:34px">${fmt(x.them)}</span></div></div>`).join('')
        : '<p class="muted">Your first head-to-head week starts when you both have picks in a locked week.</p>'}`;
  }
  return `<div class="grid">
    <section class="panel"><div class="panel-title"><h2>Your rival</h2>${picker}</div>${body}</section>
    <section class="panel"><div class="panel-title"><h3>Gunning for you</h3></div>
      ${gunning.length ? `<div class="surv-grid">${gunning.map(u => `<div class="surv-card">${avatar(u.id)}<div><b>${esc(u.name)}</b><div class="dim" style="font-size:12px">${(() => { const h = headToHead(L, u.id, myId()); return `${h.w}–${h.l}${h.t ? `–${h.t}` : ''} against you`; })()}</div></div></div>`).join('')}</div>` : '<p class="muted">Nobody has named you as their rival yet.</p>'}
    </section>
  </div>`;
}

// ---------- Trophies ----------

function viewTrophies() {
  const A = seasonAwards(S.league, pname);
  S.awards = A;
  const c = A.champion;
  const won = c.decided && c.leader;
  const podium = c.ranked.slice(0, 3).map((x, i) => `<div class="podium-spot p${i + 1}">${avatar(x.id)}<b>${esc(userName(x.id))}</b><span>${fmt(x.v)}</span></div>`).join('');
  const meIdx = c.ranked.findIndex(x => x.id === myId());
  const section = (title, sub, cards, cls = '') => cards.length ? `<section class="trophy-group ${cls}"><div class="panel-title"><h2>${title}</h2><span class="muted">${sub}</span></div><div class="trophies">${cards.join('')}</div></section>` : '';
  return `<div class="grid">
    <section class="spotlight ${won ? 'won' : ''}">
      <div class="spot-icon">🏆</div>
      <div class="kicker" style="color:#ffe39a">${LEAGUE.season} · ${won ? 'Champion' : 'The big one'}</div>
      <h1>Season Champion</h1>
      ${won ? `<div class="spot-winner">${avatar(c.leader.id, 'lg')}<b>${esc(userName(c.leader.id))}</b></div><p>${esc(c.leaderText)}</p>
        <button class="btn gold" data-act="cert" data-key="champion">Download certificate</button>`
      : `<p class="spot-how">${esc(c.how)}</p>${podium ? `<div class="podium">${podium}</div>` : '<p class="muted">The race starts when Week 1 locks.</p>'}
        ${meIdx > 2 ? `<div class="you-line">You: ${fmt(c.ranked[meIdx].v)} · #${meIdx + 1}</div>` : ''}`}
    </section>
    ${section('Title belts', 'Season-long, decided after the final week (the Belt goes when the last life does)', A.titles.map(awardCard))}
    ${section('Monthly Crowns', 'Most points in each month', A.monthly.map(awardCard))}
    ${section('Hall of Fame', 'The fun stuff, decided at the end of the season', A.fame.map(awardCard))}
    ${section('Hall of Shame', 'All in good fun. Yes, these come with certificates too', A.shame.map(awardCard), 'shame')}
    ${section('Coming in April', 'Playoffs', [`<div class="trophy"><div class="ic">🔥</div><h4>Playoff Burn</h4><p>A separate mini-game with a fresh burn list, one pick per category each playoff round.</p><div class="leader dim">Coming soon</div></div>`])}
  </div>`;
}

function awardCard(a) {
  const won = a.decided && a.leader;
  const meIdx = a.ranked.findIndex(x => x.id === myId());
  const you = !won && meIdx >= 0 && a.leader?.id !== myId() ? `<div class="you-line">You: ${esc(a.format(a.ranked[meIdx]))} · #${meIdx + 1}</div>` : '';
  const body = won
    ? `<div class="winner-line">${avatar(a.leader.id)}<b>${esc(userName(a.leader.id))}</b></div><p class="detail">${esc(a.leaderText)}</p>
       <button class="btn gold small" data-act="cert" data-key="${a.key}">Download certificate</button>`
    : a.leader
      ? `<div class="leader-tag">${a.decided ? 'Winner' : 'Leader'}</div><div class="winner-line">${avatar(a.leader.id)}<b>${esc(userName(a.leader.id))}</b>${a.leader.id === myId() ? '<span class="tag blue">You</span>' : ''}</div><p class="detail">${esc(a.leaderText)}</p>${you}`
      : `<div class="leader dim">${esc(a.status || 'No leader yet')}</div>`;
  return `<div class="trophy ${won ? 'won' : ''}"><div class="ic">${a.icon}</div><h4>${esc(a.title)}</h4><p>${esc(a.how)}</p>${body}</div>`;
}

// ---------- Commissioner ----------

function loadAdmin() {
  if (S.adminLoading) return;
  S.adminLoading = true;
  const wk = S.league.openWeek;
  Promise.all([
    S.backend.adminMembers(), wk != null ? S.backend.adminPickStatus(wk) : [],
    S.backend.adminBlocked().catch(() => []), S.backend.adminGetInvite().catch(() => undefined),
  ])
    .then(([members, status, blocked, invite]) => { S.adminData = { members, blocked, invite, status: Object.fromEntries(status.map(r => [r.user_id, r])), week: wk }; })
    .catch(e => { S.adminData = { error: e.message || String(e), week: wk }; })
    .finally(() => { S.adminLoading = false; if (S.view === 'admin') render(); });
}

function openRemove(id) {
  const m = S.adminData?.members.find(x => x.user_id === id);
  if (!m) return;
  $('#modal-root').innerHTML = `<div class="modal-bg" data-act="close-modal-bg"><div class="modal narrow" role="dialog" aria-modal="true" aria-label="Remove member">
    <div class="modal-head"><div class="ttl"><h3>Remove ${esc(m.display_name)}?</h3><button class="close-x" data-act="close-modal" aria-label="Close">×</button></div></div>
    <div class="modal-body pad" style="display:grid;gap:14px">
      <p style="margin:0">This deletes their account, picks, burns and jokers. Their results drop out of every week's standings. It can't be undone.</p>
      <label style="display:flex;gap:10px;align-items:flex-start;font-size:14px"><input type="checkbox" id="remove-block" checked style="margin-top:3px">
        <span>Also block <b>${esc(m.email || 'this email')}</b> from signing up again</span></label>
      <div class="row-actions" style="justify-content:flex-end"><button class="btn ghost" data-act="close-modal">Cancel</button><button class="btn primary" data-act="remove-confirm" data-id="${m.user_id}">Remove</button></div>
    </div></div></div>`;
}

function stillToPick() {
  const d = S.adminData;
  return (d?.members || []).filter(m => (d.status[m.user_id]?.slots || 0) < SLOTS.length);
}

function viewAdmin() {
  const L = S.league;
  const open = L.openWeek != null ? weekObj(L.openWeek) : null;
  if (!S.adminData || S.adminData.week !== L.openWeek) loadAdmin();
  const st = funStats(L, S.data.players, S.data.teams);
  return `<div class="grid">
    <section class="hero"><span class="badge">🔒 Commissioner only</span><h1>The Commissioner's office</h1>
      <div class="sub">Only accounts in the admins table can open this. Everyone's picks stay hidden until each lock, including from you.</div></section>
    ${adminInvite()}
    ${adminRoster(open)}
    ${adminTiles(st)}
    ${adminStrategy(perfectPlay(L, S.data.totals))}
    ${adminLedger(st)}
    <section class="panel"><div class="panel-title"><h2>Most burned</h2><span class="muted">Players the league has already spent</span></div>
      <div class="own-cols">${SLOTS.map(s => `<div><h3 class="kicker" style="margin:0 0 10px">${INFO[s].emoji} ${INFO[s].name}</h3>${st.mostBurned[s].map(x => `
        <div class="own-row">${thumb(x.pid, 'sm')}<div><div style="font-weight:600">${esc(shortName(x.pid))}</div><div class="dim" style="font-size:12px">${x.who.map(w => esc(userName(w.id))).join(', ')}</div></div><b class="num">${x.who.length}</b></div>`).join('') || '<p class="dim">Nobody yet.</p>'}</div>`).join('')}</div>
    </section>
    <section class="panel"><div class="panel-title"><h2>Untouched gems</h2><span class="muted">Best season averages (and records) nobody has burned in that category</span></div>
      <div class="own-cols">${SLOTS.map(s => `<div><h3 class="kicker" style="margin:0 0 10px">${INFO[s].emoji} ${INFO[s].name}</h3>${st.untouched[s].map(p => s === 'WIN' ? `
        <div class="own-row">${thumb(p.id, 'sm')}<div style="font-weight:600">${esc(shortName(p.id))}</div><b class="num">${p.record.w}–${p.record.l}</b></div>` : `
        <div class="own-row">${thumb(p.id, 'sm')}<div style="font-weight:600">${esc(shortName(p.id))} <span class="dim">${esc(p.team)}</span></div><b class="num">${fmt(p.avg[STAT_IDX[s]])}</b></div>`).join('') || '<p class="dim">All burned.</p>'}</div>`).join('')}</div>
    </section>
    ${adminFirepower(st)}
    ${adminStyles(st)}
  </div>`;
}

function inviteLink(code) {
  return `${location.origin}${location.pathname}?invite=${encodeURIComponent(code)}`;
}

function adminInvite() {
  const d = S.adminData;
  if (!d || d.error) return '';
  if (d.invite === undefined) return `<section class="panel"><div class="panel-title"><h2>Invite code</h2></div><p class="muted">Run supabase/upgrade-dub-invite.sql in the Supabase SQL editor to turn on invite codes.</p></section>`;
  const on = !!d.invite;
  return `<section class="panel"><div class="panel-title"><h2>Invite code</h2><span class="muted">${on ? 'New sign-ups need this code' : 'Off: anyone with the link can join'}</span></div>
    ${on ? `<div class="scoreline"><div class="stat"><b class="num" style="letter-spacing:.12em">${esc(d.invite)}</b><small>Current code</small></div>
      <button class="btn" data-act="copy-invite">Copy invite link</button></div>
      <p class="note" style="margin:-4px 0 14px;word-break:break-all">${esc(inviteLink(d.invite))}</p>` : ''}
    <form data-form="invite" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
      <label class="field" style="flex:1;min-width:180px">${on ? 'Change code' : 'Set a code'}<input class="input" name="code" maxlength="32" autocomplete="off" placeholder="e.g. HOOPS26"></label>
      <button class="btn" type="submit">Save code</button>
      ${on ? '<button class="btn ghost" type="button" data-act="invite-off">Turn off</button>' : ''}
    </form>
    <p class="note" style="margin:10px 0 0">Changing the code doesn't affect people who have already joined. The link fills the code in on the sign-up form.</p>
  </section>`;
}

function adminRoster(open) {
  const d = S.adminData;
  if (!d) return `<section class="panel"><div class="panel-title"><h2>Members</h2></div><p class="muted">Loading members…</p></section>`;
  if (d.error) return `<section class="panel"><div class="panel-title"><h2>Members</h2></div><p class="err">${esc(d.error)}</p><p class="note">If this says the function doesn't exist, run supabase/admin.sql in the Supabase SQL editor.</p></section>`;
  const full = d.members.filter(m => (d.status[m.user_id]?.slots || 0) === SLOTS.length).length;
  const none = d.members.filter(m => !d.status[m.user_id]).length;
  const rows = d.members.map(m => {
    const r = d.status[m.user_id];
    const n = r?.slots || 0;
    const tag = n === SLOTS.length ? `<span class="tag green">${n}/${n} ✓</span>` : n ? `<span class="tag gold">${n}/${SLOTS.length}</span>` : '<span class="tag">Not started</span>';
    return `<tr class="${m.user_id === myId() ? 'me' : ''}"><td><div class="who">${avatar(m.user_id)}<b>${esc(m.display_name)}</b></div></td>
      <td class="hide-sm"><span class="muted" style="font-size:13px">${esc(m.email || '')}</span></td>
      ${open ? `<td>${tag}${r?.backups ? ` <span class="dim" style="font-size:12px">+${r.backups} backup${r.backups > 1 ? 's' : ''}</span>` : ''}</td><td class="hide-sm dim" style="font-size:13px">${r ? ago(r.last_saved) : '—'}</td>` : ''}
      <td class="hide-sm dim" style="font-size:13px">${m.last_sign_in_at ? ago(m.last_sign_in_at) : '—'}</td>
      <td class="hide-sm dim" style="font-size:13px">${dshort(m.joined_at.slice(0, 10))}</td>
      <td class="r">${m.user_id === myId() ? '' : `<button class="link danger" data-act="remove-open" data-id="${m.user_id}">Remove</button>`}</td></tr>`;
  }).join('');
  return `<section class="panel">
    <div class="panel-title"><h2>${open ? `Week ${open.week} check-in` : 'Members'}</h2>
      <div class="row-actions">${open ? `<button class="btn small" data-act="copy-emails" ${stillToPick().length ? '' : 'disabled'}>Copy emails still to pick</button>` : ''}<button class="btn small ghost" data-act="admin-refresh">Refresh</button></div></div>
    <div class="scoreline">
      <div class="stat"><b>${d.members.length}</b><small>Members</small></div>
      ${open ? `<div class="stat"><b style="color:var(--green)">${full}</b><small>All ${SLOTS.length} picks in</small></div>
      <div class="stat"><b style="color:var(--orange)">${d.members.length - full - none}</b><small>Partly picked</small></div>
      <div class="stat"><b style="color:var(--red-hot)">${none}</b><small>Not started</small></div>
      <div class="stat"><b class="num" style="font-size:18px">${esc(lockText(open.lockAt))}</b><small>Lock</small></div>` : ''}
    </div>
    <div class="table-wrap"><table class="board"><thead><tr><th>Member</th><th class="hide-sm">Email</th>${open ? `<th>Wk ${open.week}</th><th class="hide-sm">Last saved</th>` : ''}<th class="hide-sm">Last seen</th><th class="hide-sm">Joined</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note" style="margin:10px 0 0">Shows how many slots each person has filled, never which players, until the lock.</p>
    ${d.blocked?.length ? `<div class="section-gap"><h3 class="kicker" style="margin:0 0 8px">Blocked from signing up</h3>${d.blocked.map(b => `
      <div class="alt-row" style="margin-bottom:6px"><span>${esc(b.email)}</span><span class="dim" style="font-size:12px">since ${dshort(b.blocked_at.slice(0, 10))}</span><button class="link" data-act="unblock" data-email="${esc(b.email)}">Unblock</button></div>`).join('')}</div>` : ''}
  </section>`;
}

function adminTiles(st) {
  const t = st.totals;
  const tiles = [
    ['Picks made', t.picks], ['Autopilot fills', t.autos], ['Backup saves', t.saves],
    ['Double Downs played', t.doubleDowns], ['Fumbles', t.fumbles], ['Un-burns used', S.db.unburns.length],
  ];
  const rec = (r, label) => r ? `<div class="award"><div class="ic">${label === 'Best pick of the season' ? '🚀' : '🪫'}</div><h4>${label}</h4>
    <div class="who-line">${esc(userName(r.id))} · ${esc(pname(r.pid))}</div><p>${r.value} ${INFO[r.slot].short} in week ${r.week} (${r.ratio.toFixed(2)}× the bar)</p></div>` : '';
  return `<section class="panel"><div class="panel-title"><h2>Season so far</h2></div>
    <div class="scoreline">${tiles.map(([l, v]) => `<div class="stat"><b>${v}</b><small>${l}</small></div>`).join('')}</div>
    <div class="awards">${rec(st.best, 'Best pick of the season')}${rec(st.worst, 'Worst pick of the season')}</div>
  </section>`;
}

function adminStrategy(pp) {
  if (!pp.finals) return `<section class="panel"><div class="panel-title"><h2>Best strategy</h2></div><p class="muted">Appears once Week 1 is final.</p></section>`;
  const cell = (pid, value) => pid == null ? '<span class="dim">—</span>' : `<div class="cell-pick" style="min-width:130px">${thumb(pid, 'sm')}<div><div class="v">${value}</div><div class="n">${esc(shortName(pid))}</div></div></div>`;
  const weekRows = [...pp.weeks].reverse().map(w => `<tr><td class="rank" style="font-size:16px">${w.week}</td>
    ${SLOTS.map(s => `<td>${w.perfect ? cell(w.perfect[s].pid, w.perfect[s].value) : '—'}</td>`).join('')}
    <td class="hide-sm" style="font-size:12.5px">${SLOTS.map(s => w.bestActual[s] ? `<div>${INFO[s].emoji} ${esc(userName(w.bestActual[s].id))} · ${esc(shortName(w.bestActual[s].pid))} <b>${w.bestActual[s].value}</b></div>` : '').join('')}</td>
    <td>${w.winner ? `<div class="who" style="min-width:0">${avatar(w.winner)}<div><b>${esc(userName(w.winner))}</b><div class="dim" style="font-size:12px">${fmt(w.winnerScore)} pts</div></div></div>` : '—'}</td></tr>`).join('');
  const planRows = pp.season.PTS.plan.map((x, i) => `<tr><td class="rank" style="font-size:16px">${x.week}</td>${SLOTS.map(s => `<td>${cell(pp.season[s].plan[i].pid, pp.season[s].plan[i].value)}</td>`).join('')}</tr>`).join('');
  const max = pp.people[0]?.pct || 1;
  return `<section class="panel"><div class="panel-title"><h2>Best strategy</h2><span class="muted">In hindsight, over ${pp.finals} final week${pp.finals > 1 ? 's' : ''}</span></div>
    <h3 class="kicker" style="margin:4px 0 10px">Closest to the perfect season</h3>
    ${pp.people.map((x, i) => `<div class="h2h-row" style="grid-template-columns:28px minmax(110px,180px) 1fr 52px">
      <span class="rank ${i < 3 ? 'top' : ''}" style="font-size:16px">${i + 1}</span><div class="who" style="min-width:0">${avatar(x.id)}<b>${esc(userName(x.id))}</b></div>
      <div><div class="h2h-bar"><i style="width:${(x.pct / max) * 100}%"></i></div><div class="dim" style="font-size:11.5px;margin-top:4px">${SLOTS.map(s => `${INFO[s].emoji} ${x.got[s]} of ${pp.season[s].total}`).join(' · ')}</div></div>
      <b class="num" style="text-align:right">${Math.round(x.pct * 100)}%</b></div>`).join('')}
    <p class="note" style="margin:8px 0 0">The percentage compares each person's weekly totals, summed over the season, with the perfect plan below, averaged across the four categories.</p>

    <h3 class="kicker" style="margin:22px 0 10px">Week by week</h3>
    <div class="table-wrap"><table class="board"><thead><tr><th>Wk</th>${SLOTS.map(s => `<th>${INFO[s].emoji} Perfect ${INFO[s].name}</th>`).join('')}<th class="hide-sm">League's best picks</th><th>Week winner</th></tr></thead><tbody>${weekRows}</tbody></table></div>
    <p class="note" style="margin:8px 0 0">Perfect = the three different players who'd have done best against the bars that week, plus the team with the most wins.</p>

    <h3 class="kicker" style="margin:22px 0 10px">The perfect season plan</h3>
    <div class="table-wrap"><table class="board"><thead><tr><th>Wk</th>${SLOTS.map(s => `<th>${INFO[s].emoji} ${INFO[s].name} · ${pp.season[s].total} total</th>`).join('')}</tr></thead><tbody>${planRows}</tbody></table></div>
    <p class="note" style="margin:8px 0 0">The highest possible season total in each category, using every player at most once per category, the same rule everyone plays under.</p>
  </section>`;
}

function adminLedger(st) {
  return `<section class="panel"><div class="panel-title"><h2>Burn ledger</h2><span class="muted">Who burned whom, and when</span></div>
    <input class="input" type="search" placeholder="Search a player, e.g. Jokić" data-input="ledger" value="${esc(S.ledgerQ || '')}" style="margin-bottom:10px">
    <div id="ledger-list">${ledgerRows(st)}</div></section>`;
}

function ledgerRows(st) {
  const q = norm(S.ledgerQ);
  const rows = Object.entries(st.ledger)
    .map(([pid, v]) => ({ pid: +pid, v, n: SLOTS.reduce((a, s) => a + v[s].length, 0) }))
    .filter(r => !q || norm(pname(r.pid)).includes(q))
    .sort((a, b) => b.n - a.n)
    .slice(0, 25);
  if (!rows.length) return `<p class="dim">${Object.keys(st.ledger).length ? 'No burns match.' : 'Nothing burned yet. Burns are recorded once each week is final.'}</p>`;
  return rows.map(r => `<div class="burn-item" style="align-items:flex-start">${thumb(r.pid, 'sm')}<div style="flex:1;min-width:0"><b>${esc(pname(r.pid))}</b>
    <div style="display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:4px;font-size:12.5px">${SLOTS.filter(s => r.v[s].length).map(s => `<span><span class="dim">${INFO[s].emoji} ${INFO[s].name}:</span> ${r.v[s].sort((a, b) => a.week - b.week).map(w => `${esc(userName(w.id))} <span class="dim">wk ${w.week}</span>`).join(', ')}</span>`).join('')}</div></div>
    <span class="wk">${r.n}×</span></div>`).join('');
}

function adminFirepower(st) {
  if (!st.firepower.length) return '';
  const max = st.firepower[0].score || 1;
  const min = st.firepower[st.firepower.length - 1].score;
  // Stretch the bars across the league's spread so small gaps are visible.
  const width = sc => (max > min ? 12 + 88 * (sc - min) / (max - min) : 100);
  return `<section class="panel"><div class="panel-title"><h2>Firepower left</h2><span class="muted">Strength of each person's best 5 unburned players in each player category</span></div>
    ${st.firepower.map((f, i) => `<div class="h2h-row" style="grid-template-columns:28px minmax(110px,180px) 1fr 44px">
      <span class="rank ${i < 3 ? 'top' : ''}" style="font-size:16px">${i + 1}</span><div class="who" style="min-width:0">${avatar(f.id)}<b>${esc(userName(f.id))}</b></div>
      <div><div class="h2h-bar"><i style="width:${width(f.score)}%"></i></div><div class="dim" style="font-size:11.5px;margin-top:4px">${LEAGUE.playerSlots.map(s => `${INFO[s].emoji} ${f.left[s][0] ? esc(shortName(f.left[s][0])) : '—'}`).join(' · ')}</div></div>
      <b class="num" style="text-align:right">${Math.round((f.score / max) * 100)}</b></div>`).join('')}
  </section>`;
}

function adminStyles(st) {
  const list = (arr, fmtFn) => arr.map((x, i) => `<div class="own-row" style="grid-template-columns:28px 1fr auto">${avatar(x.id)}<b style="font-weight:600">${esc(userName(x.id))}</b><span class="num">${fmtFn(x, i)}</span></div>`).join('');
  const relies = Object.values(st.people).filter(p => p.autos).sort((a, b) => b.autos - a.autos).slice(0, 6);
  return `<section class="panel"><div class="panel-title"><h2>Playing styles</h2></div>
    <div class="own-cols">
      <div><h3 class="kicker" style="margin:0 0 10px">🧠 Most contrarian</h3>${list(st.contrarian.slice(0, 6), x => `${Math.round(x.share * 100)}% overlap`) || '<p class="dim">Not enough weeks yet.</p>'}</div>
      <div><h3 class="kicker" style="margin:0 0 10px">🐐 Chalkiest</h3>${list([...st.contrarian].reverse().slice(0, 6), x => `${Math.round(x.share * 100)}% overlap`) || '<p class="dim">Not enough weeks yet.</p>'}</div>
      <div><h3 class="kicker" style="margin:0 0 10px">🤖 Autopilot regulars</h3>${list(relies, x => `${x.autos} slot${x.autos > 1 ? 's' : ''}`) || '<p class="dim">Everyone has picked for themselves.</p>'}</div>
    </div></section>`;
}

// ---------- Rules ----------

function viewRules() {
  const b = LEAGUE.bars;
  return `<div class="grid">
    <section class="hero"><span class="badge">How it works</span><h1>Pick 4. Burn 'em. Outlast the office.</h1><div class="sub">Five minutes a week. No draft, no roster, no money.</div>
      <div style="margin-top:14px"><button class="btn" data-act="tour-replay">Replay the quick tour</button></div></section>
    <div class="rules">
      <div class="panel rule"><h3>🗓️ The week</h3><p>Weeks run Monday to Sunday. Picks lock at the first tip-off of the week, shown in your local time. Week 1 (Oct 20 – Nov 1) and Week 17 (All-Star, Feb 15–28) are double weeks.</p></div>
      <div class="panel rule"><h3>🏀 The picks</h3><ul><li><b>Bucket</b>: a player's points</li><li><b>Glass</b>: a player's rebounds</li><li><b>Dime</b>: a player's assists</li><li><b>Dub</b>: a team's wins</li></ul><p>Each pick scores its <b>total</b> for the week, so a four-game week beats a two-game week.</p></div>
      <div class="panel rule"><h3>🔥 The burn</h3><p>Once you use a player in a category, he's gone from that category for the season, but still available in the other two. One player can only fill one of your slots in a given week.</p><p>Teams burn too: each team can be your Dub pick once a season. There are 30 teams for 23 weeks, so choose when to spend the contenders.</p></div>
      <div class="panel rule"><h3>🛟 Backups</h3><p>Add an optional backup to each player slot. It only comes in if your pick plays <b>zero</b> games that week; then the backup scores and burns instead, and your pick stays available. If your pick plays even once, his total counts and the backup stays unused. If neither plays, the slot scores 0 and nothing burns. Teams always play, so Dub has no backup.</p></div>
      <div class="panel rule"><h3>📊 Scoring</h3><p>Every category is ranked across the league each week. You get 1 point for every colleague whose pick you beat, ½ for a tie. Your weekly score is the sum of your four categories.</p><p>Drop your worst weeks: one drop unlocks after weeks 6, 12 and 18.</p></div>
      <div class="panel rule"><h3>❤️ Survivor</h3><p>Everyone starts with ${LEAGUE.lives} lives. Clear at least ${LEAGUE.barsToSurvive} of the ${SLOTS.length} weekly bars (${b.PTS} PTS / ${b.REB} REB / ${b.AST} AST / ${b.WIN} win, the same every week) or lose a life. Last one standing wins the Survivor Belt. You keep playing for points either way.</p></div>
      <div class="panel rule"><h3>🃏 Jokers</h3><ul><li><b>Double Down</b>: double the rank points from one slot, once a season.</li><li><b>Un-burn</b>: get one burned player back in one category, once a season.</li></ul></div>
      <div class="panel rule"><h3>🎴 Joker cards</h3><p>Earn packs, keep one card from each, and play one card a week: jinxes, traps, duels, heists, Blue Shells and pranks. Attacks are revealed at the lock. Cards move points but never cost a life.</p><p><button class="link" data-act="primer">How cards work →</button></p></div>
      <div class="panel rule"><h3>🤖 Autopilot</h3><p>Forgot to pick? At the lock, Autopilot fills empty slots with your best unburned projected week (season average × games). It never leaves you at zero, but it spends your best players first.</p></div>
      <div class="panel rule"><h3>🥊 Rivals</h3><p>Name one coworker as your rival and track your weekly head-to-head record. You can change your rival any time.</p></div>
      <div class="panel rule"><h3>🏆 Titles and awards</h3><ul><li><b>Season Champion</b></li><li><b>Title belts:</b> Survivor Belt, plus Scoring, Rebounding, Assists and Dub Champions (most of each from your picks over the season)</li><li><b>Monthly Crowns:</b> Nov, Dec, Jan, Feb, Mar/Apr</li><li><b>Hall of Fame</b> and <b>Hall of Shame:</b> fun season awards</li><li><b>Playoff Burn</b> (April–June)</li></ul><p>Every award comes with a downloadable certificate. The Trophies tab shows who's leading each race and where you stand.</p></div>
    </div>
  </div>`;
}

// ---------- Auth & profile ----------

function teamOptions(sel) {
  return `<option value="">Favorite team (optional)</option>` + Object.entries(TEAMS).sort((a, b) => a[1].city.localeCompare(b[1].city))
    .map(([k, t]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${t.city} ${t.name}</option>`).join('');
}

function viewAuth() {
  const signup = S.authMode === 'signup';
  const card = DEMO ? `
    <div class="panel auth-card"><div class="kicker">Demo league</div><h2 class="display" style="margin:6px 0 10px;font-size:28px">Take it for a spin</h2>
      <p class="muted">You're "You" in a league of 14 made-up colleagues, frozen on a Wednesday in early December. Week 6 is live and Week 7 picks are open.</p>
      <button class="btn primary" data-act="demo-enter" style="width:100%;margin-top:8px">Enter the demo</button>
      <p class="note" style="margin-top:12px">The real league runs once the commissioner connects Supabase. See the README.</p></div>`
    : `
    <div class="panel auth-card">
      <div class="seg"><button data-act="auth-mode" data-mode="signup" aria-pressed="${signup}">Join league</button><button data-act="auth-mode" data-mode="signin" aria-pressed="${!signup}">Sign in</button></div>
      <form data-form="auth">
        ${signup ? `<label class="field">Display name<input class="input" name="name" required minlength="2" maxlength="24" placeholder="e.g. Maya R." autocomplete="nickname"></label>
        <label class="field">Team<select class="input" name="team">${teamOptions('')}</select></label>` : ''}
        ${signup ? `<label class="field">Invite code<input class="input" name="invite" value="${esc(params.get('invite') || '')}" autocomplete="off" placeholder="From the commissioner's invite link"></label>` : ''}
        <label class="field">Email<input class="input" name="email" type="email" required autocomplete="email"></label>
        <label class="field">Password<input class="input" name="password" type="password" required minlength="6" autocomplete="${signup ? 'new-password' : 'current-password'}"></label>
        <div class="err" id="auth-err"></div>
        <button class="btn primary" type="submit">${signup ? 'Join the league' : 'Sign in'}</button>
        ${signup ? '' : '<button class="link" type="button" data-act="forgot">Forgot password?</button>'}
      </form>
    </div>`;
  return `<div class="auth-wrap">
    <div class="auth-pitch"><span class="badge">${LEAGUE.season} season · free to play</span>
      <h1>Pick 4.<br>Burn 'em.<br><em>Outlast the office.</em></h1>
      <p>Every week, pick a scorer, a rebounder, a passer and a team to win. Their weekly totals go up against everyone else's. Use each one once per category, then it's gone for the season.</p>
      <div class="steps">
        <div class="step"><span class="n">1</span><div><b>Pick by Monday's first tip</b><span>Bucket (PTS), Glass (REB), Dime (AST) and Dub (team wins). Add backups for injuries.</span></div></div>
        <div class="step"><span class="n">2</span><div><b>Beat everyone</b><span>1 point for every colleague your pick beats, in every category.</span></div></div>
        <div class="step"><span class="n">3</span><div><b>Survive</b><span>Clear ${LEAGUE.barsToSurvive} of the ${SLOTS.length} weekly bars or lose one of your ${LEAGUE.lives} lives. Last one standing wins the belt.</span></div></div>
      </div>
    </div>
    ${card}
  </div>`;
}

function viewProfileSetup() {
  return `<div class="auth-wrap" style="grid-template-columns:1fr;max-width:460px"><div class="panel auth-card">
    <div class="kicker">Almost there</div><h2 class="display" style="margin:6px 0 14px;font-size:28px">Set up your profile</h2>
    <form data-form="setup"><label class="field">Display name<input class="input" name="name" required minlength="2" maxlength="24"></label>
      <label class="field">Team<select class="input" name="team">${teamOptions('')}</select></label>
      <div class="err" id="auth-err"></div><button class="btn primary" type="submit">Join the league</button>
      <button class="link" type="button" data-act="signout">Sign out</button></form></div></div>`;
}

function openProfile() {
  const p = S.me;
  $('#modal-root').innerHTML = `<div class="modal-bg" data-act="close-modal-bg"><div class="modal narrow" role="dialog" aria-modal="true" aria-label="Profile">
    <div class="modal-head"><div class="ttl"><h3>Your profile</h3><button class="close-x" data-act="close-modal" aria-label="Close">×</button></div></div>
    <div class="modal-body pad"><form data-form="profile" style="display:grid;gap:12px">
      <label class="field">Display name<input class="input" name="name" required minlength="2" maxlength="24" value="${esc(p.display_name)}"></label>
      <label class="field">Team<select class="input" name="team">${teamOptions(p.fav_team)}</select></label>
      <div class="err" id="auth-err"></div>
      <button class="btn primary" type="submit">Save</button>
      <button class="btn ghost" type="button" data-act="signout">Sign out</button>
    </form></div></div></div>`;
}

// ---------- First-login tour and "What's new" ----------

// Stored on the profile so it follows people across devices; browser storage is
// a fallback if the profile columns haven't been added yet.
const seenKey = () => `phs-seen-${myId()}`;
function seenState() {
  let local = {};
  try { local = JSON.parse(localStorage.getItem(seenKey())) || {}; } catch { /* storage blocked */ }
  return { intro: !!(S.me?.intro_seen || local.intro), updates: Math.max(S.me?.updates_seen || 0, local.updates || 0) };
}

async function markSeen(patch) {
  const cur = seenState();
  const next = { intro: patch.intro_seen ?? cur.intro, updates: patch.updates_seen ?? cur.updates };
  try { localStorage.setItem(seenKey(), JSON.stringify(next)); } catch { /* storage blocked */ }
  try { await S.backend.updateProfile(patch); Object.assign(S.me, patch); } catch { /* columns missing: browser only */ }
}

function greet() {
  if (!S.me || S.greeted || $('#modal-root').innerHTML) return;
  S.greeted = true;
  const seen = seenState();
  if (!seen.intro) openTour(0);
  else if (LATEST_UPDATE > seen.updates) openWhatsNew(seen.updates);
}

const TOUR_BARS = LEAGUE.bars;
const TOUR = [
  {
    icon: '👋', kicker: 'Welcome', title: `Welcome to ${LEAGUE.name}`,
    body: () => `<p>Every week you make <b>four picks</b> and go up against everyone in the league. It's free, takes about five minutes, and the prize is bragging rights (plus a certificate).</p>
      <p>Picks lock at the <b>first tip-off of each week</b>, usually Monday evening. The countdown on <b>This Week</b> always shows the exact time in your time zone. Until then you can change your picks as often as you like.</p>`,
  },
  {
    icon: '🏀', kicker: 'Your picks', title: 'Four picks a week',
    body: () => `<div class="tour-slots">${SLOTS.map(s => `<div class="tour-slot" data-slot="${s}"><b>${INFO[s].emoji} ${INFO[s].name}</b><span>${s === 'WIN' ? "A team's wins" : `A player's ${INFO[s].stat.toLowerCase()}`}</span></div>`).join('')}</div>
      <p>Each pick scores its <b>total for the whole week</b>, so a player with four games beats one with two. The player list shows games this week and a projected total to help.</p>`,
  },
  {
    icon: '🔥', kicker: 'The catch', title: "Burn 'em",
    body: () => `<p>Once you use a player in a category, he's <b>gone from that category for the season</b>. He's still available in the other two, so the question is when, and where, to spend your stars.</p>
      <p>Teams burn too: each team can be your Dub <b>once a season</b>. A player can only fill one of your slots in a given week. Your <b>Burn Book</b> tab keeps track of what you've used.</p>`,
  },
  {
    icon: '🛟', kicker: 'Injury insurance', title: 'Backups',
    body: () => `<p>After you choose a player, tap <b>+ Add</b> next to <b>Backup</b> on his card to name a second player for that slot.</p>
      <p>The backup only comes in if your pick plays <b>zero games</b> that week. Then the backup's total counts, he's the one who burns, and your original pick stays available. If your pick plays even once, his total counts and the backup isn't used.</p>
      <p class="dim">Dub doesn't need a backup, since teams always play.</p>`,
  },
  {
    icon: '❤️', kicker: 'Scoring and survival', title: 'Beat everyone, stay alive',
    body: () => `<p><b>Points:</b> in every category, you get 1 point for each colleague whose pick you beat (½ for a tie). That's your weekly score, and it adds up across the season.</p>
      <p><b>Survivor:</b> you start with ${LEAGUE.lives} lives. Each week, clear at least ${LEAGUE.barsToSurvive} of these ${SLOTS.length} bars or lose one:</p>
      <div class="tour-bars">${SLOTS.map(s => `<span class="bar-pill">${INFO[s].emoji} <b>${TOUR_BARS[s]} ${s === 'WIN' ? (TOUR_BARS[s] === 1 ? 'win' : 'wins') : INFO[s].short}</b></span>`).join('')}</div>
      <p>Last one standing wins the Survivor Belt. Running out of lives doesn't stop you scoring points.</p>`,
  },
  {
    icon: '🃏', kicker: 'Extras', title: 'Jokers, Autopilot and rivals',
    body: () => `<ul class="tour-list">
        <li><b>Double Down:</b> double one slot's points, once a season.</li>
        <li><b>Un-burn:</b> get one used player back in one category, once a season.</li>
        <li><b>Autopilot:</b> forget to pick and it fills empty slots at the lock with your best unused option. You won't score zero, but it spends your best players first.</li>
        <li><b>Rivals:</b> pick a coworker and track your head-to-head record.</li>
        <li><b>After the lock</b> everyone's picks are revealed on <b>Results</b>.</li>
      </ul>`,
  },
  {
    icon: '🎴', kicker: 'Joker cards', title: 'Packs, cards and chaos',
    body: () => `<p>You also earn <b>packs of Joker cards</b>, mostly by making your own picks each week. Keep one card from each pack and play <b>one card a week</b>: jinx a colleague's pick, set a trap, challenge someone to a duel, or copy a rival's pick.</p>
      <p>Cards move points but <b>never cost a life</b>. Everything is revealed at the lock.</p>
      <p>The <b>Cards</b> tab has a quick guide, and every card in the Card Dex opens to show what it does.</p>`,
  },
];

function openTour(i) {
  S.tour = i;
  const st = TOUR[i];
  const last = i === TOUR.length - 1;
  $('#modal-root').innerHTML = `<div class="modal-bg"><div class="modal tour" role="dialog" aria-modal="true" aria-label="${esc(st.title)}">
    <div class="modal-body pad">
      <div class="tour-top"><span class="tour-icon">${st.icon}</span><div><div class="kicker">${esc(st.kicker)} · ${i + 1} of ${TOUR.length}</div><h3>${esc(st.title)}</h3></div></div>
      <div class="tour-body">${st.body()}</div>
      <div class="tour-foot">
        <div class="tour-dots">${TOUR.map((_, j) => `<i class="${j === i ? 'on' : ''}"></i>`).join('')}</div>
        <div class="row-actions">${i ? '<button class="btn ghost" data-act="tour-back">Back</button>' : ''}
          <button class="btn primary" data-act="${last ? 'tour-done' : 'tour-next'}">${last ? 'Make my picks' : 'Next'}</button></div>
      </div>
    </div></div></div>`;
}

function openWhatsNew(after = 0) {
  const list = UPDATES.filter(u => u.id > after).sort((a, c) => c.id - a.id);
  const items = (list.length ? list : [...UPDATES].sort((a, c) => c.id - a.id)).map(u => `
    <div class="update"><div class="kicker">${dshort(u.date)}</div><h4>${esc(u.title)}</h4><ul>${u.items.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('');
  $('#modal-root').innerHTML = `<div class="modal-bg" data-act="close-whats-new-bg"><div class="modal narrow" role="dialog" aria-modal="true" aria-label="What's new">
    <div class="modal-head"><div class="ttl"><div><div class="kicker">${esc(LEAGUE.name)}</div><h3>What's new</h3></div><button class="close-x" data-act="whats-new-done" aria-label="Close">×</button></div></div>
    <div class="modal-body pad">${items}<div class="row-actions" style="justify-content:flex-end;margin-top:6px"><button class="btn primary" data-act="whats-new-done">Got it</button></div></div>
  </div></div>`;
}

// ---------- Events ----------

function toast(msg, bad = false) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = `toast ${bad ? 'bad' : ''}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

const ACTIONS = {
  pick: el => openPicker(el.dataset.slot, el.dataset.which),
  choose: el => choose(+el.dataset.pid),
  'picker-sort': el => { S.picker.sort = el.dataset.sort; renderPicker(); },
  'close-modal': () => closeModal(),
  'close-modal-bg': (el, e) => { if (e.target === el) closeModal(); },
  'clear-alt': el => { S.draft.slots[el.dataset.slot].alt_id = null; S.draft.dirty = true; render(); },
  'clear-main': el => { const s = el.dataset.slot; S.draft.slots[s] = null; if (S.draft.dd === s) S.draft.dd = null; S.draft.dirty = true; render(); },
  dd: el => { const s = el.dataset.slot; S.draft.dd = S.draft.dd === s ? null : s; S.draft.dirty = true; render(); },
  save: () => save(),
  'unburn-open': () => openUnburn(),
  'unburn-choose': el => unburn(el.dataset.slot, +el.dataset.pid),
  'unburn-undo': async () => { try { await S.backend.setUnburn(null); toast('Un-burn returned to your hand.'); } catch (e) { toast(e.message, true); } await refresh(); },
  'results-week': el => { S.resultsWeek = +el.dataset.week; render(); },
  'pack-open': el => openWaitingPack(el.dataset.key),
  'pack-practice': () => practicePack(),
  'card-open': el => openPlay(el.dataset.uid),
  'play-mode': el => { S.play.mode = el.dataset.mode; renderPlay(); },
  'play-slot': el => {
    S.play.slot = el.dataset.slot;
    // Dub takes a team, the other slots a player: drop a choice that no longer fits.
    if (S.play.card === 'burn_notice' || (S.play.player != null && (S.play.slot === 'WIN') !== isTeamId(S.play.player))) S.play.player = null;
    renderPlay();
  },
  'play-player': el => { S.play.player = +el.dataset.pid; renderPlay(); },
  'play-player-clear': () => { S.play.player = null; renderPlay(); },
  'play-submit': el => submitPlay(el),
  'play-undo': async el => {
    try { await S.backend.deletePlay(el.dataset.id); toast('Taken back.'); } catch (e) { toast(e.message || String(e), true); }
    await refresh();
  },
  'duel-reply': async el => {
    const accept = el.dataset.accept === '1';
    try {
      await S.backend.savePlay({ week: S.league.openWeek, card: '_reply', target_id: el.dataset.to, params: { duel: el.dataset.id, accept } });
      toast(accept ? "Duel accepted. Don't choke." : 'Declined. Enjoy the chicken. 🐔');
    } catch (e) { toast(e.message || String(e), true); }
    await refresh();
  },
  'scout-view': el => showScout(+el.dataset.week, el.dataset.slot),
  'cards-week': el => { S.cardsWeek = +el.dataset.week; render(); },
  month: el => { S.month = el.dataset.key; render(); },
  cert: async el => {
    const A = S.awards || seasonAwards(S.league, pname);
    const a = [A.champion, ...A.titles, ...A.monthly, ...A.fame, ...A.shame].find(x => x.key === el.dataset.key);
    if (!a?.leader) return;
    await downloadCertificate({ title: a.title, name: userName(a.leader.id), detail: a.leaderText, kind: a.kind, date: new Date(now()).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }) });
  },
  'auth-mode': el => { S.authMode = el.dataset.mode; render(); },
  'profile-open': () => openProfile(),
  signout: async () => { await S.backend.signOut(); closeModal(); S.draft = null; await refresh(); },
  'demo-enter': async () => { await S.backend.signIn(); await refresh(); },
  'demo-reset': async () => { S.backend.reset(); location.reload(); },
  'admin-refresh': () => { S.adminData = null; render(); },
  'tour-next': () => openTour(S.tour + 1),
  'tour-back': () => openTour(S.tour - 1),
  'tour-done': async () => {
    closeModal();
    await markSeen({ intro_seen: true, updates_seen: LATEST_UPDATE });
    if (S.me) location.hash = '#week';
  },
  'tour-replay': () => openTour(0),
  'dex-open': el => openDex(el.dataset.card),
  'dex-scroll': () => $('#dex')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  primer: () => {
    S.primerOpen = true;
    const go = () => { const el = $('#primer'); if (el) { el.querySelector('details').open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } };
    if (S.view === 'cards') go(); else { location.hash = '#cards'; setTimeout(go, 60); }
  },
  'whats-new': () => openWhatsNew(0),
  'whats-new-done': async () => { closeModal(); if (S.me) await markSeen({ updates_seen: LATEST_UPDATE }); },
  'close-whats-new-bg': async (el, e) => { if (e.target === el) { closeModal(); if (S.me) await markSeen({ updates_seen: LATEST_UPDATE }); } },
  'copy-invite': async () => {
    try { await navigator.clipboard.writeText(inviteLink(S.adminData.invite)); toast('Invite link copied.'); }
    catch { toast('Could not copy. Your browser blocked clipboard access.', true); }
  },
  'invite-off': async () => {
    try { await S.backend.adminSetInvite(''); toast('Invite code turned off.'); } catch (e) { toast(e.message, true); }
    S.adminData = null; render();
  },
  'remove-open': el => openRemove(el.dataset.id),
  'remove-confirm': async el => {
    const id = el.dataset.id;
    const block = $('#remove-block')?.checked ?? true;
    el.disabled = true;
    try {
      await S.backend.adminRemoveMember(id, block);
      closeModal();
      toast(`${userName(id)} removed${block ? ' and blocked' : ''}.`);
      S.adminData = null;
      await refresh();
    } catch (e) { toast(e.message || String(e), true); el.disabled = false; }
  },
  unblock: async el => {
    try { await S.backend.adminUnblock(el.dataset.email); toast(`${el.dataset.email} can sign up again.`); } catch (e) { toast(e.message, true); }
    S.adminData = null;
    render();
  },
  'copy-emails': async () => {
    const emails = stillToPick().map(m => m.email).filter(Boolean);
    try { await navigator.clipboard.writeText(emails.join(', ')); toast(`Copied ${emails.length} email${emails.length === 1 ? '' : 's'}.`); }
    catch { toast('Could not copy. Your browser blocked clipboard access.', true); }
  },
  forgot: async () => {
    const email = document.querySelector('[data-form="auth"] [name="email"]').value;
    if (!email) return ($('#auth-err').textContent = 'Enter your email first.');
    try { await S.backend.resetPassword(email); toast('Check your email for a reset link.'); } catch (e) { $('#auth-err').textContent = e.message; }
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) { if (el.tagName === 'BUTTON' && el.type !== 'submit') e.preventDefault(); fn(el, e); }
});

document.addEventListener('change', async e => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  if (el.dataset.change === 'burn-user') { S.burnUser = el.value; render(); }
  if (S.play) {
    const k = el.dataset.change;
    if (k === 'play-target') { S.play.target = el.value; if (S.play.card === 'burn_notice') S.play.player = null; renderPlay(); }
    if (k === 'play-nick') S.play.nick = el.value;
    if (k === 'play-taunt') S.play.taunt = el.value;
    if (k === 'play-gift') S.play.giftTo = el.value;
    if (k === 'play-swap') { S.play.map[el.dataset.from] = el.value; }
  }
  if (el.dataset.change === 'rival') {
    try { await S.backend.updateProfile({ rival_id: el.value || null }); toast(el.value ? `Rivalry on: ${userName(el.value)}` : 'Rival cleared.'); } catch (err) { toast(err.message, true); }
    await refresh();
  }
});

document.addEventListener('submit', async e => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  const err = $('#auth-err');
  const btn = form.querySelector('[type="submit"]');
  btn.disabled = true;
  try {
    if (form.dataset.form === 'auth') {
      if (S.authMode === 'signup') await S.backend.signUp({ email: f.email, password: f.password, name: f.name, team: f.team, invite: f.invite });
      else await S.backend.signIn({ email: f.email, password: f.password });
    } else if (form.dataset.form === 'setup') {
      await S.backend.createProfile({ name: f.name, team: f.team });
    } else if (form.dataset.form === 'invite') {
      const code = (f.code || '').trim();
      if (!code) throw new Error('Enter a code, or use Turn off.');
      await S.backend.adminSetInvite(code);
      toast(`Invite code is now ${code}.`);
      S.adminData = null;
    } else if (form.dataset.form === 'profile') {
      await S.backend.updateProfile({ display_name: f.name.trim(), fav_team: f.team || null });
      closeModal();
      toast('Profile saved.');
    }
    await refresh();
  } catch (x) {
    if (err && form.contains(err)) err.textContent = x.message || String(x);
    else toast(x.message || String(x), true);
    btn.disabled = false;
  }
});

document.addEventListener('input', e => {
  if (e.target.dataset?.input === 'play-q' && S.play) {
    S.play.q = e.target.value;
    $('#play-list').innerHTML = playPlayerRows();
  }
  if (e.target.dataset?.input === 'ledger') {
    S.ledgerQ = e.target.value;
    $('#ledger-list').innerHTML = ledgerRows(funStats(S.league, S.data.players, S.data.teams));
  }
});

// Remember whether the primer is open across re-renders ('toggle' doesn't bubble).
document.addEventListener('toggle', e => { if (e.target.matches?.('[data-primer]')) S.primerOpen = e.target.open; }, true);

document.addEventListener('keydown', e => {
  // The tour is short and finishes with a button, so Escape doesn't skip it.
  if (e.key === 'Escape' && $('#modal-root').innerHTML && !$('.modal.tour')) closeModal();
});

boot();
