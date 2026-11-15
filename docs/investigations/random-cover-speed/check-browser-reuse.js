// Checks when Chromium reuses a cover it already loaded, with no outside network at all.
//
//   node docs/investigations/random-cover-speed/check-browser-reuse.js
//
// A local "cover server" copies the headers measured on coverartarchive.org: a 307 with no
// Cache-Control, Access-Control-Allow-Origin: *, text/plain. The 307 points at an image on the same
// local server. archive.org's real cache headers could not be read from the session this was
// written in, so the image is served two ways: with Cache-Control: max-age=86400, and with no
// cache headers at all. The script counts how often each URL reaches the server.
//
// This answers browser questions only (what gets reused, and when). It says nothing about how
// fast archive.org is.
'use strict';

const http = require('http');
const { chromium } = require('playwright');

// A valid 1x1 PNG. Its size doesn't matter here, only how often it is fetched.
const IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

function startServer() {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.set(url.pathname, (hits.get(url.pathname) || 0) + 1);
    const m = url.pathname.match(/^\/(cached|uncached)\/rg\/(\w+)\/front-(\d+)$/);
    if (m) {
      // Same headers as the real coverartarchive.org 307.
      res.writeHead(307, { Location: `/${m[1]}/dl/${m[2]}_thumb${m[3]}.jpg`, 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end('See other');
      return;
    }
    const d = url.pathname.match(/^\/(cached|uncached)\/dl\//);
    if (d) {
      const headers = { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' };
      if (d[1] === 'cached') headers['Cache-Control'] = 'max-age=86400';
      // Covers whose id starts with "slow" take 800 ms, so a second load can start while the first is in flight.
      setTimeout(() => {
        res.writeHead(200, headers);
        res.end(IMAGE);
      }, /\/dl\/slow/.test(url.pathname) ? 800 : 0);
      return;
    }
    if (url.pathname === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>reuse</title><body></body>');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port })));
}

async function main() {
  const { server, hits, port } = await startServer();
  // The page is on 127.0.0.1 and the covers on localhost, so the covers are cross-origin like the real ones.
  const page0 = `http://127.0.0.1:${port}/page`;
  const coverBase = `http://localhost:${port}`;
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const variant of ['cached', 'uncached']) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(page0);
      const load = (src, opts = {}) => page.evaluate(({ src, opts }) => new Promise((resolve) => {
        const img = opts.detached ? new Image() : document.createElement('img');
        if (opts.cors) img.crossOrigin = 'anonymous';
        img.onload = () => resolve('load');
        img.onerror = () => resolve('error');
        img.src = src;
        if (!opts.detached) document.body.append(img);
      }), { src, opts });
      const count = (id, size) => ({
        redirect: hits.get(`/${variant}/rg/${id}/front-${size}`) || 0,
        image: hits.get(`/${variant}/dl/${id}_thumb${size}.jpg`) || 0,
      });
      const step = async (name, fn, id, size) => {
        const before = count(id, size);
        const outcome = await fn();
        const after = count(id, size);
        results.push({ variant, step: name, outcome, redirectHits: after.redirect - before.redirect, imageHits: after.image - before.image });
      };
      const u = (id, size) => `${coverBase}/${variant}/rg/${id}/front-${size}`;

      // A. The grid loads a 500px cover, then the random pick shows the same record.
      await step('A1 grid <img> 500, first load', () => load(u('a', 500)), 'a', 500);
      await step('A2 same page, new <img> 500 (reuse the grid cover)', () => load(u('a', 500)), 'a', 500);
      await step('A3 same page, new <img> 1200 (what the pick does today)', () => load(u('a', 1200)), 'a', 1200);

      // B. Preload with a detached Image, then show it in an <img> with the same src.
      await step('B1 preload: detached new Image() 1200', () => load(u('b', 1200), { detached: true }), 'b', 1200);
      await step('B2 then <img> 1200 with the same src', () => load(u('b', 1200)), 'b', 1200);

      // B3. The tap comes while the preload is still on its way: does the <img> wait for it or start again?
      await step('B3 preload still in flight, then <img> 1200', () => page.evaluate((src) => new Promise((resolve) => {
        const preload = new Image();
        preload.src = src;
        setTimeout(() => {
          const img = document.createElement('img');
          img.onload = () => resolve('load');
          img.onerror = () => resolve('error');
          img.src = src;
          document.body.append(img);
        }, 200);
      }), u('slowb', 1200)), 'slowb', 1200);

      // C. The color read loads in CORS mode. Does a no-cors <img> reuse it, and the other way round?
      await step('C1 color read: detached CORS Image 500', () => load(u('c', 500), { detached: true, cors: true }), 'c', 500);
      await step('C2 then no-cors <img> 500', () => load(u('c', 500)), 'c', 500);
      await step('C3 then CORS Image 500 again', () => load(u('c', 500), { detached: true, cors: true }), 'c', 500);

      // D. After a reload: only the HTTP cache is left.
      await page.reload();
      await step('D1 after reload, <img> 500 loaded before reload', () => load(u('a', 500)), 'a', 500);
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log('variant   redirect image  outcome  step');
  for (const r of results) {
    console.log(`${r.variant.padEnd(9)} ${String(r.redirectHits).padStart(8)} ${String(r.imageHits).padStart(5)}  ${r.outcome.padEnd(7)}  ${r.step}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
