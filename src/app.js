import { LEAGUE, buildWeeks, defaultLockAt, MONTH_LABELS } from './config.js';
import { computeLeague, headToHead, blockedReason, projection, teamProjection, fmt } from './league.js';
import { TEAMS, TEAM_BY_ID, isTeamId, teamLogo, headshot } from './teams.js';
import { SupabaseBackend, DemoBackend } from './backend.js';
import { downloadCertificate } from './certificate.js';
import { funStats, perfectPlay } from './stats.js';

const SLOTS = LEAGUE.slots;
const INFO = LEAGUE.slotInfo;
const STAT_IDX = { PTS: 0, REB: 1, AST: 2 };
const VIEWS = [
  ['week', 'This Week'], ['standings', 'Standings'], ['survivor', 'Survivor'], ['results', 'Results'],
  ['burns', 'Burn Book'], ['rivals', 'Rivals'], ['trophies', 'Trophies'], ['rules', 'Rules'],
];

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo') || !LEAGUE.supabaseUrl;

const S = {
  backend: null, clockOffset: 0,
  data: { weeks: [], players: {}, totals: {}, meta: null },
  db: { profiles: [], picks: [], unburns: [], locks: {} },
  league: null, me: null,
  view: 'week', resultsWeek: null, burnUser: null, month: null,
  draft: null, picker: null, authMode: 'signup', busy: false,
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
      S.data = { weeks: seed.weeks, players: seed.players, teams: seed.teams, totals: seed.totals, meta: { updatedAt: new Date(seed.now).toISOString(), demo: true } };
      $('#demo-banner').innerHTML = `<div class="demo-banner">Demo league · made-up colleagues and simulated stats, frozen in early December. <button data-act="demo-reset">Reset demo</button></div>`;
    } else {
      S.backend = new SupabaseBackend();
      S.data = await loadData();
    }
    await S.backend.init();
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
  S.league = computeLeague({ weeks, totals: S.data.totals, picks: S.db.picks, unburns: S.db.unburns, profiles: S.db.profiles, now: now(), players: S.data.players });
  S.me = S.db.profiles.find(p => p.id === myId()) || null;
  if (S.adminFor !== myId()) {
    S.adminFor = myId();
    S.isAdmin = S.me ? await S.backend.isAdmin().catch(() => false) : false;
    S.adminData = null;
  }
  if (!S.draft || !S.draft.dirty || S.draft.week !== S.league.openWeek) resetDraft();
  render();
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
  else if (!signedIn && (S.view === 'week' || S.view === 'rivals')) html = viewAuth();
  else if (S.view === 'admin') html = S.isAdmin ? viewAdmin() : viewWeek();
  else html = ({ week: viewWeek, standings: viewStandings, survivor: viewSurvivor, results: viewResults, burns: viewBurns, rivals: viewRivals, trophies: viewTrophies, rules: viewRules })[S.view]();
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
    const dot = (k === 'week' && needsPicks()) || (k === 'results' && liveWeek()) ? '<span class="dot"></span>' : '';
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
  $('#footer').innerHTML = `<span>${esc(LEAGUE.name)} · ${LEAGUE.season} · free to play, bragging rights only</span><span>${stamp}</span>`;
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
    const pid = x.scorer ?? x.pid;
    const bar = LEAGUE.bars[s];
    const pct = Math.min(100, (x.value / bar) * 100);
    const team = isTeamId(pid) ? TEAM_BY_ID[pid] : player(pid)?.team;
    const left = w.leftByTeam?.[team] ?? 0;
    return `<div class="live-slot" data-slot="${s}">
      <div class="live-top">${thumb(pid)}<div><div class="kicker">${INFO[s].emoji} ${INFO[s].name}</div><b>${esc(pname(pid))}</b>
        <div class="dim" style="font-size:12px">${esc(team || '')} · ${x.gp} played${left ? ` · ${left} left` : ''}${x.usedAlt ? ' · backup in' : ''}${x.auto ? ' · autopilot' : ''}</div></div></div>
      <div class="big-num">${x.value}<small>${INFO[s].short}</small></div>
      <div class="meter ${x.value >= bar ? 'ok' : ''}"><i style="width:${pct}%"></i></div>
      <div class="meter-cap"><span>Survival bar ${bar}</span><span>${x.value >= bar ? 'Cleared ✓' : `${bar - x.value} to go`}</span></div>
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
  </section>`;
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
    <div class="player-info"><div class="pname">${esc(pname(sel.player_id))}</div><div class="pmeta">${esc(t ? `${t.city} ${t.name}` : p?.team || '')}${p?.pos ? ` · ${esc(p.pos)}` : ''}</div></div>
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

function closeModal() { $('#modal-root').innerHTML = ''; S.picker = null; }

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

// ---------- Standings ----------

