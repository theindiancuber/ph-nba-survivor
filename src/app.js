import { LEAGUE, buildWeeks, defaultLockAt, MONTH_LABELS, addDays } from './config.js';
import { weekDays, totalsThrough, etDate, seasonThrough } from './calendar.js';
import { nightStatus, recapNights, recapBoard, recapStats } from './recap.js';
import { computeLeague, headToHead, blockedReason, projection, teamProjection, fmt } from './league.js';
import { TEAMS, TEAM_BY_ID, DIVISIONS, isTeamId, teamLogo, headshot } from './teams.js';
import { SupabaseBackend, DemoBackend } from './backend.js';
import { downloadCertificate } from './certificate.js';
import { funStats, perfectPlay } from './stats.js';
import { UPDATES, LATEST_UPDATE } from './updates.js';
import { seasonAwards } from './awards.js';
import { CARDS, RARITY, TYPES, NICKNAMES, TAUNTS, isTrap, isHindsight, countsAsPlay, dealPack, seededDealer } from './cards.js';
import { cardFace, cardBack, packArt, openPack, initHolo } from './pack.js';
import { DECREES, parseDecree, resolveDecrees, decreeCodes } from './decrees.js';
import { weekRules, seasonRules, describeChange, LIMITS, WEEK_PATHS, SEASON_PATHS } from './settings.js';

const SLOTS = LEAGUE.slots;
const INFO = LEAGUE.slotInfo;
const STAT_IDX = { PTS: 0, REB: 1, AST: 2 };
const VIEWS = [
  ['week', 'This Week'], ['calendar', 'Calendar'], ['cards', 'Cards'], ['standings', 'Standings'], ['survivor', 'Survivor'], ['results', 'Results'],
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
  // A headshot or logo that fails to load is removed, or swapped for its data-fallback
  // text. One listener instead of inline onerror handlers, which the page's CSP blocks.
  document.addEventListener('error', e => {
    const img = e.target;
    if (img.tagName !== 'IMG') return;
    if (img.dataset.fallback) img.replaceWith(img.dataset.fallback); else img.remove();
  }, true);
  window.addEventListener('hashchange', () => { closeModal(); S.view = viewFromHash(); render(); window.scrollTo({ top: 0 }); });
  window.addEventListener('beforeunload', e => { if (S.draft?.dirty) { e.preventDefault(); e.returnValue = ''; } });
  setInterval(tick, 1000);
  await start();
  bindBrandGesture();
  if (!DEMO) {
    setInterval(async () => { if (!S.league) return; S.data = await loadData().catch(() => S.data); safeRefresh(); if (S.cal) { loadCalendar(true); if (S.recapWeek) loadCalendar(true, S.recapWeek); } }, 5 * 60e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.league) safeRefresh(); });
  }
}

// Gives up on a step that hangs, so a slow or stuck service shows an error and a retry instead of spinning.
function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} took too long to answer`)), ms); })]).finally(() => clearTimeout(t));
}

// Loads everything. If any of it fails it says so, then tries again by itself every 30 seconds.
async function start() {
  clearTimeout(S.retryTimer);
  try {
    if (DEMO) {
      const { makeDemo } = await import('./demo.js');
      const seed = makeDemo();
      S.clockOffset = seed.now - Date.now();
      S.backend = new DemoBackend(seed, now);
      S.data = { weeks: seed.weeks, players: seed.players, teams: seed.teams, totals: seed.totals, cardsFrom: seed.cardsFrom, meta: { updatedAt: new Date(seed.now).toISOString(), demo: true } };
      S.cal = { schedule: seed.schedule, days: seed.days };
      $('#demo-banner').innerHTML = `<div class="demo-banner">Demo league · made-up colleagues and simulated stats, frozen in early December. <button data-act="demo-reset">Reset demo</button></div>`;
    } else {
      S.backend = new SupabaseBackend();
      S.data = await loadData();
    }
    await withTimeout(S.backend.init(), 15000, 'Signing in');
    initHolo();
    S.view = viewFromHash();
    await withTimeout(refresh(), 25000, 'The league database');
  } catch (e) {
    console.error(e);
    S.league = null;
    $('#app').innerHTML = `<div class="panel empty-state"><div class="ic">⚠️</div><b>Couldn't load the league.</b>
      <p class="muted">${esc(e.message || e)}. Trying again in 30 seconds.</p><button class="btn primary" data-act="boot-retry">Try again now</button></div>`;
    S.retryTimer = setTimeout(start, 30e3);
  }
}

// Background refresh: if the database is unreachable, keep showing what we have and say so once.
async function safeRefresh() {
  try {
    await withTimeout(refresh(), 25000, 'The league database');
    if (S.offline) toast('Back online.');
    S.offline = false;
  } catch (e) {
    console.warn(e);
    if (!S.offline) toast("Can't reach the league right now. Showing the last update; retrying.", true);
    S.offline = true;
  }
}

function viewFromHash() {
  const v = location.hash.slice(1);
  return v === 'admin' || VIEWS.some(([k]) => k === v) ? v : 'week';
}

function views() {
  // Signed out, only the rules are readable, so don't offer tabs that all lead to the sign-in form.
  if (!S.me) return [['week', myId() ? 'Finish sign-up' : 'Join or sign in'], ['rules', 'Rules']];
  return S.isAdmin ? [...VIEWS, ['admin', 'Commissioner']] : VIEWS;
}

async function loadData() {
  const get = async f => {
    const r = await fetch(`data/${f}.json`, { cache: 'no-cache', signal: AbortSignal.timeout(15000) });
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
  S.decrees = resolveDecrees(S.db.decrees, S.db.tallies, Object.fromEntries(weeks.map(w => [w.week, w.lockAt])), now());
  // Kept so the Calendar can score the week as it stood after any day with the same inputs.
  S.leagueArgs = {
    weeks, totals: S.data.totals, picks: S.db.picks, unburns: S.db.unburns, plays: S.db.plays || [], profiles: S.db.profiles,
    now: now(), players: S.data.players,
    // The real league deals from the database's secret seeds; without them (cards SQL not run yet) cards stay off.
    cardsFrom: DEMO ? (S.data.cardsFrom ?? LEAGUE.cards.startWeek) : S.db.seeds ? LEAGUE.cards.startWeek : Infinity,
    dealer: S.db.seeds ? seededDealer(S.db.seeds) : undefined,
    decrees: decreeCodes(S.decrees),
    rules: S.db.settings?.rules || [], meta: S.db.settings?.meta || {}, adjustments: S.db.settings?.adjustments || [],
  };
  S.calMemo = {};
  S.league = computeLeague(S.leagueArgs);
  S.me = S.db.profiles.find(p => p.id === myId()) || null;
  if (S.adminFor !== myId()) {
    S.adminFor = myId();
    S.greeted = false;
    S.isAdmin = S.me ? await S.backend.isAdmin().catch(() => false) : false;
    S.adminData = null;
    // The commissioner's tab shows a dot when a night's recap is ready, which needs the schedule.
    if (S.isAdmin && !S.cal) loadCalendar();
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
  if (t) return `<div class="thumb team ${cls}" style="--tc1:${t.c1}"><span class="mini">${t.tri}</span><img src="${teamLogo(t.tri)}" alt="" loading="lazy"></div>`;
  const p = player(pid);
  const c = TEAMS[p?.team]?.c1 || '#1d3361';
  return `<div class="thumb ${cls}" style="--tc1:${c}"><span class="mini">${esc(initials(p?.name))}</span>${pid != null ? `<img src="${headshot(pid)}" alt="" loading="lazy">` : ''}</div>`;
}

function gchip(n) {
  return `<span class="gchip ${n >= 4 ? 'g4' : n <= 2 ? 'g2' : ''}">${n}G</span>`;
}

// ---------- Render ----------

// A bug in one page shouldn't take down the whole app: that page shows an error,
// and the tabs, the other pages and saving picks keep working.
function render() {
  if (!S.league) return;
  try {
    renderPage();
  } catch (e) {
    console.error(e);
    $('#app').innerHTML = `<div class="panel empty-state view-error"><div class="ic">🛠️</div><b>This page hit a snag.</b>
      <p class="muted">The other tabs still work. Try reloading, and tell the commissioner if it keeps happening.</p>
      <button class="btn primary" data-act="reload">Reload</button><p class="dim" style="font-size:12px;margin-top:12px">Details: ${esc(e.message || e)}</p></div>`;
  }
}

function renderPage() {
  renderTop();
  renderTabs();
  renderTicker();
  renderFooter();
  const signedIn = !!myId();
  let html;
  if (signedIn && !S.me) html = viewProfileSetup();
  // Members only: signed out, everything but the rules is the sign-in page.
  else if (!signedIn && S.view !== 'rules') html = viewAuth();
  else if (S.view === 'admin') html = S.isAdmin ? viewAdmin() : viewWeek();
  else html = ({ week: viewWeek, calendar: viewCalendar, cards: viewCards, standings: viewStandings, survivor: viewSurvivor, results: viewResults, burns: viewBurns, rivals: viewRivals, trophies: viewTrophies, rules: viewRules })[S.view]();
  $('#app').innerHTML = (S.me ? announcementBar() : '') + html;
  if ($('#recap-canvas')) drawRecap();
  tick();
  if (S.tour != null) redrawTour();
}

// The commissioner's announcement, on every page until it's cleared or you dismiss it.
function announcementBar() {
  const a = S.db?.settings?.meta?.announcement;
  if (!a?.text) return '';
  let gone = false;
  try { gone = localStorage.getItem(`phs-ann-${myId()}`) === String(a.at); } catch { /* storage blocked */ }
  if (gone) return '';
  return `<div class="announce"><span class="ic">📣</span><div class="txt"><small>From the Commissioner${a.at ? ` · ${dshort(a.at.slice(0, 10))}` : ''}</small>${esc(a.text)}</div><button class="close-x" data-act="announce-dismiss" aria-label="Dismiss">×</button></div>`;
}

function renderTop() {
  const el = $('#topbar-right');
  if (S.me) {
    el.innerHTML = `<button class="me-chip" data-act="profile-open" aria-label="Your profile">${avatar(S.me.id)}<span class="nm">${esc(S.me.display_name)}</span></button>`;
  } else {
    // The sign-in form is already on screen everywhere but the Rules tab.
    el.innerHTML = S.view === 'rules' ? `<a class="btn small" href="#week">${myId() ? 'Finish sign-up' : 'Sign in'}</a>` : '';
  }
}

function needsPicks() {
  if (!S.me || S.league.openWeek == null) return false;
  return SLOTS.some(s => !S.db.picks.some(p => p.user_id === myId() && p.week === S.league.openWeek && p.slot === s));
}

function renderTabs() {
  // Signed out, every page but Rules shows the sign-in form, which lives on the first tab.
  const cur = !S.me && S.view !== 'rules' ? 'week' : S.view;
  $('#tabs').innerHTML = views().map(([k, label]) => {
    const cardsDot = k === 'cards' && S.me && (waitingPacks().length || unansweredDuels().length);
    const dot = (k === 'week' && needsPicks()) || (k === 'results' && liveWeek()) || cardsDot || (k === 'admin' && recapDot()) ? '<span class="dot"></span>' : '';
    return `<a class="tab" role="tab" href="#${k}" aria-selected="${cur === k}">${label}${dot}</a>`;
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
            <div class="kicker">Locks at first tip · ${esc(lockText(open.lockAt))}</div>
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
        ${t ? `<img class="team-logo-big" src="${teamLogo(t.tri)}" alt="">` : ''}
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
      ${t ? `<img class="logo" src="${teamLogo(p.team)}" alt="${esc(t.name)}">` : ''}
      <span class="mono">${esc(initials(p?.name))}</span>
      <img class="shot" src="${headshot(sel.player_id)}" alt="">
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
        <div class="mt">${teamLogo(p.team) ? `<img src="${teamLogo(p.team)}" alt="">` : ''}${esc(p.team)}${p.pos ? ` · ${esc(p.pos)}` : ''} ${gchip(games)} <span>${fmt(avg)} ${INFO[P.slot].short}/g${p.pre ? ' (preseason)' : ''}</span>${why ? ` <span class="blocked">${esc(why)}</span>` : ''}</div></div>
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

function closeModal() { $('#modal-root').innerHTML = ''; S.picker = null; S.play = null; S.opsOpen = false; }

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
const PRACTICE_PACKS = 2;
function practiceLeft() {
  if (DEMO) return Infinity;
  try { return Math.max(0, PRACTICE_PACKS - Number(localStorage.getItem(`phs-practice-${myId()}`) || 0)); } catch { return PRACTICE_PACKS; }
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
  const dk = S.decrees?.[ow]?.decree?.kind;
  if (dk === 'ceasefire') return { why: "Ceasefire this week: the Commissioner's Decree says no cards. You can still gift it." };
  if (countsAsPlay(c)) {
    const mine = (cw(ow)?.plays || []).filter(p => p.user_id === myId() && p.ok && countsAsPlay(p.card));
    const limit = dk === 'free_for_all' ? 2 : 1;
    if (mine.length >= limit) return { why: limit > 1 ? `Free-for-all: you've played your ${limit} cards this week.` : `One card a week: you've played ${cardName(mine[0].card)}.` };
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
  const title = r.adj.map(x => `${x.label || CARDS[x.card].name}${x.note ? ` (${x.note})` : ''} ${x.pts > 0 ? '+' : ''}${fmt(x.pts)}${x.who ? ` (${userName(x.who)})` : ''}`).join(', ');
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

// Decrees from the open week on: votes to cast, and decrees already in force.
function decreeCallouts() {
  const ow = S.league.openWeek;
  if (ow == null) return [];
  return Object.values(S.decrees || {}).filter(d => d.week >= ow).sort((a, b) => a.week - b.week).map(d => {
    if (d.vote && !d.closed) {
      const mine = S.db.votes?.find(v => v.week === d.week)?.choice;
      const total = d.votes.reduce((a, b) => a + b, 0);
      return `<div class="decree vote"><div class="decree-head"><span class="ic">🗳️</span><div><small>The Commissioner's Decree · you decide</small><b>Vote on Week ${d.week}'s twist</b></div></div>
        <div class="decree-opts">${d.options.map((code, i) => {
          const x = parseDecree(code);
          const pct = total ? Math.round(d.votes[i] / total * 100) : 0;
          return `<button class="decree-opt ${mine === i ? 'on' : ''}" data-act="decree-vote" data-week="${d.week}" data-i="${i}" aria-pressed="${mine === i}">
            <span class="di">${x.icon}</span><span class="dt"><b>${esc(x.title)}</b><small>${esc(x.text)}</small></span>
            <span class="dv"><b>${d.votes[i]}</b><small>${pct}%</small></span><i style="width:${pct}%"></i></button>`;
        }).join('')}</div>
        <p class="note" style="margin:8px 0 0">${mine != null ? 'Tap your choice again to take your vote back. ' : ''}Voting closes ${esc(lockText(new Date(d.closesAt).toISOString()))}. Most votes wins; a tie goes to the option listed first.</p></div>`;
    }
    const x = d.decree;
    if (!x) return '';
    return `<div class="decree"><div class="decree-head"><span class="ic">📜</span><div><small>The Commissioner's Decree · Week ${d.week}${d.vote ? ' · voted by the league' : ''}</small><b>${x.icon} ${esc(x.title)}</b></div></div><p>${esc(x.text)}</p></div>`;
  });
}

