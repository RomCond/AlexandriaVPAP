/*
 * Drives the real page in Chromium with Playwright.
 * MusicBrainz and the Cover Art Archive are answered with fixed sample data so the test
 * is repeatable and runs offline. Set SCREENSHOT_DIR to save screenshots along the way.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  chromium = null;
}

const PAGE_URL = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const SHOTS = process.env.SCREENSHOT_DIR;

const credit = (name, id) => [{ name, artist: { id, name } }];
const rg = (id, title, date, primaryType = 'Album', secondaryTypes = []) => ({
  id, title, 'first-release-date': date, 'primary-type': primaryType, 'secondary-types': secondaryTypes,
});

const DISCOGRAPHIES = {
  'a-radiohead': [
    rg('rg-pablo', 'Pablo Honey', '1993-02-22'),
    rg('rg-bends', 'The Bends', '1995-03-13'),
    rg('rg-okc', 'OK Computer', '1997-05-21'),
    rg('rg-kida', 'Kid A', '2000-10-02'),
    rg('rg-amnesiac', 'Amnesiac', '2001-06-04'),
    rg('rg-creep', 'Creep', '1992-09-21', 'Single'),
    rg('rg-wrong', 'I Might Be Wrong: Live Recordings', '2001-11-12', 'Album', ['Live']),
    rg('rg-glasto', 'Live at Glastonbury 1997', '1997-06-28', 'Album', ['Live']),
  ],
  'a-portishead': [
    rg('rg-dummy', 'Dummy', '1994-08-22'),
    rg('rg-portishead', 'Portishead', '1997-09-29'),
    rg('rg-third', 'Third', '2008-04-28'),
  ],
  'a-takanaka': [
    rg('rg-seychelles', 'Seychelles', '1976-07-25'),
    rg('rg-goblins', '虹伝説 THE RAINBOW GOBLINS', '1981-04-25'),
  ],
};

// The artists' releases, as browsing them with inc=media+release-groups returns them. Pablo Honey
// only has a bootleg LP and a CD, and the live album only a flexi-disc, so neither counts as having
// a vinyl pressing. The Bends has a deluxe edition on vinyl; Kid A's is CD only, so it only shows
// with Vinyl only turned off. The Glastonbury recording only exists as a bootleg, so it isn't
// among these at all, and only loads once Vinyl only is turned off.
const pressing = (artistId, id, groupId, format, extra = {}) => {
  const group = DISCOGRAPHIES[artistId].find((g) => g.id === groupId);
  const formats = Array.isArray(format) ? format : [format];
  return { id, status: 'Official', title: group.title, date: group['first-release-date'], 'release-group': group, media: formats.map((f) => ({ format: f })), ...extra };
};
const RELEASES = {
  'a-radiohead': [
    pressing('a-radiohead', 'rel-pablo-boot', 'rg-pablo', '12" Vinyl', { status: 'Bootleg' }),
    pressing('a-radiohead', 'rel-pablo-cd', 'rg-pablo', 'CD'),
    pressing('a-radiohead', 'rel-bends', 'rg-bends', '12" Vinyl'),
    pressing('a-radiohead', 'rel-bends-dlx', 'rg-bends', ['12" Vinyl', '12" Vinyl'], { disambiguation: 'collector’s deluxe edition', date: '2009-03-24' }),
    pressing('a-radiohead', 'rel-okc', 'rg-okc', '12" Vinyl'),
    pressing('a-radiohead', 'rel-okc-2', 'rg-okc', '12" Vinyl'),
    pressing('a-radiohead', 'rel-kida', 'rg-kida', '10" Vinyl'),
    pressing('a-radiohead', 'rel-kida-dlx', 'rg-kida', 'CD', { title: 'Kid A (Expanded Edition)', date: '2016-05-06' }),
    pressing('a-radiohead', 'rel-amnesiac-10', 'rg-amnesiac', '10" Vinyl'),
    pressing('a-radiohead', 'rel-amnesiac', 'rg-amnesiac', '12" Vinyl'),
    pressing('a-radiohead', 'rel-amnesiac-promo', 'rg-amnesiac', '12" Vinyl', { status: 'Promotion' }),
    pressing('a-radiohead', 'rel-creep', 'rg-creep', '7" Vinyl'),
    pressing('a-radiohead', 'rel-wrong', 'rg-wrong', 'Flexi-disc'),
    pressing('a-radiohead', 'rel-glasto', 'rg-glasto', '12" Vinyl', { status: 'Bootleg' }),
  ],
  'a-portishead': ['rg-dummy', 'rg-portishead', 'rg-third'].map((id) => pressing('a-portishead', `rel-${id}`, id, '12" Vinyl')),
};

// Answers to the album lookups for an imported list, by the title searched for. "Weezer" is two
// different albums, so it can't be matched until the title says which.
const found = (id, title, date, artist, artistId, primaryType = 'Album') => ({ ...rg(id, title, date, primaryType), 'artist-credit': credit(artist, artistId) });
const ALBUM_LOOKUPS = {
  Dumy: [found('rg-dummy', 'Dummy', '1994-08-22', 'Portishead', 'a-portishead')],
  'Kid A': [found('rg-kida', 'Kid A', '2000-10-02', 'Radiohead', 'a-radiohead')],
  Creep: [found('rg-creep-album', 'Creep', '2009', 'Radiohead', 'a-radiohead'), found('rg-creep', 'Creep', '1992-09-21', 'Radiohead', 'a-radiohead', 'Single')],
  Weezer: [found('rg-blue', 'Weezer', '1994-05-10', 'Weezer', 'a-weezer'), found('rg-green', 'Weezer', '2001-05-15', 'Weezer', 'a-weezer')],
  'Weezer (Blue Album)': [found('rg-blue', 'Weezer (Blue Album)', '1994-05-10', 'Weezer', 'a-weezer')],
};

function fakeMusicBrainz(url) {
  const params = url.searchParams;
  const query = params.get('query') || '';
  if (url.pathname === '/ws/2/release-group' && params.get('artist')) {
    const groups = DISCOGRAPHIES[params.get('artist')] || [];
    return { 'release-group-count': groups.length, 'release-group-offset': 0, 'release-groups': groups };
  }
  if (url.pathname === '/ws/2/release-group' && query.includes('releasegroup:"')) {
    const title = /releasegroup:"([^"]+)"/.exec(query)[1];
    return { 'release-groups': ALBUM_LOOKUPS[title] || [] };
  }
  if (url.pathname === '/ws/2/release-group' && query.includes('NOT secondarytype:')) {
    const albums = (DISCOGRAPHIES[/arid:"([^"]+)"/.exec(query)[1]] || []).filter((g) => g['primary-type'] === 'Album' && !g['secondary-types'].length);
    return { count: albums.length, 'release-groups': albums };
  }
  if (url.pathname === '/ws/2/release' && params.get('artist')) {
    const statuses = (params.get('status') || '').split('|');
    const releases = (RELEASES[params.get('artist')] || []).filter((r) => !params.get('status') || statuses.includes(r.status.toLowerCase()));
    return { 'release-count': releases.length, 'release-offset': 0, releases };
  }
  if (url.pathname === '/ws/2/release' && query.includes('takanaka')) {
    // MusicBrainz files him as 高中正義, and the sleeve credits Masayoshi Takanaka.
    const group = { id: 'rg-goblins', title: '虹伝説 THE RAINBOW GOBLINS', 'primary-type': 'Album', 'secondary-types': [] };
    return {
      releases: [{
        id: 'rel-goblins', status: 'Official', score: 100, title: group.title, date: '1981-04-25', 'release-group': group,
        'artist-credit': [{ name: 'Masayoshi Takanaka', artist: { id: 'a-takanaka', name: '高中正義' } }], media: [{ format: '12" Vinyl' }],
      }],
    };
  }
  if (url.pathname === '/ws/2/release' && !query.startsWith('barcode:')) {
    // Typed search: vinyl pressings, grouped into albums by the app. Two pressings of OK Computer
    // show as one result; the CD and the bootleg are left out.
    const pressing = (id, group, extra = {}) => ({
      id, status: 'Official', score: 100, title: group.title, date: group.date,
      'release-group': { id: group.id, title: group.title, 'primary-type': 'Album', 'secondary-types': group.secondary || [] },
      'artist-credit': credit('Radiohead', 'a-radiohead'), media: [{ format: '12" Vinyl' }], ...extra,
    });
    const okc = { id: 'rg-okc', title: 'OK Computer', date: '1997-06-16' };
    const oknotok = { id: 'rg-oknotok', title: 'OK Computer OKNOTOK 1997 2017', date: '2017-06-23', secondary: ['Compilation'] };
    return {
      releases: [
        pressing('rel-okc-1', okc),
        pressing('rel-okc-2', okc, { date: '2016-05-06' }),
        pressing('rel-oknotok', oknotok, { score: 90, media: [{ format: '12" Vinyl' }, { format: '12" Vinyl' }, { format: '12" Vinyl' }] }),
        pressing('rel-okc-cd', okc, { media: [{ format: 'CD' }] }),
        pressing('rel-boot', { id: 'rg-boot', title: 'OK Computer Live', date: '1998' }, { status: 'Bootleg' }),
      ],
    };
  }
  if (url.pathname === '/ws/2/release' && query === 'barcode:5000000000045') {
    return {
      releases: [{
        id: 'rel-creep-7', title: 'Creep', date: '1992-09-21', status: 'Official', 'artist-credit': credit('Radiohead', 'a-radiohead'),
        'release-group': { id: 'rg-creep', 'primary-type': 'Single' }, media: [{ format: '7" Vinyl' }],
      }],
    };
  }
  if (url.pathname === '/ws/2/release' && query === 'barcode:0724384260927') {
    return {
      releases: [{
        id: 'rel-pablo-cd', title: 'Pablo Honey', 'artist-credit': credit('Radiohead', 'a-radiohead'),
        'release-group': { id: 'rg-pablo', 'primary-type': 'Album' }, media: [{ format: 'CD' }],
      }],
    };
  }
  if (url.pathname === '/ws/2/release' && query.startsWith('barcode:')) {
    return {
      releases: [{
        id: 'rel-kida',
        title: 'Kid A',
        date: '2000-10-02',
        'artist-credit': credit('Radiohead', 'a-radiohead'),
        'release-group': { id: 'rg-kida', 'primary-type': 'Album' },
        media: [{ format: '12" Vinyl' }, { format: '12" Vinyl' }],
      }],
    };
  }
  if (url.pathname === '/ws/2/artist') {
    return {
      artists: [
        { id: 'a-portishead', name: 'Portishead', type: 'Group', country: 'GB', disambiguation: 'Bristol trip hop band', score: 100 },
        { id: 'a-tribute', name: 'Portishead Tribute Band', type: 'Group', score: 60 },
      ],
    };
  }
  return { error: 'not in fixture' };
}

const coverHue = (id) => [...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 360;

// The rgb() a sample cover's background color comes out as.
function coverRgb(id) {
  const h = coverHue(id) / 360;
  const s = 0.45;
  const l = 0.45;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [h + 1 / 3, h, h - 1 / 3].map((t) => Math.round(channel(t) * 255));
}

function fakeCover(id) {
  const hue = coverHue(id);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="hsl(${hue} 45% 45%)"/><text x="8" y="90" font-family="Georgia" font-size="12" fill="#fff">${id}</text></svg>`;
}

// `setup` runs on the browser context before the page opens, as fakeSyncService's install does.
async function openApp(browser, { setup, ...options } = {}) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, ...options });
  // Nothing here reaches Firebase. A request to it is recorded and stopped.
  const firebaseCalls = [];
  await context.route(/^https:\/\/(www\.gstatic\.com\/firebasejs\/|[^/]+\.firebaseapp\.com\/|(firestore|identitytoolkit|securetoken)\.googleapis\.com\/)/, (route) => {
    firebaseCalls.push(route.request().url());
    route.abort();
  });
  const mbCalls = [];
  const hold = { browse: null };
  await context.route('https://musicbrainz.org/**', async (route) => {
    const url = new URL(route.request().url());
    mbCalls.push(url);
    if (hold.browse && url.pathname === '/ws/2/release' && url.searchParams.get('artist')) await hold.browse;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(fakeMusicBrainz(url)),
    });
  });
  // Some covers exist, the rest 404 so the vinyl placeholder shows.
  const coverCalls = [];
  await context.route('https://coverartarchive.org/**', (route) => {
    coverCalls.push(route.request().url());
    const id = route.request().url().split('/release-group/')[1].split('/')[0];
    if (['rg-okc', 'rg-kida', 'rg-dummy', 'rg-pablo'].includes(id)) {
      route.fulfill({ status: 200, contentType: 'image/svg+xml', body: fakeCover(id), headers: { 'Access-Control-Allow-Origin': '*' } });
    } else {
      route.fulfill({ status: 404, body: '' });
    }
  });
  // Fonts come from Google Fonts in real use; an empty stylesheet keeps the test offline.
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  if (setup) await setup(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) errors.push(msg.text());
  });
  await page.goto(PAGE_URL);
  return { context, page, errors, mbCalls, coverCalls, hold, firebaseCalls };
}

/*
 * A sync service that stands in for Firebase, given to the page as RC.syncService. It plays one
 * Firebase project: each account keeps its own buckets, and access records decide who syncs, as
 * firestore.rules does, with fake.owner as the owner. `install(account)` sets up a browser context as
 * a device that signs in as that account. Every device installed from the same fake shares the
 * project. Set `fail` to a Firebase error code to make every call after sign-in fail with it.
 * `calls` lists every call any device made.
 */
