import { LEAGUE, buildWeeks, defaultLockAt, MONTH_LABELS } from './config.js';
import { computeLeague, headToHead, blockedReason, projection, fmt } from './league.js';
import { TEAMS, teamLogo, headshot } from './teams.js';
import { SupabaseBackend, DemoBackend } from './backend.js';
import { downloadCertificate } from './certificate.js';

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
const pname = pid => player(pid)?.name || (pid != null ? `Player #${pid}` : '—');
const shortName = pid => { const p = player(pid); return p ? `${p.first?.[0] ? p.first[0] + '. ' : ''}${p.last || p.name}` : pname(pid); };
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
      S.data = { weeks: seed.weeks, players: seed.players, totals: seed.totals, meta: { updatedAt: new Date(seed.now).toISOString(), demo: true } };
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
  return VIEWS.some(([k]) => k === v) ? v : 'week';
}

async function loadData() {
  const get = async f => {
    const r = await fetch(`data/${f}.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`data/${f}.json: ${r.status}`);
    return r.json();
  };
  const [weeks, players, totals, meta] = await Promise.all([
    get('weeks').catch(() => null), get('players').catch(() => null), get('totals').catch(() => null), get('meta').catch(() => null),
  ]);
  return {
    weeks: weeks?.weeks || buildWeeks().map(w => ({ ...w, lockAt: defaultLockAt(w), final: false, gamesByTeam: {}, leftByTeam: {} })),
    players: players?.players || {},
    totals: totals?.weeks || {},
    meta,
  };
}

async function refresh() {
  S.db = await S.backend.load();
  const weeks = S.data.weeks.map(w => ({ ...w, lockAt: S.db.locks[w.week] || w.lockAt }));
  S.league = computeLeague({ weeks, totals: S.data.totals, picks: S.db.picks, unburns: S.db.unburns, profiles: S.db.profiles, now: now(), players: S.data.players });
  S.me = S.db.profiles.find(p => p.id === myId()) || null;
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
  $('#tabs').innerHTML = VIEWS.map(([k, label]) => {
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
            <div class="sub">${weekRange(open)} · ${picked}/3 picks saved</div>
          </div>
          <div class="lock-box">
            <div class="kicker" style="color:#dbe4f7">Locks at first tip · ${esc(lockText(open.lockAt))}</div>
            ${clock(open.lockAt)}
          </div>
        </div>
        <div class="bars-strip">
          ${SLOTS.map(s => `<span class="bar-pill">${INFO[s].emoji} Survive: <b>${LEAGUE.bars[s] * open.mult} ${INFO[s].short}</b></span>`).join('')}
          <span class="bar-pill">Clear <b>${LEAGUE.barsToSurvive} of 3</b> to keep your lives · ${hearts(meU()?.lives ?? LEAGUE.lives)}</span>
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
    const bar = LEAGUE.bars[s] * w.mult;
    const pct = Math.min(100, (x.value / bar) * 100);
    const team = player(pid)?.team;
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
      <div class="stat"><b style="color:${onTrack ? 'var(--green)' : 'var(--orange)'}">${r.cleared}/3</b><small>${onTrack ? 'Bars cleared · safe' : 'Bars cleared · in danger'}</small></div>
    </div>
    <div class="live-grid">${cards}</div>
  </section>`;
}

function viewPicks(open) {
  const u = meU();
  const d = S.draft;
  const cards = SLOTS.map(s => slotCard(s, open, u, d)).join('');
  const complete = SLOTS.every(s => d.slots[s]?.player_id);
  const status = d.dirty ? '<b>Unsaved changes</b>' : complete ? '<b>All three picks saved ✓</b> You can change them until the lock.' : 'Fill all three slots. Empty slots go to Autopilot at the lock.';
  return `<section>
    <div class="panel-title" style="margin-top:4px"><h2>Your Week ${open.week} picks</h2><span class="muted">Each pick scores his total for the week</span></div>
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
  const p = player(sel.player_id);
  const t = TEAMS[p?.team];
  const games = open.gamesByTeam?.[p?.team] ?? 0;
  const avg = p?.avg?.[STAT_IDX[s]] ?? 0;
  const ddUsed = u?.doubleDownWeek != null;
  const ddOn = d.dd === s;
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
      <div class="alt-row"><span class="lbl">Backup</span>${sel.alt_id ? `${thumb(sel.alt_id, 'sm')}<span>${esc(shortName(sel.alt_id))}</span><button class="link danger" data-act="clear-alt" data-slot="${s}">Remove</button>` : `<span class="dim">Plays if your pick sits all week</span><button class="link" data-act="pick" data-slot="${s}" data-which="alt">+ Add</button>`}</div>
      <button class="dd-toggle" data-act="dd" data-slot="${s}" aria-pressed="${ddOn}" ${ddUsed ? 'disabled' : ''}><span class="x2">×2</span>${ddUsed ? `Double Down used in week ${u.doubleDownWeek}` : ddOn ? 'Double Down is on for this slot' : 'Double Down this slot'}</button>
      <div class="row-actions"><button class="btn small" data-act="pick" data-slot="${s}" data-which="main">Change pick</button><button class="btn small ghost" data-act="clear-main" data-slot="${s}">Clear</button></div>
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
  $('#modal-root').innerHTML = `<div class="modal-bg" data-act="close-modal-bg"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head">
      <div class="ttl"><div><div class="kicker">Week ${open.week} · ${INFO[P.slot].stat} total</div><h3>${esc(title)}</h3></div><button class="close-x" data-act="close-modal" aria-label="Close">×</button></div>
      <div class="filters">
        <input id="picker-q" class="input" type="search" placeholder="Search players" value="${esc(P.q)}" autocomplete="off">
        <select id="picker-team" class="input"><option value="">All teams</option>${Object.keys(TEAMS).sort().map(t => `<option value="${t}" ${P.team === t ? 'selected' : ''}>${t} · ${TEAMS[t].name}</option>`).join('')}</select>
      </div>
      <div class="pills">${[['proj', 'Projected week'], ['avg', `${INFO[P.slot].short} per game`], ['games', 'Most games'], ['name', 'Name']].map(([k, l]) => `<button class="pill" data-act="picker-sort" data-sort="${k}" aria-pressed="${P.sort === k}">${l}</button>`).join('')}</div>
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
      <div class="sub">Everyone starts with ${LEAGUE.lives} lives. Each week, clear at least ${LEAGUE.barsToSurvive} of the 3 bars with your weekly totals or lose one. Last one standing takes the belt.</div>
    </section>
    <section class="panel"><div class="panel-title"><h2>The bars</h2><span class="muted">Fixed all season · doubled in double weeks (1 and 17)</span></div>
      <div class="ladder-bars">${SLOTS.map(s => `<div class="ladder-bar" data-slot="${s}"><div class="kicker">${INFO[s].emoji} ${INFO[s].name}</div><b>${LEAGUE.bars[s]}${open?.mult === 2 ? ` <span class="muted" style="font-size:16px">×2 this week</span>` : ''}</b><div class="muted" style="font-size:12px">${INFO[s].stat.toLowerCase()} in the week</div></div>`).join('')}</div>
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
      const bar = LEAGUE.bars[s] * w.mult;
      return `<td><div class="cell-pick">${thumb(pid, 'sm')}<div><div class="v" style="color:${x.value >= bar ? 'var(--text)' : 'var(--muted)'}">${x.value}${x.dd ? ' 🔥' : ''}</div><div class="n">${esc(shortName(pid))}${x.usedAlt ? ' (B)' : ''}${x.auto ? ' · auto' : ''}</div><div class="rp">+${fmt(x.rank)}</div></div></div></td>`;
    }).join('');
    const surv = w.status === 'final' ? (r.survived ? '<span class="trend-up">✓</span>' : '<span class="trend-down">✗ ❤️</span>') : `<span class="dim">${r.cleared}/3</span>`;
    return `<tr class="${id === myId() ? 'me' : ''}"><td class="rank ${rank <= 3 ? 'top' : ''}">${rank}</td><td><div class="who">${avatar(id)}<b>${esc(userName(id))}</b></div></td>${cells}<td class="r"><span class="pts">${fmt(r.score)}</span></td><td class="c">${surv}</td></tr>`;
  }).join('');
  return `<div class="grid">
    <section class="panel">
      <div class="panel-title"><h2>Week ${w.week} ${w.status === 'live' ? '<span class="badge live">Live</span>' : '<span class="badge final">Final</span>'}</h2>
        <div class="pills">${weeks.map(x => `<button class="pill ${x.status === 'live' ? 'live' : ''}" data-act="results-week" data-week="${x.week}" aria-pressed="${x.week === w.week}">Wk ${x.week}</button>`).join('')}</div></div>
      <p class="muted" style="margin:-6px 0 12px;font-size:13px">${weekRange(w)} · bars ${SLOTS.map(s => `${LEAGUE.bars[s] * w.mult} ${INFO[s].short}`).join(' / ')} · (B) backup scored · 🔥 Double Down</p>
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

// ---------- Rules ----------

function viewRules() {
  const b = LEAGUE.bars;
  return `<div class="grid">
    <section class="hero"><span class="badge">How it works</span><h1>Pick 3. Burn 'em. Outlast the office.</h1><div class="sub">Five minutes a week. No draft, no roster, no money.</div></section>
    <div class="rules">
      <div class="panel rule"><h3>🗓️ The week</h3><p>Weeks run Monday to Sunday. Picks lock at the first tip-off of the week, shown in your local time. Week 1 (Oct 20 – Nov 1) and Week 17 (All-Star, Feb 15–28) are double weeks.</p></div>
      <div class="panel rule"><h3>🏀 The picks</h3><ul><li><b>Bucket</b>: points</li><li><b>Glass</b>: rebounds</li><li><b>Dime</b>: assists</li></ul><p>Each pick scores his <b>total</b> for the week, so a four-game week beats a two-game week.</p></div>
      <div class="panel rule"><h3>🔥 The burn</h3><p>Once you use a player in a category, he's gone from that category for the season, but still available in the other two. One player can only fill one of your slots in a given week.</p></div>
      <div class="panel rule"><h3>🛟 Backups</h3><p>Add an optional backup to each slot. If your pick plays zero games, the backup scores and burns instead. If neither plays, the slot scores 0 and nothing burns.</p></div>
      <div class="panel rule"><h3>📊 Scoring</h3><p>Every category is ranked across the league each week. You get 1 point for every colleague whose pick you beat, ½ for a tie. Your weekly score is the sum of your three categories.</p><p>Drop your worst weeks: one drop unlocks after weeks 6, 12 and 18.</p></div>
      <div class="panel rule"><h3>❤️ Survivor</h3><p>Everyone starts with ${LEAGUE.lives} lives. Clear at least ${LEAGUE.barsToSurvive} of the 3 weekly bars (${b.PTS} PTS / ${b.REB} REB / ${b.AST} AST, doubled in double weeks) or lose a life. Last one standing wins the Survivor Belt. You keep playing for points either way.</p></div>
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
        <label class="field">Email<input class="input" name="email" type="email" required autocomplete="email"></label>
        <label class="field">Password<input class="input" name="password" type="password" required minlength="6" autocomplete="${signup ? 'new-password' : 'current-password'}"></label>
        <div class="err" id="auth-err"></div>
        <button class="btn primary" type="submit">${signup ? 'Join the league' : 'Sign in'}</button>
        ${signup ? '' : '<button class="link" type="button" data-act="forgot">Forgot password?</button>'}
      </form>
    </div>`;
  return `<div class="auth-wrap">
    <div class="auth-pitch"><span class="badge">${LEAGUE.season} season · free to play</span>
      <h1>Pick 3.<br>Burn 'em.<br><em>Outlast the office.</em></h1>
      <p>Every week, pick a scorer, a rebounder and a passer. Their weekly totals go up against everyone else's. Use a player once per category, then he's gone for the season.</p>
      <div class="steps">
        <div class="step"><span class="n">1</span><div><b>Pick by Monday's first tip</b><span>Bucket (PTS), Glass (REB), Dime (AST). Add backups for injuries.</span></div></div>
        <div class="step"><span class="n">2</span><div><b>Beat everyone</b><span>1 point for every colleague your pick beats, in every category.</span></div></div>
        <div class="step"><span class="n">3</span><div><b>Survive</b><span>Clear 2 of 3 weekly bars or lose one of your 3 lives. Last one standing wins the belt.</span></div></div>
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
      if (S.authMode === 'signup') await S.backend.signUp({ email: f.email, password: f.password, name: f.name, team: f.team });
      else await S.backend.signIn({ email: f.email, password: f.password });
    } else if (form.dataset.form === 'setup') {
      await S.backend.createProfile({ name: f.name, team: f.team });
    } else if (form.dataset.form === 'profile') {
      await S.backend.updateProfile({ display_name: f.name.trim(), fav_team: f.team || null });
      closeModal();
      toast('Profile saved.');
    }
    await refresh();
  } catch (x) {
    if (err) err.textContent = x.message || String(x);
    btn.disabled = false;
  }
});

document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#modal-root').innerHTML) closeModal(); });

boot();