function weekCallouts() {
  const out = decreeCallouts();
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
  const dk = ow != null ? S.decrees?.[ow]?.decree?.kind : null;
  const mainCount = ow != null ? (cw(ow)?.plays || []).filter(p => p.user_id === myId() && p.ok && countsAsPlay(p.card)).length : 0;
  const parts = [];
  const dex = collected(u);
  const albumN = u.cards.album.size;
  const ownPicked = ow != null && S.db.picks.some(p => p.user_id === myId() && p.week === ow && !p.auto);
  const slotsHtml = Array.from({ length: LEAGUE.cards.handLimit }, (_, i) => `<i class="${i < hand.length ? 'on' : ''}"></i>`).join('');
  parts.push(`<section class="hero cards-hero hud">
    <div class="hud-head"><span class="badge gold">Joker cards</span><h1>The card table</h1></div>
    <div class="hud-row">
      <div class="hud-tile"><small>Hand</small><div class="hand-slots">${slotsHtml}</div><b>${hand.length}/${LEAGUE.cards.handLimit}</b></div>
      <div class="hud-tile ${main ? 'used' : 'ready'}"><small>This week's play${dk === 'free_for_all' ? 's · Free-for-all' : ''}</small><b>${dk === 'ceasefire' ? '🏳️ Ceasefire' : main ? `✓ ${esc(cardName(main.card))}${dk === 'free_for_all' ? ` (${mainCount}/2)` : ''}` : ow != null ? '⚡ Ready' : '—'}</b></div>
      <div class="hud-tile"><small>Traps armed</small><b>${u.cards.armed.length ? '🛡️'.repeat(u.cards.armed.length) : '0'}</b></div>
      <div class="hud-tile"><small>Card Dex</small><b>${dex.size}/${Object.keys(CARDS).length}</b><span class="hud-bar"><i style="width:${dex.size / Object.keys(CARDS).length * 100}%"></i></span></div>
      <div class="hud-tile"><small>Album</small><b>${albumN}/30</b><span class="hud-bar"><i style="width:${albumN / 30 * 100}%"></i></span></div>
    </div>
    ${L.cards.from === Infinity ? `<p class="sub" style="margin:12px 0 0">Cards switch on once the commissioner finishes setting them up. Everyone gets a Starter Pack then.</p>`
      : ow != null && ow < L.cards.from ? `<p class="sub" style="margin:12px 0 0">Cards switch on in Week ${L.cards.from}. Everyone gets a Starter Pack then.</p>`
      : ow != null ? `<div class="next-pack ${ownPicked ? 'done' : ''}">${ownPicked ? `✓ Next week's Locker Room Pack is secured.` : `🎁 Save your own Week ${ow} picks to earn next week's Locker Room Pack.`}</div>` : ''}
    ${packs.length ? `<div class="packs-row">${packs.map(p => `<button class="pack-mini" data-act="pack-open" data-key="${esc(p.key)}" aria-label="Open pack"><div class="shell">${packArt(p)}</div><span class="btn small gold">Open</span></button>`).join('')}</div>` : ''}
    ${practiceLeft() > 0 ? `<div class="practice-row"><button class="btn small" data-act="pack-practice">🎲 Rip a practice pack${DEMO ? '' : ` (${practiceLeft()} left)`}</button><span>See what a pull feels like. Practice cards don't stick.</span></div>` : ''}
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
    const note = p.ok ? '' : ` <span class="dim">(${p.why === 'limit' ? "doesn't count: over this week's card limit" : p.why === 'ceasefire' ? "doesn't count: Ceasefire this week, so take it back" : p.why === 'not-in-hand' ? 'card not in your hand' : 'not valid'})</span>`;
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
        <div class="stickers">${teams.map(t => `<span class="sticker ${album.has(t) ? '' : 'off'}" title="${esc(`${TEAMS[t].city} ${TEAMS[t].name}`)}"><img src="${teamLogo(t)}" alt="${t}" loading="lazy" data-fallback="${t}"></span>`).join('')}</div></div>`;
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
          <div><b>2</b><span>Keep 1 of 3</span><small>Choose carefully: it's final</small></div>
          <div><b>3</b><span>Play 1 a week</span><small>Before the lock</small></div>
          <div><b>4</b><span>The reveal</span><small>Everything shows at the lock</small></div>
        </div>
        <ul class="primer-list">
          <li>🎁 <b>Bonus packs</b> for weekly awards, losing a life and finishing an album division.</li>
          <li>🃏 Hold up to <b>${C.handLimit} cards</b>. 🎲 Two practice packs let you try a pull for free.</li>
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
  const ow = S.league.openWeek ?? S.league.weeks.length;
  const season = Math.max(0, (ow - 1) / Math.max(1, S.league.weeks.length - 1));
  const tier = ow >= LEAGUE.cards.oddsFrom ? { pos: 1, season } : 'trail';
  const cards = dealPack(`practice-${Date.now()}-${Math.random()}`, 'practice', Math.random() < 0.4 ? 'album' : 'revenge', tier);
  if (!DEMO) {
    if (practiceLeft() <= 0) return;
    try { localStorage.setItem(`phs-practice-${myId()}`, String(PRACTICE_PACKS - practiceLeft() + 1)); } catch {}
  }
  await openPack({ pack, cards, practice: true, onKeep: async () => {} });
  render();
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
  const body = gift ? giftForm() : use.why ? `<p style="margin:0;color:var(--soft)">${esc(d.text)}</p><div class="callout"><span class="ic">⏳</span><div class="txt">${esc(use.why)}</div></div>` : playForm(use);
  $('#modal-root').innerHTML = `<div class="modal-bg" data-act="close-modal-bg"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(d.name)}">
    <div class="modal-head"><div class="ttl"><div><div class="kicker">${TYPES[d.type].label} · ${RARITY[d.rarity].label}</div><h3>${d.icon} ${esc(d.name)}</h3></div><button class="close-x" data-act="close-modal" aria-label="Close">×</button></div>
      <div class="seg" style="margin:0"><button data-act="play-mode" data-mode="play" aria-pressed="${!gift}">${isTrap(P.card) ? 'Arm it' : 'Play it'}</button><button data-act="play-mode" data-mode="gift" aria-pressed="${gift}">Gift it</button></div></div>
    <div class="modal-body pad"><div class="play-wrap">${cardFace(P.card, { cls: 'tilt' })}<div class="play-form">${body}<div class="err" id="play-err"></div></div></div></div>
  </div></div>`;
}

function giftForm() {
  const P = S.play;
  const others = Object.values(S.league.users).filter(u => u.id !== myId()).sort(byName);
  return `<p style="margin:0;color:var(--soft)">Give this card to a colleague. It lands in their hand next week, and it doesn't use up your card for the week. Alliances are allowed. Betrayal is encouraged.</p>
    <label class="field">Who gets it<select class="input" data-change="play-gift"><option value="">Choose…</option>${others.map(u => `<option value="${u.id}" ${P.giftTo === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
    <button class="btn primary" data-act="play-submit">Gift ${esc(CARDS[P.card].name)}</button>`;
}

function playForm(use) {
  const P = S.play, d = CARDS[P.card], L = S.league;
  const f = [`<p style="margin:0;color:var(--soft)">${esc(d.text)}</p>`];
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

// ---------- Calendar ----------

// The schedule and the day-by-day files load the first time the tab opens, then with each data refresh.
async function loadCalendar(force = false, W = calWeek().week) {
  if (DEMO || !S.league) return;
  const c = S.cal ||= { schedule: null, days: {}, busy: new Set() };
  const needSched = force || !c.schedule;
  const needDays = weekObj(W)?.status !== 'open' && (force || !(W in c.days));
  const key = `${needSched}|${needDays && W}`;
  if (c.busy.has(key) || (!needSched && !needDays)) return;
  c.busy.add(key);
  const get = async f => {
    const r = await fetch(`data/${f}.json`, { cache: 'no-cache', signal: AbortSignal.timeout(15000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`data/${f}.json: ${r.status}`);
    return r.json();
  };
  try {
    const [sched, days] = await Promise.all([
      needSched ? get('schedule') : null,
      needDays ? get(`days/${W}`) : null,
    ]);
    if (sched || !c.schedule) c.schedule = sched?.games || [];
    if (needDays) c.days[W] = days?.days || {};
    c.err = null;
    S.calMemo = {};
  } catch (e) {
    console.warn(e);
    c.err = e.message || String(e);
  } finally {
    c.busy.delete(key);
  }
  // Only redraw pages that show this data; elsewhere a redraw could wipe a half-typed form.
  if (S.view === 'calendar' || (S.view === 'admin' && S.adminTab === 'recap')) render();
  else if (S.league) renderTabs();
}

function calWeek() {
  const L = S.league;
  const pick = weekObj(S.calWeek);
  return pick || liveWeek() || (L.openWeek != null ? weekObj(L.openWeek) : L.weeks[L.weeks.length - 1]);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dow = iso => WEEKDAYS[new Date(iso + 'T12:00:00Z').getUTCDay()];
const tipTime = iso => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP])M/i, (_, x) => x.toLowerCase());
const slotTeam = pid => team(pid)?.tri || player(pid)?.team || null;

// The teams of your picks this week: your draft before the lock, what you locked in after.
function myTeams(w) {
  const out = {};
  const add = (pid, s) => { const t = pid != null && slotTeam(pid); if (t) (out[t] ||= []).push(INFO[s].emoji); };
  if (w.status === 'open') {
    if (w.week === S.league.openWeek) for (const s of SLOTS) add(S.draft?.slots[s]?.player_id, s);
  } else {
    const r = w.results[myId()];
    if (r) for (const s of SLOTS) { const x = r.slots[s]; add(x.copy ? x.copyPid : x.scorer ?? x.pid, s); }
  }
  return out;
}

// After the lock: how many people have a scoring pick on each team.
function leagueTeams(w) {
  const out = {};
  if (w.status === 'open') return out;
  for (const id of w.entrants) {
    const seen = new Set();
    for (const s of SLOTS) {
      const x = w.results[id].slots[s];
      const t = slotTeam(x.copy ? x.copyPid : x.scorer ?? x.pid);
      if (t && !seen.has(t)) { seen.add(t); out[t] = (out[t] || 0) + 1; }
    }
  }
  return out;
}

function viewCalendar() {
  const w = calWeek();
  const c = S.cal;
  if (!c?.schedule) {
    if (!DEMO && !c?.err) queueMicrotask(() => loadCalendar());
    return `<section class="panel empty-state"><div class="ic">📅</div><b>${c?.err ? "Couldn't load the schedule." : 'Loading the schedule…'}</b>${c?.err ? `<p class="muted">${esc(c.err)}</p><button class="btn primary" data-act="cal-retry">Try again</button>` : ''}</section>`;
  }
  if (w.status !== 'open' && !(w.week in c.days) && !DEMO && !c.err) queueMicrotask(() => loadCalendar());
  const dates = weekDays(w);
  const games = c.schedule.filter(g => g[1] >= w.start && g[1] <= w.end);
  const locked = w.status !== 'open';
  const mode = locked && S.calMode === 'days' ? 'days' : 'grid';
  return `<div class="grid">
    ${calHeader(w)}
    <section class="panel">
      <div class="seg cal-seg" role="group" aria-label="Calendar view">
        <button data-act="cal-mode" data-mode="grid" aria-pressed="${mode === 'grid'}">📅 Head-to-head schedule</button>
        <button data-act="cal-mode" data-mode="days" aria-pressed="${mode === 'days'}" ${locked ? '' : 'disabled title="Starts when the week locks"'}>📈 Day by day</button>
      </div>
      ${mode === 'grid' ? calGrid(w, dates, games) : calDays(w, dates, games)}
    </section>
  </div>`;
}

function calHeader(w) {
  const L = S.league;
  const weeks = L.weeks;
  const i = weeks.indexOf(w);
  const status = w.status === 'live' ? '<span class="badge live">Live</span>' : w.status === 'final' ? '<span class="badge final">Final</span>'
    : w.week === L.openWeek ? '<span class="badge open">Picks open</span>' : '<span class="badge">Upcoming</span>';
  const dec = w.decree;
  const near = weeks.filter(x => Math.abs(x.week - w.week) <= 3);
  return `<section class="panel cal-head">
    <div class="cal-nav">
      <button class="btn small icon" data-act="cal-week" data-week="${weeks[i - 1]?.week ?? ''}" ${i > 0 ? '' : 'disabled'} aria-label="Previous week">‹</button>
      <div class="cal-title">
        <div class="cal-badges">${status}${w.mult === 2 ? '<span class="badge gold">Double week</span>' : ''}${dec ? `<span class="badge">📜 ${esc(dec.title)}</span>` : ''}</div>
        <h2>Week ${w.week}</h2>
        <div class="muted">${weekRange(w)} · ${w.status === 'open' ? 'locks' : 'locked'} ${esc(lockText(w.lockAt))}</div>
      </div>
      <button class="btn small icon" data-act="cal-week" data-week="${weeks[i + 1]?.week ?? ''}" ${i < weeks.length - 1 ? '' : 'disabled'} aria-label="Next week">›</button>
    </div>
    <div class="pills cal-pills">${near.map(x => `<button class="pill ${x.status === 'live' ? 'live' : ''}" data-act="cal-week" data-week="${x.week}" aria-pressed="${x.week === w.week}">Wk ${x.week}</button>`).join('')}
      <select class="input cal-jump" data-change="cal-week-select" aria-label="Jump to week">${weeks.map(x => `<option value="${x.week}" ${x.week === w.week ? 'selected' : ''}>Week ${x.week} · ${weekRange(x)}</option>`).join('')}</select>
    </div>
  </section>`;
}

function calGrid(w, dates, games) {
  const today = etDate(now());
  const lockDay = etDate(Date.parse(w.lockAt));
  const at = {};
  for (const g of games) {
    at[`${g[3]}|${g[1]}`] = { g, home: true };
    at[`${g[4]}|${g[1]}`] = { g, home: false };
  }
  const count = tri => games.filter(g => g[3] === tri || g[4] === tri).length;
  const mine = myTeams(w), league = leagueTeams(w);
  const teams = Object.keys(TEAMS).map(tri => ({ tri, n: count(tri) }))
    .filter(t => !S.calMine || mine[t.tri])
    .sort((a, b) => b.n - a.n || a.tri.localeCompare(b.tri));
  const perDay = d => games.filter(g => g[1] === d).length;
  const head = dates.map(d => `<th class="cal-day ${d === today ? 'today' : ''}"><span>${dow(d)}${d === lockDay ? ' 🔒' : ''}</span><b>${dshort(d)}</b><small>${perDay(d) ? `${perDay(d)} games` : 'No games'}</small></th>`).join('');
  const cell = (tri, d) => {
    const x = at[`${tri}|${d}`];
    if (!x) return `<td class="cal-cell off ${d === today ? 'today' : ''}"></td>`;
    const [, , tip, home, away, st, hp, ap] = x.g;
    const opp = x.home ? away : home;
    const us = x.home ? hp : ap, them = x.home ? ap : hp;
    const res = st === 3 ? `<span class="${us > them ? 'win' : 'loss'}">${us > them ? 'W' : 'L'} ${us}–${them}</span>`
      : st === 2 ? `<span class="live">LIVE ${us ?? 0}–${them ?? 0}</span>` : `<span class="dim">${tip ? tipTime(tip) : 'TBD'}</span>`;
    return `<td class="cal-cell ${d === today ? 'today' : ''} ${st === 3 ? 'done' : ''}"><div class="cal-g"><span class="opp">${x.home ? 'vs' : '@'} <img src="${teamLogo(opp)}" alt="" loading="lazy">${opp}</span>${res}</div></td>`;
  };
  const rows = teams.map(({ tri, n }) => `<tr class="${mine[tri] ? 'me' : ''}">
    <th class="cal-team" scope="row"><div><img src="${teamLogo(tri)}" alt="" loading="lazy"><b>${tri}</b>${gchip(n)}${mine[tri] ? `<span class="cal-mine" title="Your picks">${mine[tri].join('')}</span>` : ''}${league[tri] ? `<span class="cal-league" title="${league[tri]} ${league[tri] === 1 ? 'person has' : 'people have'} a pick on this team">👥${league[tri]}</span>` : ''}</div></th>
    ${dates.map(d => cell(tri, d)).join('')}</tr>`).join('');
  const heavy = Object.keys(TEAMS).filter(t => count(t) >= (w.mult === 2 ? 8 : 4)).length;
  const light = Object.keys(TEAMS).filter(t => count(t) <= (w.mult === 2 ? 5 : 2)).length;
  const hasMine = Object.keys(mine).length;
  return `<div class="cal-tools">
      <span class="muted">${games.length ? `${games.length} games · <b>${heavy}</b> teams play ${w.mult === 2 ? 8 : 4}+ · <b>${light}</b> play ${w.mult === 2 ? 5 : 2} or fewer` : 'No games on the schedule yet'}</span>
      ${hasMine ? `<button class="pill" data-act="cal-mine" aria-pressed="${!!S.calMine}">Just my teams</button>` : ''}
    </div>
    ${games.length ? `<div class="table-wrap cal-wrap"><table class="cal-grid"><thead><tr><th class="cal-team">Team</th>${head}</tr></thead><tbody>${rows || `<tr><td colspan="${dates.length + 1}" class="muted">None of your picks' teams play this week.</td></tr>`}</tbody></table></div>` : ''}
    <p class="dim cal-legend">${SLOTS.map(s => INFO[s].emoji).join(' ')} your ${w.status === 'open' ? 'picks so far' : 'picks'}${w.status === 'open' ? '' : ' · 👥 people with a pick on the team'} · ${gchip(w.mult === 2 ? 8 : 4)} games this week · tip times in your time zone · scores refresh every few minutes during games</p>`;
}

// The week as it stood after a day: the real engine run on the week's games up to that day.
// The latest day is the live league itself, so it always matches Results.
function dayLeague(w, date) {
  const days = S.cal.days[w.week] || {};
  const last = Object.keys(days).sort().pop();
  if (!last || date >= last) return S.league;
  const memo = S.calMemo ||= {};
  const key = `${w.week}|${date}`;
  if (memo[key]) return memo[key];
  const a = S.leagueArgs;
  return memo[key] = computeLeague({
    ...a,
    weeks: a.weeks.map(x => x.week === w.week ? { ...x, final: false } : x),
    totals: { ...a.totals, [w.week]: totalsThrough(days, date) },
  });
}

function calDays(w, dates, games) {
  const days = S.cal.days[w.week];
  if (!days) {
    return S.cal.err ? `<div class="empty-state"><div class="ic">⚠️</div><b>Couldn't load the week's days.</b><p class="muted">${esc(S.cal.err)}</p><button class="btn primary" data-act="cal-retry">Try again</button></div>`
      : `<div class="empty-state"><div class="ic">⏳</div><b>Loading the week's days…</b></div>`;
  }
  const played = Object.keys(days).sort();
  if (!played.length) return `<div class="empty-state"><div class="ic">🏀</div><b>No games played yet.</b><p class="muted">The first results show here after the first tip.</p></div>`;
  const day = played.includes(S.calDay) ? S.calDay : played[played.length - 1];
  const prev = addDays(day, -1);
  const L = dayLeague(w, day), P = dayLeague(w, prev);
  const W = L.weeks.find(x => x.week === w.week), PW = P.weeks.find(x => x.week === w.week);
  const order = wk => [...wk.entrants].sort((a, b) => wk.results[b].score - wk.results[a].score || userName(a).localeCompare(userName(b)));
  const ranks = wk => { const o = order(wk), out = {}; o.forEach((id, i) => { out[id] = i && wk.results[o[i - 1]].score === wk.results[id].score ? out[o[i - 1]] : i + 1; }); return out; };
  const now1 = ranks(W), before = day === w.start ? null : ranks(PW);
  const today = etDate(now());
  const chips = dates.map(d => {
    const n = games.filter(g => g[1] === d).length;
    const ok = played.includes(d);
    return `<button class="cal-chip ${d === today ? 'today' : ''}" data-act="cal-day" data-day="${d}" aria-pressed="${d === day}" ${ok ? '' : 'disabled'}><span>${dow(d)}</span><b>${+d.slice(8)}</b><small>${ok ? `${n}G` : d === today ? 'Tonight' : d > today ? 'Later' : '—'}</small></button>`;
  }).join('');
  const label = `${dow(day)} ${dshort(day)}`;
  const moved = id => {
    if (!before) return '';
    const d = (before[id] ?? now1[id]) - now1[id];
    return d > 0 ? `<span class="trend-up">▲${d}</span>` : d < 0 ? `<span class="trend-down">▼${-d}</span>` : '<span class="dim">–</span>';
  };
  const me = meU();
  const rows = order(W).map(id => {
    const r = W.results[id], pr = PW.results[id];
    const gain = r.score - (pr?.score || 0);
    const u = L.users[id];
    return `<tr class="${id === myId() ? 'me' : ''}"><td class="rank ${now1[id] <= 3 ? 'top' : ''}">${now1[id]}</td><td class="c">${moved(id)}</td>
      <td><div class="who">${avatar(id)}<div><b>${esc(userName(id))}</b>${me?.rival === id ? ' <span class="badge cal-rival">Rival</span>' : ''}</div></div></td>
      <td class="c dim hide-sm">${r.cleared}/${SLOTS.length}</td>
      <td class="r"><span class="pts">${fmt(r.score)}</span>${gain ? ` <small class="${gain > 0 ? 'trend-up' : 'trend-down'}">${gain > 0 ? '+' : ''}${fmt(gain)}</small>` : ''}</td>
      <td class="r num">${fmt(seasonThrough(L, u, w.week))}</td></tr>`;
  }).join('');
  return `<div class="cal-chips" role="group" aria-label="Day">${chips}</div>
    ${myWeekByDay(w, dates, days, played)}
    <div class="panel-title cal-sub"><h3>Standings after ${label}</h3><span class="muted">${day === played[played.length - 1] && w.status === 'live' ? `Latest · stats updated ${S.data.meta?.updatedAt ? ago(S.data.meta.updatedAt) : '—'}` : 'Rank points as they stood that night'}</span></div>
    <div class="table-wrap"><table class="board"><thead><tr><th>#</th><th class="c">Day</th><th>Player</th><th class="c hide-sm">Bars</th><th class="r">Week pts</th><th class="r">Season</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="dim cal-legend">Week points are scored the way the live week is: a pick who hasn't played yet doesn't take rank points. ▲▼ is the change in place from the day before.</p>`;
}

// Your four picks, one column per day: what each did that night, and your week points after it.
function myWeekByDay(w, dates, days, played) {
  const r = w.results[myId()];
  if (!r) return '';
  const today = etDate(now());
  // A day without a line: no game, a game still to come (or on now), or a game he sat out.
  const noLine = (tri, d) => {
    const g = S.cal.schedule.find(x => x[1] === d && (x[3] === tri || x[4] === tri));
    if (!g) return '·';
    if (g[5] === 3) return 'DNP';
    return g[5] === 2 ? 'Live' : `${g[3] === tri ? 'vs' : '@'} ${g[3] === tri ? g[4] : g[3]}`;
  };
  const rows = SLOTS.map(s => {
    const x = r.slots[s];
    if (x.missing) return `<tr><td class="cal-rowh">${INFO[s].emoji} <span class="dim">No pick</span></td>${dates.map(() => '<td></td>').join('')}<td class="r">—</td></tr>`;
    const pid = x.copy ? x.copyPid : x.scorer ?? x.pid;
    const tri = slotTeam(pid);
    const cells = dates.map(d => {
      const day = days[d];
      if (s === 'WIN') {
        const t = day?.t?.[tri];
        if (t?.[0]) return `<td class="c"><b class="${t[1] ? 'win' : 'loss'}">${t[1] ? 'W' : 'L'}</b></td>`;
      } else {
        const l = day?.p?.[pid];
        if (l?.[0]) return `<td class="c"><b>${l[1 + STAT_IDX[s]]}</b></td>`;
      }
      return `<td class="c"><span class="dim cal-o">${noLine(tri, d)}</span></td>`;
    }).join('');
    return `<tr><td class="cal-rowh"><div class="cal-pick">${thumb(pid, 'sm')}<div><small>${INFO[s].emoji} ${INFO[s].name}</small><b>${esc(shortName(pid))}</b></div></div></td>${cells}<td class="r"><b>${x.value}</b> <small class="dim">${INFO[s].short}</small></td></tr>`;
  }).join('');
  const pts = dates.map(d => played.includes(d) ? `<td class="c"><b class="pts">${fmt(dayLeague(w, d).weeks.find(x => x.week === w.week).results[myId()]?.score || 0)}</b></td>` : '<td></td>').join('');
  return `<div class="panel-title cal-sub"><h3>Your week, day by day</h3><span class="muted">${fmt(r.score)} pts so far</span></div>
    <div class="table-wrap"><table class="board cal-mine-t"><thead><tr><th>Pick</th>${dates.map(d => `<th class="c ${d === today ? 'today' : ''}">${dow(d)} ${+d.slice(8)}</th>`).join('')}<th class="r">Week</th></tr></thead>
    <tbody>${rows}<tr class="cal-total"><td class="cal-rowh">Your points after the day</td>${pts}<td class="r"><b class="pts">${fmt(r.score)}</b></td></tr></tbody></table></div>`;
}

// ---------- Standings ----------

function viewStandings() {
  const L = S.league;
  const lw = [...lockedWeeks()].pop();
  const rival = meU()?.rival;
  // The raw-picks view: the same table scored from picks alone, with no Joker cards.
  const raw = S.standingsMode === 'raw';
  const T = u => raw ? u.raw : u;
  const moved = u => {
    const d = u.rank - u.raw.rank, pts = u.raw.counted - u.counted;
    const place = d > 0 ? `<span class="trend-up">▲${d}</span> ` : d < 0 ? `<span class="trend-down">▼${-d}</span> ` : '';
    return place || pts ? `${place}<span class="dim">${pts ? signed(pts) : ''}</span>` : '<span class="dim">Same</span>';
  };
  const rows = (raw ? L.rawStandings : L.standings).filter(u => Object.keys(u.weekly).length || u.id === myId()).map(u => `
    <tr class="${u.id === myId() ? 'me' : ''}">
      <td class="rank ${T(u).rank <= 3 ? 'top' : ''}">${T(u).rank}</td>
      <td><div class="who">${avatar(u.id)}<div><b>${esc(u.name)}</b>${lw ? decor(u.id, lw.week, true) : ''}${u.id === myId() ? '<span class="tag blue">You</span>' : ''}${u.id === rival ? '<span class="tag">Rival</span>' : ''}${u.lives === 0 ? '<span class="tag gold">Out of lives</span>' : ''}
        <div class="dim" style="font-size:12px">${u.team ? esc(u.team) + ' fan' : ''}</div></div></div></td>
      <td class="hide-sm">${hearts(u.lives)}</td>
      ${lw ? `<td class="r num ${raw ? 'hide-sm' : ''}">${T(u).weekly[lw.week] != null ? fmt(T(u).weekly[lw.week]) : '—'}${lw.status === 'live' ? ' <span class="dim">·live</span>' : ''}</td>` : ''}
      ${L.dropCount ? `<td class="r num hide-sm">${fmt(T(u).total)}</td>` : ''}
      <td class="r"><span class="pts">${fmt(T(u).counted)}</span></td>
      ${raw ? `<td class="r num" title="Places and points against the real standings (#${u.rank})">${moved(u)}</td>` : ''}
    </tr>`).join('');
  const toggle = `<div class="pills" role="group" aria-label="Standings view">
    <button class="pill" data-act="standings-mode" data-mode="real" aria-pressed="${!raw}">Actual</button>
    <button class="pill" data-act="standings-mode" data-mode="raw" aria-pressed="${raw}">🕊️ Raw picks</button></div>`;
  return `<div class="grid">
    <section class="panel">
      <div class="panel-title"><h2>${raw ? 'Standings from raw picks' : 'Season standings'}</h2>${rows ? toggle : ''}</div>
      <p class="muted" style="margin:-4px 0 10px;font-size:13px">${raw
        ? 'Just for fun: the table as it would be right now from everyone\'s picks alone, as if no Joker card had ever been played. No jinxes, heists, duels, Copycats or Sixth Men, and nothing blocked by an Embargo or a Burn Notice. Double Down, decrees and the commissioner\'s adjustments still count. The leader at the end of the season wins the Pure Hoops Champion title.'
        : L.dropCount ? `Worst ${L.dropCount} week${L.dropCount > 1 ? 's' : ''} dropped` : 'Drops unlock after weeks 6, 12 and 18'}</p>
      ${rows ? `<div class="table-wrap"><table class="board"><thead><tr><th>#</th><th>Player</th><th class="hide-sm">Lives</th>${lw ? `<th class="r ${raw ? 'hide-sm' : ''}">Wk ${lw.week}</th>` : ''}${L.dropCount ? '<th class="r hide-sm">Total</th>' : ''}<th class="r">${L.dropCount ? 'Counted' : 'Points'}</th>${raw ? '<th class="r" title="Places and points against the real standings">vs real</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>`
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

function weekAdjustments(week) {
  const list = (S.db.settings?.adjustments || []).filter(a => a.week === week);
  if (!list.length) return '';
  return `<div class="decree slim">⚖️ <span>Commissioner's adjustments: ${list.map(a => `<b>${esc(userName(a.user_id))}</b> ${adjText(a)}${a.reason ? ` <span class="dim">(${esc(a.reason)})</span>` : ''}`).join('; ')}</span></div>`;
}
const signed = n => `${n > 0 ? '+' : ''}${fmt(n)}`;
const adjText = a => [a.points ? `${signed(a.points)} pts` : '', a.lives ? `${signed(a.lives)} ${Math.abs(a.lives) === 1 ? 'life' : 'lives'}` : ''].filter(Boolean).join(', ');

function resultsMineStrip(w) {
  const id = myId();
  if (!id || !w.results[id]) return '';
  const r = w.results[id];
  const rank = [...w.entrants].sort((a, b) => w.results[b].score - w.results[a].score).findIndex(x => x === id) + 1;
  const hits = (w.cards?.plays || []).filter(p => p.ok && p.target_id === id && !['_keep', '_reply'].includes(p.card));
  const hitTxt = hits.length
    ? hits.slice(0, 4).map(p => `${CARDS[p.card]?.icon || '🎴'} ${CARDS[p.card]?.name || p.card}${p.user_id ? ` · ${userName(p.user_id)}` : ''}`).join(' · ')
    : 'Nothing landed on you';
  return `<div class="results-mine">
    <div class="stat"><b>#${rank}</b><small>Your place</small></div>
    <div class="stat"><b class="num">${fmt(r.score)}</b><small>Your points</small></div>
    <div class="stat"><b>${r.cleared}/${SLOTS.length}</b><small>Bars cleared</small></div>
    <div class="stat"><b>${w.status === 'final' ? (r.survived ? '✓' : 'Lost a life') : '…'}</b><small>Survivor</small></div>
    <div class="results-mine-hits"><small class="kicker">Cards that hit you</small><div>${esc(hitTxt)}</div></div>
  </div>`;
}

// Results filters: a search over colleagues and their picks, one category at a time, sorting and the bars.
function rf() { return (S.rf ||= { q: '', show: 'all', sort: 'score', dir: -1, bars: 'any' }); }
const RF_BARS = {
  any: () => true,
  all: r => r.cleared === SLOTS.length,
  safe: r => r.survived,
  short: r => !r.survived,
};
function resultsSortValue(r, key) {
  if (key === 'score') return r.score;
  if (key === 'bars') return r.cleared;
  const x = r.slots[key];
  return x.missing ? -Infinity : x.value;
}

function resultsRows(w) {
  const F = rf();
  const q = norm(F.q.trim());
  const cols = F.show === 'all' ? SLOTS : [F.show];
  const byScore = [...w.entrants].sort((a, b) => w.results[b].score - w.results[a].score);
  // The place is always the real one for the week, whatever the table is sorted or filtered by.
  const place = {};
  byScore.forEach((id, i) => { place[id] = i > 0 && w.results[byScore[i - 1]].score === w.results[id].score ? place[byScore[i - 1]] : i + 1; });
  const names = id => {
    const r = w.results[id];
    const pids = SLOTS.flatMap(s => { const x = r.slots[s]; return [x.pid, x.alt, x.scorer, x.copyPid]; }).filter(x => x != null);
    return [userName(id), ...pids.map(pname)].map(norm);
  };
  const ids = byScore
    .filter(id => RF_BARS[F.bars](w.results[id]))
    .filter(id => !q || names(id).some(n => n.includes(q)))
    .sort((a, b) => F.dir * (resultsSortValue(w.results[a], F.sort) - resultsSortValue(w.results[b], F.sort)) || place[a] - place[b]);
  if (!ids.length) return { count: 0, html: `<tr><td colspan="${cols.length + 4}" class="dim" style="text-align:center;padding:22px">Nobody matches these filters.</td></tr>` };
  const html = ids.map(id => {
    const r = w.results[id];
    const rank = place[id];
    const cells = cols.map(s => {
      const x = r.slots[s];
      if (x.missing) return '<td><span class="dim">—</span></td>';
      const pid = x.copy ? x.copyPid : x.scorer ?? x.pid;
      const bar = LEAGUE.bars[s];
      return `<td><div class="cell-pick">${thumb(pid, 'sm')}<div><div class="v" style="color:${x.base >= bar ? 'var(--text)' : 'var(--muted)'}">${x.value}${x.dd ? ' 🔥' : ''}${fxIcons(x)}</div><div class="n">${x.copy ? `🐱 ${esc(userName(x.copy))}'s` : esc(shortName(pid))}${x.usedAlt ? ' (B)' : ''}${x.auto ? ' · auto' : ''}</div><div class="rp">+${fmt(x.rank)}</div></div></div></td>`;
    }).join('');
    const surv = w.status === 'final' ? (r.survived ? '<span class="trend-up">✓</span>' : '<span class="trend-down">✗ ❤️</span>') : `<span class="dim">${r.cleared}/${SLOTS.length}</span>`;
    return `<tr class="${id === myId() ? 'me' : ''}"><td class="rank ${rank <= 3 ? 'top' : ''}">${rank}</td><td><div class="who">${avatar(id)}<div><b>${esc(userName(id))}</b>${decor(id, w.week)}</div></div></td>${cells}<td class="r"><span class="pts">${fmt(r.score)}</span>${adjChip(r)}</td><td class="c">${surv}</td></tr>`;
  }).join('');
  return { count: ids.length, html };
}

function resultsCount(w, n) {
  const all = w.entrants.length;
  return n === all ? `${all} entr${all === 1 ? 'y' : 'ies'}` : `Showing ${n} of ${all}`;
}

function resultsFilters(w) {
  const F = rf();
  const active = F.q || F.show !== 'all' || F.sort !== 'score' || F.bars !== 'any';
  const shows = [['all', 'All'], ...SLOTS.map(s => [s, `${INFO[s].emoji} ${INFO[s].name}`])];
  const bars = [['any', 'Any'], ['all', `All ${SLOTS.length}`], ['safe', w.status === 'final' ? 'Survived' : `${LEAGUE.barsToSurvive}+ cleared`], ['short', w.status === 'final' ? 'Lost a life' : `Under ${LEAGUE.barsToSurvive}`]];
  return `<div class="results-filters">
    <input class="input" type="search" placeholder="Search a colleague or a player" aria-label="Search the results" data-input="results-q" value="${esc(F.q)}" autocomplete="off">
    <div class="rf-group"><span class="kicker">Show</span><div class="pills">${shows.map(([k, label]) => `<button class="pill" data-act="results-show" data-key="${k}" aria-pressed="${F.show === k}">${label}</button>`).join('')}</div></div>
    <div class="rf-group"><span class="kicker">Bars</span><div class="pills">${bars.map(([k, label]) => `<button class="pill" data-act="results-bars" data-key="${k}" aria-pressed="${F.bars === k}">${label}</button>`).join('')}</div></div>
    ${active ? '<button class="link" data-act="results-clear">Clear filters</button>' : ''}
  </div>`;
}

function resultsHead() {
  const F = rf();
  const cols = F.show === 'all' ? SLOTS : [F.show];
  const th = (key, label, cls = '') => {
    const on = F.sort === key;
    return `<th class="${cls}"><button class="th-sort ${on ? 'on' : ''}" data-act="results-sort" data-key="${key}" aria-label="Sort by ${esc(label)}">${label}${on ? (F.dir < 0 ? ' ▼' : ' ▲') : ''}</button></th>`;
  };
  return `<tr><th>#</th><th>Player</th>${cols.map(s => th(s, `${INFO[s].emoji} ${INFO[s].name}`)).join('')}${th('score', 'Pts', 'r')}${th('bars', 'Bars', 'c')}</tr>`;
}

function viewResults() {
  const weeks = lockedWeeks();
  if (!weeks.length) return `<section class="panel empty-state"><div class="ic">🔒</div><b>Nothing to show yet.</b><p>Everyone's picks are revealed when Week 1 locks.</p></section>`;
  const w = resultsWeekObj();
  const recent = weeks.slice(-8);
  const body = resultsRows(w);
  return `<div class="grid">
    <section class="panel">
      <div class="panel-title"><h2>Week ${w.week} ${w.status === 'live' ? '<span class="badge live">Live</span>' : '<span class="badge final">Final</span>'}</h2>
        <div class="results-week-nav">
          <label class="field" style="margin:0;min-width:140px"><span class="dim" style="font-size:11px">Jump to week</span>
            <select class="input" data-change="results-week-select" aria-label="Results week">${[...weeks].reverse().map(x =>
              `<option value="${x.week}" ${x.week === w.week ? 'selected' : ''}>Week ${x.week}${x.status === 'live' ? ' · live' : ''}</option>`).join('')}
            </select></label>
          <div class="pills">${recent.map(x => `<button class="pill ${x.status === 'live' ? 'live' : ''}" data-act="results-week" data-week="${x.week}" aria-pressed="${x.week === w.week}">Wk ${x.week}</button>`).join('')}</div>
        </div></div>
      ${resultsMineStrip(w)}
      ${weekAdjustments(w.week)}
      ${w.decree ? `<div class="decree slim"><span>📜 Decree: <b>${w.decree.icon} ${esc(w.decree.title)}</b></span> <span class="dim">${esc(w.decree.text)}</span></div>` : ''}
      <p class="muted" style="margin:-6px 0 12px;font-size:13px">${weekRange(w)} · bars ${SLOTS.map(s => `${LEAGUE.bars[s]} ${INFO[s].short}`).join(' / ')} · (B) backup scored · 🔥 Double Down · card icons show what hit a pick (hover for who)</p>
      ${resultsFilters(w)}
      <p class="muted" id="results-count" style="margin:0 0 8px;font-size:12.5px">${resultsCount(w, body.count)} · tap a column to sort</p>
      <div class="table-wrap"><table class="board"><thead>${resultsHead()}</thead><tbody id="results-body">${body.html}</tbody></table></div>
    </section>
    ${cardTablePanel(w)}
    ${ownershipPanel(w)}
    ${w.awards?.length ? `<section class="panel"><div class="panel-title"><h2>Week ${w.week} awards</h2></div><div class="awards">${w.awards.map(a => `
      <div class="award"><div class="ic">${a.icon}</div><h4>${esc(a.title)}</h4><div class="who-line">${esc(userName(a.user))}${a.pid ? ` · ${esc(pname(a.pid))}` : ''}</div><p>${esc(a.text)}</p></div>`).join('')}</div></section>` : ''}
  </div>`;
}

function resultsWeekObj() {
  const weeks = lockedWeeks();
  return weekObj(S.resultsWeek) && weekObj(S.resultsWeek).status !== 'open' ? weekObj(S.resultsWeek) : weeks[weeks.length - 1];
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
  const voteWeek = Object.values(S.decrees || {}).find(d => d.vote && !d.closed)?.week;
  Promise.all([
    S.backend.adminMembers(),
    wk != null ? S.backend.adminCheckin(wk).catch(() => S.backend.adminPickStatus(wk)) : [],
    S.backend.adminBlocked().catch(() => []),
    S.backend.adminGetInvite().catch(() => undefined),
    voteWeek != null ? S.backend.adminVoteTurnout(voteWeek).catch(() => []) : [],
  ])
    .then(([members, status, blocked, invite, voters]) => {
      S.adminData = {
        members, blocked, invite,
        status: Object.fromEntries(status.map(r => [r.user_id, r])),
        voters: new Set((voters || []).map(v => v.user_id)),
        voteWeek,
        week: wk,
      };
    })
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
  const tab = ADMIN_TABS.some(([k]) => k === S.adminTab) ? S.adminTab : 'members';
  const toPick = open && S.adminData?.members ? stillToPick().length : 0;
  const decreesLeft = Math.max(0, LEAGUE.decree.perSeason - Object.keys(S.decrees || {}).length);
  const count = { members: toPick, decrees: decreesLeft, recap: recapDot() ? 'New' : 0 };
  const head = `<header class="page-head"><div><span class="badge">🔒 Commissioner only</span><h1>The Commissioner's office</h1>
      <p>Everyone's picks stay hidden until each lock, including from you. Everything you change here is public.</p></div></header>
    <nav class="subnav" aria-label="Commissioner sections">${ADMIN_TABS.map(([k, label, ic]) => `<button data-act="admin-tab" data-tab="${k}" aria-pressed="${k === tab}">${ic} ${label}${count[k] ? `<span class="count${k === 'decrees' ? ' soft' : ''}">${count[k]}</span>` : ''}</button>`).join('')}</nav>`;
  if (tab === 'members') return `<div class="grid">${head}${adminRoster(open)}${adminReminder(open)}<div class="split">${adminInvite()}${adminAnnounce()}</div></div>`;
  if (tab === 'rules') return `<div class="grid">${head}${adminRules()}${adminSeason()}${adminAdjust()}</div>`;
  if (tab === 'decrees') return `<div class="grid">${head}${adminDecree()}</div>`;
  if (tab === 'recap') return `<div class="grid">${head}${adminRecap()}</div>`;
  const st = funStats(L, S.data.players, S.data.teams);
  return `<div class="grid">${head}
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

// ---- Nightly recap (Commissioner tab): a leaderboard image and fun stats to share ----

const recapWeekOf = date => S.league.weeks.find(w => date >= w.start && date <= w.end);

// The latest night that's over (every game final), for the tab's "New" dot.
function recapLatest() {
  if (!S.cal?.schedule) return null;
  const nights = recapNights(S.cal.schedule, S.league.weeks, etDate(now()));
  return [...nights].reverse().find(d => nightStatus(S.cal.schedule, d, now()).over) || null;
}
const recapSeenKey = () => `phs-recap-${myId()}`;
function recapDot() {
  if (!S.isAdmin) return false;
  const d = recapLatest();
  if (!d) return false;
  try { return (localStorage.getItem(recapSeenKey()) || '') < d; } catch { return false; }
}

function adminRecap() {
  const c = S.cal;
  if (!c?.schedule) {
    if (!DEMO && !c?.err) queueMicrotask(() => loadCalendar());
    return `<section class="panel empty-state"><div class="ic">📸</div><b>${c?.err ? "Couldn't load the schedule." : 'Loading…'}</b>${c?.err ? `<p class="muted">${esc(c.err)}</p><button class="btn primary" data-act="cal-retry">Try again</button>` : ''}</section>`;
  }
  const nights = recapNights(c.schedule, S.league.weeks, etDate(now()));
  if (!nights.length) return `<section class="panel empty-state"><div class="ic">📸</div><b>No nights to recap yet.</b><p class="muted">After the first night of games in a locked week, its leaderboard and fun stats show here.</p></section>`;
  const date = nights.includes(S.recapDate) ? S.recapDate : recapLatest() || nights[nights.length - 1];
  const w = recapWeekOf(date);
  S.recapWeek = w.week;
  const i = nights.indexOf(date);
  const st = nightStatus(c.schedule, date, now());
  const label = `${dow(date)}, ${dshort(date)}`;
  const nav = `<div class="recap-nav">
      <button class="btn small icon" data-act="recap-night" data-date="${nights[i - 1] || ''}" ${i > 0 ? '' : 'disabled'} aria-label="Night before">‹</button>
      <div><b>${label}</b><span class="muted">Week ${w.week} · ${st.games} game${st.games === 1 ? '' : 's'}</span></div>
      <button class="btn small icon" data-act="recap-night" data-date="${nights[i + 1] || ''}" ${i < nights.length - 1 ? '' : 'disabled'} aria-label="Night after">›</button>
    </div>`;
  const status = st.over ? `<span class="badge open">Final · all ${st.games} games done</span>`
    : `<span class="badge live">${st.done} of ${st.games} games final</span> <span class="muted">Share it after the last game. It updates as scores come in.</span>`;
  const days = c.days[w.week];
  if (!days) {
    if (!DEMO && !c.err) queueMicrotask(() => loadCalendar(false, w.week));
    return `<section class="panel">${nav}<div class="empty-state"><div class="ic">⏳</div><b>Loading the night's stats…</b></div></section>`;
  }
  if (!days[date]) {
    return `<section class="panel">${nav}<div class="recap-status">${status}</div><div class="empty-state"><div class="ic">🏀</div><b>No box scores for this night yet.</b><p class="muted">They show here once the first game tips off.</p></div></section>`;
  }
  if (st.over && date === recapLatest()) { try { localStorage.setItem(recapSeenKey(), date); } catch { /* storage blocked */ } }
  const after = dayLeague(w, date), before = dayLeague(w, addDays(date, -1));
  const kind = S.recapKind === 'week' ? 'week' : 'season';
  const rows = recapBoard(after, before, w.week, kind);
  const text = recapStats({ after, before, W: w.week, date, day: days[date], schedule: c.schedule, players: S.data.players, label });
  S.recap = { date, rows, kind, W: w.week, label, final: st.over, text };
  const canShare = typeof navigator.canShare === 'function';
  return `<section class="panel">
      <div class="panel-title"><h2>Nightly recap</h2><span class="muted">Ready after each night's last game</span></div>
      ${nav}
      <div class="recap-status">${status}</div>
    </section>
    <div class="split recap-split">
      <section class="panel">
        <div class="panel-title"><h3>Leaderboard image</h3>
          <div class="seg recap-seg" role="group" aria-label="Which leaderboard">
            <button data-act="recap-board" data-kind="season" aria-pressed="${kind === 'season'}">Season</button>
            <button data-act="recap-board" data-kind="week" aria-pressed="${kind === 'week'}">Week ${w.week}</button>
          </div></div>
        <canvas id="recap-canvas" class="recap-canvas" role="img" aria-label="Leaderboard after ${esc(label)}"></canvas>
        <div class="recap-actions">
          ${canShare ? '<button class="btn primary" data-act="recap-share">Share…</button>' : ''}
          <button class="btn ${canShare ? '' : 'primary'}" data-act="recap-download">Download image</button>
          <button class="btn" data-act="recap-copy-img">Copy image</button>
        </div>
      </section>
      <section class="panel">
        <div class="panel-title"><h3>Fun stats</h3><button class="btn small primary" data-act="recap-copy-text">Copy text</button></div>
        <textarea class="input recap-text" readonly rows="18" aria-label="Fun stats to copy">${esc(text)}</textarea>
        <p class="dim" style="font-size:12px;margin:8px 0 0">Everything here comes from picks that have already locked, so it's safe to share.</p>
      </section>
    </div>`;
}

const recapFile = () => `peakhill-${S.recap?.kind || 'season'}-${S.recap?.date || 'recap'}.png`;
const recapBlob = () => new Promise(res => { const cv = $('#recap-canvas'); if (!cv) res(null); else cv.toBlob(res, 'image/png'); });

// The brand mark from the header, as an image the canvas can draw.
let brandImg = null;
function brandImage() {
  if (brandImg) return brandImg;
  const svg = document.querySelector('.brand-mark');
  if (!svg) return Promise.resolve(null);
  let src = new XMLSerializer().serializeToString(svg);
  if (!src.includes('xmlns=')) src = src.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
  src = src.replace('<svg ', '<svg width="56" height="88" ');
  brandImg = new Promise(res => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(src)}`;
  });
  return brandImg;
}

// Draws the leaderboard as a 1080px-wide image, sized for phones and group chats.
async function drawRecap() {
  const R = S.recap;
  if (!R) return;
  try { await Promise.all(['700 80px Oswald', '600 28px Geist', '500 20px "Geist Mono"', '600 16px Montserrat'].map(f => document.fonts.load(f))); } catch { /* fall back to system fonts */ }
  const logo = await brandImage();
  const cv = $('#recap-canvas');
  if (!cv || S.recap !== R) return;
  const W = 1080, PAD = 64, ROW = 64, TOP = 352;
  const H = TOP + Math.max(1, R.rows.length) * ROW + 120;
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  const font = (f, color) => { c.font = f; c.fillStyle = color; };
  const spaced = px => { if ('letterSpacing' in c) c.letterSpacing = `${px}px`; };
  const right = (t, x, y) => { c.textAlign = 'right'; c.fillText(t, x, y); c.textAlign = 'left'; };
  const fit = (t, max) => { if (c.measureText(t).width <= max) return t; while (t.length > 1 && c.measureText(`${t}…`).width > max) t = t.slice(0, -1); return `${t}…`; };

  const bg = c.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#11141c'); bg.addColorStop(1, '#08090d');
  c.fillStyle = bg; c.fillRect(0, 0, W, H);
  for (const [x, col] of [[W * 0.92, 'rgba(200,16,46,.30)'], [W * 0.05, 'rgba(29,66,138,.35)']]) {
    const g = c.createRadialGradient(x, 0, 0, x, 0, 560);
    g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, W, 620);
  }
  c.fillStyle = '#022350'; c.fillRect(0, 0, W / 2, 8);
  c.fillStyle = '#c8102e'; c.fillRect(W / 2, 0, W / 2, 8);

  if (logo) c.drawImage(logo, PAD, 52, 42, 66);
  spaced(1); font('600 34px Geist, sans-serif', '#f5f6f8'); c.fillText('PEAKHILL', PAD + 60, 88);
  spaced(5); font('600 15px Montserrat, Geist, sans-serif', '#9198a6'); c.fillText('NBA SURVIVOR', PAD + 62, 114);
  // Status pill, top right.
  spaced(3); font('600 16px Geist, sans-serif', R.final ? '#8ef0c6' : '#ffb3c1');
  const pill = R.final ? 'FINAL' : 'LIVE';
  const pw = c.measureText(pill).width + 44;
  c.fillStyle = R.final ? 'rgba(52,211,153,.14)' : 'rgba(240,53,90,.16)';
  c.beginPath(); c.roundRect(W - PAD - pw, 66, pw, 40, 20); c.fill();
  c.fillStyle = R.final ? '#34d399' : '#f0355a';
  c.beginPath(); c.arc(W - PAD - pw + 20, 86, 5, 0, Math.PI * 2); c.fill();
  font('600 16px Geist, sans-serif', R.final ? '#8ef0c6' : '#ffb3c1'); c.fillText(pill, W - PAD - pw + 32, 92);

  spaced(1); font('700 96px Oswald, "Arial Narrow", sans-serif', '#f5f6f8');
  c.fillText(R.kind === 'week' ? `WEEK ${R.W} STANDINGS` : 'LEADERBOARD', PAD, 236);
  spaced(0); font('500 28px Geist, sans-serif', '#d3d7df');
  c.fillText(`Week ${R.W} · after ${R.label}`, PAD, 284);

  // Columns: rank, move, name, then three numbers on the right.
  const X = { rank: PAD + 6, move: PAD + 64, name: PAD + 140, a: 744, b: 870, c: W - PAD - 8 };
  const cols = R.kind === 'week' ? ['BARS', 'TONIGHT', 'WEEK'] : ['TONIGHT', 'WEEK', 'SEASON'];
  spaced(2); font('600 15px Geist, sans-serif', '#646b79');
  c.fillText('#', X.rank, TOP - 22); c.fillText('PLAYER', X.name, TOP - 22);
  right(cols[0], X.a, TOP - 22); right(cols[1], X.b, TOP - 22); right(cols[2], X.c, TOP - 22);
  spaced(0);
  c.fillStyle = 'rgba(255,255,255,.13)'; c.fillRect(PAD, TOP - 8, W - PAD * 2, 1);

  const MEDAL = ['#f5c451', '#d7dbe3', '#e39a62'];
  const signed = n => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))}`;
  R.rows.forEach((r, i) => {
    const y = TOP + i * ROW, mid = y + ROW / 2 + 9;
    if (i % 2 === 0) { c.fillStyle = 'rgba(255,255,255,.028)'; c.beginPath(); c.roundRect(PAD - 8, y + 3, W - PAD * 2 + 16, ROW - 6, 12); c.fill(); }
    font('700 32px Oswald, sans-serif', MEDAL[r.rank - 1] || '#9198a6'); c.fillText(String(r.rank), X.rank, mid + 2);
    if (r.move == null || r.move === 0) { font('600 20px Geist, sans-serif', '#646b79'); c.fillText('–', X.move + 6, mid); }
    else { font('600 20px Geist, sans-serif', r.move > 0 ? '#34d399' : '#f0355a'); c.fillText(`${r.move > 0 ? '▲' : '▼'}${Math.abs(r.move)}`, X.move, mid); }
    font('600 28px Geist, sans-serif', r.out ? '#646b79' : '#f5f6f8');
    const name = fit(r.name, X.a - X.name - 200);
    c.fillText(name, X.name, mid);
    // Lives as small dots after the name (season board), or OUT.
    let lx = X.name + c.measureText(name).width + 18;
    if (R.kind === 'season') {
      if (r.out) { font('600 15px Geist, sans-serif', '#f0355a'); spaced(2); c.fillText('OUT', lx, mid - 3); spaced(0); }
      else for (let k = 0; k < LEAGUE.lives; k++) { c.fillStyle = k < r.lives ? '#f0355a' : 'rgba(255,255,255,.14)'; c.beginPath(); c.arc(lx + k * 16, mid - 9, 5, 0, Math.PI * 2); c.fill(); }
    }
    const tonight = r.tonight ? signed(r.tonight) : '0';
    const tColor = r.tonight > 0 ? '#34d399' : r.tonight < 0 ? '#f0355a' : '#646b79';
    if (R.kind === 'week') {
      font('500 24px "Geist Mono", monospace', '#9198a6'); right(`${r.cleared ?? 0}/${SLOTS.length}`, X.a, mid);
      font('500 24px "Geist Mono", monospace', tColor); right(tonight, X.b, mid);
      font('700 30px Geist, sans-serif', '#f5f6f8'); right(fmt(r.week), X.c, mid);
    } else {
      font('500 24px "Geist Mono", monospace', tColor); right(tonight, X.a, mid);
      font('500 26px Geist, sans-serif', '#d3d7df'); right(fmt(r.week), X.b, mid);
      font('700 30px Geist, sans-serif', '#f5f6f8'); right(fmt(r.season), X.c, mid);
    }
  });

  const fy = TOP + R.rows.length * ROW + 44;
  c.fillStyle = 'rgba(255,255,255,.1)'; c.fillRect(PAD, fy - 6, W - PAD * 2, 1);
  font('500 19px Geist, sans-serif', '#646b79');
  c.fillText(R.kind === 'week' ? 'Tonight = week points gained tonight · Bars = survival bars cleared' : 'Tonight = points gained tonight · dots = lives left', PAD, fy + 34);
  right('Box scores from NBA.com', W - PAD, fy + 34);
}

const ADMIN_TABS = [['members', 'Members', '👥'], ['recap', 'Nightly recap', '📸'], ['rules', 'Rules & settings', '⚙️'], ['decrees', 'Decrees', '📜'], ['insights', 'Insights', '📈']];

// ---- League settings (Commissioner tab) ----

const num = (name, label, value, path, hint = '') => {
  const [lo, hi] = LIMITS[path];
  return `<label class="field">${label}<input class="input" type="number" name="${name}" value="${value}" min="${lo}" max="${hi}" step="1" required>${hint ? `<small class="dim">${hint}</small>` : ''}</label>`;
};
const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);

function adminAnnounce() {
  const a = S.db.settings?.meta?.announcement;
  return `<section class="panel"><div class="panel-title"><h2>📣 Announcement</h2><span class="muted">A banner at the top of every page for everyone</span></div>
    ${a?.text ? `<div class="announce" style="margin:0 0 12px"><span class="ic">📣</span><div class="txt"><small>Live since ${dshort(a.at.slice(0, 10))}</small>${esc(a.text)}</div><button class="btn small ghost" data-act="announce-clear">Take down</button></div>` : ''}
    <form data-form="announce" style="display:grid;gap:10px">
      <textarea class="input" name="text" maxlength="280" rows="2" placeholder="e.g. Picks lock tonight at 7pm. Don't let Autopilot pick for you." required></textarea>
      <div><button class="btn" type="submit">${a?.text ? 'Replace announcement' : 'Post announcement'}</button></div>
    </form></section>`;
}

function reminderText(open) {
  if (!open) return 'No open week right now.';
  const need = stillToPick();
  const dec = S.decrees?.[open.week];
  const lines = [
    `Peakhill NBA Survivor — Week ${open.week}`,
    `Picks lock ${lockText(open.lockAt)}. Don't leave it to Autopilot.`,
  ];
  if (dec?.vote && !dec.closed) lines.push(`Vote open on this week's decree (${dec.options.map(c => parseDecree(c).title).join(' / ')}).`);
  else if (dec?.decree) lines.push(`Decree this week: ${dec.decree.icon} ${dec.decree.title} — ${dec.decree.text}`);
  lines.push('');
  if (need.length) {
    lines.push(`${need.length} still to pick:`);
    for (const m of need) lines.push(`- ${m.display_name}${m.email ? ` <${m.email}>` : ''}`);
  } else {
    lines.push('Everyone has all four slots filled. Nice.');
  }
  lines.push('', 'Pick here: ' + location.origin + location.pathname + '#week');
  return lines.join('\n');
}

function adminReminder(open) {
  const text = reminderText(open);
  const need = stillToPick();
  const emails = need.map(m => m.email).filter(Boolean);
  const mailto = emails.length
    ? `mailto:?bcc=${encodeURIComponent(emails.join(','))}&subject=${encodeURIComponent(`Peakhill Survivor — Week ${open?.week} locks soon`)}&body=${encodeURIComponent(text)}`
    : '';
  return `<section class="panel"><div class="panel-title"><h2>📨 Lock-night reminder</h2><span class="muted">Copy or mail a nudge. Counts and names only — never which players.</span></div>
    <textarea class="input" id="reminder-text" rows="8" readonly style="font-family:var(--body);font-size:13px;line-height:1.45">${esc(text)}</textarea>
    <div class="row-actions" style="margin-top:12px">
      <button class="btn" data-act="copy-reminder" ${open ? '' : 'disabled'}>Copy text</button>
      ${mailto ? `<a class="btn ghost" href="${mailto}">Open email draft</a>` : `<button class="btn ghost" disabled>Open email draft</button>`}
      <button class="btn ghost" data-act="copy-emails" ${need.length ? '' : 'disabled'}>Copy emails still to pick</button>
    </div>
  </section>`;
}

// Weeks a rule change can still start from: the open week and later.
function changeableWeeks() { return S.league.weeks.filter(w => w.status === 'open'); }

function adminRules() {
  const weeks = changeableWeeks();
  if (!weeks.length) return '';
  const R = S.rulesWeek && weeks.some(w => w.week === S.rulesWeek) ? S.rulesWeek : weeks[0].week;
  const cur = weekRules(S.db.settings?.rules || [], R);
  const changes = [...(S.db.settings?.rules || [])].sort((a, b) => a.from_week - b.from_week);
  return `<section class="panel"><div class="panel-title"><h2>⚙️ Survival and card rules</h2><span class="muted">Changes start from the week you pick. Weeks already locked keep their rules.</span></div>
    ${changes.length ? `<div class="list-stack">${changes.map(ch => {
      const live = weeks.some(w => w.week === ch.from_week);
      return `<div class="own-row"><span class="tag">From Wk ${ch.from_week}</span><div style="flex:1">${esc(describeChange(ch).join(' · ') || 'No change')}</div>${live ? `<button class="link danger" data-act="rule-undo" data-week="${ch.from_week}">Undo</button>` : '<span class="dim">In force</span>'}</div>`;
    }).join('')}</div>` : ''}
    <form data-form="rules" class="settings-form">
      <label class="field wide">Takes effect from<select class="input" name="from_week" data-change="rules-week">${weeks.map(w => `<option value="${w.week}" ${w.week === R ? 'selected' : ''}>Week ${w.week}${w === weeks[0] ? ' (this week)' : ''} · locks ${esc(lockText(w.lockAt))}</option>`).join('')}</select></label>
      <h4 class="wide">❤️ Weekly survival bars</h4>
      ${SLOTS.map(s => num(`bars.${s}`, `${INFO[s].emoji} ${INFO[s].name} (${INFO[s].short})`, cur.bars[s], `bars.${s}`)).join('')}
      ${num('barsToSurvive', `Bars to clear (of ${SLOTS.length})`, cur.barsToSurvive, 'barsToSurvive')}
      <h4 class="wide">🎴 Joker cards</h4>
      ${num('cards.handLimit', 'Hand limit', cur.cards.handLimit, 'cards.handLimit')}
      ${num('cards.attackCap', 'Max attacks on one person a week', cur.cards.attackCap, 'cards.attackCap')}
      ${num('cards.duelStake', 'Duel stake (points)', cur.cards.duelStake, 'cards.duelStake')}
      ${num('cards.heist', 'Heist (points)', cur.cards.heist, 'cards.heist')}
      <div class="wide form-foot"><button class="btn primary" type="submit">Save rules from Week ${R}</button><span class="dim">Everyone sees rule changes on the Rules tab. Post an announcement too.</span></div>
    </form></section>`;
}

function adminSeason() {
  const r = seasonRules(S.db.settings?.meta || {});
  return `<section class="panel"><div class="panel-title"><h2>🏟️ Season settings</h2><span class="muted">These apply to the whole season, past weeks included</span></div>
    <form data-form="season" class="settings-form">
      ${num('lives', 'Lives', r.lives, 'lives', 'Raising it gives everyone more lives, even people who are out.')}
      ${num('drops.max', 'Worst weeks dropped (max)', r.drops.max, 'drops.max')}
      ${num('drops.every', 'One drop per … final weeks', r.drops.every, 'drops.every')}
      ${num('decree.perSeason', 'Decrees a season', r.decree.perSeason, 'decree.perSeason')}
      ${num('decree.bounty', 'Bounty decree (points)', r.decree.bounty, 'decree.bounty')}
      <label class="field">Commissioner name (on certificates)<input class="input" name="commissioner" maxlength="40" value="${esc(r.commissioner)}"></label>
      <div class="wide form-foot"><button class="btn primary" type="submit">Save season settings</button></div>
    </form></section>`;
}

function adminAdjust() {
  const weeks = lockedWeeks();
  const list = S.db.settings?.adjustments || [];
  const members = Object.values(S.league.users).sort(byName);
  return `<section class="panel"><div class="panel-title"><h2>⚖️ Adjustments</h2><span class="muted">Fix a mistake: add or take away points or lives. Shown publicly on Results with your reason.</span></div>
    ${list.length ? `<div class="list-stack">${list.map(a => `<div class="own-row"><span class="tag">Wk ${a.week}</span><div style="flex:1"><b>${esc(userName(a.user_id))}</b> ${adjText(a)} <span class="dim">${esc(a.reason || '')}</span></div><button class="link danger" data-act="adjust-remove" data-id="${esc(a.id)}">Remove</button></div>`).join('')}</div>` : ''}
    ${weeks.length ? `<form data-form="adjust" class="settings-form">
      <label class="field">Member<select class="input" name="user_id" required><option value="">Choose…</option>${members.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
      <label class="field">Week<select class="input" name="week">${[...weeks].reverse().map(w => `<option value="${w.week}">Week ${w.week}</option>`).join('')}</select></label>
      <label class="field">Points (+/−)<input class="input" type="number" name="points" value="0" min="-50" max="50" step="0.5"></label>
      <label class="field">Lives (+/−)<input class="input" type="number" name="lives" value="0" min="-5" max="5" step="1"></label>
      <label class="field wide">Reason (everyone sees this)<input class="input" name="reason" maxlength="120" required placeholder="e.g. Stat correction: NBA changed a rebound total"></label>
      <div class="wide form-foot"><button class="btn primary" type="submit">Add adjustment</button></div>
    </form>` : '<p class="muted" style="margin:0">Adjustments open once Week 1 locks.</p>'}
  </section>`;
}

async function saveSetting(key, value, msg) {
  await S.backend.adminSaveSetting(key, value);
  toast(msg);
}

function adminDecree() {
  const L = S.league, C = LEAGUE.decree;
  const all = Object.values(S.decrees || {}).sort((a, b) => a.week - b.week);
  const left = C.perSeason - all.length;
  const eligible = L.weeks.filter(w => w.status === 'open' && Date.parse(w.lockAt) - now() > C.noticeHours * 3600e3 && !S.decrees?.[w.week]);
  const D = S.decreeDraft ||= { week: null, mode: 'impose', picks: [], slots: {} };
  if (!eligible.some(w => w.week === D.week)) D.week = eligible[0]?.week ?? null;
  const max = D.mode === 'vote' ? 3 : 1;
  const ready = D.mode === 'vote' ? D.picks.length >= 2 : D.picks.length === 1;
  const list = all.map(d => {
    const open = Date.parse(weekObj(d.week).lockAt) - now() > C.noticeHours * 3600e3;
    const what = d.vote
      ? d.options.map((code, i) => `${parseDecree(code).icon} ${esc(parseDecree(code).title)} <b>${d.votes[i]}</b>`).join(' · ') + (d.closed ? ` → <b>${esc(d.decree?.title || '')}</b>` : ' <span class="dim">(voting)</span>')
      : `${d.decree.icon} <b>${esc(d.decree.title)}</b>`;
    return `<div class="own-row"><span class="tag">Wk ${d.week}</span><div style="flex:1">${what}</div>${open ? `<button class="link danger" data-act="decree-cancel" data-week="${d.week}">Cancel</button>` : '<span class="dim">Locked in</span>'}</div>`;
  }).join('');
  const openVote = all.find(d => d.vote && !d.closed);
  const turnout = openVote && S.adminData && !S.adminData.error ? (() => {
    const voters = S.adminData.voters || new Set();
    const members = S.adminData.members || [];
    const missing = members.filter(m => !voters.has(m.user_id));
    return `<div class="section-gap"><h3 class="kicker" style="margin:0 0 8px">Week ${openVote.week} vote turnout</h3>
      <div class="scoreline" style="margin-bottom:10px">
        <div class="stat"><b>${voters.size}</b><small>Voted</small></div>
        <div class="stat"><b style="color:var(--orange)">${missing.length}</b><small>Not yet</small></div>
        <div class="stat"><b>${members.length ? Math.round((voters.size / members.length) * 100) : 0}%</b><small>Turnout</small></div>
      </div>
      <p class="note" style="margin:0 0 8px">Shows who has voted, never which option. Choices stay private.</p>
      ${missing.length ? `<div class="row-actions"><button class="btn small" data-act="copy-nonvoters">Copy non-voter emails</button></div>
        <p class="dim" style="font-size:12.5px;margin:8px 0 0">${missing.map(m => esc(m.display_name)).join(' · ')}</p>` : '<p class="muted" style="margin:0">Everyone has voted.</p>'}
    </div>`;
  })() : '';
  return `<section class="panel decree-admin"><div class="panel-title"><h2>📜 Commissioner's Decree</h2><span class="muted">${left} of ${C.perSeason} left this season · everyone sees it once it's posted</span></div>
    ${list ? `<div class="list-stack">${list}</div>` : ''}
    ${turnout}
    ${left <= 0 ? '<p class="muted" style="margin:0">That\'s every decree for the season.</p>'
      : !eligible.length ? `<p class="muted" style="margin:0">No week is far enough out. Decrees go up at least ${C.noticeHours} hours before a lock.</p>`
      : `<div class="decree-form">
        <label class="field">Week<select class="input" data-change="decree-week">${eligible.slice(0, 8).map(w => `<option value="${w.week}" ${w.week === D.week ? 'selected' : ''}>Week ${w.week} · locks ${esc(lockText(w.lockAt))}</option>`).join('')}</select></label>
        <div class="seg" style="margin:0"><button data-act="decree-mode" data-mode="impose" aria-pressed="${D.mode === 'impose'}">⚖️ Impose one</button><button data-act="decree-mode" data-mode="vote" aria-pressed="${D.mode === 'vote'}">🗳️ Let them vote</button></div>
      </div>
      <p class="note">${D.mode === 'vote' ? 'Pick 2 or 3 options. Members vote until ' + C.noticeHours + ' hours before the lock; most votes wins.' : 'Pick one. It goes live for everyone straight away.'}</p>
      <div class="decree-cat">${Object.entries(DECREES).map(([k, d]) => {
        const on = D.picks.includes(k);
        const slot = D.slots[k] || 'PTS';
        const x = parseDecree(d.slot ? `${k}:${slot}` : k);
        return `<div class="decree-pick ${on ? 'on' : ''}"><button class="dp-main" data-act="decree-toggle" data-kind="${k}" aria-pressed="${on}"><span class="di">${d.icon}</span><b>${esc(d.name)}</b><small>${esc(x.text)}</small></button>
          ${d.slot ? `<select class="input" data-change="decree-slot" data-kind="${k}">${SLOTS.map(s => `<option value="${s}" ${s === slot ? 'selected' : ''}>${INFO[s].emoji} ${INFO[s].name}</option>`).join('')}</select>` : ''}</div>`;
      }).join('')}</div>
      <div class="form-foot" style="margin-top:16px"><button class="btn primary" data-act="decree-issue" ${ready ? '' : 'disabled'}>${D.mode === 'vote' ? `Put ${D.picks.length || ''} to a vote` : 'Issue the decree'}</button><span class="dim">${D.picks.length}/${max} chosen</span></div>`}
  </section>`;
}

async function decreeIssue() {
  const D = S.decreeDraft;
  const options = D.picks.map(k => DECREES[k].slot ? `${k}:${D.slots[k] || 'PTS'}` : k);
  if (!D.week || !options.length) return;
  try { await S.backend.adminSaveDecree(D.week, options); } catch (e) { return toast(e.message, true); }
  toast(options.length > 1 ? `Week ${D.week} is up for a vote.` : `Decreed: ${parseDecree(options[0]).title} in Week ${D.week}.`);
  S.decreeDraft = null;
  await refresh();
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

function rosterFilterMatch(m, r, filter) {
  const n = r?.slots || 0;
  const backups = r?.backups || 0;
  if (filter === 'none') return n === 0;
  if (filter === 'partial') return n > 0 && n < SLOTS.length;
  if (filter === 'full') return n === SLOTS.length;
  if (filter === 'nobackup') return n > 0 && backups === 0;
  return true;
}

function adminRoster(open) {
  const d = S.adminData;
  if (!d) return `<section class="panel"><div class="panel-title"><h2>Members</h2></div><p class="muted">Loading members…</p></section>`;
  if (d.error) return `<section class="panel"><div class="panel-title"><h2>Members</h2></div><p class="err">${esc(d.error)}</p><p class="note">If this says the function doesn't exist, run supabase/admin.sql (and upgrade-commissioner-ops.sql for the richer check-in) in the Supabase SQL editor.</p></section>`;
  const filter = S.checkinFilter || 'all';
  const full = d.members.filter(m => (d.status[m.user_id]?.slots || 0) === SLOTS.length).length;
  const none = d.members.filter(m => !(d.status[m.user_id]?.slots)).length;
  const noBackup = d.members.filter(m => {
    const r = d.status[m.user_id];
    return (r?.slots || 0) > 0 && !(r?.backups);
  }).length;
  const packKept = d.members.filter(m => d.status[m.user_id]?.pack_kept).length;
  const played = d.members.filter(m => d.status[m.user_id]?.played).length;
  const filtered = d.members.filter(m => rosterFilterMatch(m, d.status[m.user_id], filter));
  const filters = [
    ['all', 'All', d.members.length],
    ['none', 'Not started', none],
    ['partial', 'Partial', d.members.length - full - none],
    ['full', 'Full', full],
    ['nobackup', 'No backups', noBackup],
  ];
  const rows = filtered.map(m => {
    const r = d.status[m.user_id];
    const n = r?.slots || 0;
    const tag = n === SLOTS.length ? `<span class="tag green">${n}/${SLOTS.length} ✓</span>` : n ? `<span class="tag gold">${n}/${SLOTS.length}</span>` : '<span class="tag">Not started</span>';
    const flags = open ? `<span class="checkin-flags">${r?.pack_kept ? '<span class="tag" title="Opened a pack this week">Pack</span>' : ''}${r?.played ? '<span class="tag green" title="Main card play in">Card</span>' : ''}${n && !r?.backups ? '<span class="tag gold" title="No backups set">0 bak</span>' : ''}</span>` : '';
    return `<tr class="${m.user_id === myId() ? 'me' : ''}"><td><div class="who">${avatar(m.user_id)}<b>${esc(m.display_name)}</b></div></td>
      <td class="hide-sm"><span class="muted" style="font-size:13px">${esc(m.email || '')}</span></td>
      ${open ? `<td>${tag}${r?.backups ? ` <span class="dim" style="font-size:12px">+${r.backups} bak</span>` : ''} ${flags}</td><td class="hide-sm dim" style="font-size:13px">${r?.last_saved ? ago(r.last_saved) : '—'}</td>` : ''}
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
      <div class="stat"><b>${packKept}</b><small>Pack kept</small></div>
      <div class="stat"><b>${played}</b><small>Card played</small></div>
      <div class="stat"><b class="num" style="font-size:18px">${esc(lockText(open.lockAt))}</b><small>Lock</small></div>` : ''}
    </div>
    ${open ? `<div class="pills checkin-filters" style="margin:0 0 12px">${filters.map(([id, label, n]) =>
      `<button class="pill" data-act="checkin-filter" data-filter="${id}" aria-pressed="${filter === id}">${label} (${n})</button>`).join('')}</div>
      ${noBackup ? `<p class="note" style="margin:-4px 0 12px">${noBackup} people have picks in but zero backups — risky if someone sits.</p>` : ''}` : ''}
    <div class="table-wrap"><table class="board"><thead><tr><th>Member</th><th class="hide-sm">Email</th>${open ? `<th>Wk ${open.week}</th><th class="hide-sm">Last saved</th>` : ''}<th class="hide-sm">Last seen</th><th class="hide-sm">Joined</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="dim">Nobody in this filter.</td></tr>'}</tbody></table></div>
    <p class="note" style="margin:10px 0 0">Shows how many slots each person has filled (and pack / card flags), never which players or cards, until the lock.</p>
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

// ---- Office week board (commissioner tooling; opened from the brand mark) ----

function defaultOpsWeek() {
  return S.league.openWeek ?? lockedWeeks().at(-1)?.week ?? S.league.weeks[0]?.week ?? 1;
}

function loadOps(week) {
  if (!S.isAdmin || S.opsLoading) return;
  S.opsLoading = true;
  S.opsWeek = week;
  Promise.all([
    S.backend.adminWeekRows(week),
    S.backend.adminWeekPlays(week).catch(() => []),
    S.backend.adminPackSeeds().catch(() => null),
    S.backend.adminMembers().catch(() => S.adminData?.members || []),
    S.backend.adminCheckin(week).catch(() => []),
  ])
    .then(([rows, plays, seeds, members, checkin]) => {
      S.opsData = { week, rows, plays, seeds, members, checkin: Object.fromEntries(checkin.map(r => [r.user_id, r])) };
      // Isolated recompute so player-facing S.league / S.db stay RLS-filtered.
      const pickKey = p => `${p.user_id}|${p.week}|${p.slot}`;
      const playKey = p => p.id || `${p.user_id}|${p.week}|${p.card}|${p.card_uid || ''}|${p.created_at || ''}`;
      const picks = [...S.db.picks.filter(p => p.week !== week), ...rows.map(r => ({ ...r, week }))];
      const seen = new Set();
      const mergedPicks = [];
      for (const p of picks) { const k = pickKey(p); if (seen.has(k)) continue; seen.add(k); mergedPicks.push(p); }
      const playSeen = new Set();
      const mergedPlays = [];
      for (const p of [...(S.db.plays || []), ...plays]) {
        const k = playKey(p);
        if (playSeen.has(k)) continue;
        playSeen.add(k);
        mergedPlays.push(p);
      }
      const weeks = S.data.weeks.map(w => ({ ...w, lockAt: S.db.locks[w.week] || w.lockAt }));
      const seedMap = seeds || S.db.seeds;
      S.opsLeague = computeLeague({
        weeks, totals: S.data.totals, picks: mergedPicks, unburns: S.db.unburns, plays: mergedPlays,
        profiles: S.db.profiles, now: now(), players: S.data.players,
        cardsFrom: seedMap ? (DEMO ? (S.data.cardsFrom ?? LEAGUE.cards.startWeek) : LEAGUE.cards.startWeek) : Infinity,
        dealer: seedMap ? seededDealer(seedMap) : undefined,
        decrees: decreeCodes(S.decrees),
        rules: S.db.settings?.rules || [], meta: S.db.settings?.meta || {}, adjustments: S.db.settings?.adjustments || [],
      });
    })
    .catch(e => { S.opsData = { week, error: e.message || String(e) }; S.opsLeague = null; })
    .finally(() => { S.opsLoading = false; if (S.opsOpen) renderOfficeModal(); });
}

function openOfficeModal() {
  if (!S.isAdmin) return;
  S.opsOpen = true;
  const week = S.opsWeek || defaultOpsWeek();
  if (!S.opsData || S.opsData.week !== week) loadOps(week);
  renderOfficeModal();
}

function renderOfficeModal() {
  if (!S.opsOpen) return;
  const week = S.opsWeek || defaultOpsWeek();
  const body = !S.opsData || S.opsLoading ? '<p class="muted">Loading week board…</p>'
    : S.opsData.error ? `<p class="err">${esc(S.opsData.error)}</p><p class="note">Run supabase/upgrade-commissioner-ops.sql if the functions are missing.</p>`
    : officeBoard(week);
  const weeks = S.league.weeks;
  $('#modal-root').innerHTML = `<div class="modal-bg" data-act="close-modal-bg"><div class="modal office-modal" role="dialog" aria-modal="true" aria-label="Office week board">
    <div class="modal-head"><div class="ttl"><h3>Week board</h3>
      <div class="row-actions">
        <select class="input" style="width:auto" data-change="ops-week" aria-label="Week">${weeks.map(w =>
          `<option value="${w.week}" ${w.week === week ? 'selected' : ''}>Wk ${w.week} · ${w.status}</option>`).join('')}</select>
        <button class="btn small ghost" data-act="ops-refresh">Refresh</button>
        <button class="close-x" data-act="close-modal" aria-label="Close">×</button>
      </div></div></div>
    <div class="modal-body pad office-board">${body}</div>
  </div></div>`;
}

function officeBoard(week) {
  const d = S.opsData;
  const L = S.opsLeague || S.league;
  const wk = L.weeks.find(w => w.week === week) || weekObj(week);
  const members = d.members?.length ? d.members : Object.values(L.users).map(u => ({ user_id: u.id, display_name: u.name }));
  const byUser = {};
  for (const r of d.rows || []) {
    (byUser[r.user_id] ||= {})[r.slot] = r;
  }
  const checkin = d.checkin || {};
  const full = members.filter(m => Object.keys(byUser[m.user_id] || {}).length === SLOTS.length).length;
  const none = members.filter(m => !Object.keys(byUser[m.user_id] || {}).length).length;

  // Ownership / conflict radar
  const owners = Object.fromEntries(SLOTS.map(s => [s, {}]));
  for (const [uid, slots] of Object.entries(byUser)) {
    for (const s of SLOTS) {
      const pid = slots[s]?.player_id;
      if (pid == null) continue;
      (owners[s][pid] ||= []).push(uid);
    }
  }
  const chalk = SLOTS.map(s => {
    const top = Object.entries(owners[s]).sort((a, b) => b[1].length - a[1].length).slice(0, 4);
    return `<div><h3 class="kicker" style="margin:0 0 8px">${INFO[s].emoji} ${INFO[s].name}</h3>${top.map(([pid, who]) =>
      `<div class="own-row">${thumb(+pid, 'sm')}<div><div style="font-weight:600">${esc(shortName(+pid))}</div><div class="dim" style="font-size:12px">${who.map(id => esc(userName(id))).join(', ')}</div></div><b class="num">${who.length}</b></div>`).join('') || '<p class="dim">Nobody yet.</p>'}</div>`;
  }).join('');

  const pickCell = (uid, s) => {
    const r = byUser[uid]?.[s];
    if (!r) return '<span class="dim">—</span>';
    return `<div class="cell-pick">${thumb(r.player_id, 'sm')}<div><div class="n">${esc(shortName(r.player_id))}${r.double_down ? ' 🔥' : ''}${r.auto ? ' · auto' : ''}</div>
      ${r.alt_id != null ? `<div class="dim" style="font-size:11px">B: ${esc(shortName(r.alt_id))}</div>` : ''}</div></div>`;
  };

  const pickRows = members.map(m => {
    const u = L.users[m.user_id];
    const n = Object.keys(byUser[m.user_id] || {}).length;
    const c = checkin[m.user_id];
    return `<tr class="${m.user_id === myId() ? 'me' : ''}"><td><div class="who">${avatar(m.user_id)}<div><b>${esc(m.display_name || userName(m.user_id))}</b>
      <div class="dim" style="font-size:11px">${n}/${SLOTS.length}${c?.pack_kept ? ' · pack' : ''}${c?.played ? ' · card' : ''} · ${u ? hearts(u.lives) : ''}</div></div></div></td>
      ${SLOTS.map(s => `<td>${pickCell(m.user_id, s)}</td>`).join('')}</tr>`;
  }).join('');

  const handRows = members.map(m => {
    const u = L.users[m.user_id];
    const hand = u?.cards?.hand || [];
    const armed = u?.cards?.armed || [];
    const packs = (u?.cards?.packs || []).filter(p => p.step === week && p.keep == null && !p.auto);
    const handTxt = hand.map(h => `${CARDS[h.card]?.icon || ''} ${CARDS[h.card]?.name || h.card}`).join(' · ') || '—';
    const armedTxt = armed.map(h => `${CARDS[h.card]?.icon || ''} ${CARDS[h.card]?.name || h.card}`).join(' · ') || '—';
    const packTxt = packs.length ? `${packs.length} waiting` : '—';
    return `<tr><td><b>${esc(m.display_name || userName(m.user_id))}</b></td><td style="font-size:13px">${esc(handTxt)}</td><td style="font-size:13px">${esc(armedTxt)}</td><td class="dim">${esc(packTxt)}</td></tr>`;
  }).join('');

  const weekPlays = (d.plays || []).filter(p => !['_keep'].includes(p.card));
  const playRows = weekPlays.length ? weekPlays.map(p => {
    const c = CARDS[p.card];
    return `<div class="ct-row"><span>${c?.icon || '🎴'}</span><div><b>${esc(c?.name || p.card)}</b> · ${esc(userName(p.user_id))}
      ${p.target_id ? ` → ${esc(userName(p.target_id))}` : ''}${p.slot ? ` · ${INFO[p.slot]?.emoji || p.slot}` : ''}
      ${p.player_id != null ? ` · ${esc(shortName(p.player_id))}` : ''}</div></div>`;
  }).join('') : '<p class="dim">No plays this week.</p>';

  const dec = S.decrees?.[week];
  const adjs = (S.db.settings?.adjustments || []).filter(a => a.week === week);
  const standing = (L.standings || []).slice(0, 8).map((u, i) =>
    `<div class="own-row"><span class="rank ${i < 3 ? 'top' : ''}">${i + 1}</span>${avatar(u.id)}<b>${esc(u.name)}</b><span class="num">${fmt(u.counted)} · ${hearts(u.lives)}</span></div>`).join('');

  return `
    <div class="scoreline" style="margin-bottom:14px">
      <div class="stat"><b>${members.length}</b><small>Members</small></div>
      <div class="stat"><b style="color:var(--green)">${full}</b><small>Full picks</small></div>
      <div class="stat"><b style="color:var(--orange)">${members.length - full - none}</b><small>Partial</small></div>
      <div class="stat"><b style="color:var(--red-hot)">${none}</b><small>Empty</small></div>
      ${wk ? `<div class="stat"><b class="num" style="font-size:16px">${esc(lockText(wk.lockAt))}</b><small>Lock · ${wk.status}</small></div>` : ''}
    </div>
    ${dec ? `<div class="decree slim" style="margin-bottom:12px"><span>📜 ${dec.vote && !dec.closed ? 'Vote open' : 'Decree'}: <b>${esc(dec.decree?.title || dec.options?.map(c => parseDecree(c).title).join(' / ') || '')}</b></span></div>` : ''}
    <h3 class="kicker" style="margin:0 0 8px">Picks</h3>
    <div class="table-wrap"><table class="board"><thead><tr><th>Member</th>${SLOTS.map(s => `<th>${INFO[s].emoji}</th>`).join('')}</tr></thead><tbody>${pickRows}</tbody></table></div>
    <h3 class="kicker" style="margin:16px 0 8px">Ownership / conflicts</h3>
    <div class="own-cols">${chalk}</div>
    <h3 class="kicker" style="margin:16px 0 8px">Hands & traps</h3>
    <div class="table-wrap"><table class="board"><thead><tr><th>Member</th><th>Hand</th><th>Armed</th><th>Packs</th></tr></thead><tbody>${handRows}</tbody></table></div>
    <h3 class="kicker" style="margin:16px 0 8px">Card plays</h3>
    <div class="ct-list">${playRows}</div>
    <div class="own-cols" style="margin-top:16px">
      <div><h3 class="kicker" style="margin:0 0 8px">Standings (top)</h3>${standing || '<p class="dim">—</p>'}</div>
      <div><h3 class="kicker" style="margin:0 0 8px">Adjustments</h3>${adjs.length ? adjs.map(a =>
        `<div class="own-row"><b>${esc(userName(a.user_id))}</b><span>${adjText(a)}</span><span class="dim">${esc(a.reason || '')}</span></div>`).join('') : '<p class="dim">None this week.</p>'}</div>
    </div>`;
}

function bindBrandGesture() {
  const brand = document.querySelector('.brand');
  if (!brand || brand.dataset.opsBound) return;
  brand.dataset.opsBound = '1';
  let clicks = 0, last = 0;
  brand.addEventListener('click', e => {
    if (!S.isAdmin) return;
    const t = Date.now();
    if (t - last > 500) clicks = 0;
    last = t;
    clicks++;
    if (clicks >= 3) {
      e.preventDefault();
      clicks = 0;
      openOfficeModal();
    }
  });
}

// ---------- Rules ----------

function ruleChangesPanel() {
  const list = [...(S.db.settings?.rules || [])].sort((a, b) => a.from_week - b.from_week).filter(ch => describeChange(ch).length);
  if (!list.length) return '';
  return `<section class="panel"><div class="panel-title"><h2>⚙️ Rule changes this season</h2><span class="muted">Set by the commissioner. Earlier weeks keep the rules they were played under.</span></div>
    <div style="display:grid;gap:8px">${list.map(ch => `<div class="own-row"><span class="tag">From Wk ${ch.from_week}</span><div>${esc(describeChange(ch).join(' · '))}</div></div>`).join('')}</div></section>`;
}

function viewRules() {
  const b = LEAGUE.bars;
  return `<div class="grid">${ruleChangesPanel()}
    <section class="hero"><span class="badge">How it works</span><h1>Pick 4. Burn 'em. Outlast the office.</h1><div class="sub">Five minutes a week. No draft, no roster, no money.</div>
      <div style="margin-top:14px"><button class="btn" data-act="tour-replay">Replay the quick tour</button></div></section>
    <div class="rules">
      <div class="panel rule"><h3>🗓️ The week</h3><p>Weeks run Monday to Sunday. Picks lock at the first tip-off of the week, shown in your local time. Week 1 (Oct 20 – Nov 1) and Week 17 (All-Star, Feb 15–28) are double weeks.</p></div>
      <div class="panel rule"><h3>🏀 The picks</h3><ul><li><b>Bucket</b>: a player's points</li><li><b>Glass</b>: a player's rebounds</li><li><b>Dime</b>: a player's assists</li><li><b>Dub</b>: a team's wins</li></ul><p>Each pick scores its <b>total</b> for the week, so a four-game week beats a two-game week.</p></div>
      <div class="panel rule"><h3>🔥 The burn</h3><p>Once you use a player in a category, he's gone from that category for the season, but still available in the other two. One player can only fill one of your slots in a given week.</p><p>Teams burn too: each team can be your Dub pick once a season. There are 30 teams for 23 weeks, so choose when to spend the contenders.</p></div>
      <div class="panel rule"><h3>🛟 Backups</h3><p>Add an optional backup to each player slot. It only comes in if your pick plays <b>zero</b> games that week; then the backup scores and burns instead, and your pick stays available. If your pick plays even once, his total counts and the backup stays unused. If neither plays, the slot scores 0 and nothing burns. Teams always play, so Dub has no backup.</p></div>
      <div class="panel rule"><h3>📊 Scoring</h3><p>Every category is ranked across the league each week. You get 1 point for every colleague whose pick you beat, ½ for a tie. During a live week, a pick that has played is ranked against everyone (picks still waiting count as 0); a pick that hasn't played yet scores 0 until it does. The final count ranks everyone. Your weekly score is the sum of your four categories.</p><p>Drop your worst weeks: one drop unlocks after weeks 6, 12 and 18.</p></div>
      <div class="panel rule"><h3>❤️ Survivor</h3><p>Everyone starts with ${LEAGUE.lives} lives. Clear at least ${LEAGUE.barsToSurvive} of the ${SLOTS.length} weekly bars (${b.PTS} PTS / ${b.REB} REB / ${b.AST} AST / ${b.WIN} ${b.WIN === 1 ? 'win' : 'wins'}, the same every week unless the commissioner changes them) or lose a life. Last one standing wins the Survivor Belt. You keep playing for points either way.</p></div>
      <div class="panel rule"><h3>🃏 Jokers</h3><ul><li><b>Double Down</b>: double the rank points from one slot, once a season.</li><li><b>Un-burn</b>: get one burned player back in one category, once a season.</li></ul></div>
      <div class="panel rule"><h3>📜 Commissioner's Decree</h3><p>Up to ${LEAGUE.decree.perSeason} times a season the commissioner sets a one-week twist, such as Prime Time (a category counts double), Opposite Day, Mercy Rule, Sudden Death, Amnesty, Ceasefire or Pack Day. Sometimes the league votes on it instead. Decrees are posted, and votes close, at least ${LEAGUE.decree.noticeHours} hours before the lock, so nobody gets surprised.</p></div>
      <div class="panel rule"><h3>🎴 Joker cards</h3><p>Earn packs, keep one card from each (your choice is final), and play one card a week: jinxes, traps, duels, heists, Blue Shells and pranks. Attacks are revealed at the lock. Cards move points but never cost a life.</p><p><button class="link" data-act="primer">How cards work →</button></p></div>
      <div class="panel rule"><h3>🤖 Autopilot</h3><p>Forgot to pick? At the lock, Autopilot fills empty slots with your best unburned projected week (season average × games). It never leaves you at zero, but it spends your best players first.</p></div>
      <div class="panel rule"><h3>🥊 Rivals</h3><p>Name one coworker as your rival and track your weekly head-to-head record. You can change your rival any time.</p></div>
      <div class="panel rule"><h3>🏆 Titles and awards</h3><ul><li><b>Season Champion</b></li><li><b>Title belts:</b> Survivor Belt, plus Scoring, Rebounding, Assists and Dub Champions (most of each from your picks over the season)</li><li><b>Pure Hoops Champion:</b> top of the standings from your picks alone, with no Joker cards at all. Flip Standings to <i>Raw picks</i> to see the race.</li><li><b>Monthly Crowns:</b> Nov, Dec, Jan, Feb, Mar/Apr</li><li><b>Hall of Fame</b> and <b>Hall of Shame:</b> fun season awards</li><li><b>Playoff Burn</b> (April–June)</li></ul><p>Every award comes with a downloadable certificate. The Trophies tab shows who's leading each race and where you stand.</p></div>
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

// The tour walks through the real app: each step opens a page and spotlights the
// thing it talks about. Targets are tried in order; with none on screen the step
// shows as a centred card.
const TOUR_BARS = LEAGUE.bars;
const tab = k => `#tabs a[href="#${k}"]`;
const TOUR = [
  {
    route: 'week', icon: '👋', title: `Welcome to ${LEAGUE.name}`,
    text: () => `<p>Four picks a week, everyone in the league against everyone else. It's free, takes about five minutes, and the prize is bragging rights plus a certificate.</p><p>This quick tour shows you where everything is.</p>`,
  },
  {
    route: 'week', target: ['.lock-box'], icon: '⏰', title: 'The lock',
    text: () => `<p>Picks lock at the <b>first tip-off of the week</b>, usually Monday evening. This countdown always shows the exact time in your time zone. Until then, change your picks as often as you like.</p>`,
  },
  {
    route: 'week', target: ['.slots'], ptarget: ['.slot-card .slot-head'], icon: '🏀', title: 'Your four picks',
    text: () => `<div class="tour-slots">${SLOTS.map(s => `<div class="tour-slot" data-slot="${s}"><b>${INFO[s].emoji} ${INFO[s].name}</b><span>${s === 'WIN' ? "A team's wins" : `A player's ${INFO[s].stat.toLowerCase()}`}</span></div>`).join('')}</div>
      <p>Each pick scores its <b>total for the whole week</b>, so a player with four games beats one with two.</p>`,
  },
  {
    route: 'week', target: ['.slot-card .add-big', '.slot-card [data-act="pick"]'], icon: '👆', title: 'Choose a player',
    text: () => `<p>Tap here to open the player list. It shows <b>games this week</b> and a <b>projected total</b> for everyone, and greys out anyone you can't use.</p>`,
  },
  {
    route: 'week', target: ['.slot-card [data-which="alt"]', '.slot-card .alt-row', '.slot-card .slot-head'], icon: '🛟', title: 'Backups',
    text: () => `<p>Once you've chosen a player, tap <b>+ Add</b> next to Backup to name a second one. The backup only counts if your pick plays <b>zero games</b> that week. Then the backup burns instead and your pick stays available.</p>`,
  },
  {
    route: 'week', target: ['.bars-strip'], icon: '❤️', title: 'Stay alive',
    text: () => `<p>You have <b>${LEAGUE.lives} lives</b>. Each week, clear at least <b>${LEAGUE.barsToSurvive} of these ${SLOTS.length} bars</b> or lose one:</p>
      <div class="tour-bars">${SLOTS.map(s => `<span class="bar-pill">${INFO[s].emoji} <b>${TOUR_BARS[s]} ${s === 'WIN' ? (TOUR_BARS[s] === 1 ? 'win' : 'wins') : INFO[s].short}</b></span>`).join('')}</div>
      <p>Last one standing wins the Survivor Belt. Running out of lives doesn't stop you scoring points.</p>`,
  },
  {
    route: 'week', target: ['.savebar'], icon: '💾', title: 'Save your picks',
    text: () => `<p>Hit <b>Save picks</b> when you're done. Forget, and <b>Autopilot</b> fills empty slots at the lock with your best unused option. You won't score zero, but it spends your best players first.</p>`,
  },
  {
    route: 'week', target: ['.jokers'], icon: '🃏', title: 'Jokers',
    text: () => `<p><b>Double Down</b> doubles one slot's points, once a season. <b>Un-burn</b> gets one used player back in one category, once a season.</p>`,
  },
  {
    route: 'burns', target: [tab('burns')], icon: '🔥', title: "Burn 'em",
    text: () => `<p>Use a player in a category and he's <b>gone from that category for the season</b>, but still free in the others. Each team can be your Dub once. The <b>Burn Book</b> tracks everything you've used.</p>`,
  },
  {
    route: 'standings', target: [tab('standings')], icon: '📊', title: 'Scoring',
    text: () => `<p>In every category you get <b>1 point for each colleague your pick beats</b> (½ for a tie). Weekly scores add up here in <b>Standings</b>. <b>Survivor</b>, next door, tracks lives.</p>`,
  },
  {
    route: 'results', target: [tab('results')], icon: '👀', title: 'The reveal',
    text: () => `<p>Nobody can see anyone's picks until the lock. Then everything appears in <b>Results</b>, with live scores as games are played.</p>`,
  },
  {
    route: 'cards', target: ['.hud-row', tab('cards')], icon: '🎴', title: 'Joker cards',
    text: () => `<p>Make your own picks to earn <b>packs</b>. Keep one card from each and play <b>one a week</b>: jinxes, traps, duels, heists and more. Cards move points but <b>never cost a life</b>.</p>`,
  },
  {
    route: 'cards', target: ['#dex .dex-slot', '#dex'], icon: '📖', title: 'The Card Dex',
    text: () => `<p>All ${Object.keys(CARDS).length} cards live further down the Cards tab, in the Card Dex. <b>Tap any card</b>, like this one, to see what it does and when to play it.</p>`,
  },
  {
    route: 'rivals', target: ['[data-change="rival"]', tab('rivals')], icon: '⚔️', title: 'Pick a rival',
    text: () => `<p>Choose a coworker and track your <b>head-to-head record</b> all season.</p>`,
  },
  {
    route: 'rules', target: ['[data-act="tour-replay"]', tab('rules')], icon: '📜', title: "That's it",
    text: () => `<p>The full rules live in <b>Rules</b>, and you can replay this tour from here any time. Now go make your picks.</p>`,
  },
];

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function tourTarget(st) {
  for (const sel of (innerWidth < 640 && st.ptarget) || st.target || []) {
    const el = document.querySelector(sel);
    if (el && el.getClientRects().length) return el;
  }
  return null;
}

async function openTour(i) {
  if (i < 0 || i >= TOUR.length) return;
  S.tour = i;
  closeModal();
  const st = TOUR[i];
  if (st.route && S.view !== st.route) {
    location.hash = `#${st.route}`;
    await new Promise(r => setTimeout(r, 60)); // let the hashchange render the page
  }
  if (S.tour !== i) return;
  drawTour();
  const el = tourTarget(st);
  if (el) {
    // Bring it into view below the sticky header, leaving room for the bubble
    // (underneath it on a computer, the bottom sheet on a phone).
    el.scrollIntoView({ block: 'nearest', inline: 'center' });
    const head = document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0;
    const bh = document.querySelector('.tour-bubble')?.offsetHeight || 300;
    const top = head + 16, bottom = innerHeight - bh - 32;
    const r = el.getBoundingClientRect();
    if (r.top < top || r.bottom > bottom) window.scrollBy(0, r.top - top);
  } else window.scrollTo(0, 0);
  drawTour();
}

// Draws the spotlight and the speech bubble, then keeps them on the target as the page scrolls or re-renders.
function drawTour() {
  if (S.tour == null) return;
  const st = TOUR[S.tour];
  let root = document.getElementById('tour-root');
  if (!root) { root = document.createElement('div'); root.id = 'tour-root'; document.body.appendChild(root); }
  if (root.dataset.step !== String(S.tour)) {
    const last = S.tour === TOUR.length - 1;
    const first = !root.innerHTML;
    root.dataset.step = S.tour;
    root.innerHTML = `<div class="tour-layer ${first && !reducedMotion() ? 'enter' : ''}"><div class="tour-spot"></div>
      <div class="tour-bubble" role="dialog" aria-modal="true" aria-label="${esc(st.title)}">
        <div class="tour-top"><span class="tour-icon">${st.icon}</span><div><div class="kicker">Quick tour · ${S.tour + 1} of ${TOUR.length}</div><h3>${esc(st.title)}</h3></div>
          <button class="tour-skip" data-act="tour-skip">Skip</button></div>
        <div class="tour-body">${st.text()}</div>
        <div class="tour-foot">
          <div class="tour-progress"><i style="width:${(S.tour + 1) / TOUR.length * 100}%"></i></div>
          <div class="row-actions">${S.tour ? '<button class="btn ghost small" data-act="tour-back">Back</button>' : ''}
            <button class="btn primary small" data-act="${last ? 'tour-done' : 'tour-next'}">${last ? 'Make my picks' : S.tour ? 'Next' : 'Show me around'}</button></div>
        </div></div></div>`;
    root.querySelector('.tour-bubble .btn.primary')?.focus({ preventScroll: true });
  }
  const spot = root.querySelector('.tour-spot'), b = root.querySelector('.tour-bubble');
  const el = tourTarget(st);
  const phone = innerWidth < 640;
  const pad = 8;
  const r = el?.getBoundingClientRect();
  spot.classList.toggle('none', !r);
  b.classList.toggle('sheet', phone);
  b.classList.toggle('center', !r && !phone);
  b.classList.remove('top');
  b.style.top = b.style.left = '';
  if (!r) return;
  Object.assign(spot.style, { top: `${r.top - pad}px`, left: `${r.left - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
  // On a phone the bubble is a sheet: at the bottom, or the top if the target sits down there (like the save bar).
  if (phone) { if (r.bottom + pad > innerHeight - b.offsetHeight - 16) b.classList.add('top'); return; }
  // Below the target if it fits, else above, else beside it; always on screen.
  const bw = b.offsetWidth, bh = b.offsetHeight, gap = 16;
  let top = r.bottom + pad + gap, left = r.left + r.width / 2 - bw / 2;
  if (top + bh > innerHeight - 8) top = r.top - pad - gap - bh;
  if (top < 8) {
    top = Math.min(Math.max(8, r.top), innerHeight - bh - 8);
    left = r.right + pad + gap + bw < innerWidth ? r.right + pad + gap : r.left - pad - gap - bw;
  }
  b.style.top = `${top}px`;
  b.style.left = `${Math.min(Math.max(8, left), innerWidth - bw - 8)}px`;
}

async function endTour() {
  S.tour = null;
  document.getElementById('tour-root')?.remove();
  await markSeen({ intro_seen: true, updates_seen: LATEST_UPDATE });
}

let tourRaf = 0;
const redrawTour = () => { if (S.tour != null && !tourRaf) tourRaf = requestAnimationFrame(() => { tourRaf = 0; drawTour(); }); };
addEventListener('scroll', redrawTour, { passive: true });
addEventListener('resize', redrawTour);

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
  'standings-mode': el => { S.standingsMode = el.dataset.mode; render(); },
  // Showing one category sorts by it too; All goes back to the week's order.
  'results-show': el => { const F = rf(), k = el.dataset.key; F.show = k; F.sort = k === 'all' ? 'score' : k; F.dir = -1; render(); },
  'results-bars': el => { rf().bars = el.dataset.key; render(); },
  'results-sort': el => { const F = rf(), k = el.dataset.key; F.dir = F.sort === k ? -F.dir : -1; F.sort = k; render(); },
  'results-clear': () => { S.rf = null; render(); },
  'cal-week': el => { if (el.dataset.week) { S.calWeek = +el.dataset.week; S.calDay = null; render(); } },
  'cal-mode': el => { S.calMode = el.dataset.mode; render(); },
  'cal-day': el => { S.calDay = el.dataset.day; render(); },
  'cal-mine': () => { S.calMine = !S.calMine; render(); },
  'recap-night': el => { S.recapDate = el.dataset.date; render(); },
  'recap-board': el => { S.recapKind = el.dataset.kind; render(); },
  'recap-download': () => recapBlob().then(b => { if (!b) return; const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = recapFile(); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }),
  'recap-copy-img': async () => {
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': recapBlob() })]); toast('Image copied. Paste it into the chat.'); } catch { toast("This browser can't copy images. Use Download instead.", true); }
  },
  'recap-share': async () => {
    const b = await recapBlob();
    if (!b) return;
    try { await navigator.share({ files: [new File([b], recapFile(), { type: 'image/png' })], text: S.recap?.text || '' }); } catch (e) { if (e?.name !== 'AbortError') toast("Couldn't open sharing. Use Download instead.", true); }
  },
  'recap-copy-text': async () => {
    try { await navigator.clipboard.writeText(S.recap?.text || ''); toast('Fun stats copied.'); }
    catch { toast('Could not copy. Your browser blocked clipboard access.', true); }
  },
  'cal-retry': () => { if (S.cal) S.cal.err = null; loadCalendar(true); render(); },
  'pack-open': el => openWaitingPack(el.dataset.key),
  'pack-practice': () => practicePack(),
  'decree-mode': el => { S.decreeDraft.mode = el.dataset.mode; S.decreeDraft.picks = S.decreeDraft.picks.slice(0, el.dataset.mode === 'vote' ? 3 : 1); render(); },
  'decree-toggle': el => {
    const D = S.decreeDraft, k = el.dataset.kind;
    if (D.picks.includes(k)) D.picks = D.picks.filter(x => x !== k);
    else if (D.mode === 'impose') D.picks = [k];
    else if (D.picks.length < 3) D.picks.push(k);
    else return toast('Up to 3 options in a vote.', true);
    render();
  },
  'decree-issue': () => decreeIssue(),
  'announce-dismiss': () => {
    try { localStorage.setItem(`phs-ann-${myId()}`, String(S.db.settings?.meta?.announcement?.at)); } catch { /* storage blocked */ }
    render();
  },
  'announce-clear': async () => {
    const meta = { ...(S.db.settings?.meta || {}) };
    delete meta.announcement;
    try { await saveSetting('meta', meta, 'Announcement taken down.'); } catch (e) { toast(e.message, true); }
    await refresh();
  },
  'rule-undo': async el => {
    const week = +el.dataset.week;
    if (!confirm(`Undo the rule change from Week ${week}?`)) return;
    try { await saveSetting('rules', (S.db.settings?.rules || []).filter(r => r.from_week !== week), 'Rule change undone.'); } catch (e) { toast(e.message, true); }
    await refresh();
  },
  'adjust-remove': async el => {
    if (!confirm('Remove this adjustment?')) return;
    try { await saveSetting('adjustments', (S.db.settings?.adjustments || []).filter(a => a.id !== el.dataset.id), 'Adjustment removed.'); } catch (e) { toast(e.message, true); }
    await refresh();
  },
  'decree-cancel': async el => {
    if (!confirm(`Cancel the Week ${el.dataset.week} decree? Any votes are lost.`)) return;
    try { await S.backend.adminDeleteDecree(+el.dataset.week); toast('Decree cancelled.'); } catch (e) { toast(e.message, true); }
    await refresh();
  },
  'decree-vote': async el => {
    const week = +el.dataset.week, i = +el.dataset.i;
    const mine = S.db.votes?.find(v => v.week === week)?.choice;
    try { await S.backend.voteDecree(week, mine === i ? null : i); toast(mine === i ? 'Vote taken back.' : 'Vote counted.'); } catch (e) { toast(e.message, true); }
    await refresh();
  },
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
  reload: () => location.reload(),
  'boot-retry': () => { $('#app').innerHTML = '<div class="empty-state"><div class="ic">🏀</div>Loading the league…</div>'; start(); },
  'demo-reset': async () => { S.backend.reset(); location.reload(); },
  'admin-refresh': () => { S.adminData = null; render(); },
  'admin-tab': el => { S.adminTab = el.dataset.tab; render(); window.scrollTo({ top: 0 }); },
  'checkin-filter': el => { S.checkinFilter = el.dataset.filter; render(); },
  'copy-reminder': async () => {
    const text = $('#reminder-text')?.value || '';
    try { await navigator.clipboard.writeText(text); toast('Reminder copied.'); }
    catch { toast('Could not copy. Your browser blocked clipboard access.', true); }
  },
  'copy-nonvoters': async () => {
    const d = S.adminData;
    const missing = (d?.members || []).filter(m => !(d.voters || new Set()).has(m.user_id));
    const emails = missing.map(m => m.email).filter(Boolean);
    try { await navigator.clipboard.writeText(emails.join(', ')); toast(`Copied ${emails.length} email${emails.length === 1 ? '' : 's'}.`); }
    catch { toast('Could not copy. Your browser blocked clipboard access.', true); }
  },
  'ops-refresh': () => { S.opsData = null; loadOps(S.opsWeek || defaultOpsWeek()); renderOfficeModal(); },
  'tour-next': () => openTour(S.tour + 1),
  'tour-back': () => openTour(S.tour - 1),
  'tour-done': async () => {
    await endTour();
    if (S.me) location.hash = '#week';
  },
  'tour-skip': () => endTour(),
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
  if (el.dataset.change === 'rules-week') { S.rulesWeek = +el.value; render(); }
  if (el.dataset.change === 'decree-week') { S.decreeDraft.week = +el.value; render(); }
  if (el.dataset.change === 'decree-slot') { S.decreeDraft.slots[el.dataset.kind] = el.value; render(); }
  if (el.dataset.change === 'results-week-select') { S.resultsWeek = +el.value; render(); }
  if (el.dataset.change === 'cal-week-select') { S.calWeek = +el.value; S.calDay = null; render(); }
  if (el.dataset.change === 'ops-week') {
    S.opsWeek = +el.value;
    S.opsData = null;
    loadOps(S.opsWeek);
    renderOfficeModal();
  }
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
    } else if (form.dataset.form === 'announce') {
      const text = (f.text || '').trim();
      if (!text) throw new Error('Write something first.');
      await saveSetting('meta', { ...(S.db.settings?.meta || {}), announcement: { text, at: new Date().toISOString() } }, 'Announcement posted.');
    } else if (form.dataset.form === 'rules') {
      const week = +f.from_week;
      const rules = S.db.settings?.rules || [];
      // Store only what differs from the rules already in force that week.
      const before = weekRules(rules, week);
      const change = { from_week: week };
      for (const p of WEEK_PATHS) {
        const n = Number(f[p]), [lo, hi] = LIMITS[p];
        if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`Check ${p}: it must be between ${lo} and ${hi}.`);
        if (n !== getPath(before, p)) p.split('.').reduce((o, k, i, ks) => (i === ks.length - 1 ? (o[k] = n) : (o[k] ||= {})), change);
      }
      if (!describeChange(change).length) throw new Error('Nothing changed.');
      const old = rules.find(r => r.from_week === week);
      const merged = old ? { ...old, ...change, bars: { ...old.bars, ...change.bars }, cards: { ...old.cards, ...change.cards } } : change;
      await saveSetting('rules', [...rules.filter(r => r.from_week !== week), merged].sort((a, b) => a.from_week - b.from_week), `Rules saved from Week ${week}.`);
    } else if (form.dataset.form === 'season') {
      const meta = { ...(S.db.settings?.meta || {}) };
      for (const p of SEASON_PATHS) {
        const n = Number(f[p]), [lo, hi] = LIMITS[p];
        if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`Check ${p}: it must be between ${lo} and ${hi}.`);
        p.split('.').reduce((o, k, i, ks) => (i === ks.length - 1 ? (o[k] = n) : (o[k] = { ...(o[k] || {}) })), meta);
      }
      meta.commissioner = (f.commissioner || '').trim();
      await saveSetting('meta', meta, 'Season settings saved.');
    } else if (form.dataset.form === 'adjust') {
      const points = Number(f.points) || 0, lives = Math.trunc(Number(f.lives) || 0);
      if (!f.user_id) throw new Error('Choose a member.');
      if (!points && !lives) throw new Error('Add some points or lives (or take some away).');
      const row = { id: `adj-${Date.now().toString(36)}`, user_id: f.user_id, week: +f.week, points, lives, reason: (f.reason || '').trim(), at: new Date().toISOString() };
      await saveSetting('adjustments', [...(S.db.settings?.adjustments || []), row], `Adjustment added for ${userName(f.user_id)}.`);
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
  if (e.target.dataset?.input === 'results-q') {
    const w = resultsWeekObj();
    if (!w) return;
    rf().q = e.target.value;
    const body = resultsRows(w);
    $('#results-body').innerHTML = body.html;
    $('#results-count').innerHTML = `${resultsCount(w, body.count)} · tap a column to sort`;
  }
  if (e.target.dataset?.input === 'ledger') {
    S.ledgerQ = e.target.value;
    $('#ledger-list').innerHTML = ledgerRows(funStats(S.league, S.data.players, S.data.teams));
  }
});

// Remember whether the primer is open across re-renders ('toggle' doesn't bubble).
document.addEventListener('toggle', e => { if (e.target.matches?.('[data-primer]')) S.primerOpen = e.target.open; }, true);

document.addEventListener('keydown', e => {
  if (S.tour != null) {
    if (e.key === 'ArrowRight') openTour(S.tour + 1);
    else if (e.key === 'ArrowLeft') openTour(S.tour - 1);
    else if (e.key === 'Escape') endTour();
    return;
  }
  if (e.key === 'Escape' && $('#modal-root').innerHTML) closeModal();
});

boot();