const OWNER = { id: 'test-account-id', name: 'Site Owner', email: 'owner@example.com' };
const ANA = { id: 'ana-account-id', name: 'Ana Lima', email: 'ana@example.com' };
const BEN = { id: 'ben-account-id', name: 'Ben Ortiz', email: 'ben@example.com' };

function fakeSyncService() {
  const fake = { owner: OWNER, buckets: new Map(), access: new Map(), fail: null, calls: [] };
  const bucketsOf = (id) => fake.buckets.get(id) || fake.buckets.set(id, new Map()).get(id);
  const moves = { pending: ['approved', 'denied'], approved: ['denied'] };
  const denied = { error: 'permission-denied' };

  function answer(account, action, arg) {
    fake.calls.push(action);
    if (action === 'signIn') return { user: account };
    if (fake.fail) return { error: fake.fail };
    const isOwner = account.id === OWNER.id;
    const mine = fake.access.get(account.id);
    const syncs = isOwner || (mine && mine.status === 'approved');
    if (action === 'read') return syncs ? { buckets: Object.fromEntries(bucketsOf(account.id)) } : denied;
    if (action === 'write') {
      if (!syncs) return denied;
      for (const [id, text] of Object.entries(arg)) bucketsOf(account.id).set(id, text);
      return {};
    }
    if (action === 'list') return isOwner ? { people: [...fake.access.values()] } : denied;
    if (action === 'mine') return { access: mine || null };
    if (action === 'request') {
      if (mine) return denied;
      fake.access.set(account.id, { id: account.id, name: account.name, email: account.email, status: 'pending', requestedAt: new Date().toISOString(), decidedAt: null });
      return {};
    }
    if (action === 'withdraw') {
      if (!mine || mine.status !== 'pending') return denied;
      fake.access.delete(account.id);
      return {};
    }
    if (action === 'decide') {
      const record = fake.access.get(arg.id);
      if (!isOwner || !record || !(moves[record.status] || []).includes(arg.status)) return denied;
      fake.access.set(arg.id, { ...record, status: arg.status, decidedAt: new Date().toISOString() });
      return {};
    }
    throw new Error(`fake sync has no ${action}`);
  }

  fake.install = (account = OWNER) => async (context) => {
    await context.exposeFunction('fakeSync', (action, arg) => answer(account, action, arg));
    await context.addInitScript(() => {
      let user = null;
      const watchers = [];
      const tell = () => watchers.forEach((watcher) => watcher(user));
      const call = async (action, arg) => {
        const reply = await window.fakeSync(action, arg);
        if (reply.error) throw Object.assign(new Error(`Fake sync: ${reply.error}`), { code: reply.error });
        return reply;
      };
      window.RC = {
        syncService: {
          watchUser(callback) {
            watchers.push(callback);
            callback(user);
          },
          async signIn() {
            user = (await call('signIn')).user;
            tell();
            return user;
          },
          async signOut() {
            user = null;
            tell();
          },
          async exchange(change) {
            const stored = new Map(Object.entries((await call('read')).buckets));
            await call('write', Object.fromEntries(change(stored)));
          },
          listAccess: async () => (await call('list')).people,
          readAccess: async () => (await call('mine')).access,
          requestAccess: () => call('request'),
          withdrawAccess: () => call('withdraw'),
          decideAccess: (id, status) => call('decide', { id, status }),
        },
      };
    });
  };
  return fake;
}

// Opens the sync dialog from the header.
async function openSync(page) {
  await page.click('#sync-button');
  await page.locator('#sync-dialog[open]').waitFor();
}

const syncName = (page) => page.locator('#sync-button').getAttribute('aria-label');

