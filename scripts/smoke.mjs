// Smoke test: opens the app in a real browser and checks it actually works.
//
//   node scripts/smoke.mjs                  serves this checkout and tests it (CI)
//   BASE_URL=https://… node scripts/smoke.mjs  tests the live site (the uptime monitor)
//
// Checks, for each league on the site (NBA at the root, NHL at nhl/): every file in src/ parses;
// the data files are valid JSON; the signed-out page reaches the sign-in form; the demo league
// signs in and every tab renders with no script errors, no "This page hit a snag" and no
// Content-Security-Policy blocks.
// Exits non-zero with a list of what failed.

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const failures = [];
const fail = msg => { failures.push(msg); console.log(`  ✗ ${msg}`); };
const pass = msg => console.log(`  ✓ ${msg}`);

const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || 'playwright'));

// ---- Serve this checkout unless a live URL was given ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
let server = null;
let base = process.env.BASE_URL;
if (!base) {
  server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(ROOT, path.endsWith('/') ? `${path}index.html` : path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
}
if (!base.endsWith('/')) base += '/';
console.log(`Smoke test: ${base}`);

// The leagues on the site. The NHL league has no card game or nightly recap yet.
const ALL_VIEWS = ['week', 'calendar', 'cards', 'standings', 'survivor', 'results', 'burns', 'rivals', 'trophies', 'rules', 'admin'];
const ALL_ADMIN = ['members', 'recap', 'rules', 'decrees', 'insights'];
const LEAGUES = [
  { name: 'NBA', path: '', views: ALL_VIEWS, admin: ALL_ADMIN, calendar: true },
  { name: 'NHL', path: 'nhl/', views: ALL_VIEWS.filter(v => v !== 'cards'), admin: ALL_ADMIN.filter(t => t !== 'recap'), calendar: true },
];

// ---- Data files ----
console.log('Data');
for (const lg of LEAGUES) {
  for (const f of ['weeks', 'players', 'teams', 'totals']) {
    const file = `${lg.path}data/${f}.json`;
    try {
      const r = await fetch(`${base}${file}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
      if (r.status === 404) { pass(`${file} not there yet (the app falls back)`); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      JSON.parse(await r.text());
      pass(`${file} is valid JSON`);
    } catch (e) {
      fail(`${file}: ${e.message}`);
    }
  }
}

// ---- Browser ----
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

async function openPage(label) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(`script error: ${e.message}`));
  page.on('console', m => {
    const t = m.text();
    if (/Content Security Policy|Refused to (load|execute|connect|apply)/i.test(t)) errors.push(`CSP: ${t.slice(0, 200)}`);
  });
  // Our own files must load. Third parties (fonts, NBA images) may be blocked in CI.
  const ours = u => u.startsWith(base) && !/\/data\//.test(u);
  page.on('requestfailed', r => {
    const why = r.failure()?.errorText || '';
    // ERR_ABORTED is the browser cancelling a request because the page navigated or reloaded
    // (the demo reloads while src/demo.js is still on its way), not a file that failed to load.
    if (ours(r.url()) && !/ERR_ABORTED/.test(why)) errors.push(`failed to load ${r.url().slice(base.length)}: ${why}`);
  });
  page.on('response', r => {
    if (ours(r.url()) && r.status() >= 400) errors.push(`failed to load ${r.url().slice(base.length)}: HTTP ${r.status()}`);
  });
  // Keep the test about our code: no fonts, headshots, logos or database traffic.
  await page.route(/fonts\.(googleapis|gstatic)\.com|cdn\.nba\.com|assets\.nhle\.com|supabase\.co/, r => r.abort());
  page.label = label;
  page.errors = errors;
  return page;
}

function report(page, what) {
  if (page.errors.length) { for (const e of page.errors.splice(0)) fail(`${page.label} ${what}: ${e}`); return false; }
  return true;
}

async function appText(page) { return (await page.textContent('#app').catch(() => '')).replace(/\s+/g, ' ').trim(); }

try {
 for (const lg of LEAGUES) {
  const url = `${base}${lg.path}`;
  // Signed out: the real app should reach the sign-in form (no database needed for that).
  console.log(`${lg.name}: signed-out page`);
  {
    const page = await openPage(`${lg.name} signed-out page`);
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    const ok = await page.waitForSelector('[data-form="auth"]', { timeout: 20000 }).then(() => true).catch(() => false);
    if (ok) pass('reaches the sign-in form'); else fail(`signed-out page never showed sign-in. It shows: "${(await appText(page)).slice(0, 160)}"`);
    if (report(page, 'load')) pass('no script errors or CSP blocks');
    await page.close();
  }

  // Demo league: sign in, then visit every tab.
  console.log(`${lg.name}: demo league`);
  {
    const page = await openPage(`${lg.name} demo`);
    await page.goto(`${url}?demo`, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* fine */ } });
    await page.reload({ waitUntil: 'load' });
    const enter = await page.waitForSelector('[data-act="demo-enter"]', { timeout: 20000 }).catch(() => null);
    if (!enter) {
      fail(`demo never reached its welcome page. It shows: "${(await appText(page)).slice(0, 160)}"`);
    } else {
      await enter.click();
      const tour = await page.waitForSelector('[data-act="tour-skip"]', { timeout: 5000 }).catch(() => null);
      if (tour) { await tour.click(); pass('first-login tour opened and closed'); } else fail('first-login tour did not open');
      for (const view of lg.views) {
        await page.evaluate(v => { location.hash = `#${v}`; }, view);
        await page.waitForTimeout(350);
        const snag = await page.$('.view-error');
        const text = await appText(page);
        if (snag) fail(`demo #${view} hit a snag: ${text.slice(0, 200)}`);
        else if (text.length < 40 || /Loading the league/.test(text)) fail(`demo #${view} rendered almost nothing: "${text}"`);
        else if (report(page, `#${view}`)) pass(`#${view} renders`);
      }
      // The Calendar's day-by-day view scores the live week as it stood after each day.
      if (lg.calendar) {
        await page.evaluate(() => { location.hash = '#calendar'; });
        await page.waitForTimeout(300);
        const btn = await page.$('[data-act="cal-mode"][data-mode="days"]');
        if (!btn) fail('demo #calendar has no day-by-day view');
        else {
          await btn.click();
          await page.waitForTimeout(300);
          const days = await page.$$('[data-act="cal-day"]:not([disabled])');
          if (days.length) { await days[0].click(); await page.waitForTimeout(300); }
          if (await page.$('.view-error')) fail(`demo #calendar day by day hit a snag: ${(await appText(page)).slice(0, 200)}`);
          else if (!days.length) fail('demo #calendar day by day shows no played days');
          else if (report(page, '#calendar day by day')) pass('#calendar day by day renders');
        }
        await page.evaluate(() => { location.hash = '#admin'; });
        await page.waitForTimeout(350);
      }
      // The Commissioner tab is split into sections; each one renders on its own.
      await page.evaluate(() => { location.hash = '#admin'; });
      await page.waitForTimeout(350);
      for (const tab of lg.admin) {
        const btn = await page.$(`[data-act="admin-tab"][data-tab="${tab}"]`);
        if (!btn) { fail(`demo #admin has no ${tab} section`); continue; }
        await btn.click();
        await page.waitForTimeout(300);
        const snag = await page.$('.view-error');
        if (snag) fail(`demo #admin ${tab} hit a snag: ${(await appText(page)).slice(0, 200)}`);
        else if (report(page, `#admin ${tab}`)) pass(`#admin ${tab} renders`);
      }
    }
    report(page, 'end');
    await page.close();
  }
 }
} finally {
  await browser.close();
  server?.close();
}

// ---- Syntax: every source file parses (only for a local checkout) ----
if (!process.env.BASE_URL) {
  console.log('Syntax');
  const { execFileSync } = await import('node:child_process');
  for (const dir of ['src', 'scripts']) {
    for (const f of (await readdir(join(ROOT, dir))).filter(x => /\.m?js$/.test(x))) {
      try { execFileSync(process.execPath, ['--check', join(ROOT, dir, f)], { stdio: 'pipe' }); } catch (e) { fail(`${dir}/${f} doesn't parse: ${String(e.stderr).split('\n').slice(0, 4).join(' ')}`); }
    }
  }
  pass('source files checked');
}

if (failures.length) {
  console.log(`\nSMOKE TEST FAILED (${failures.length}):\n${failures.map(f => `- ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('\nSmoke test passed.');
