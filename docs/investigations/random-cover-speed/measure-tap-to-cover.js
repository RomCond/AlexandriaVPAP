// Measures how long the random pick's cover takes to show, before and after this branch's changes,
// on a throttled 4G connection, against the real Cover Art Archive and archive.org.
//
//   node docs/investigations/random-cover-speed/measure-tap-to-cover.js [release-group-id...]
//
// - "before" is the app at BEFORE_REF (default bf604df, main before this work), unpacked with git archive.
//   "after" is this checkout. "both" is BOTH_REF (default 35f7d26), the first version of this change,
//   which asked for 500px and 1200px together even when the grid had not loaded the 500px cover.
// - SET=main (default) compares before and after. SET=strategy compares both and after on covers the
//   grid has not loaded.
// - Each pick runs in a fresh browser context, so nothing is cached from an earlier pick.
// - Conditions:
//     not-loaded   the app opens straight on Random, so the grid has not loaded the cover
//     not-loaded+color   the same, with the cover's color already saved on the record (after only)
//     grid-loaded  the app opens on the collection grid, waits until the cover shows there, then picks
// - 4G profile, through Chromium's network emulation: 165 ms added latency per request, 8.1 Mbps down,
//   1.35 Mbps up. This container's own network and proxy come on top.
// - No Playwright routes, which would turn the HTTP cache off.
//
// For each pick it prints, in ms after the tap:
//   first  the first frame with any cover image showing
//   sharp  the first frame with the 1200px image showing
//   color  when the card behind the record is tinted
// and the bytes the pick downloaded from the Cover Art Archive and archive.org.
'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../../..');
const REFS = { before: process.env.BEFORE_REF || 'bf604df', both: process.env.BOTH_REF || '35f7d26', after: null };
const COVERS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'b1392450-e666-3926-a536-22c65f834433', // OK Computer
  'e75c0549-ad55-39e3-8025-c72c5d4a3c5d', // Kid A
  '80975c59-4094-30d5-bb58-365e8b061274', // The Best Of
  'e404b349-7cef-398f-ac5e-ce06737341d1', // I Might Be Wrong
  'd2f48ef0-9a77-42bc-95af-89dd0c8452b4', // In Rainbows: From the Basement
];
const FOUR_G = { offline: false, latency: 165, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9 };
const SETS = {
  main: [
    { version: 'before', start: 'not-loaded' },
    { version: 'after', start: 'not-loaded' },
    { version: 'after', start: 'not-loaded', color: true },
    { version: 'before', start: 'grid-loaded' },
    { version: 'after', start: 'grid-loaded' },
  ],
  strategy: [
    { version: 'both', start: 'not-loaded' },
    { version: 'after', start: 'not-loaded' },
    { version: 'both', start: 'not-loaded', color: true },
    { version: 'after', start: 'not-loaded', color: true },
  ],
};
const CONDITIONS = SETS[process.env.SET || 'main'];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values) => {
  const sorted = values.filter((v) => v != null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

function serve(dir) {
  const port = 9000 + Math.floor(Math.random() * 1000);
  const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '-d', dir], { stdio: 'ignore' });
  return { server, url: `http://127.0.0.1:${port}/index.html` };
}