async function addByHand(page, artist, title) {
  await openTab(page, 'add');
  const form = page.locator('#manual-form');
  if (!(await form.isVisible())) await page.click('#manual-add summary');
  await form.locator('[name=artist]').fill(artist);
  await form.locator('[name=title]').fill(title);
  await form.locator('button[type=submit]').click();
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

const text = (page, selector) => page.locator(selector).innerText();

// Tabs only change the address; the app switches screens on the hashchange that follows,
// so wait for that before reading anything.
async function openTab(page, route) {
  await page.click(route === 'wishlist' ? '.segmented a[href="#wishlist"]' : `.tabs a[href="#${route}"]`);
  await page.waitForFunction((r) => {
    const view = r === 'wishlist' ? 'collection' : r;
    const heading = { collection: 'Your collection', wishlist: 'Your wishlist' }[r];
    return location.hash === `#${r}`
      && !document.querySelector(`#view-${view}`).hidden
      && (!heading || document.querySelector('#collection-heading').textContent === heading);
  }, route);
}

// The discography shows as soon as its studio albums are in, then again as each page of releases
// arrives. This waits for the last of it.
const discoReady = (page) => page.locator('#disco-panel[aria-busy="false"]').waitFor();

async function assertNoJunkText(page, where) {
  const shown = await page.locator('main').innerText();
  assert.doesNotMatch(shown, /\b(null|undefined|NaN)\b/, `stray placeholder text on ${where}`);
}

test('add, browse, edit, shuffle and find missing records', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const { context, page, errors, mbCalls, coverCalls, hold } = await openApp(browser);

    // Empty shelf
    assert.ok(await page.locator('#collection-empty').isVisible());
    await shot(page, '01-empty');

    // Results show up while typing part of a name, after one request rather than one per key
    await openTab(page, 'add');
    const searchBox = page.locator('#search-form [name=q]');
    const callsBeforeTyping = mbCalls.length;
    await searchBox.pressSequentially('radiohead ok comp', { delay: 40 });
    await page.locator('#search-results .result').first().waitFor();
    const typedSearches = mbCalls.slice(callsBeforeTyping);
    assert.equal(typedSearches.length, 1, `typing sent ${typedSearches.length} searches`);
    assert.match(typedSearches[0].searchParams.get('query'), /artist:\(radiohead ok comp comp\*\)/);
    assert.equal(await page.locator('#search-results .result').count(), 2);
    assert.equal(await text(page, '#search-results .artist-row'), 'Radiohead · Artist · See all albums', 'the artist typed gets a row above the albums');
    await page.locator('#search-results .result').first().getByRole('button', { name: 'Add' }).click();
    await page.locator('#toast.show', { hasText: 'Added OK Computer' }).waitFor();
    assert.equal(await text(page, '#nav-count'), '1');
    // Only one copy: an album you have can't be added again
    const addedButton = page.locator('#search-results .result').first().getByRole('button');
    assert.equal(await addedButton.innerText(), 'In collection');
    assert.ok(await addedButton.isDisabled());
    await shot(page, '02-search');

    // The same box takes a barcode, and the lookup picks the format from the release
    await searchBox.fill('0 724352 775324');
    await searchBox.press('Enter');
    await page.locator('#search-results .result', { hasText: 'Kid A' }).waitFor();
    assert.match(await text(page, '#search-results .result'), /2 x 12" Vinyl/);
    await page.locator('#search-results .result').getByRole('button', { name: 'Add' }).click();
    assert.equal(mbCalls.at(-1).searchParams.get('query'), 'barcode:0724352775324');

    // The catalog is vinyl only: a CD's barcode is turned away, and CD and Cassette aren't formats
    await searchBox.fill('0724384260927');
    await searchBox.press('Enter');
    await page.locator('#search-status', { hasText: 'That barcode is for a CD or cassette, not a vinyl record.' }).waitFor();
    assert.equal(await page.locator('#search-results .result').count(), 0);
    assert.deepEqual(await page.locator('#add-format option').allTextContents(), ['LP', 'Double LP', 'EP', '12" single', 'Box set', 'Other']);
    assert.deepEqual(await page.locator('#filter-format option').allTextContents(), ['All formats', ...['LP', 'Double LP', 'EP', '12" single', 'Box set', 'Other']]);

    // 45s and 10" records are off by default: a 45's barcode explains how to include them,
    // and turning them on searches again and adds 45 and 10" to the format menus
    await searchBox.fill('5000000000045');
    await searchBox.press('Enter');
    await page.locator('#search-status', { hasText: 'That barcode is for a 45 or a 10" record.' }).waitFor();
    await page.check('#small-records');
    await page.locator('#search-results .result', { hasText: 'Creep' }).waitFor();
    assert.match(await text(page, '#search-results .result'), /7" Vinyl/);
    assert.deepEqual(await page.locator('#add-format option').allTextContents(), ['LP', 'Double LP', 'EP', '45', '10"', '12" single', 'Box set', 'Other']);
    await page.uncheck('#small-records');
    await page.locator('#search-status', { hasText: 'That barcode is for a 45 or a 10" record.' }).waitFor();
    assert.equal(await page.locator('#search-results .result').count(), 0);
    assert.deepEqual(await page.locator('#add-format option').allTextContents(), ['LP', 'Double LP', 'EP', '12" single', 'Box set', 'Other']);

    // Manual entry keeps the artist filled in for the next one
    await page.click('#manual-add summary');
    const manual = page.locator('#manual-form');
    await manual.locator('[name=artist]').fill('Radiohead');
    await manual.locator('[name=title]').fill('The Bends (Remastered)');
    await manual.locator('[name=year]').fill('1995');
    await manual.locator('button[type=submit]').click();
    assert.equal(await manual.locator('[name=artist]').inputValue(), 'Radiohead');
    assert.equal(await manual.locator('[name=title]').inputValue(), '');
    await manual.locator('[name=title]').fill('Live at the Astoria');
    await manual.locator('button[type=submit]').click();
    await manual.locator('[name=artist]').fill('Portishead');
    await manual.locator('[name=title]').fill('Dummy');
    await manual.locator('button[type=submit]').click();
    assert.equal(await text(page, '#nav-count'), '5');

    // Typing in an album you already have is turned away, and the form keeps what you typed
    await manual.locator('[name=title]').fill('dummy');
    await manual.locator('button[type=submit]').click();
    await page.locator('#toast.show', { hasText: '"Dummy" is already in your collection.' }).waitFor();
    assert.equal(await text(page, '#nav-count'), '5');
    assert.equal(await manual.locator('[name=title]').inputValue(), 'dummy');

    // Collection: covers by default, under the first letter of the artist ("The" doesn't count)
    await openTab(page, 'collection');
    assert.equal(await text(page, '#collection-summary'), '5 records by 2 artists');
    assert.deepEqual(await page.locator('#collection-list .section-title').allTextContents(), ['P', 'R']);
    assert.deepEqual(await page.locator('#collection-list .tile-title').allTextContents(), ['Dummy', 'The Bends (Remastered)', 'OK Computer', 'Kid A', 'Live at the Astoria']);
    assert.equal(await page.locator('#view-switch [data-view=grid]').getAttribute('aria-pressed'), 'true');
    assert.ok(await page.locator('#az-rail').isHidden(), 'no A to Z for a short list');
    await shot(page, '03-collection');
    // Covers use the sharper 500px images
    assert.ok(coverCalls.some((url) => url.endsWith('/rg-okc/front-500')));
    assert.ok(!coverCalls.some((url) => url.endsWith('front-250')), 'no low-resolution covers');
    await page.fill('#filter-text', 'bends');
    assert.equal(await page.locator('#collection-list li').count(), 1);
    await page.fill('#filter-text', '');
    // Format and sort live behind Filter; sorting by year heads the list with decades
    assert.ok(await page.locator('#collection-filters').isHidden());
    await page.click('#filter-btn');
    await page.selectOption('#sort', 'year');
    assert.deepEqual(await page.locator('#collection-list .section-title').allTextContents(), ['1990s', '2000s', 'Year unknown']);
    await page.selectOption('#filter-format', 'Double LP');
    assert.deepEqual(await page.locator('#collection-list .tile-title').allTextContents(), ['Kid A']);
    assert.equal(await page.locator('#filter-btn .count').textContent(), '1', 'Filter shows a format is chosen');
    await page.selectOption('#filter-format', '');
    await page.selectOption('#sort', 'artist');
    await page.click('#filter-btn');
    // The list view, which the app remembers
    await page.click('#view-switch [data-view=list]');
    assert.match(await text(page, '#collection-list'), /Kid A\nRadiohead · 2000 · Double LP/);
    await page.reload();
    assert.equal(await page.locator('#view-switch [data-view=list]').getAttribute('aria-pressed'), 'true');
    await shot(page, '03-collection-list');

    // Edit, delete, undo
    await page.locator('.record', { hasText: 'Dummy' }).click();
    assert.ok(await page.locator('#edit-dialog').isVisible());
    const focused = () => page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
    assert.equal(await focused(), 'edit-heading', 'no text box is focused, so no cursor or phone keyboard pops up');
    await page.selectOption('#edit-form [name=format]', 'Box set');
    await page.fill('#edit-form [name=notes]', 'Found at a yard sale');
    await shot(page, '04-edit');
    await page.click('#edit-form button[value=save]');
    // The dialog's close event fires a moment after the click, so wait for the list to update.
    await page.locator('.record', { hasText: 'Dummy' }).filter({ hasText: 'Box set' }).waitFor();
    await page.locator('.record', { hasText: 'Dummy' }).click();
    await page.click('#edit-delete');
    assert.equal(await text(page, '#nav-count'), '4');
    await page.locator('#toast .toast-action').click();
    assert.equal(await text(page, '#nav-count'), '5');

    // Random pick, with an artist filter
    await openTab(page, 'random');
    await page.selectOption('#random-artist', { label: 'Portishead' });
    await page.click('#spin-btn');
    assert.equal(await text(page, '.pick-title'), 'Dummy');
    // No cover was found for Dummy (it was typed in), so the card takes its placeholder color
    const albumTint = () => page.locator('#view-random .random-card').evaluate((el) => el.classList.contains('has-album') && el.style.getPropertyValue('--album'));
    await page.waitForFunction(() => document.querySelector('#view-random .random-card').classList.contains('has-album'));
    assert.match(await albumTint(), /^hsl\(/);
    await page.selectOption('#random-artist', '');
    // Kid A is the only Double LP, and it has a cover. The list above already loaded its 500px cover,
    // so the pick shows that at once without asking for it again, then lays the 1200px cover over it.
    await page.selectOption('#random-format', 'Double LP');
    const kidA500 = () => coverCalls.filter((url) => url.endsWith('/rg-kida/front-500')).length;
    const kidA500Before = kidA500();
    assert.ok(kidA500Before > 0, 'the list loaded the 500px cover');
    await page.click('#spin-btn');
    assert.equal(await text(page, '.pick-title'), 'Kid A');
    assert.equal(await page.locator('#spin-sleeve img.shown[src$="/rg-kida/front-500"]').count(), 1, 'the 500px cover shows at once');
    await page.locator('#spin-sleeve img.shown[src$="/rg-kida/front-1200"]').waitFor();
    assert.equal(kidA500(), kidA500Before, 'the 500px cover came from memory');
    // Kid A has a cover, so the card fades down from the cover's main color
    await page.waitForFunction(() => document.querySelector('#view-random .random-card').style.getPropertyValue('--album').startsWith('rgb('));
    const [r, g, b] = (await albumTint()).match(/\d+/g).map(Number);
    const expected = coverRgb('rg-kida');
    assert.ok([r, g, b].every((v, i) => Math.abs(v - expected[i]) <= 3), `album color ${[r, g, b]} should match the cover ${expected}`);
    await shot(page, '05b-random-album-color');
    await page.selectOption('#random-format', '');
    const titles = new Set(['OK Computer', 'Kid A', 'The Bends (Remastered)', 'Live at the Astoria', 'Dummy']);
    const seen = [];
    for (let i = 0; i < 4; i++) {
      await page.click('#spin-btn');
      seen.push(await text(page, '.pick-title'));
    }
    assert.ok(seen.every((title) => titles.has(title)));
    assert.equal(new Set(seen).size, 4, `four picks in a row should not repeat: ${seen}`);
    await shot(page, '05-random');

    // Discography from a record in the collection: Radiohead already has a MusicBrainz id
    await openTab(page, 'collection');
    await page.locator('.record', { hasText: 'OK Computer' }).click();
    // The studio albums show at once. Until every release has been checked for vinyl, none says
    // "Vinyl not confirmed". Holding back the release browse keeps the page in that state.
    let letBrowseThrough;
    hold.browse = new Promise((resolve) => { letBrowseThrough = resolve; });
    await page.click('#edit-discography');
    await page.locator('#disco-panel[aria-busy="true"]').waitFor();
    assert.equal(await text(page, '#disco-name'), 'Radiohead');
    assert.equal(await text(page, '#disco-progress-text'), 'You have 3 of 5');
    assert.equal(await text(page, '#disco-missing'), 'Pablo Honey\n1993 · Album\nWishlist\nGot it\nAmnesiac\n2001 · Album\nWishlist\nGot it');
    assert.match(await text(page, '#artist-status'), /Checking which releases came out on vinyl/);
    hold.browse = null;
    letBrowseThrough();
    await discoReady(page);
    // Vinyl only is on by default. Pablo Honey has no official vinyl in MusicBrainz, but it's a studio
    // album, so it's listed anyway as "Vinyl not confirmed". The Bends has a deluxe edition on vinyl,
    // which gets its own line right after the original.
    assert.equal(await text(page, '#disco-progress-text'), 'You have 3 of 6');
    assert.equal(await text(page, '#missing-heading'), 'Missing (3)');
    // One line per album, with no count of individual pressings
    assert.equal(await text(page, '#disco-missing'),
      'Pablo Honey\n1993 · Album\nVinyl not confirmed\nConfirm\nWishlist\nGot it\n'
      + 'The Bends (Deluxe Edition)\n2009 · Album\nWishlist\nGot it\nAmnesiac\n2001 · Album\nWishlist\nGot it');
    assert.match(await text(page, '#disco-owned'), /^The Bends\n1995 · Album · You have: LP\nOK Computer/);
    assert.doesNotMatch(await text(page, '#disco-panel'), /Kid A \(Expanded/, 'a deluxe edition still needs confirmed vinyl');
    assert.equal(await page.locator('.toggle', { hasText: 'Live' }).count(), 0, 'a flexi-disc alone should not count as vinyl');
    assert.match(await text(page, '#disco-unmatched'), /Live at the Astoria/);
    await assertNoJunkText(page, 'discography');
    await shot(page, '06-discography');

    // Turning it off shows everything, including the CD-only expanded edition. It also loads the
    // albums with no official release, like the bootleg Glastonbury recording, so Live counts two.
    await page.locator('.toggle', { hasText: 'Vinyl only' }).click();
    await page.locator('.toggle', { hasText: 'Live' }).locator('.toggle-count', { hasText: '2' }).waitFor();
    await discoReady(page);
    assert.equal(mbCalls.at(-1).pathname, '/ws/2/release-group');
    assert.equal(mbCalls.at(-1).searchParams.get('artist'), 'a-radiohead');
    assert.equal(await text(page, '#disco-progress-text'), 'You have 3 of 7');
    assert.match(await text(page, '#disco-missing'), /Kid A \(Expanded Edition\)\n2016 · Album\nVinyl not confirmed\nConfirm/);
    await page.locator('.toggle', { hasText: 'Vinyl only' }).click();
    assert.equal(await text(page, '#disco-progress-text'), 'You have 3 of 6');

    // Wishlist from the discography: the button flips to "On wishlist", and tapping that takes it off again
    const missingRow = (title) => page.locator('#disco-missing .result', { hasText: title });
    const wishCount = () => page.locator('#count-wishlist').textContent();
    await missingRow('Amnesiac').getByRole('button', { name: 'Wishlist', exact: true }).click();
    await missingRow('The Bends (Deluxe Edition)').getByRole('button', { name: 'Wishlist', exact: true }).click();
    assert.equal(await wishCount(), '2');
    await missingRow('Amnesiac').getByRole('button', { name: 'On wishlist', exact: true }).click();
    assert.equal(await wishCount(), '1');
    await missingRow('Amnesiac').getByRole('button', { name: 'Wishlist', exact: true }).click();
    assert.equal(await wishCount(), '2');
    assert.equal(await text(page, '#disco-progress-text'), 'You have 3 of 6', 'wishlisted records still count as missing');

    // Getting a wishlisted record takes it off the wishlist
    await missingRow('Amnesiac').getByRole('button', { name: 'Got it' }).click();
    assert.equal(await text(page, '#disco-progress-text'), 'You have 4 of 6');
    assert.equal(await wishCount(), '1');

    // The wishlist lives in the Collection tab. Getting the deluxe edition from there ticks off
    // the deluxe line, not the original.
    await openTab(page, 'collection');
    await openTab(page, 'wishlist');
    assert.equal(await text(page, '#collection-heading'), 'Your wishlist');
    assert.deepEqual(await page.locator('#collection-list .record-title').allTextContents(), ['The Bends (Deluxe Edition)']);
    await page.locator('#collection-list .result').getByRole('button', { name: 'Got it' }).click();
    await page.locator('#wishlist-empty').waitFor();
    assert.equal(await text(page, '#nav-count'), '7');
    await openTab(page, 'discography');
    assert.equal(await text(page, '#disco-progress-text'), 'You have 5 of 6');
    assert.match(await text(page, '#disco-owned'), /The Bends\n1995 · Album · You have: LP\nThe Bends \(Deluxe Edition\)\n2009 · Album · You have: LP/);
    assert.equal(await text(page, '#missing-heading'), 'Missing (1)', 'only Pablo Honey is left');

    // Creep only came out on 45, so with 45s and 10" records off it doesn't count as missing
    assert.equal(await page.locator('.toggle', { hasText: 'Singles' }).count(), 0, 'no singles count yet');
    await page.locator('.toggle', { hasText: 'Vinyl only' }).click();
    await page.locator('.toggle', { hasText: 'Singles' }).click();
    assert.match(await text(page, '#disco-missing'), /Creep\n1992 · Single\nOnly on 45 or 10"\nConfirm/);
    await page.locator('.toggle', { hasText: 'Vinyl only' }).click();
    assert.equal(await text(page, '#disco-progress-text'), 'You have 5 of 6');
    // Turning on 45s and 10" records here does the same as on the Add page
    await page.locator('.toggle', { hasText: '45s and 10"' }).click();
    assert.equal(await text(page, '#disco-progress-text'), 'You have 5 of 7');
    assert.ok(await page.locator('#small-records').isChecked(), 'the Add page checkbox follows');

    // Copy the missing list
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('#disco-copy');
    await page.locator('#toast.show', { hasText: 'Copied 2 titles' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Radiohead - Creep (1992)\nRadiohead - Pablo Honey (1993)');

    // Remove from the wishlist, then undo
    await missingRow('Creep').getByRole('button', { name: 'Wishlist', exact: true }).click();
    await openTab(page, 'collection');
    await openTab(page, 'wishlist');
    await page.locator('#collection-list .result', { hasText: 'Creep' }).getByRole('button', { name: 'Remove' }).click();
    await page.locator('#wishlist-empty').waitFor();
    await page.locator('#toast .toast-action').click();
    assert.deepEqual(await page.locator('#collection-list .record-title').allTextContents(), ['Creep']);
    await assertNoJunkText(page, 'wishlist');
    await shot(page, '07-wishlist');
    await openTab(page, 'discography');

    // Confirming vinyl yourself: the CD-only expanded edition is hidden while Vinyl only is on,
    // until you confirm it's out on vinyl. Undo hides it again.
    await page.locator('.toggle', { hasText: 'Vinyl only' }).click();
    await missingRow('Kid A (Expanded Edition)').getByRole('button', { name: 'Confirm' }).click();
    assert.match(await text(page, '#disco-missing'), /Kid A \(Expanded Edition\)\n2016 · Album\nVinyl confirmed by you\nUndo/);
    await page.locator('.toggle', { hasText: 'Vinyl only' }).click();
    assert.equal(await text(page, '#disco-progress-text'), 'You have 5 of 8', 'it now counts as on vinyl');
    await shot(page, '06b-confirmed-vinyl');
    await missingRow('Kid A (Expanded Edition)').getByRole('button', { name: 'Undo' }).click();
    assert.equal(await text(page, '#disco-progress-text'), 'You have 5 of 7');

    // Portishead has no id yet, so the app looks the name up once and remembers it
    const callsBefore = mbCalls.length;
    await page.selectOption('#disco-artist', { label: 'Portishead (1)' });
    await page.locator('#disco-name', { hasText: 'Portishead' }).waitFor();
    await discoReady(page);
    assert.equal(await text(page, '#disco-progress-text'), 'You have 1 of 3');
    assert.deepEqual(mbCalls.slice(callsBefore).map((u) => u.pathname), ['/ws/2/artist', '/ws/2/release-group', '/ws/2/release']);
    const linked = await page.evaluate(() => JSON.parse(localStorage.getItem('recordcatalog.records.v1')).find((r) => r.title === 'Dummy').artistId);
    assert.equal(linked, 'a-portishead');

    // Cached: coming back to Radiohead makes no new requests
    const callsCached = mbCalls.length;
    await page.selectOption('#disco-artist', { label: 'Radiohead (6)' });
    await page.locator('#disco-name', { hasText: 'Radiohead' }).waitFor();
    assert.equal(mbCalls.length, callsCached);

    // Survives a reload, including the type filter
    await page.reload();
    assert.equal(await text(page, '#nav-count'), '7');
    await page.goto(`${PAGE_URL}#discography`);
    await page.selectOption('#disco-artist', { label: 'Radiohead (6)' });
    assert.equal(await text(page, '#disco-progress-text'), 'You have 5 of 7');

    // A saved copy more than a week old still shows at once, while a new one loads behind it
    await page.evaluate((key) => {
      const saved = JSON.parse(localStorage.getItem(key));
      saved['a-radiohead'].fetchedAt -= 10 * 24 * 60 * 60 * 1000;
      localStorage.setItem(key, JSON.stringify(saved));
    }, 'recordcatalog.discographies.v6');
    await page.selectOption('#disco-artist', { label: 'Portishead (1)' });
    await discoReady(page);
    let letRefreshThrough;
    hold.browse = new Promise((resolve) => { letRefreshThrough = resolve; });
    await page.selectOption('#disco-artist', { label: 'Radiohead (6)' });
    await page.locator('#disco-panel[aria-busy="true"]').waitFor();
    assert.equal(await text(page, '#disco-progress-text'), 'You have 5 of 7');
    assert.match(await text(page, '#disco-updated'), /Updated 10 days ago/);
    assert.match(await text(page, '#disco-missing'), /Pablo Honey\n1993 · Album\nVinyl not confirmed/, 'the saved copy keeps its labels');
    assert.match(await text(page, '#artist-status'), /Checking MusicBrainz for changes/);
    hold.browse = null;
    letRefreshThrough();
    await discoReady(page);
    assert.match(await text(page, '#disco-updated'), /Updated just now/);
    assert.equal(await text(page, '#disco-progress-text'), 'You have 5 of 7');

    // Backup, wipe, restore
    await openTab(page, 'collection');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
    const backupPath = await download.path();
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    assert.equal(backup.records.length, 7);
    assert.deepEqual(backup.wishlist.map((w) => w.title), ['Creep']);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    assert.ok(await page.locator('#collection-empty').isVisible());
    assert.equal(await page.locator('.import-open:visible').count(), 1, 'the empty shelf shows one Import button');
    await page.click('#collection-empty .import-open');
    await page.setInputFiles('#import-file', backupPath);
    await page.locator('#import-summary', { hasText: 'A Record Catalog backup with 7 records and 1 on your wishlist.' }).waitFor();
    assert.equal(await text(page, '#import-file-name'), path.basename(backupPath), 'the backup shows by name, not as JSON');
    assert.ok(await page.locator('#import-form [name=text]').isHidden());
    assert.ok(await page.locator('#import-format-field').isHidden(), 'a backup keeps its own formats');
    assert.equal(await text(page, '#import-submit'), 'Import backup');
    await page.click('#import-submit');
    await page.locator('#toast.show', { hasText: 'Imported 7 records and 1 for your wishlist' }).waitFor();
    assert.equal(await text(page, '#nav-count'), '7');
    assert.equal(await wishCount(), '1');

    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
  }
});

// The discography asks for an artist by id, either as a browse parameter or inside a search query.
const asksForArtist = (url, id) => url.searchParams.get('artist') === id || (url.searchParams.get('query') || '').includes(`arid:"${id}"`);

test('a search for an artist opens their discography in one tap', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const { context, page, errors, mbCalls } = await openApp(browser, { viewport: { width: 375, height: 760 } });
    await openTab(page, 'add');
    const searchBox = page.locator('#search-form [name=q]');
    const callsBefore = mbCalls.length;
    await searchBox.fill('radiohead');
    const row = page.locator('#search-results .artist-row');
    await row.waitFor();
    assert.equal(mbCalls.length - callsBefore, 1, 'the row comes from the search itself, with no request of its own');
    assert.equal(await row.innerText(), 'Radiohead · Artist · See all albums');
    assert.equal(await page.locator('#search-results li').first().getAttribute('class'), 'artist-row', 'the row is above the albums');
    assert.equal(await page.locator('#search-results .result').count(), 2);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no sideways scrolling on a phone');
    await shot(page, '10-artist-row');

    await row.getByRole('button', { name: /See all albums/ }).click();
    await page.locator('#disco-name', { hasText: 'Radiohead' }).waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#discography');
    assert.ok(mbCalls.some((url) => asksForArtist(url, 'a-radiohead')), 'it loads the artist by their MusicBrainz id');
    assert.match(await text(page, '#disco-missing'), /OK Computer/);

    // An artist MusicBrainz files under another name shows as the sleeve credits them, and still
    // opens by their MusicBrainz id
    await openTab(page, 'add');
    await searchBox.fill('takanaka rainbow goblins');
    await page.locator('#search-results .artist-row', { hasText: 'Masayoshi Takanaka' }).waitFor();
    assert.equal(await row.innerText(), 'Masayoshi Takanaka · Artist · See all albums');
    await row.getByRole('button').click();
    await page.locator('#disco-name', { hasText: 'Masayoshi Takanaka' }).waitFor();
    assert.ok(mbCalls.some((url) => asksForArtist(url, 'a-takanaka')), 'it loads 高中正義 by id');
    assert.match(await text(page, '#disco-missing'), /Seychelles/);

    // A barcode names no artist, so the row goes away
    await openTab(page, 'add');
    await searchBox.fill('0 724352 775324');
    await searchBox.press('Enter');
    await page.locator('#search-results .result', { hasText: 'Kid A' }).waitFor();
    assert.equal(await page.locator('#search-results .artist-row').count(), 0);

    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
  }
});

test('the random pick shows the 500px cover while the 1200px one loads', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const { context, page, errors, coverCalls } = await openApp(browser);
    // Kid A's 1200px cover is slow to arrive, and OK Computer has no 1200px cover at all.
    await context.route(/\/front-1200$/, async (route) => {
      if (route.request().url().includes('/rg-okc/')) return route.fulfill({ status: 404, body: '' });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return route.fallback();
    });
    await page.evaluate(() => {
      const record = (id, title, format) => ({ id, artist: 'Radiohead', title, year: 2000, format, releaseGroupId: `rg-${id}`, notes: '', addedAt: new Date(2024, 0, 1).toISOString() });
      localStorage.setItem('recordcatalog.records.v1', JSON.stringify([record('kida', 'Kid A', 'Double LP'), record('okc', 'OK Computer', 'LP')]));
    });
    await page.goto(`${PAGE_URL}#random`);
    await page.reload();
    const shown = () => page.locator('#spin-sleeve img.shown').evaluateAll((imgs) => imgs.map((img) => img.src.split('/').pop()));

    // Opened straight on Random, so nothing has loaded Kid A's cover yet, and its color hasn't been
    // read. Only the 1200px cover is asked for, so it doesn't share the connection with two others.
    const calls = (size) => coverCalls.filter((url) => url.endsWith(`/rg-kida/front-${size}`)).length;
    assert.ok(!coverCalls.some((url) => url.includes('/rg-kida/')));
    await page.selectOption('#random-format', 'Double LP');
    await page.click('#spin-btn');
    await page.locator('#spin-sleeve img.shown').waitFor();
    assert.deepEqual(await shown(), ['front-1200']);
    assert.equal(calls(500), 0);

    // The cover's main color is kept with the record. After a reload the card takes it at once,
    // without reading the cover again.
    const tint = () => page.locator('#view-random .random-card').evaluate((el) => el.style.getPropertyValue('--album'));
    await page.waitForFunction(() => document.querySelector('#view-random .random-card').style.getPropertyValue('--album').startsWith('rgb('));
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('recordcatalog.records.v1')).find((r) => r.id === 'kida').coverColor);
    assert.equal(saved, await tint());
    await page.reload();
    const colorReads = calls(250);
    await page.selectOption('#random-format', 'Double LP');
    await page.click('#spin-btn');
    assert.equal(await tint(), saved);
    assert.equal(calls(250), colorReads, 'no second read of the cover');

    // With no color to read, both sizes are asked for. The 500px one shows first, and the 1200px
    // one goes on top when it arrives.
    await page.locator('#spin-sleeve img.shown').waitFor();
    assert.deepEqual(await shown(), ['front-500'], 'the 500px cover shows while the 1200px one loads');
    await page.locator('#spin-sleeve img.shown[src$="front-1200"]').waitFor();
    assert.deepEqual(await shown(), ['front-500', 'front-1200'], 'the 1200px cover lies on top');

    // Without a 1200px cover, the 500px one takes its place
    await page.selectOption('#random-format', 'LP');
    await page.click('#spin-btn');
    assert.equal(await text(page, '.pick-title'), 'OK Computer');
    await page.waitForFunction(() => document.querySelectorAll('#spin-sleeve img').length === 1);
    await page.locator('#spin-sleeve img.shown').waitFor();
    assert.deepEqual(await shown(), ['front-500']);

    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
  }
});

