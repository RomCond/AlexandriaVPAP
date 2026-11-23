// Drives the real app in Chromium and records what the random pick asks the network for, and when.
//
//   node docs/investigations/random-cover-speed/measure-random-pick.js
//
// - Serves the app from this checkout on 127.0.0.1 and seeds four real Radiohead records.
// - Sends coverartarchive.org requests through HTTPS_PROXY when it is set.
// - Aborts every archive.org request locally (set ALLOW_ARCHIVE=1 to let them through). In the
//   session this was written in, archive.org is not on the network allowlist, so only hop 1 is real.
// - Phone-sized page: 390x844 at 3x, like a recent iPhone.
//
// Prints one line per request: ms after the click, what started it, the URL, how long hop 1 took
// and whether the 307 came from the browser cache.
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../../..');
const PORT = 8765 + Math.floor(Math.random() * 1000);
const APP = `http://127.0.0.1:${PORT}/index.html`;

// Real release groups. Each gets its own format so a format filter can force a pick.
const RECORDS = [
  { id: 'r-okc', artist: 'Radiohead', title: 'OK Computer', year: 1997, format: 'LP', releaseGroupId: 'b1392450-e666-3926-a536-22c65f834433' },
  { id: 'r-kida', artist: 'Radiohead', title: 'Kid A', year: 2000, format: 'Double LP', releaseGroupId: 'e75c0549-ad55-39e3-8025-c72c5d4a3c5d' },
  { id: 'r-best', artist: 'Radiohead', title: 'The Best Of', year: 2008, format: 'Box set', releaseGroupId: '80975c59-4094-30d5-bb58-365e8b061274' },
  { id: 'r-imbw', artist: 'Radiohead', title: 'I Might Be Wrong', year: 2001, format: 'EP', releaseGroupId: 'e404b349-7cef-398f-ac5e-ce06737341d1' },
].map((r) => ({ notes: '', artistId: null, releaseId: null, pendingLookup: false, addedAt: '2026-01-01T00:00:00.000Z', ...r }));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '-d', ROOT], { stdio: 'ignore' });
  await wait(800);
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined;
  const browser = await chromium.launch({ proxy });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await context.addInitScript((records) => {
      if (!localStorage.getItem('alexandria.records.v1')) localStorage.setItem('alexandria.records.v1', JSON.stringify(records));
      // Marks when the big cover's <img> goes into the page, to compare with when its request starts.
      new MutationObserver(() => {
        const img = document.querySelector('#spin-sleeve img');
        if (img && !img.dataset.seen) {
          img.dataset.seen = '1';
          (window.__marks ||= []).push({ what: 'lg img inserted', at: performance.timeOrigin + performance.now(), src: img.src, loading: img.loading });
        }
      }).observe(document, { subtree: true, childList: true });
    }, RECORDS);
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
    if (!process.env.ALLOW_ARCHIVE) await context.route(/^https:\/\/([a-z0-9-]+\.)*archive\.org\//, (route) => route.abort('blockedbyclient'));

    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    const log = [];
    const byId = new Map();
    cdp.on('Network.requestWillBeSent', (e) => {
      const prev = byId.get(e.requestId);
      if (prev && e.redirectResponse) {
        prev.hop1Ms = Math.round((e.timestamp - prev.ts) * 1000);
        prev.redirectStatus = e.redirectResponse.status;
        prev.redirectFromCache = Boolean(e.redirectResponse.fromDiskCache || e.redirectResponse.fromPrefetchCache);
        prev.redirectCacheControl = e.redirectResponse.headers['cache-control'] || e.redirectResponse.headers['Cache-Control'] || '';
        prev.hop1NewConnection = !e.redirectResponse.connectionReused;
        prev.protocol = e.redirectResponse.protocol;
        prev.connectionId = e.redirectResponse.connectionId;
        prev.location = e.request.url;
        return;
      }
      const entry = { id: e.requestId, url: e.request.url, wall: e.wallTime * 1000, ts: e.timestamp, priority: e.request.initialPriority, mode: e.request.headers.Origin ? 'cors' : 'no-cors' };
      byId.set(e.requestId, entry);
      log.push(entry);
    });
    cdp.on('Network.responseReceived', (e) => {
      const entry = byId.get(e.requestId);
      if (!entry || entry.hop1Ms != null) return;
      entry.status = e.response.status;
      entry.protocol = e.response.protocol;
      entry.connectionId = e.response.connectionId;
      entry.newConnection = !e.response.connectionReused;
      entry.fromCache = Boolean(e.response.fromDiskCache);
      entry.cacheControl = e.response.headers['cache-control'] || '';
      entry.headersMs = Math.round((e.timestamp - entry.ts) * 1000);
    });
    cdp.on('Network.resourceChangedPriority', (e) => {
      const entry = byId.get(e.requestId);
      if (entry) entry.priorityLater = e.newPriority;
    });
    cdp.on('Network.loadingFailed', (e) => {
      const entry = byId.get(e.requestId);
      if (entry) entry.failed = e.errorText;
    });
    cdp.on('Network.loadingFinished', (e) => {
      const entry = byId.get(e.requestId);
      if (entry) entry.doneMs = Math.round((e.timestamp - entry.ts) * 1000);
    });

    const caa = (entry) => entry.url.startsWith('https://coverartarchive.org/');
    const short = (url) => url.replace(/^https:\/\/coverartarchive\.org\/release-group\/([0-9a-f]{8})[0-9a-f-]+\//, 'caa/$1/');
    const print = (title, since, entries) => {
      console.log(`\n## ${title}`);
      for (const e of entries) {
        console.log([
          `+${String(Math.round(e.wall - since)).padStart(5)}ms`,
          e.mode.padEnd(7),
          `${e.priority}${e.priorityLater ? `->${e.priorityLater}` : ''}`.padEnd(14),
          short(e.url).padEnd(26),
          e.hop1Ms != null ? `hop1 ${e.hop1Ms}ms ${e.redirectStatus} ${e.protocol} conn#${e.connectionId}${e.hop1NewConnection ? ' new-conn' : ' reused-conn'}${e.redirectFromCache ? ' FROM-CACHE' : ' from-network'} cache-control="${e.redirectCacheControl}"`
            : e.status ? `${e.status} in ${e.headersMs}ms ${e.protocol} conn#${e.connectionId}${e.newConnection ? ' new-conn' : ' reused-conn'}${e.fromCache ? ' FROM-CACHE' : ' from-network'}`
              : (e.failed ? `failed: ${e.failed}` : ''),
        ].join('  '));
      }
    };

    // 1. The collection grid, as the app opens.
    const t0 = Date.now();
    await page.goto(`${APP}#collection`);
    await wait(4000);
    print('Collection grid (page load)', t0, log.filter(caa));

    // 2. The random pick, three times, with the page warmed up.
    await page.click('.tabs a[href="#random"]');
    await wait(500);
    const picks = [];
    async function pick(format) {
      if (format != null) await page.selectOption('#random-format', format);
      const from = log.length;
      await page.evaluate(() => { window.__marks = []; });
      const clickAt = await page.evaluate(() => new Promise((resolve) => {
        const btn = document.querySelector('#spin-btn');
        btn.addEventListener('click', () => resolve(performance.timeOrigin + performance.now()), { capture: true, once: true });
        btn.click();
      }));
      await wait(3000);
      const title = await page.locator('#spin-meta .pick-title').innerText();
      const marks = await page.evaluate(() => window.__marks);
      const entries = log.slice(from).filter(caa);
      print(`Pick: ${title}${format ? ` (forced with format ${format})` : ''}`, clickAt, entries);
      for (const m of marks) console.log(`   mark +${Math.round(m.at - clickAt)}ms ${m.what} loading=${m.loading} ${short(m.src)}`);
      const lg = entries.find((e) => e.url.endsWith('front-1200'));
      const color = entries.find((e) => e.url.endsWith('front-250'));
      const inserted = marks.find((m) => m.what === 'lg img inserted');
      picks.push({
        title,
        lgRequestMs: lg ? Math.round(lg.wall - clickAt) : null,
        lgAfterInsertMs: lg && inserted ? Math.round(lg.wall - inserted.at) : null,
        colorRequestMs: color ? Math.round(color.wall - clickAt) : null,
        hop1Ms: lg ? lg.hop1Ms : null,
        hop1FromCache: lg ? lg.redirectFromCache : null,
      });
    }
    await pick('Double LP'); // Kid A
    await pick('LP'); // OK Computer
    await pick('Double LP'); // Kid A again: does the browser reuse anything?

    // 3. A same-page repeat of a cover URL the page already asked for, through a fresh <img>.
    const from = log.length;
    const again = await page.evaluate(() => new Promise((resolve) => {
      const img = new Image();
      const start = performance.timeOrigin + performance.now();
      img.onload = img.onerror = () => resolve(start);
      img.src = 'https://coverartarchive.org/release-group/e75c0549-ad55-39e3-8025-c72c5d4a3c5d/front-1200';
    }));
    await wait(1500);
    print('Same 1200 URL again, fresh <img>', again, log.slice(from).filter(caa));

    // 4. Hop 1 alone, from the page: fetch without following the redirect, one at a time.
    //    This is the lookup cost a browser pays per cover, without the sandbox's blocked hop 2.
    const probeFrom = log.length;
    const probeAt = Date.now();
    const probe = await page.evaluate(async (ids) => {
      const out = [];
      for (const id of ids) {
        for (const size of [250, 1200]) {
          const start = performance.now();
          const res = await fetch(`https://coverartarchive.org/release-group/${id}/front-${size}`, { redirect: 'manual' });
          out.push({ id: id.slice(0, 8), size, type: res.type, ms: Math.round(performance.now() - start) });
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      return out;
    }, RECORDS.map((r) => r.releaseGroupId));
    print('Hop 1 only, fetch with redirect: manual, one at a time', probeAt, log.slice(probeFrom).filter(caa));
    console.log(JSON.stringify(probe));

    // 5. CPU side, on this machine: how big the sleeve is drawn, how long a JPEG takes to decode at
    //    each Cover Art Archive size, and how long the app's color sampling takes on each.
    //    The JPEGs are made in the page (a gradient with noise), so no network is involved.
    const appSource = require('fs').readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
    const mainColorSource = appSource.match(/ {2}function mainColor\(img\) \{[\s\S]*?\n {2}\}\n/)[0];
    const cpu = await page.evaluate(async (source) => {
      // eslint-disable-next-line no-new-func
      const mainColor = new Function(`${source}; return mainColor;`)();
      const sleeve = document.querySelector('#spin-sleeve').getBoundingClientRect();
      const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
      const out = { sleeveCssPx: Math.round(sleeve.width), devicePixelRatio, sizes: {} };
      for (const size of [250, 500, 1200]) {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, size, size);
        gradient.addColorStop(0, '#c0392b');
        gradient.addColorStop(1, '#2c3e50');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);
        const noise = ctx.getImageData(0, 0, size, size);
        for (let i = 0; i < noise.data.length; i += 4) {
          const n = (Math.random() - 0.5) * 40;
          noise.data[i] += n;
          noise.data[i + 1] += n;
          noise.data[i + 2] += n;
        }
        ctx.putImageData(noise, 0, 0);
        const url = canvas.toDataURL('image/jpeg', 0.85);
        const decodes = [];
        const samples = [];
        for (let run = 0; run < 9; run += 1) {
          const img = new Image();
          img.src = `${url}#${run}`;
          const start = performance.now();
          await img.decode();
          decodes.push(performance.now() - start);
          const sampleStart = performance.now();
          mainColor(img);
          samples.push(performance.now() - sampleStart);
        }
        out.sizes[size] = { jpegKB: Math.round((url.length * 3) / 4 / 1024), decodeMs: +median(decodes).toFixed(1), colorSampleMs: +median(samples).toFixed(1) };
      }
      return out;
    }, mainColorSource);
    console.log('\n## CPU side (this machine)');
    console.log(JSON.stringify(cpu, null, 2));

    const allCaa = log.filter(caa);
    console.log('\n## Summary');
    console.log(JSON.stringify({
      caaRequests: allCaa.length,
      hop1Ms: allCaa.map((e) => e.hop1Ms).filter((v) => v != null),
      probeMs: probe.map((p) => p.ms),
      hop1FromCache: allCaa.filter((e) => e.redirectFromCache).length,
      picks,
      archiveOrg: process.env.ALLOW_ARCHIVE ? 'allowed' : 'aborted locally',
    }, null, 2));
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
