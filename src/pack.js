// Card faces, sealed packs and the pack-opening show.
//
// The opening borrows from the games that do it best:
//   - Pokémon TCG Pocket: you swipe across the top to rip the foil.
//   - FIFA Ultimate Team walkouts: light leaks out of the tear in the colour of
//     the best card inside, and an epic or legendary pull gets the full
//     lights-down, beams-and-flares treatment before the cards come out.
//   - Hearthstone: cards land face-down and glow in their rarity colour.
//   - simeydotme's pokemon-cards-css: holo foil and glare that follow the pointer.
// Then you keep one card, and the other two burn.

import { LEAGUE } from './config.js';
import { CARDS, RARITY, TYPES, PACKS, bestRarity } from './cards.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const wait = ms => new Promise(r => setTimeout(r, ms));

const LOGO = `<svg viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="9" fill="#1d428a"/><path d="M0 9a9 9 0 0 1 9-9h31L0 40z" fill="#c8102e"/><circle cx="20" cy="20" r="10.5" fill="none" stroke="#fff" stroke-width="2.4"/><path d="M9.5 20h21M20 9.5v21" stroke="#fff" stroke-width="2"/><path d="M13 12.5c3 2.2 3 12.8 0 15M27 12.5c-3 2.2-3 12.8 0 15" fill="none" stroke="#fff" stroke-width="1.8"/></svg>`;

// ---------- Card faces ----------

export function cardFace(type, { cls = '', attrs = '' } = {}) {
  const c = CARDS[type];
  if (!c) return '';
  const r = RARITY[c.rarity], t = TYPES[c.type];
  return `<div class="tc r-${c.rarity} ${cls}" data-card="${type}" style="--rc:${r.color};--tcol:${t.color}" ${attrs}>
    <div class="tc-in">
      <div class="tc-head"><span class="tc-name ${c.name.length > 12 ? 'long' : ''}">${esc(c.name)}</span><span class="tc-stars" aria-label="${r.label}">${'★'.repeat(r.stars)}</span></div>
      <div class="tc-art"><span class="tc-court"></span><span class="tc-icon">${c.icon}</span></div>
      <div class="tc-type"><span>${t.label}</span><span>${r.label}</span></div>
      <p class="tc-text">${esc(c.text)}</p>
    </div>
    <div class="tc-holo"></div><div class="tc-glare"></div>
  </div>`;
}

export function cardBack(cls = '') {
  return `<div class="tc-back ${cls}"><div class="tc-back-in">${LOGO}<b>JOKER</b><small>${esc(LEAGUE.season)}</small></div></div>`;
}

export function packTitle(pack) {
  if (pack.kind === 'award') return `${pack.label} Pack`;
  if (pack.kind === 'album') return `${pack.label} Division Pack`;
  return PACKS[pack.kind]?.name || 'Joker Pack';
}

// The foil wrapper. Rendered twice in the opening (the strip you rip off and the
// body that stays), each clipped along the same jagged tear line.
export function packArt(pack, extra = '') {
  const p = PACKS[pack.kind] || PACKS.locker;
  return `<div class="pa ${extra}" style="--p1:${p.c1};--p2:${p.c2}">
    <div class="pa-foil"></div>
    <div class="pa-seal top"></div><div class="pa-seal bot"></div>
    <div class="pa-brand">${LOGO}<span>PEAKHILL<b>NBA Survivor</b></span></div>
    <div class="pa-burst"><b>KEEP 1</b><small>of 3</small></div>
    <div class="pa-title"><small>Joker cards</small><b>${esc(packTitle(pack))}</b></div>
    <div class="pa-foot">3 cards · Week ${pack.step} · ${esc(LEAGUE.season)}</div>
  </div>`;
}

// Holo foil and tilt that follow the pointer, for any card face marked .tilt.
let holoReady = false;
export function initHolo() {
  if (holoReady) return;
  holoReady = true;
  const reset = el => { el.style.removeProperty('--mx'); el.style.removeProperty('--my'); el.style.removeProperty('--rx'); el.style.removeProperty('--ry'); el.classList.remove('lit'); };
  document.addEventListener('pointermove', e => {
    const el = e.target.closest?.('.tc.tilt');
    if (!el || e.pointerType === 'touch' && !el.closest('.pk')) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    el.style.setProperty('--mx', `${x * 100}%`);
    el.style.setProperty('--my', `${y * 100}%`);
    if (!reduced()) {
      el.style.setProperty('--rx', `${(0.5 - y) * 16}deg`);
      el.style.setProperty('--ry', `${(x - 0.5) * 20}deg`);
    }
    el.classList.add('lit');
  }, { passive: true });
  document.addEventListener('pointerout', e => {
    const el = e.target.closest?.('.tc.tilt');
    if (el && !el.contains(e.relatedTarget)) reset(el);
  });
}