test('imports a typed list and looks the records up', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const { context, page, errors, mbCalls } = await openApp(browser, { viewport: { width: 420, height: 900 } });
    await page.evaluate(() => {
      localStorage.setItem('recordcatalog.records.v1', JSON.stringify([{
        id: 'bends', artist: 'Radiohead', artistId: 'a-radiohead', title: 'The Bends', year: 1995, releaseGroupId: 'rg-bends',
        format: 'LP', notes: '', releaseId: null, addedAt: new Date(2024, 0, 1).toISOString(),
      }]));
    });
    await page.reload();
    const records = () => page.evaluate(() => JSON.parse(localStorage.getItem('recordcatalog.records.v1')));
    const byTitle = async () => Object.fromEntries((await records()).map((r) => [r.title, r]));

    await page.click('#import-btn');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'import-heading', 'the list box waits for a tap');
    await page.fill('#import-form [name=text]', [
      'Radiohead - The Bends',
      'Portishead - Dumy (Signed)',
      'Radiohed - Kid A',
      'Radiohead - Creep (45)',
      'Weezer - Weezer',
      'Weezer - Weezer',
      'a line with no dash',
    ].join('\n'));
    const summary = await text(page, '#import-summary');
    assert.match(summary, /4 records to add/);
    assert.match(summary, /1 record already in your collection is skipped/);
    assert.match(summary, /1 line named an album already on the list/);
    assert.match(summary, /1 line couldn't be read[\s\S]*a line with no dash/);
    assert.equal(await text(page, '#import-submit'), 'Add 4 records');
    await shot(page, 'import-01-dialog');
    await page.click('#import-submit');
    await page.locator('#toast.show', { hasText: 'Added 4 records' }).waitFor();
    assert.equal(await text(page, '#nav-count'), '5');

    // Records are on the shelf straight away, then looked up one by one
    await page.locator('#lookup', { hasText: 'Looking up covers and years' }).waitFor();
    await shot(page, 'import-02-looking-up');
    await page.locator('#lookup', { hasText: 'Found 3 of 4 imported records' }).waitFor({ timeout: 20000 });
    let shelf = await byTitle();
    assert.deepEqual(
      [shelf.Dummy.artist, shelf.Dummy.releaseGroupId, shelf.Dummy.year, shelf.Dummy.notes, shelf.Dummy.format],
      ['Portishead', 'rg-dummy', 1994, 'Signed', 'LP'], 'the typo in the title is fixed');
    assert.deepEqual([shelf['Kid A'].artist, shelf['Kid A'].artistId], ['Radiohead', 'a-radiohead'], 'and the one in the artist');
    assert.deepEqual([shelf.Creep.format, shelf.Creep.releaseGroupId, shelf.Creep.notes], ['45', 'rg-creep', ''], 'a 45 is matched to the single');
    assert.deepEqual([shelf.Weezer.releaseGroupId, shelf.Weezer.notes], [null, '2 copies'], 'two albums called Weezer: too close to call');
    assert.ok(Object.values(shelf).every((r) => !r.pendingLookup));
    assert.equal(mbCalls.filter((url) => url.pathname === '/ws/2/release-group').length, 4, 'one lookup per record');

    // The ones not matched stay listed, even after the app is closed
    await page.reload();
    await page.locator('#lookup', { hasText: 'Found 3 of 4 imported records' }).waitFor();
    await page.click('#lookup summary');
    await shot(page, 'import-03-not-matched');
    await page.locator('#lookup .record', { hasText: 'Weezer' }).click();
    await page.fill('#edit-form [name=title]', 'Weezer (Blue Album)');
    await page.click('#edit-form button[value=save]');
    await page.locator('#lookup', { hasText: 'Found all 4 imported records' }).waitFor({ timeout: 10000 });
    shelf = await byTitle();
    assert.equal(shelf['Weezer (Blue Album)'].releaseGroupId, 'rg-blue', 'fixing the title looks it up again');
    await page.click('#lookup button:has-text("Dismiss")');
    assert.ok(await page.locator('#lookup').isHidden());
    await page.reload();
    assert.ok(await page.locator('#lookup').isHidden());

    // Undo takes the whole import back, and puts back the wishes it ticked off
    await page.evaluate(() => {
      localStorage.setItem('recordcatalog.wishlist.v1', JSON.stringify([{ id: 'wish-third', artist: 'Portishead', title: 'Third', format: 'LP', notes: '' }]));
    });
    await page.reload();
    const wishes = () => page.evaluate(() => JSON.parse(localStorage.getItem('recordcatalog.wishlist.v1')).map((w) => w.title));
    await page.click('#import-btn');
    await page.fill('#import-form [name=text]', 'Portishead - Third\nPortishead - Portishead');
    await page.click('#import-submit');
    await page.locator('#toast.show', { hasText: 'Added 2 records' }).waitFor();
    assert.deepEqual(await wishes(), [], 'owning Third takes it off the wishlist');
    await page.click('#toast .toast-action');
    assert.equal(await text(page, '#nav-count'), '5');
    assert.deepEqual(await wishes(), ['Third']);
    await page.waitForFunction(() => document.querySelector('#lookup').hidden);

    await assertNoJunkText(page, 'collection after import');
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
  }
});