function viewStandings() {
  const L = S.league;
  const lw = [...lockedWeeks()].pop();
  const rival = meU()?.rival;
  const rows = L.standings.filter(u => Object.keys(u.weekly).length || u.id === myId()).map(u => `
    <tr class="${u.id === myId() ? 'me' : ''}">
      <td class="rank ${u.rank <= 3 ? 'top' : ''}">${u.rank}</td>
      <td><div class="who">${avatar(u.id)}<div><b>${esc(u.name)}</b>${u.id === myId() ? '<span class="tag blue">You</span>' : ''}${u.id === rival ? '<span class="tag">Rival</span>' : ''}${u.lives === 0 ? '<span class="tag gold">Out of lives</span>' : ''}
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
      const pid = x.scorer ?? x.pid;
      const bar = LEAGUE.bars[s];
      return `<td><div class="cell-pick">${thumb(pid, 'sm')}<div><div class="v" style="color:${x.value >= bar ? 'var(--text)' : 'var(--muted)'}">${x.value}${x.dd ? ' 🔥' : ''}</div><div class="n">${esc(shortName(pid))}${x.usedAlt ? ' (B)' : ''}${x.auto ? ' · auto' : ''}</div><div class="rp">+${fmt(x.rank)}</div></div></div></td>`;
    }).join('');
    const surv = w.status === 'final' ? (r.survived ? '<span class="trend-up">✓</span>' : '<span class="trend-down">✗ ❤️</span>') : `<span class="dim">${r.cleared}/${SLOTS.length}</span>`;
    return `<tr class="${id === myId() ? 'me' : ''}"><td class="rank ${rank <= 3 ? 'top' : ''}">${rank}</td><td><div class="who">${avatar(id)}<b>${esc(userName(id))}</b></div></td>${cells}<td class="r"><span class="pts">${fmt(r.score)}</span></td><td class="c">${surv}</td></tr>`;
  }).join('');
  return `<div class="grid">
    <section class="panel">
      <div class="panel-title"><h2>Week ${w.week} ${w.status === 'live' ? '<span class="badge live">Live</span>' : '<span class="badge final">Final</span>'}</h2>
        <div class="pills">${weeks.map(x => `<button class="pill ${x.status === 'live' ? 'live' : ''}" data-act="results-week" data-week="${x.week}" aria-pressed="${x.week === w.week}">Wk ${x.week}</button>`).join('')}</div></div>
      <p class="muted" style="margin:-6px 0 12px;font-size:13px">${weekRange(w)} · bars ${SLOTS.map(s => `${LEAGUE.bars[s]} ${INFO[s].short}`).join(' / ')} · (B) backup scored · 🔥 Double Down</p>
      <div class="table-wrap"><table class="board"><thead><tr><th>#</th><th>Player</th>${SLOTS.map(s => `<th>${INFO[s].emoji} ${INFO[s].name}</th>`).join('')}<th class="r">Pts</th><th class="c">Bars</th></tr></thead><tbody>${body}</tbody></table></div>
    </section>
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
  const L = S.league;
  const champs = L.champions;
  const won = champs.map((c, i) => `<div class="trophy won"><div class="ic">${c.title.startsWith('Season') ? '🏆' : c.title.startsWith('Survivor') ? '🥊' : '👑'}</div>
    <h4>${esc(c.title)}</h4><div class="leader">${esc(c.user.name)}</div><p>${esc(c.detail)}</p>
    <button class="btn gold small" data-act="cert" data-i="${i}">Download certificate</button></div>`).join('');
  const leader = L.standings[0];
  const races = [];
  if (!champs.some(c => c.title === 'Season Champion')) races.push(`<div class="trophy"><div class="ic">🏆</div><h4>Season Champion</h4><p>Most points after dropped weeks. Decided after Week ${L.weeks.length}.</p><div class="leader">${leader && lockedWeeks().length ? `Leader: ${esc(leader.name)} · ${fmt(leader.counted)}` : 'No leader yet'}</div></div>`);
  if (!L.survivor.winner) races.push(`<div class="trophy"><div class="ic">🥊</div><h4>Survivor Belt</h4><p>Last person with a life left.</p><div class="leader">${L.survivor.order.length ? `${L.survivor.alive} still alive` : 'Starts at the Week 1 lock'}</div></div>`);
  for (const m of L.months.filter(m => !m.winner)) {
    const lead = m.ranked[0];
    races.push(`<div class="trophy"><div class="ic">👑</div><h4>Monthly Crown · ${esc(m.label)}</h4><p>Most points in weeks ${m.weeks[0]}–${m.weeks[m.weeks.length - 1]}.</p><div class="leader">${lead ? `Leader: ${esc(lead.name)} · ${fmt(lead.monthly[m.key])}` : 'Not started'}</div></div>`);
  }
  races.push(`<div class="trophy"><div class="ic">🔥</div><h4>Playoff Burn</h4><p>A separate mini-game with a fresh burn list, one pick per category each playoff round. Opens in April.</p><div class="leader">Coming soon</div></div>`);
  return `<div class="grid">
    <section class="hero"><span class="badge gold">Bragging rights</span><h1>Trophy room</h1><div class="sub">No money, ever. Every champion gets a certificate, signed by the commissioner.</div></section>
    ${won ? `<section><div class="panel-title"><h2>Champions</h2></div><div class="trophies">${won}</div></section>` : ''}
    <section><div class="panel-title"><h2>Up for grabs</h2></div><div class="trophies">${races.join('')}</div></section>
  </div>`;
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
    <section class="hero"><span class="badge">How it works</span><h1>Pick 4. Burn 'em. Outlast the office.</h1><div class="sub">Five minutes a week. No draft, no roster, no money.</div></section>
    <div class="rules">
      <div class="panel rule"><h3>🗓️ The week</h3><p>Weeks run Monday to Sunday. Picks lock at the first tip-off of the week, shown in your local time. Week 1 (Oct 20 – Nov 1) and Week 17 (All-Star, Feb 15–28) are double weeks.</p></div>
      <div class="panel rule"><h3>🏀 The picks</h3><ul><li><b>Bucket</b>: a player's points</li><li><b>Glass</b>: a player's rebounds</li><li><b>Dime</b>: a player's assists</li><li><b>Dub</b>: a team's wins</li></ul><p>Each pick scores its <b>total</b> for the week, so a four-game week beats a two-game week.</p></div>
      <div class="panel rule"><h3>🔥 The burn</h3><p>Once you use a player in a category, he's gone from that category for the season, but still available in the other two. One player can only fill one of your slots in a given week.</p><p>Teams burn too: each team can be your Dub pick once a season. There are 30 teams for 23 weeks, so choose when to spend the contenders.</p></div>
      <div class="panel rule"><h3>🛟 Backups</h3><p>Add an optional backup to each player slot. It only comes in if your pick plays <b>zero</b> games that week; then the backup scores and burns instead, and your pick stays available. If your pick plays even once, his total counts and the backup stays unused. If neither plays, the slot scores 0 and nothing burns. Teams always play, so Dub has no backup.</p></div>
      <div class="panel rule"><h3>📊 Scoring</h3><p>Every category is ranked across the league each week. You get 1 point for every colleague whose pick you beat, ½ for a tie. Your weekly score is the sum of your four categories.</p><p>Drop your worst weeks: one drop unlocks after weeks 6, 12 and 18.</p></div>
      <div class="panel rule"><h3>❤️ Survivor</h3><p>Everyone starts with ${LEAGUE.lives} lives. Clear at least ${LEAGUE.barsToSurvive} of the ${SLOTS.length} weekly bars (${b.PTS} PTS / ${b.REB} REB / ${b.AST} AST / ${b.WIN} win, the same every week) or lose a life. Last one standing wins the Survivor Belt. You keep playing for points either way.</p></div>
      <div class="panel rule"><h3>🃏 Jokers</h3><ul><li><b>Double Down</b>: double the rank points from one slot, once a season.</li><li><b>Un-burn</b>: get one burned player back in one category, once a season.</li></ul></div>
      <div class="panel rule"><h3>🤖 Autopilot</h3><p>Forgot to pick? At the lock, Autopilot fills empty slots with your best unburned projected week (season average × games). It never leaves you at zero, but it spends your best players first.</p></div>
      <div class="panel rule"><h3>🥊 Rivals</h3><p>Name one coworker as your rival and track your weekly head-to-head record. You can change your rival any time.</p></div>
      <div class="panel rule"><h3>🏆 Titles</h3><ul><li>Season Champion</li><li>Survivor Belt</li><li>Monthly Crowns: Nov, Dec, Jan, Feb, Mar/Apr</li><li>Playoff Burn (April–June)</li></ul><p>Bragging rights and a downloadable certificate.</p></div>
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
  month: el => { S.month = el.dataset.key; render(); },
  cert: async el => {
    const c = S.league.champions[+el.dataset.i];
    await downloadCertificate({ title: c.title, name: c.user.name, detail: c.detail, date: new Date(now()).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }) });
  },
  'auth-mode': el => { S.authMode = el.dataset.mode; render(); },
  'profile-open': () => openProfile(),
  signout: async () => { await S.backend.signOut(); closeModal(); S.draft = null; await refresh(); },
  'demo-enter': async () => { await S.backend.signIn(); await refresh(); },
  'demo-reset': async () => { S.backend.reset(); location.reload(); },
  'admin-refresh': () => { S.adminData = null; render(); },
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
  if (e.target.dataset?.input === 'ledger') {
    S.ledgerQ = e.target.value;
    $('#ledger-list').innerHTML = ledgerRows(funStats(S.league, S.data.players, S.data.teams));
  }
});

document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#modal-root').innerHTML) closeModal(); });

boot();