// ---------- Sound (synthesised, off by default) ----------

const Sound = {
  get on() { try { return localStorage.getItem('phs-sound') === '1'; } catch { return false; } },
  set on(v) { try { localStorage.setItem('phs-sound', v ? '1' : '0'); } catch { /* private mode */ } },
  ctx: null,
  ready() {
    if (!this.on) return null;
    try { this.ctx ||= new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },
  tone(freq, dur, { type = 'sine', at = 0, gain = 0.12, slide } = {}) {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  },
  noise(dur, { freq = 1800, q = 0.8, gain = 0.25, type = 'bandpass' } = {}) {
    const ctx = this.ready();
    if (!ctx) return;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 1.5;
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = buf;
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    g.gain.value = gain;
    src.connect(f).connect(g).connect(ctx.destination);
    src.start();
  },
  tear() { this.noise(0.38, { freq: 2600, q: 0.6, gain: 0.3 }); this.noise(0.2, { freq: 700, gain: 0.15 }); },
  flip() { this.tone(540, 0.08, { type: 'triangle', gain: 0.08 }); },
  rarity(r) {
    if (r === 'rare') { this.tone(660, 0.18); this.tone(990, 0.3, { at: 0.08 }); }
    if (r === 'epic') [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.35, { at: i * 0.07, type: 'triangle' }));
    if (r === 'legendary') {
      this.tone(70, 0.9, { gain: 0.3, slide: 40 });
      [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.5, { at: 0.12 + i * 0.08, type: 'triangle', gain: 0.1 }));
    }
  },
  whoosh() { this.noise(0.5, { freq: 400, q: 0.4, gain: 0.18, type: 'lowpass' }); },
  burn() { this.noise(0.9, { freq: 300, q: 0.3, gain: 0.2, type: 'lowpass' }); },
};

// ---------- Particles ----------

class Fx {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.parts = [];
    this.running = false;
    this.resize();
  }
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.c.width = innerWidth * dpr;
    this.c.height = innerHeight * dpr;
  }
  burst(x, y, { n = 40, colors = ['#fff'], speed = 7, gravity = 0.18, size = 3, life = 60, kind = 'spark', spread = Math.PI * 2, angle = -Math.PI / 2 } = {}) {
    if (reduced()) return;
    for (let i = 0; i < n; i++) {
      const a = angle + (Math.random() - 0.5) * spread;
      const v = speed * (0.35 + Math.random() * 0.8);
      this.parts.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: gravity, life: life * (0.6 + Math.random() * 0.6), age: 0,
        color: colors[i % colors.length], size: size * (0.6 + Math.random()), kind, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
      });
    }
    this.run();
  }
  embers(rect, n = 26) {
    if (reduced()) return;
    for (let i = 0; i < n; i++) {
      this.parts.push({
        x: rect.left + Math.random() * rect.width, y: rect.top + rect.height * (0.4 + Math.random() * 0.6),
        vx: (Math.random() - 0.5) * 1.2, vy: -1 - Math.random() * 2.4, g: -0.02, life: 50 + Math.random() * 50, age: 0,
        color: ['#ffb02e', '#ff6b2c', '#ffd56b', '#ef2b4d'][i % 4], size: 1.5 + Math.random() * 2.5, kind: 'ember',
      });
    }
    this.run();
  }
  run() {
    if (this.running) return;
    this.running = true;
    const step = () => {
      const { g, dpr } = this;
      g.clearRect(0, 0, this.c.width, this.c.height);
      this.parts = this.parts.filter(p => p.age < p.life);
      for (const p of this.parts) {
        p.age++;
        p.vy += p.g;
        p.vx *= 0.985;
        p.x += p.vx; p.y += p.vy;
        p.rot += p.vr || 0;
        const a = 1 - p.age / p.life;
        g.globalAlpha = Math.max(0, a);
        g.fillStyle = p.color;
        if (p.kind === 'confetti') {
          g.save();
          g.translate(p.x * dpr, p.y * dpr);
          g.rotate(p.rot);
          g.fillRect(-p.size * dpr, -p.size * 0.45 * dpr, p.size * 2 * dpr, p.size * 0.9 * dpr);
          g.restore();
        } else {
          g.beginPath();
          g.arc(p.x * dpr, p.y * dpr, Math.max(0.1, p.size * dpr * (p.kind === 'ember' ? a : 1)), 0, Math.PI * 2);
          g.fill();
        }
      }
      g.globalAlpha = 1;
      if (this.parts.length) requestAnimationFrame(step);
      else this.running = false;
    };
    requestAnimationFrame(step);
  }
}