test('two tabs open at once keep both their changes', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const { context, page: first, errors } = await openApp(browser);
    const second = await context.newPage();
    second.on('pageerror', (err) => errors.push(err.message));
    await second.goto(PAGE_URL);

    await addByHand(first, 'Steely Dan', 'Aja');
    await second.locator('#nav-count', { hasText: '1' }).waitFor({ timeout: 5000 });
    await addByHand(second, 'Radiohead', 'OK Computer');
    await first.locator('#nav-count', { hasText: '2' }).waitFor({ timeout: 5000 });
    await first.reload();
    assert.equal(await text(first, '#nav-count'), '2');
    const saved = await first.evaluate(() => JSON.parse(localStorage.getItem('recordcatalog.records.v1')).map((record) => record.title).sort());
    assert.deepEqual(saved, ['Aja', 'OK Computer']);

    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
  }
});

const syncConfigFilledIn = !fs.readFileSync(path.join(__dirname, '..', 'js', 'sync-config.js'), 'utf8').includes('PASTE_');

test('sync stays hidden and loads nothing from Firebase until it is set up', { skip: (!chromium && 'playwright is not installed') || (syncConfigFilledIn && 'js/sync-config.js is filled in') }, async () => {
  const browser = await chromium.launch();
  try {
    const { context, page, errors, firebaseCalls } = await openApp(browser);
    assert.equal(await page.locator('#sync-button').isHidden(), true);
    assert.deepEqual(firebaseCalls, []);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
  }
});