async function pick(browser, app, cover, condition) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const record = {
    id: 'pick', artist: 'Radiohead', title: 'Test pick', year: 2000, format: 'LP', notes: '', artistId: null,
    releaseGroupId: cover, releaseId: null, pendingLookup: false, addedAt: '2026-01-01T00:00:00.000Z',
    ...(condition.color ? { coverColor: 'rgb(120 80 60)' } : {}),
  };
  await context.addInitScript((r) => {
    if (!localStorage.getItem('alexandria.records.v1')) localStorage.setItem('alexandria.records.v1', JSON.stringify([r]));
  }, record);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', FOUR_G);
  let counting = false;
  let bytes = 0;
  const coverRequests = new Set();
  cdp.on('Network.requestWillBeSent', (e) => {
    if (counting && /^https:\/\/([a-z0-9-]+\.)*(coverartarchive|archive)\.org\//.test(e.request.url)) coverRequests.add(e.requestId);
  });
  cdp.on('Network.loadingFinished', (e) => {
    if (coverRequests.has(e.requestId)) bytes += e.encodedDataLength;
  });

  try {
    if (condition.start === 'grid-loaded') {
      await page.goto(`${app}#collection`);
      await page.locator('#collection-list .cover.loaded').waitFor({ timeout: 30000 });
      await page.click('.tabs a[href="#random"]');
    } else {
      await page.goto(`${app}#random`);
    }
    await page.evaluate(() => document.fonts.ready);
    await wait(1000);
    counting = true;
    await page.evaluate(() => {
      const btn = document.querySelector('#spin-btn');
      btn.addEventListener('click', () => {
        const probe = { start: performance.now(), first: null, sharp: null, color: null, done: false };
        window.__probe = probe;
        const card = document.querySelector('#view-random .random-card');
        const tick = () => {
          const now = Math.round(performance.now() - probe.start);
          for (const img of document.querySelectorAll('#spin-sleeve img')) {
            if (img.complete && img.naturalWidth > 0 && parseFloat(getComputedStyle(img).opacity) > 0) {
              if (probe.first == null) probe.first = now;
              if (probe.sharp == null && img.src.endsWith('front-1200')) probe.sharp = now;
            }
          }
          if (probe.color == null && card.style.getPropertyValue('--album')) probe.color = now;
          if (probe.sharp != null && probe.color != null) probe.done = true;
          else if (now < 25000) requestAnimationFrame(tick);
          else probe.done = true;
        };
        requestAnimationFrame(tick);
      }, { capture: true, once: true });
      btn.click();
    });
    await page.waitForFunction(() => window.__probe && window.__probe.done, null, { timeout: 30000 });
    await wait(500); // let the last bytes be counted
    const probe = await page.evaluate(() => window.__probe);
    return { first: probe.first, sharp: probe.sharp, color: probe.color, kb: Math.round(bytes / 1024) };
  } catch (err) {
    return { error: err.message.split('\n')[0] };
  } finally {
    await context.close();
  }
}

async function main() {
  const dirs = {};
  const servers = {};
  for (const version of new Set(CONDITIONS.map((c) => c.version))) {
    if (REFS[version]) {
      dirs[version] = fs.mkdtempSync(path.join(os.tmpdir(), `alexandria-${version}-`));
      execFileSync('sh', ['-c', `git -C "${ROOT}" archive ${REFS[version]} | tar -x -C "${dirs[version]}"`]);
    }
    servers[version] = serve(dirs[version] || ROOT);
  }
  await wait(800);
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined;
  const browser = await chromium.launch({ proxy });
  const results = [];
  try {
    console.log('cover     condition                    first  sharp  color     kB');
    for (const [i, cover] of COVERS.entries()) {
      // Each cover runs the conditions in a different order, so no condition always goes first.
      // ROTATE shifts the orders, so a run split in two can carry on where the first part stopped.
      const shift = i + Number(process.env.ROTATE || 0);
      const order = CONDITIONS.map((_, k) => CONDITIONS[(k + shift) % CONDITIONS.length]);
      for (const condition of order) {
        const result = await pick(browser, servers[condition.version].url, cover, condition);
        const name = `${condition.version} ${condition.start}${condition.color ? '+color' : ''}`;
        results.push({ cover: cover.slice(0, 8), name, ...result });
        const cell = (v) => String(v ?? '-').padStart(6);
        console.log(`${cover.slice(0, 8)}  ${name.padEnd(27)} ${result.error ? `error: ${result.error}` : `${cell(result.first)} ${cell(result.sharp)} ${cell(result.color)} ${cell(result.kb)}`}`);
        await wait(1500);
      }
    }
  } finally {
    await browser.close();
    Object.values(servers).forEach(({ server }) => server.kill());
    Object.values(dirs).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  }

  console.log('\nmedians                               first  sharp  color     kB   picks');
  for (const condition of CONDITIONS) {
    const name = `${condition.version} ${condition.start}${condition.color ? '+color' : ''}`;
    const rows = results.filter((r) => r.name === name && !r.error);
    const cell = (v) => String(v ?? '-').padStart(6);
    console.log(`${name.padEnd(37)} ${cell(median(rows.map((r) => r.first)))} ${cell(median(rows.map((r) => r.sharp)))} ${cell(median(rows.map((r) => r.color)))} ${cell(median(rows.map((r) => r.kb)))} ${String(rows.length).padStart(7)}`);
  }
  if (process.env.JSON_OUT) fs.writeFileSync(process.env.JSON_OUT, JSON.stringify({ profile: FOUR_G, refs: REFS, results }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
