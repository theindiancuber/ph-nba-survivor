// Smoke test: opens the app in a real browser and checks it actually works.
//
//   node scripts/smoke.mjs                  serves this checkout and tests it (CI)
//   BASE_URL=https://… node scripts/smoke.mjs  tests the live site (the uptime monitor)
//
// Checks: every file in src/ parses; the data files are valid JSON; the signed-out
// page reaches the sign-in form; the demo league signs in and every tab renders with
// no script errors, no "This page hit a snag" and no Content-Security-Policy blocks.
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

// ---- Data files ----
console.log('Data');
for (const f of ['weeks', 'players', 'teams', 'totals']) {
  try {
    const r = await fetch(`${base}data/${f}.json`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (r.status === 404) { pass(`data/${f}.json not there yet (the app falls back)`); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    JSON.parse(await r.text());
    pass(`data/${f}.json is valid JSON`);
  } catch (e) {
    fail(`data/${f}.json: ${e.message}`);
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
  page.on('requestfailed', r => {
    const u = r.url();
    // Our own files must load. Third parties (fonts, NBA images) may be blocked in CI.
    if (u.startsWith(base) && !/\/data\//.test(u)) errors.push(`failed to load ${u.slice(base.length)}: ${r.failure()?.errorText}`);
  });
  // Keep the test about our code: no fonts, headshots, logos or database traffic.
  await page.route(/fonts\.(googleapis|gstatic)\.com|cdn\.nba\.com|supabase\.co/, r => r.abort());
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
  // Signed out: the real app should reach the sign-in form (no database needed for that).
  console.log('Signed-out page');
  {
    const page = await openPage('signed-out page');
    await page.goto(base, { waitUntil: 'load', timeout: 30000 });
    const ok = await page.waitForSelector('[data-form="auth"]', { timeout: 20000 }).then(() => true).catch(() => false);
    if (ok) pass('reaches the sign-in form'); else fail(`signed-out page never showed sign-in. It shows: "${(await appText(page)).slice(0, 160)}"`);
    if (report(page, 'load')) pass('no script errors or CSP blocks');
    await page.close();
  }

  // Demo league: sign in, then visit every tab.
  console.log('Demo league');
  {
    const page = await openPage('demo');
    await page.goto(`${base}?demo`, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* fine */ } });
    await page.reload({ waitUntil: 'load' });
    const enter = await page.waitForSelector('[data-act="demo-enter"]', { timeout: 20000 }).catch(() => null);
    if (!enter) {
      fail(`demo never reached its welcome page. It shows: "${(await appText(page)).slice(0, 160)}"`);
    } else {
      await enter.click();
      const tour = await page.waitForSelector('[data-act="tour-skip"]', { timeout: 5000 }).catch(() => null);
      if (tour) { await tour.click(); pass('first-login tour opened and closed'); } else fail('first-login tour did not open');
      for (const view of ['week', 'cards', 'standings', 'survivor', 'results', 'burns', 'rivals', 'trophies', 'rules', 'admin']) {
        await page.evaluate(v => { location.hash = `#${v}`; }, view);
        await page.waitForTimeout(350);
        const snag = await page.$('.view-error');
        const text = await appText(page);
        if (snag) fail(`demo #${view} hit a snag: ${text.slice(0, 200)}`);
        else if (text.length < 40 || /Loading the league/.test(text)) fail(`demo #${view} rendered almost nothing: "${text}"`);
        else if (report(page, `#${view}`)) pass(`#${view} renders`);
      }
      // The Commissioner tab is split into sections; each one renders on its own.
      for (const tab of ['members', 'rules', 'decrees', 'insights']) {
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