test('enabled: false hides sync and calls nothing, even when it is set up', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    for (const enabled of [false, true]) {
      const fake = fakeSyncService();
      // Stands in for a filled-in js/sync-config.js with enabled set as given.
      const filledIn = (context) => context.addInitScript((on) => {
        let config;
        Object.defineProperty(window.RC, 'syncConfig', {
          get: () => config,
          set: (value) => {
            config = { ...value, apiKey: 'key', authDomain: 'example.firebaseapp.com', projectId: 'example', appId: 'app', enabled: on };
          },
        });
      }, enabled);
      const { context, page, errors, firebaseCalls } = await openApp(browser, { setup: async (c) => { await fake.install()(c); await filledIn(c); } });
      assert.equal(await page.evaluate(() => RC.syncConfig.enabled), enabled);
      assert.equal(await page.locator('#sync-button').isVisible(), enabled, `button shown when enabled is ${enabled}`);
      if (!enabled) assert.deepEqual(fake.calls, []);
      assert.deepEqual(firebaseCalls, []);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test('two devices sync their collections after signing in', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const fake = fakeSyncService();
    const pc = await openApp(browser, { setup: fake.install() });
    const phone = await openApp(browser, { setup: fake.install(), viewport: { width: 390, height: 844 } });
    await addByHand(pc.page, 'Steely Dan', 'Aja');
    await addByHand(phone.page, 'Can', 'Tago Mago');

    assert.equal(await syncName(pc.page), 'Sync: signed out');
    await openSync(pc.page);
    assert.match(await text(pc.page, '#sync-body'), /Sign in with Google on each device/);
    await pc.page.click('#sync-sign-in');
    await pc.page.locator('#sync-status', { hasText: 'Synced just now.' }).waitFor({ timeout: 5000 });
    assert.match(await text(pc.page, '#sync-body'), /Signed in as owner@example.com\./);
    assert.equal(await syncName(pc.page), 'Sync: synced just now');
    assert.equal(await pc.page.locator('#sync-account-id').count(), 0, 'the owner has no use for the setup help');
    assert.match(await text(pc.page, '#sync-people'), /No requests waiting\.[\s\S]*Nobody else syncs yet\./);

    await openSync(phone.page);
    await phone.page.click('#sync-sign-in');
    await phone.page.locator('#nav-count', { hasText: '2' }).waitFor({ timeout: 5000 });
    await shot(phone.page, 'sync-signed-in');

    await pc.page.click('#sync-now');
    await pc.page.locator('#nav-count', { hasText: '2' }).waitFor({ timeout: 5000 });
    const titles = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('recordcatalog.records.v1')).map((record) => record.title).sort());
    assert.deepEqual(await titles(pc.page), ['Aja', 'Tago Mago']);
    assert.deepEqual(await titles(phone.page), ['Aja', 'Tago Mago']);

    await phone.page.click('#sync-sign-out');
    await phone.page.locator('#sync-sign-in').waitFor();
    assert.equal(await text(phone.page, '#nav-count'), '2', 'signing out keeps the records');
    await phone.page.click('#sync-close');
    assert.equal(await phone.page.locator('#sync-dialog').isVisible(), false);

    assert.deepEqual([...pc.firebaseCalls, ...phone.firebaseCalls], []);
    assert.deepEqual([...pc.errors, ...phone.errors], []);
    await pc.context.close();
    await phone.context.close();
  } finally {
    await browser.close();
  }
});

