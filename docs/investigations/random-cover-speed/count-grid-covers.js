// Counts how many 500px covers the collection grid loads on a phone before any scrolling.
// Those are the covers the random pick can show at once. No outside network: covers are answered
// locally with a tiny image, and Google Fonts is answered with an empty stylesheet.
//
//   node docs/investigations/random-cover-speed/count-grid-covers.js [records]
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const PAGE = pathToFileURL(path.resolve(__dirname, '../../../index.html')).href;
const COUNT = Number(process.argv[2] || 300);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

async function main() {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const covers = new Set();
    await context.route('https://coverartarchive.org/**', (route) => {
      covers.add(route.request().url());
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    });
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await context.addInitScript((count) => {
      if (localStorage.getItem('recordcatalog.records.v1')) return;
      const records = [];
      for (let i = 0; i < count; i++) {
        records.push({ id: `r${i}`, artist: `Artist ${String(i).padStart(3, '0')}`, title: `Album ${i}`, year: 1970 + (i % 50), format: 'LP',
          notes: '', releaseGroupId: `rg-${i}`, addedAt: '2026-01-01T00:00:00.000Z' });
      }
      localStorage.setItem('recordcatalog.records.v1', JSON.stringify(records));
    }, COUNT);
    const page = await context.newPage();
    await page.goto(`${PAGE}#collection`);
    await page.waitForTimeout(3000);
    const shown = await page.locator('#collection-list .tile').count();
    const onScreen = await page.locator('#collection-list .tile').evaluateAll((tiles) => tiles.filter((t) => t.getBoundingClientRect().top < innerHeight).length);
    console.log(JSON.stringify({ records: COUNT, tilesInPage: shown, tilesOnScreen: onScreen, coversLoadedBeforeScrolling: covers.size }));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