// ---------- The opening ----------

// A jagged tear line about 15% from the top, as clip-path polygons for the strip and the body.
function tearPaths() {
  const pts = [];
  const n = 16;
  for (let i = 0; i <= n; i++) pts.push([(i / n) * 100, 15 + (i % 2 ? 1.6 : -1.2) * (0.5 + Math.random() * 0.7)]);
  const line = pts.map(([x, y]) => `${x.toFixed(2)}% ${y.toFixed(2)}%`);
  return {
    body: `polygon(${line.join(',')}, 100% 100%, 0% 100%)`,
    strip: `polygon(0% 0%, 100% 0%, ${[...line].reverse().join(',')})`,
  };
}

const BEST_TEXT = { epic: 'EPIC PULL', legendary: 'LEGENDARY PULL' };

/**
 * Opens a pack in a full-screen overlay. Resolves with the kept card's index, or
 * null if the person closes it first. onKeep(index) saves the choice and may throw.
 */
export function openPack({ pack, cards, onKeep, practice = false }) {
  initHolo();
  return new Promise(resolve => {
    const best = bestRarity(cards);
    const bestColor = RARITY[best].color;
    const paths = tearPaths();
    const root = document.createElement('div');
    root.className = 'pk';
    root.dataset.best = best;
    root.dataset.state = 'sealed';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', `Open ${packTitle(pack)}`);
    root.style.setProperty('--leak', bestColor);
    root.innerHTML = `
      <div class="pk-bg"></div>
      <div class="pk-beams" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="pk-flares" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <canvas class="pk-fx" aria-hidden="true"></canvas>
      <div class="pk-bar">
        <button class="pk-sound" type="button" aria-pressed="${Sound.on}" title="Sound">${Sound.on ? '🔊' : '🔇'}</button>
        <button class="pk-x" type="button" aria-label="Close">×</button>
      </div>
      <div class="pk-head"><small>${esc(practice ? 'Practice pack · nothing is saved' : PACKS[pack.kind]?.blurb || '')}</small><b>${esc(packTitle(pack))}</b></div>
      <div class="pk-scene">
        <div class="pk-pack" tabindex="0" role="button" aria-label="Rip the pack open">
          <div class="pk-body" style="clip-path:${paths.body}">${packArt(pack)}</div>
          <div class="pk-strip" style="clip-path:${paths.strip}">${packArt(pack)}</div>
          <div class="pk-leak"></div>
          <div class="pk-perf"></div>
          <div class="pk-glow"></div>
        </div>
        <div class="pk-cards">${cards.map((c, i) => `
          <button class="pk-card" type="button" data-i="${i}" data-rarity="${CARDS[c].rarity}" style="--i:${i}" aria-label="Face-down card ${i + 1}">
            <div class="pk-flip"><div class="pk-side back">${cardBack()}</div><div class="pk-side front">${cardFace(c, { cls: 'tilt' })}</div></div>
          </button>`).join('')}
        </div>
      </div>
      <div class="pk-walk" aria-hidden="true"><span>${BEST_TEXT[best] || ''}</span></div>
      <div class="pk-foot">
        <p class="pk-hint" aria-live="polite">Swipe across the top to rip it open</p>
        <div class="pk-actions"><button class="btn primary pk-rip" type="button">Rip it open</button></div>
      </div>`;
    document.body.appendChild(root);
    document.body.classList.add('pk-open');
    const $ = s => root.querySelector(s);
    const fx = new Fx($('.pk-fx'));
    const packEl = $('.pk-pack');
    const hint = $('.pk-hint');
    const actions = $('.pk-actions');
    const cardEls = [...root.querySelectorAll('.pk-card')];
    const flipped = new Set();
    let state = 'sealed', chosen = null, saving = false, done = false;
    const setState = s => { state = s; root.dataset.state = s; };
    const onResize = () => fx.resize();
    window.addEventListener('resize', onResize);
    requestAnimationFrame(() => root.classList.add('in'));
    setTimeout(() => packEl.focus({ preventScroll: true }), 50);

    const close = result => {
      if (done) return;
      done = true;
      root.classList.add('out');
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKey, true);
      setTimeout(() => { root.remove(); if (!document.querySelector('.pk')) document.body.classList.remove('pk-open'); }, reduced() ? 50 : 320);
      resolve(result);
    };

    // --- Sealed: float, tilt toward the pointer, swipe to tear ---
    let drag = null;
    const setTear = t => { packEl.style.setProperty('--t', t.toFixed(3)); };
    root.addEventListener('pointermove', e => {
      if (state !== 'sealed' || drag || reduced()) return;
      const r = packEl.getBoundingClientRect();
      const x = (e.clientX - (r.left + r.width / 2)) / innerWidth, y = (e.clientY - (r.top + r.height / 2)) / innerHeight;
      packEl.style.setProperty('--ty', `${x * 26}deg`);
      packEl.style.setProperty('--tx', `${-y * 18}deg`);
      packEl.style.setProperty('--sx', `${50 + x * 120}%`);
    });
    packEl.addEventListener('pointerdown', e => {
      if (state !== 'sealed') return;
      const r = packEl.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, w: r.width, moved: false, top: e.clientY - r.top < r.height * 0.45 };
      packEl.setPointerCapture(e.pointerId);
      packEl.classList.add('grab');
    });
    packEl.addEventListener('pointermove', e => {
      if (!drag || state !== 'sealed') return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 6) drag.moved = true;
      const t = Math.min(1, Math.abs(dx) / (drag.w * 0.85));
      packEl.dataset.dir = dx < 0 ? 'l' : 'r';
      setTear(t);
      if (t >= 1) { drag = null; packEl.classList.remove('grab'); rip(); }
    });
    const endDrag = () => {
      if (!drag) return;
      const t = parseFloat(packEl.style.getPropertyValue('--t') || '0');
      const wasTap = !drag.moved;
      drag = null;
      packEl.classList.remove('grab');
      if (t > 0.55) return rip();
      setTear(0);
      if (wasTap) { packEl.classList.remove('nudge'); void packEl.offsetWidth; packEl.classList.add('nudge'); hint.textContent = 'Swipe across the top of the pack, or press Rip it open'; }
    };
    packEl.addEventListener('pointerup', endDrag);
    packEl.addEventListener('pointercancel', endDrag);
    packEl.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && state === 'sealed') { e.preventDefault(); autoTear(); } });
    $('.pk-rip').addEventListener('click', () => autoTear());

    async function autoTear() {
      if (state !== 'sealed') return;
      setState('tearing');
      packEl.dataset.dir = 'r';
      if (reduced()) return rip();
      const t0 = performance.now();
      await new Promise(done => {
        const f = now => {
          const t = Math.min(1, (now - t0) / 420);
          setTear(t * t * (3 - 2 * t));
          if (t < 1) requestAnimationFrame(f); else done();
        };
        requestAnimationFrame(f);
      });
      rip();
    }

    // --- Rip, the tell, and (for epic+) the walkout ---
    async function rip() {
      if (state === 'torn' || done) return;
      setState('torn');
      setTear(1);
      Sound.tear();
      navigator.vibrate?.(30);
      actions.innerHTML = '';
      hint.textContent = '';
      const r = packEl.getBoundingClientRect();
      fx.burst(r.left + r.width / 2, r.top + r.height * 0.15, { n: 46, colors: [bestColor, '#ffffff', '#ffd56b'], speed: 9, spread: Math.PI * 1.1, life: 55 });
      await wait(reduced() ? 50 : 650);
      setState('tell');
      hint.textContent = best === 'common' ? '' : best === 'rare' ? 'Something shiny in there…' : 'Oh. Oh no. Look at that light.';
      if (best === 'rare') Sound.tone(880, 0.5, { gain: 0.06 });
      await wait(reduced() ? 50 : best === 'common' ? 450 : 1100);
      if (BEST_TEXT[best] && !reduced()) {
        setState('walkout');
        Sound.rarity(best);
        navigator.vibrate?.([40, 60, 80]);
        await wait(500);
        fx.burst(innerWidth / 2, innerHeight * 0.45, { n: best === 'legendary' ? 140 : 80, colors: best === 'legendary' ? ['#f2c14e', '#fff3c4', '#ff8a2a', '#ffffff'] : ['#b45cff', '#e0b8ff', '#ffffff'], speed: 12, kind: 'confetti', size: 5, life: 110, gravity: 0.12 });
        await wait(1500);
      }
      deal();
    }

    // --- Cards out, face down, glowing by rarity ---
    async function deal() {
      setState('deal');
      Sound.whoosh();
      await wait(reduced() ? 50 : 900);
      setState('flip');
      hint.textContent = 'Tap each card to flip it';
      actions.innerHTML = '<button class="btn pk-all" type="button">Flip all</button>';
      actions.querySelector('.pk-all').addEventListener('click', async () => {
        for (const el of cardEls) { if (!flipped.has(el)) { flip(el); await wait(reduced() ? 0 : 380); } }
      });
      cardEls[0]?.focus({ preventScroll: true });
    }

    function flip(el) {
      if (flipped.has(el) || state !== 'flip') return;
      flipped.add(el);
      el.classList.add('flipped');
      const i = +el.dataset.i;
      const c = CARDS[cards[i]];
      el.setAttribute('aria-label', `${c.name}, ${RARITY[c.rarity].label}. ${c.text}`);
      Sound.flip();
      const r = el.getBoundingClientRect();
      const color = RARITY[c.rarity].color;
      setTimeout(() => {
        if (c.rarity !== 'common') {
          Sound.rarity(c.rarity === 'legendary' ? 'epic' : c.rarity);
          fx.burst(r.left + r.width / 2, r.top + r.height / 2, { n: c.rarity === 'rare' ? 26 : 60, colors: [color, '#ffffff'], speed: c.rarity === 'rare' ? 6 : 10, life: 50 });
        }
        if (c.rarity === 'legendary') {
          root.classList.remove('shake'); void root.offsetWidth; root.classList.add('shake');
          fx.burst(r.left + r.width / 2, r.top, { n: 90, colors: ['#f2c14e', '#fff3c4', '#ffffff'], kind: 'confetti', speed: 11, size: 5, life: 100 });
        }
      }, reduced() ? 0 : 260);
      if (flipped.size === cardEls.length) setTimeout(chooseMode, reduced() ? 0 : 750);
    }

    // --- Keep one; the other two burn ---
    function chooseMode() {
      if (state !== 'flip') return;
      setState('keep');
      hint.textContent = practice ? 'Keep one. The other two burn.' : 'Keep one. Changed your mind? You get one swap before the lock.';
      actions.innerHTML = '<button class="btn primary pk-keep" type="button" disabled>Pick a card to keep</button>';
      actions.querySelector('.pk-keep').addEventListener('click', keep);
    }

    function select(el) {
      chosen = +el.dataset.i;
      cardEls.forEach(c => c.classList.toggle('chosen', c === el));
      const b = actions.querySelector('.pk-keep');
      b.disabled = false;
      b.textContent = `Keep ${CARDS[cards[chosen]].name}`;
    }

    async function keep() {
      if (chosen == null || saving) return;
      saving = true;
      const b = actions.querySelector('.pk-keep');
      b.disabled = true;
      b.textContent = 'Saving…';
      try {
        await onKeep?.(chosen);
      } catch (e) {
        saving = false;
        b.disabled = false;
        b.textContent = `Keep ${CARDS[cards[chosen]].name}`;
        hint.textContent = e?.message || 'Could not save. Try again.';
        return;
      }
      setState('burn');
      hint.textContent = `${CARDS[cards[chosen]].name} is in your hand.`;
      actions.innerHTML = '';
      Sound.burn();
      for (const el of cardEls) {
        if (+el.dataset.i === chosen) continue;
        el.classList.add('burning');
        fx.embers(el.getBoundingClientRect());
      }
      await wait(reduced() ? 300 : 1500);
      cardEls[chosen].classList.add('stash');
      await wait(reduced() ? 100 : 700);
      close(chosen);
    }

    cardEls.forEach(el => el.addEventListener('click', () => {
      if (state === 'flip') flip(el);
      else if (state === 'keep') select(el);
    }));

    $('.pk-x').addEventListener('click', () => { if (!saving) close(null); });
    $('.pk-sound').addEventListener('click', e => {
      Sound.on = !Sound.on;
      e.currentTarget.textContent = Sound.on ? '🔊' : '🔇';
      e.currentTarget.setAttribute('aria-pressed', String(Sound.on));
      if (Sound.on) Sound.flip();
    });
    const onKey = e => {
      if (e.key === 'Escape' && !saving) { e.stopPropagation(); close(null); }
    };
    document.addEventListener('keydown', onKey, true);
  });
}