test('a guest asks for access, the owner approves, and the guest syncs only their own collection', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const fake = fakeSyncService();
    const owner = await openApp(browser, { setup: fake.install() });
    const ana = await openApp(browser, { setup: fake.install(ANA), viewport: { width: 375, height: 760 } });
    await addByHand(owner.page, 'Steely Dan', 'Aja');
    await addByHand(ana.page, 'Can', 'Tago Mago');

    await openSync(ana.page);
    await ana.page.click('#sync-sign-in');
    await ana.page.locator('#sync-request').waitFor({ timeout: 5000 });
    assert.equal(await syncName(ana.page), 'Sync: no access yet');
    assert.equal(await text(ana.page, '#sync-privacy'), "Asking shares your name and email with the site's owner, and your collection is kept in their Firebase project.");
    assert.equal(await ana.page.locator('#sync-people, #sync-now, [data-approve]').count(), 0, 'a guest sees no owner controls and no Sync now');
    assert.equal(await ana.page.locator('.sync-account[open]').count(), 0, 'the setup help starts closed');
    await shot(ana.page, 'sync-guest-request');

    await ana.page.click('#sync-request');
    await ana.page.locator('#sync-status', { hasText: "You're waiting for the site's owner to approve it." }).waitFor({ timeout: 5000 });
    assert.equal(await syncName(ana.page), 'Sync: waiting for approval');
    assert.equal(await ana.page.locator('#sync-account-id').count(), 0);
    assert.deepEqual(fake.buckets.get(ANA.id), undefined, 'nothing synced while pending');

    await openSync(owner.page);
    await owner.page.click('#sync-sign-in');
    await owner.page.locator('#sync-requests [data-person]').waitFor({ timeout: 5000 });
    assert.equal(await owner.page.locator('#sync-count').isVisible(), true);
    assert.equal(await text(owner.page, '#sync-count'), '1');
    assert.equal(await syncName(owner.page), 'Sync: synced just now, 1 request waiting');
    assert.match(await text(owner.page, '#sync-requests'), /Ana Lima\s+ana@example.com/);
    await shot(owner.page, 'sync-owner-requests');
    await owner.page.click(`[data-approve="${ANA.id}"]`);
    await owner.page.locator(`#sync-approved [data-person="${ANA.id}"]`).waitFor({ timeout: 5000 });
    assert.equal(await owner.page.locator('#sync-count').isHidden(), true);
    assert.equal(fake.access.get(ANA.id).status, 'approved');

    await ana.page.click('#sync-check');
    await ana.page.locator('#sync-status', { hasText: 'Synced just now.' }).waitFor({ timeout: 5000 });
    assert.equal(await syncName(ana.page), 'Sync: synced just now');
    const titles = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('recordcatalog.records.v1')).map((record) => record.title).sort());
    assert.deepEqual(await titles(ana.page), ['Tago Mago'], "Ana doesn't get the owner's records");
    await owner.page.click('#sync-now');
    await owner.page.locator('#sync-status', { hasText: 'Synced just now.' }).waitFor({ timeout: 5000 });
    assert.deepEqual(await titles(owner.page), ['Aja'], "the owner doesn't get Ana's records");

    await owner.page.click(`[data-remove="${ANA.id}"]`);
    assert.match(await text(owner.page, `[data-person="${ANA.id}"]`), /Remove Ana Lima\? They can't ask again\./);
    assert.equal(fake.access.get(ANA.id).status, 'approved', 'nothing changes before the second tap');
    await owner.page.click(`[data-confirm="${ANA.id}"]`);
    await owner.page.locator('#sync-people', { hasText: 'Nobody else syncs yet.' }).waitFor({ timeout: 5000 });
    assert.equal(fake.access.get(ANA.id).status, 'denied');

    await ana.page.click('#sync-now');
    await ana.page.locator('#sync-status', { hasText: "You don't have access to sync on this site." }).waitFor({ timeout: 5000 });
    assert.equal(await syncName(ana.page), 'Sync: no access');
    assert.equal(await ana.page.locator('#sync-request, #sync-now').count(), 0);

    assert.deepEqual([...owner.firebaseCalls, ...ana.firebaseCalls], []);
    assert.deepEqual([...owner.errors, ...ana.errors], []);
    await owner.context.close();
    await ana.context.close();
  } finally {
    await browser.close();
  }
});

test('the owner denies a request, and a guest can withdraw one', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const fake = fakeSyncService();
    const ana = await openApp(browser, { setup: fake.install(ANA) });
    const ben = await openApp(browser, { setup: fake.install(BEN) });
    for (const guest of [ana, ben]) {
      await openSync(guest.page);
      await guest.page.click('#sync-sign-in');
      await guest.page.click('#sync-request');
      await guest.page.locator('#sync-withdraw').waitFor({ timeout: 5000 });
    }
    await ben.page.click('#sync-withdraw');
    await ben.page.locator('#sync-request').waitFor({ timeout: 5000 });
    assert.equal(fake.access.has(BEN.id), false);

    const owner = await openApp(browser, { setup: fake.install() });
    await openSync(owner.page);
    await owner.page.click('#sync-sign-in');
    await owner.page.locator(`[data-deny="${ANA.id}"]`).waitFor({ timeout: 5000 });
    assert.equal(await owner.page.locator('#sync-requests [data-person]').count(), 1, 'a withdrawn request is gone');
    await owner.page.click(`[data-deny="${ANA.id}"]`);
    await owner.page.click(`[data-person="${ANA.id}"] .link`);
    assert.equal(fake.access.get(ANA.id).status, 'pending', 'Cancel keeps the request');
    await owner.page.click(`[data-deny="${ANA.id}"]`);
    await owner.page.click(`[data-confirm="${ANA.id}"]`);
    await owner.page.locator('#sync-people', { hasText: 'No requests waiting.' }).waitFor({ timeout: 5000 });
    assert.equal(fake.access.get(ANA.id).status, 'denied');

    await ana.page.click('#sync-check');
    await ana.page.locator('#sync-status', { hasText: "You don't have access to sync on this site." }).waitFor({ timeout: 5000 });
    assert.deepEqual([...ana.errors, ...ben.errors, ...owner.errors], []);
    for (const device of [ana, ben, owner]) await device.context.close();
  } finally {
    await browser.close();
  }
});

test('sync says what went wrong, with the account id for setting up the rules', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const fake = fakeSyncService();
    const { context, page, errors, firebaseCalls } = await openApp(browser, { setup: fake.install() });
    fake.fail = 'permission-denied';
    await openSync(page);
    await page.click('#sync-sign-in');
    await page.locator('#sync-problem').waitFor({ timeout: 5000 });
    assert.equal(await text(page, '#sync-problem'), "Firebase didn't allow that. If you run this site, check that its access rules are published with your account id.");
    assert.equal(await syncName(page), 'Sync: something went wrong');
    await page.click('.sync-account summary');
    assert.equal(await text(page, '#sync-account-id'), 'test-account-id');

    fake.fail = 'resource-exhausted';
    await page.click('#sync-sign-out');
    await page.click('#sync-sign-in');
    await page.locator('#sync-problem', { hasText: "This site has used up today's free Firebase reads." }).waitFor({ timeout: 5000 });

    fake.fail = null;
    await page.click('#sync-sign-out');
    await page.click('#sync-sign-in');
    await page.locator('#sync-status', { hasText: 'Synced just now.' }).waitFor({ timeout: 5000 });
    assert.equal(await page.locator('#sync-problem').count(), 0);

    fake.fail = 'unavailable';
    await page.click('#sync-now');
    await page.locator('#sync-problem', { hasText: "Couldn't reach the sync service." }).waitFor({ timeout: 5000 });

    assert.deepEqual(firebaseCalls, []);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
  }
});

test('the sync button fits the header on a phone and on a desktop, in light and dark mode', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const fake = fakeSyncService();
    fake.access.set(ANA.id, { ...ANA, status: 'pending', requestedAt: new Date().toISOString(), decidedAt: null });
    for (const [width, height] of [[375, 760], [1100, 900]]) {
      for (const colorScheme of ['light', 'dark']) {
        const plain = await openApp(browser, { viewport: { width, height }, colorScheme });
        const before = await plain.page.locator('.app-header').boundingBox();
        await plain.context.close();
        const { context, page, errors } = await openApp(browser, { setup: fake.install(), viewport: { width, height }, colorScheme });
        const header = () => page.locator('.app-header').boundingBox();
        await openSync(page);
        await page.click('#sync-sign-in');
        await page.locator('#sync-requests [data-person]').waitFor({ timeout: 5000 });
        await shot(page, `sync-dialog-${width}-${colorScheme}`);
        await page.click('#sync-close');
        const button = await page.locator('#sync-button').boundingBox();
        const brand = await page.locator('.brand').boundingBox();
        const tabs = await page.locator('.tabs').boundingBox();
        const end = await page.locator('.header-inner').evaluate((el) => el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight));
        assert.equal((await header()).height, before.height, `the button adds no height at ${width}px`);
        assert.ok(Math.abs(button.x + button.width - end) < 1, `the button ends at the header's right edge at ${width}px`);
        assert.ok(Math.abs(button.y + button.height / 2 - (brand.y + brand.height / 2)) < 4, `the button lines up with the name at ${width}px`);
        assert.ok(button.x >= (width < 640 ? brand.x + brand.width : tabs.x + tabs.width), `the button doesn't cover the name or the tabs at ${width}px`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, `no sideways scroll at ${width}px (${colorScheme})`);
        assert.equal(await page.locator('#sync-count').isVisible(), true);
        assert.equal(await text(page, '#sync-count'), '1');
        await shot(page, `sync-header-${width}-${colorScheme}`);
        assert.deepEqual(errors, []);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
});

test('imports spreadsheets saved as Excel or CSV, and says what to do with a Numbers file', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const { context, page, errors } = await openApp(browser, { viewport: { width: 420, height: 900 } });
    await page.evaluate(() => {
      localStorage.setItem('recordcatalog.records.v1', JSON.stringify([{
        id: 'dummy', artist: 'Portishead', artistId: 'a-portishead', title: 'Dummy', year: 1994, releaseGroupId: 'rg-dummy',
        format: 'LP', notes: '', releaseId: null, addedAt: new Date(2024, 0, 1).toISOString(),
      }]));
    });
    await page.reload();
    const records = () => page.evaluate(() => JSON.parse(localStorage.getItem('recordcatalog.records.v1')));

    assert.equal(await page.locator('.import-open:visible').count(), 1, 'one Import button under the collection');
    await page.click('#import-btn');
    await page.fill('#import-form [name=text]', 'Steely Dan - Aja');
    await page.setInputFiles('#import-file', path.join(__dirname, 'fixtures', 'records.numbers'));
    await page.locator('#import-summary', { hasText: "can't read Numbers or old Excel (.xls) files" }).waitFor();
    assert.equal(await text(page, '#import-file-name'), 'records.numbers', 'the file shows by name in place of the paste box');
    assert.ok(await page.locator('#import-form [name=text]').isHidden());
    assert.ok(await page.locator('#import-submit').isDisabled());
    await page.click('#import-paste-btn');
    assert.ok(await page.locator('#import-chosen').isHidden());
    assert.equal(await page.inputValue('#import-form [name=text]'), 'Steely Dan - Aja', 'Paste instead brings back what was pasted');
    await page.locator('#import-summary', { hasText: '1 record to add.' }).waitFor();

    // An .xlsx file, unzipped by the browser itself
    await page.setInputFiles('#import-file', path.join(__dirname, 'fixtures', 'records-xlsxwriter.xlsx'));
    await page.locator('#import-summary', { hasText: '5 records to add.' }).waitFor();
    assert.match(await text(page, '#import-summary'), /Read the Artist, Album, Year, Format, Label and Notes columns\.[\s\S]*1 row is a CD or cassette/);
    await shot(page, 'import-05-excel');

    // Excel on Windows saves CSV in Windows-1252, where ö and ’ are single bytes.
    const csv = [
      'Artist,Album,Year,Format,Label,Price',
      'Portishead,Dummy,1994,LP,Go! Beat',
      '"Crosby, Stills & Nash",Crosby Stills & Nash,1969,LP,Atlantic',
      'Motörhead,Ace of Spades (Signed),1980,"7""",Bronze',
      'Björk,Homogenic,1997-09-22,,One Little Indian',
      ',Didn’t Say,1999,LP,',
      'Prince,Purple Rain,1984,Cassette,Warner Bros.',
    ].join('\r\n');
    const windows1252 = Buffer.from([...csv].map((ch) => (ch === '’' ? 0x92 : ch.charCodeAt(0))));
    await page.setInputFiles('#import-file', { name: 'records.csv', mimeType: 'text/csv', buffer: windows1252 });
    await page.locator('#import-summary', { hasText: '3 records to add.' }).waitFor();
    assert.equal(await text(page, '#import-file-name'), 'records.csv');
    const summary = await text(page, '#import-summary');
    assert.match(summary, /Read the Artist, Album, Year, Format and Label columns and left out the Price column\./);
    assert.match(summary, /1 record already in your collection is skipped/);
    assert.match(summary, /1 row couldn't be read[\s\S]*Each row needs an artist and a title\.[\s\S]*Didn’t Say, 1999, LP/);
    assert.match(summary, /1 row is a CD or cassette, so it's left out\.[\s\S]*Prince, Purple Rain, 1984, Cassette, Warner Bros\./);
    assert.ok(await page.locator('#import-format-field').isVisible());
    await page.selectOption('#import-format', 'Double LP');
    await shot(page, 'import-04-spreadsheet');
    await page.click('#import-submit');
    await page.locator('#toast.show', { hasText: 'Added 3 records' }).waitFor();
    assert.equal(await text(page, '#nav-count'), '4');

    const added = Object.fromEntries((await records()).map((r) => [r.title, [r.artist, r.year, r.format, r.notes]]));
    assert.deepEqual(added['Crosby Stills & Nash'], ['Crosby, Stills & Nash', 1969, 'LP', 'Label: Atlantic']);
    assert.deepEqual(added['Ace of Spades'], ['Motörhead', 1980, '45', 'Signed; Label: Bronze'], 'the umlaut survives and 7" is a 45');
    assert.deepEqual(added.Homogenic, ['Björk', 1997, 'Double LP', 'Label: One Little Indian'], 'no format in the file, so Add as decides');
    await page.locator('#lookup', { hasText: 'Found 0 of 3 imported records' }).waitFor({ timeout: 20000 });

    // A Discogs collection export, pasted. Its columns are from memory and other parsers, not a real export.
    await page.click('#import-btn');
    await page.fill('#import-form [name=text]', [
      'Catalog#,Artist,Title,Label,Format,Rating,Released,release_id,CollectionFolder,Date Added,Collection Media Condition,Collection Sleeve Condition,Collection Notes',
      'DGC-24425,Nirvana (2),Nevermind,DGC,"LP, Album",,1991,1111111,Uncategorized,2023-01-07 10:00:00,Very Good Plus (VG+),,',
    ].join('\n'));
    assert.match(await text(page, '#import-summary'), /1 record to add\.[\s\S]*Collection Notes columns of this Discogs export and left out the Rating, release_id, CollectionFolder and Date Added columns\./);
    await page.click('#import-submit');
    await page.locator('#toast.show', { hasText: 'Added 1 record' }).waitFor();
    const nevermind = (await records()).find((r) => r.title === 'Nevermind');
    assert.deepEqual([nevermind.artist, nevermind.year, nevermind.notes], ['Nirvana', null, 'Label: DGC; Catalog number: DGC-24425; Pressing year: 1991; Media condition: VG+']);

    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
  }
});

test('uses Inter Tight and Inter, and follows the phone\'s light or dark setting', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    for (const [colorScheme, background] of [['light', 'rgb(243, 245, 251)'], ['dark', 'rgb(7, 9, 15)']]) {
      const { context, page, errors } = await openApp(browser, { colorScheme });
      const styles = await page.evaluate(() => ({
        heading: getComputedStyle(document.querySelector('#collection-heading')).fontFamily,
        body: getComputedStyle(document.body).fontFamily,
        background: getComputedStyle(document.body).backgroundColor,
      }));
      assert.match(styles.heading, /^"?Inter Tight"?,/);
      assert.match(styles.body, /^"?Inter"?,/);
      assert.equal(styles.background, background, `${colorScheme} background`);
      assert.equal(await page.locator('#theme-btn, #look-dialog').count(), 0, 'there is no theme picker');

      // The record logo uses the brighter blue in dark mode, and turns only while it's hovered
      const vinylColor = await page.locator('#logo-vinyl stop').nth(1).evaluate((el) => getComputedStyle(el).stopColor);
      assert.equal(vinylColor, colorScheme === 'dark' ? 'rgb(91, 133, 255)' : 'rgb(31, 77, 255)');
      const spinState = () => page.locator('.logo-spin').evaluateAll((els) => els.map((el) => getComputedStyle(el).animationPlayState));
      assert.deepEqual(await spinState(), ['paused', 'paused']);
      await page.hover('.brand');
      assert.deepEqual(await spinState(), ['running', 'running'], 'the record and its label turn together');
      await page.mouse.move(500, 500);
      assert.deepEqual(await spinState(), ['paused', 'paused']);

      // The empty shelf and the empty wishlist draw the header's record, whole
      for (const view of ['collection', 'wishlist']) {
        if (view === 'wishlist') await openTab(page, 'wishlist');
        const emptyRecord = await page.locator(`#${view}-empty .empty-logo use`).evaluate((use) => ({
          isHeaderLogo: !!document.querySelector(use.getAttribute('href'))?.closest('.brand'),
          width: Math.round(use.getBBox().width),
        }));
        assert.deepEqual(emptyRecord, { isHeaderLogo: true, width: 60 }, `${view} (${colorScheme})`);
      }

      assert.deepEqual(errors, []);
      await context.close();
    }

    // With reduced motion on, the logo never turns
    const { context, page } = await openApp(browser, { reducedMotion: 'reduce' });
    await page.hover('.brand');
    assert.deepEqual(await page.locator('.logo-spin').evaluateAll((els) => els.map((el) => getComputedStyle(el).animationName)), ['none', 'none']);
    await context.close();
  } finally {
    await browser.close();
  }
});

test('fits a phone screen in light and dark mode', { skip: !chromium && 'playwright is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    for (const colorScheme of ['light', 'dark']) {
      const { context, page, errors } = await openApp(browser, { viewport: { width: 375, height: 760 }, colorScheme });
      await page.evaluate(() => {
        const records = [
          ['Radiohead', 'a-radiohead', 'OK Computer', 1997, 'rg-okc', 'LP'],
          ['Radiohead', 'a-radiohead', 'Kid A', 2000, 'rg-kida', 'Double LP'],
          ['Portishead', null, 'Dummy', 1994, 'rg-dummy', 'LP'],
          ['Godspeed You! Black Emperor', null, 'Lift Your Skinny Fists Like Antennas to Heaven', 2000, null, 'Box set'],
        ].map(([artist, artistId, title, year, releaseGroupId, format], i) => ({
          id: `r${i}`, artist, artistId, title, year, releaseGroupId, format, notes: '', releaseId: null, addedAt: new Date(2024, 0, i + 1).toISOString(),
        }));
        localStorage.setItem('recordcatalog.records.v1', JSON.stringify(records));
        localStorage.setItem('recordcatalog.wishlist.v1', JSON.stringify([{
          id: 'w1', artist: 'Radiohead', artistId: 'a-radiohead', title: 'Amnesiac', year: 2001, releaseGroupId: 'rg-amnesiac',
          format: 'LP', notes: '', releaseId: null, addedAt: new Date(2024, 1, 1).toISOString(),
        }]));
      });
      // A long collection gets the A to Z down the side; tapping a letter scrolls to it
      await page.evaluate(() => {
        const records = JSON.parse(localStorage.getItem('recordcatalog.records.v1'));
        for (let i = 0; i < 40; i++) {
          records.push({ id: `x${i}`, artist: `${'ABCDEFGHJKLMNOPRSTW'[i % 19]}rtist ${i}`, title: `Album ${i}`, year: 1970 + i, format: 'LP', notes: '', addedAt: new Date(2023, 0, 1).toISOString() });
        }
        localStorage.setItem('recordcatalog.records.v1', JSON.stringify(records));
      });
      await page.reload();
      assert.ok(await page.locator('#az-rail').isVisible());
      assert.equal(await page.locator('#az-rail .off').count(), 27 - 19, 'letters nobody starts with are dimmed');
      await page.locator('#az-rail [data-letter="P"]').click();
      const sectionTop = await page.locator('[data-section="P"]').evaluate((el) => el.getBoundingClientRect().top);
      const headerBottom = await page.locator('.app-header').evaluate((el) => el.getBoundingClientRect().bottom);
      assert.ok(Math.abs(sectionTop - headerBottom - 8) < 2, `P lands just under the header (${sectionTop} vs ${headerBottom})`);
      await page.locator('#az-rail [data-letter="Q"]').click();
      assert.ok(Math.abs(await page.locator('[data-section="R"]').evaluate((el) => el.getBoundingClientRect().top) - headerBottom - 8) < 2, 'Q has nothing, so R');

      for (const view of ['collection', 'wishlist', 'add', 'random', 'discography']) {
        await page.goto(`${PAGE_URL}#${view}`);
        await page.reload();
        if (view === 'random') await page.click('#spin-btn');
        if (view === 'discography') {
          await page.selectOption('#disco-artist', { label: 'Radiohead (2)' });
          await discoReady(page);
        }
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, `${view} (${colorScheme}) scrolls sideways by ${overflow}px`);
        await assertNoJunkText(page, `${view} (${colorScheme})`);
        await shot(page, `phone-${colorScheme}-${view}`);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
