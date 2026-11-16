const test = require('node:test');
const assert = require('node:assert/strict');
const mb = require('../js/musicbrainz.js');

const { field, formatFromMedia, mediaLabel, creditName } = mb.internals;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('search fields escape Lucene syntax and neutralize operators', () => {
  assert.equal(field('artist', 'AC/DC'), '(artist:"AC/DC"^3 OR artist:(ac\\/dc))');
  assert.equal(field('releasegroup', 'Love AND Theft'), '(releasegroup:"Love AND Theft"^3 OR releasegroup:(love and theft))');
  assert.equal(field('releasegroup', 'Say "Hi"'), '(releasegroup:"Say \\"Hi\\""^3 OR releasegroup:(say \\"hi\\"))');
});

test('a half-typed last word also matches as a prefix', () => {
  assert.equal(field('artist', 'radioh', true), '(artist:"radioh"^3 OR artist:(radioh radioh*))');
  assert.equal(field('artist', 'ok co', true), '(artist:"ok co"^3 OR artist:(ok co))');
});

test('looksLikeBarcode tells barcodes from numeric titles', () => {
  assert.equal(mb.looksLikeBarcode('0 724352 775324'), true);
  assert.equal(mb.looksLikeBarcode('5099-9029-5562-0'), true);
  assert.equal(mb.looksLikeBarcode('1989'), false);
  assert.equal(mb.looksLikeBarcode('radiohead 2000'), false);
});

test('formatFromMedia maps MusicBrainz media to collection formats', () => {
  assert.equal(formatFromMedia(['12" Vinyl'], 'Album'), 'LP');
  assert.equal(formatFromMedia(['12" Vinyl', '12" Vinyl'], 'Album'), 'Double LP');
  assert.equal(formatFromMedia(['Vinyl', 'Vinyl', 'Vinyl'], 'Album'), 'Box set');
  assert.equal(formatFromMedia(['7" Vinyl'], 'Single'), '45');
  assert.equal(formatFromMedia(['10" Vinyl'], 'Album'), '10"');
  assert.equal(formatFromMedia(['12" Vinyl'], 'Single'), '12" single');
  assert.equal(formatFromMedia(['12" Vinyl'], 'EP'), 'EP');
  assert.equal(formatFromMedia(['CD', 'Enhanced CD'], 'Album'), null, 'CDs are not a collection format');
  assert.equal(formatFromMedia(['Cassette'], 'Album'), null, 'nor are cassettes');
  assert.equal(formatFromMedia(['CD', '12" Vinyl'], 'Album'), null);
  assert.equal(formatFromMedia(['VinylDisc'], 'Album'), null);
  assert.equal(formatFromMedia(['Flexi-disc'], 'Single'), null);
  assert.equal(formatFromMedia([], 'Album'), null);
});

test('mediaLabel and creditName read like the sleeve', () => {
  assert.equal(mediaLabel(['12" Vinyl', '12" Vinyl', 'CD']), '2 x 12" Vinyl + CD');
  assert.equal(creditName([{ name: 'Simon', joinphrase: ' & ' }, { name: 'Garfunkel' }]), 'Simon & Garfunkel');
});

// A release as the release search returns it.
const pressing = (id, group, { title = group.title, note = '', status = 'Official', date = '', score = 100, formats = ['12" Vinyl'], artist = 'Radiohead' } = {}) => ({
  id, title, disambiguation: note, status, date, score,
  'release-group': { id: group.id, title: group.title, 'primary-type': group.type, 'secondary-types': group.secondary || [] },
  'artist-credit': [{ name: artist, artist: { id: 'a1', name: artist } }],
  media: formats.map((format) => ({ format })),
});

test('search looks for vinyl pressings and studio albums by title or artist name, and maps results', async (t) => {
  const calls = [];
  const okc = { id: 'rg1', title: 'OK Computer', type: 'Album' };
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(new URL(url));
    return jsonResponse({ releases: [pressing('r1', okc, { date: '1997-06-16' })] });
  });
  const { results } = await mb.search('radiohead ok comp');
  assert.equal(calls[0].pathname, '/ws/2/release');
  assert.equal(calls[0].searchParams.get('fmt'), 'json');
  assert.equal(calls[0].searchParams.get('query'),
    '((release:"radiohead ok comp"^3 OR release:(radiohead ok comp comp*))'
    + ' OR (artist:"radiohead ok comp"^3 OR artist:(radiohead ok comp comp*)))'
    + ' AND (format:(vinyl OR 12vinyl) OR primarytype:album)', 'LPs and 12" records (by default), plus studio albums');
  assert.deepEqual(results[0], {
    releaseGroupId: 'rg1',
    releaseId: null,
    title: 'OK Computer',
    deluxe: false,
    artist: 'Radiohead',
    artistId: 'a1',
    year: 1997,
    primaryType: 'Album',
    secondaryTypes: [],
    vinyl: true,
    formatHint: null,
    media: '',
  });
});

test('search shows each vinyl album or single once, and leaves out what never came out on vinyl', async (t) => {
  const okc = { id: 'okc', title: 'OK Computer', type: 'Album' };
  const creep = { id: 'creep', title: 'Creep', type: 'Single' };
  const sampler = { id: 'sampler', title: 'Promo Sampler', type: 'EP' };
  const bends = { id: 'bends', title: 'The Bends', type: 'Album' };
  const pablo = { id: 'pablo', title: 'Pablo Honey', type: 'Album' };
  const live = { id: 'live', title: 'I Might Be Wrong', type: 'Album', secondary: ['Live'] };
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    releases: [
      pressing('r1', okc, { date: '2008-08-19', score: 90 }),
      pressing('r2', okc, { date: '1997-06-16', score: 100 }), // the earliest pressing gives the year
      pressing('r3', creep, { date: '1992-09-21', formats: ['7" Vinyl'], score: 95 }),
      pressing('r4', sampler, { formats: ['CD'] }), // matched, but it's a CD
      pressing('r5', sampler, { status: 'Bootleg' }), // bootleg vinyl doesn't count
      pressing('r6', bends, { note: 'collector’s deluxe edition', date: '2009-03-24', score: 80 }),
      pressing('r7', bends, { date: '1995-03-13', score: 70 }),
      // Pablo Honey is a studio album with no vinyl in MusicBrainz: it still shows, unconfirmed,
      // dated by its earliest release. Its digital-only deluxe edition doesn't.
      pressing('r8', pablo, { date: '1993-02-22', formats: ['CD'], score: 60 }),
      pressing('r9', pablo, { date: '2009-08-31', formats: ['Digital Media'], note: 'deluxe edition', score: 60 }),
      pressing('r10', live, { formats: ['CD'], score: 60 }), // a live album without vinyl doesn't show
    ],
  }));
  const { results } = await mb.search('radiohead');
  assert.deepEqual(results.map((r) => [r.title, r.year, r.vinyl]), [
    ['OK Computer', 1997, true],
    ['The Bends (Deluxe Edition)', 2009, true],
    ['The Bends', 1995, true],
    ['Pablo Honey', 1993, false],
  ], 'Creep only came out on 45, so it is left out');

  // With 45s and 10" records turned on, the search asks for them and Creep shows up
  const calls = [];
  const fetchMock = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(new URL(url));
    return fetchMock(url);
  });
  const withSmall = await mb.search('radiohead', undefined, { small: true });
  assert.match(calls[0].searchParams.get('query'), /AND \(format:\(vinyl OR 12vinyl OR 7vinyl OR 10vinyl\) OR primarytype:album\)$/);
  assert.deepEqual(withSmall.results.map((r) => r.title), ['OK Computer', 'Creep', 'The Bends (Deluxe Edition)', 'The Bends', 'Pablo Honey']);
});

test('equal scores put plain albums first, then EPs and singles, oldest first', async (t) => {
  const group = (id, type, secondary) => ({ id, title: id, type, secondary });
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    releases: [
      pressing('r1', group('single', 'Single'), { date: '1992' }),
      pressing('r2', group('live', 'Album', ['Live']), { date: '1994' }),
      pressing('r3', group('later-album', 'Album'), { date: '2000' }),
      pressing('r4', group('ep', 'EP'), { date: '1993' }),
      pressing('r5', group('early-album', 'Album'), { date: '1993' }),
      pressing('r6', group('weaker-match', 'Album'), { date: '1990', score: 80 }),
    ],
  }));
  const { results } = await mb.search('radiohead');
  assert.deepEqual(results.map((r) => r.releaseGroupId), ['early-album', 'later-album', 'ep', 'single', 'live', 'weaker-match']);
});

test('a barcode in the search box looks up vinyl pressings only', async (t) => {
  const calls = [];
  const release = (id, note, ...formats) => ({ id, title: 'Pinkerton', disambiguation: note, 'release-group': { id: 'g1' }, media: formats.map((format) => ({ format })) });
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(new URL(url));
    return jsonResponse({
      releases: [
        release('r1', 'deluxe edition', '12" Vinyl'),
        release('r2', 'Japan', 'CD'),
        release('r3', '', 'Cassette'),
        release('r4', 'bundle', 'CD', '12" Vinyl'),
        release('r5', 'single', '7" Vinyl'),
      ],
    });
  });
  const { results, hiddenNonVinyl, hiddenSmall } = await mb.search('0 724352 775324');
  assert.equal(calls[0].pathname, '/ws/2/release');
  assert.equal(calls[0].searchParams.get('query'), 'barcode:0724352775324');
  assert.deepEqual(results.map((r) => r.releaseId), ['r1', 'r4'], 'the CD and the cassette are left out');
  assert.equal(hiddenNonVinyl, 2);
  assert.equal(hiddenSmall, 1, 'the 45 is left out unless 45s and 10" records are on');
  assert.deepEqual(results.map((r) => r.title), ['Pinkerton (deluxe edition)', 'Pinkerton'], 'only deluxe notes go in the title');
});

test('a cancelled search never reaches MusicBrainz', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse({ 'release-groups': [] }));
  const controller = new AbortController();
  const pending = mb.search('radiohead', controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(fetchMock.mock.callCount(), 0);
});

// The one-request-a-second queue's pauses end straight away, so these tests don't take half a minute.
function skipTheWait(t) {
  const waits = [];
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    waits.push(ms);
    callback();
    return 0;
  });
  return waits;
}

const MIN_GAP_MS = 1100;
const retryWaits = (waits) => waits.filter((ms) => ms > MIN_GAP_MS).map((ms) => ms / 1000);

// A release group, and a release as the release browse returns it with inc=media+release-groups.
const albumGroup = (id, { title = `Title ${id.slice(1)}`, type = 'Album', secondary = [], date = '2000' } = {}) => ({
  id, title, 'primary-type': type, 'secondary-types': secondary, 'first-release-date': date,
});
const browsed = (id, group, { status = 'Official', title = group.title, note = '', date = '' } = {}, ...formats) => ({
  id, status, title, disambiguation: note, date, 'release-group': group, media: formats.map((format) => ({ format })),
});

/*
 * Answers like MusicBrainz: the studio album search, the release group browse and the release
 * browse, which pages in a fixed order and keeps only the statuses asked for. Searching for
 * releases returns results that tie on score in a new order every time, as the real one does, and
 * at most 500 of them. pageSize makes the browse return fewer than asked, to show paging by count.
 */
function fakeDiscographyServer({ groups, studio = groups.filter((g) => g['primary-type'] === 'Album' && !g['secondary-types'].length), releases, pageSize = 100 }) {
  const calls = [];
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const fetch = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const params = u.searchParams;
    const offset = Number(params.get('offset') || 0);
    const limit = Math.min(Number(params.get('limit') || 25), pageSize);
    if (u.pathname === '/ws/2/release-group' && params.get('artist')) {
      return jsonResponse({ 'release-group-count': groups.length, 'release-groups': groups.slice(offset, offset + limit) });
    }
    if (u.pathname === '/ws/2/release-group') {
      return jsonResponse({ count: studio.length, 'release-groups': studio.slice(0, Number(params.get('limit'))) });
    }
    if (params.get('artist')) {
      const statuses = (params.get('status') || '').split('|');
      const kept = releases.filter((r) => !params.get('status') || statuses.includes((r.status || '').toLowerCase()));
      return jsonResponse({ 'release-count': kept.length, releases: kept.slice(offset, offset + limit) });
    }
    if (offset + limit > 500) return jsonResponse({ error: `Must retrieve at most 500 search results, not ${offset + limit}.` }, 400);
    const query = params.get('query');
    const found = releases.filter((r) => (query.includes('format:') ? formatsOfFake(r).some((f) => /Vinyl$/.test(f)) : /deluxe|expanded/i.test(`${r.title} ${r.disambiguation}`)));
    const shuffled = found.map((r) => [random(), r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
    return jsonResponse({ count: found.length, releases: shuffled.slice(offset, offset + limit) });
  };
  return { calls, fetch };
}
const formatsOfFake = (release) => (release.media || []).map((m) => m.format);

test('getDiscography shows studio albums first, then marks vinyl and finds deluxe editions in the browsed releases', async (t) => {
  const g = Array.from({ length: 10 }, (_, i) => albumGroup(`g${i}`, i === 6 ? { title: 'Title 6 (Deluxe Edition)' } : i === 1 ? { secondary: ['Live'] } : {}));
  const releases = [
    browsed('r1', g[0], {}, '12" Vinyl', '12" Vinyl'),
    browsed('r2', g[0], {}, '7" Vinyl'),
    browsed('r3', g[1], { status: 'Bootleg' }, '12" Vinyl'), // bootlegs don't count
    browsed('r4', g[2], {}, 'CD'),
    browsed('r5', g[3], {}, 'Flexi-disc'), // flexi-discs don't count
    browsed('r6', g[4], {}, 'VinylDisc'), // a CD/vinyl hybrid isn't a vinyl pressing
    browsed('r7', g[5], { status: 'Promotion' }, 'CD', 'Vinyl'),
    browsed('r8', g[6], {}, '12" Vinyl'), // an album that is itself a deluxe edition
    browsed('r9', g[7], { note: 'deluxe edition', date: '2010-11-02' }, '12" Vinyl'), // only the deluxe is on vinyl
    browsed('r10', g[7], { note: '2010 Deluxe Edition', date: '2010-11-01' }, 'CD', 'CD'),
    browsed('r11', g[8], { title: 'Title 8 (Expanded Edition)', date: '2004' }, 'CD'),
    browsed('r12', g[8], {}, '10" Vinyl'), // only on a 10"
    browsed('r13', g[9], { status: 'Bootleg', note: 'deluxe' }, '12" Vinyl'),
    browsed('r14', g[9], { status: null }, '12" Vinyl'), // no status in MusicBrainz: doesn't count
  ];
  const fake = fakeDiscographyServer({ groups: g, releases, pageSize: 5 });
  t.mock.method(globalThis, 'fetch', fake.fetch);
  skipTheWait(t);
  const progress = [];
  const result = await mb.getDiscography('a1', (p) => progress.push(p));

  assert.deepEqual(fake.calls.map((u) => `${u.pathname}@${u.searchParams.get('offset') || 0}`),
    ['/ws/2/release-group@0', '/ws/2/release@0', '/ws/2/release@5', '/ws/2/release@10']);
  assert.equal(fake.calls[0].searchParams.get('query'), 'arid:"a1" AND primarytype:album AND NOT secondarytype:[* TO *]');
  const browse = fake.calls[1].searchParams;
  assert.deepEqual([browse.get('artist'), browse.get('type'), browse.get('status'), browse.get('inc')],
    ['a1', 'album|ep|single', 'official|promotion', 'media+release-groups'], 'every size, so the 45s and 10" setting needs no reload');

  assert.deepEqual(progress.map(({ step, loaded, total }) => [step, loaded, total]),
    [['studio', 9, 9], ['vinyl', 5, 11], ['vinyl', 10, 11], ['vinyl', 11, 11]]);
  const first = progress[0].discography;
  assert.deepEqual(first.groups.map((group) => group.id), ['g0', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9'], 'the studio albums, before any vinyl is known');
  assert.ok(first.groups.every((group) => !group.vinyl && !group.small && !group.deluxe));

  const byId = new Map(result.groups.map((group) => [group.id, group]));
  const flags = (key) => ['g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9'].map((id) => Boolean(byId.get(id) && byId.get(id)[key]));
  assert.deepEqual(flags('vinyl'), [true, false, false, false, false, true, true, false, false, false], 'LP or 12" pressings');
  assert.deepEqual(flags('small'), [true, false, false, false, false, false, false, false, true, false], '45 or 10" pressings');
  assert.equal(byId.has('g1'), false, 'a group with only bootlegs waits for Vinyl only to be turned off');
  assert.deepEqual(byId.get('g7').deluxe, { title: 'Title 7 (Deluxe Edition)', date: '2010-11-01', vinyl: true, small: false, releaseIds: ['r9', 'r10'] });
  assert.deepEqual(byId.get('g8').deluxe, { title: 'Title 8 (Expanded Edition)', date: '2004', vinyl: false, small: false, releaseIds: ['r11'] });
  assert.equal(byId.get('g6').deluxe, null, 'an album that is already a deluxe edition gets no second deluxe line');
  assert.equal(byId.get('g9').deluxe, null, 'bootleg deluxe editions do not count');
  assert.deepEqual([result.total, result.truncated, result.vinylComplete, result.allGroups], [9, false, true, false]);
});

// Searching for vinyl and paging through the results used to lose about a fifth of the pressings,
// because MusicBrainz returns results that tie on score in a different order on every page.
test('getDiscography finds every pressing, though search results come back in a new order each time', async (t) => {
  const groups = Array.from({ length: 300 }, (_, i) => albumGroup(`g${i}`, { type: 'Single' }));
  const releases = groups.map((group, i) => browsed(`r${i}`, group, {}, '12" Vinyl'));
  const fake = fakeDiscographyServer({ groups, releases, studio: [] });
  t.mock.method(globalThis, 'fetch', fake.fetch);
  skipTheWait(t);
  const result = await mb.getDiscography('a1');
  assert.equal(result.groups.filter((group) => group.vinyl).length, 300, 'every single has its pressing');
});

test('an artist with more studio albums than one search page holds gets every group browsed first', async (t) => {
  const groups = Array.from({ length: 150 }, (_, i) => albumGroup(`g${i}`));
  const releases = [browsed('r1', groups[149], {}, '12" Vinyl')];
  const fake = fakeDiscographyServer({ groups, releases });
  t.mock.method(globalThis, 'fetch', fake.fetch);
  skipTheWait(t);
  const progress = [];
  const result = await mb.getDiscography('a1', (p) => progress.push([p.step, p.loaded, p.total]));
  assert.deepEqual(fake.calls.map((u) => `${u.pathname}@${u.searchParams.get('offset') || 0}`),
    ['/ws/2/release-group@0', '/ws/2/release-group@0', '/ws/2/release-group@100', '/ws/2/release@0']);
  assert.deepEqual(progress, [['groups', 100, 150], ['groups', 150, 150], ['vinyl', 1, 1]]);
  assert.equal(result.groups.length, 150);
  assert.equal(result.groups[149].vinyl, true);
  assert.deepEqual([result.total, result.truncated, result.allGroups], [150, false, true]);
});

test('addAllReleaseGroups adds the groups with no official release and keeps what was found', async (t) => {
  const groups = [albumGroup('g0'), albumGroup('g1', { secondary: ['Live'] }), albumGroup('g2', { type: 'Single' })];
  const fake = fakeDiscographyServer({ groups, releases: [] });
  t.mock.method(globalThis, 'fetch', fake.fetch);
  skipTheWait(t);
  const before = { groups: [{ id: 'g0', title: 'Title 0', vinyl: true, small: false, deluxe: null }], total: 1, truncated: false, vinylComplete: true, allGroups: false };
  const progress = [];
  const after = await mb.addAllReleaseGroups(before, 'a1', (p) => progress.push(p));
  assert.deepEqual(after.groups.map((group) => [group.id, group.vinyl]), [['g0', true], ['g1', false], ['g2', false]]);
  assert.deepEqual([after.total, after.truncated, after.vinylComplete, after.allGroups], [3, false, true, true]);
  assert.deepEqual(progress, [{ step: 'groups', loaded: 3, total: 3 }]);
  assert.equal(before.groups.length, 1, 'the discography passed in is left as it was');
});

test('a discography load that is cancelled stops asking MusicBrainz', async (t) => {
  const groups = [albumGroup('g0')];
  const fake = fakeDiscographyServer({ groups, releases: [browsed('r1', groups[0], {}, '12" Vinyl')] });
  t.mock.method(globalThis, 'fetch', fake.fetch);
  skipTheWait(t);
  const controller = new AbortController();
  const pending = mb.getDiscography('a1', ({ step }) => step === 'studio' && controller.abort(), { signal: controller.signal });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(fake.calls.length, 1, 'the release browse never went out');
});

test('a burst of 503s is waited out, longer each time', async (t) => {
  const answers = [503, 503, 503, 503, 200];
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse({ artists: [{ id: 'low' }] }, answers.shift()));
  const waits = skipTheWait(t);
  const found = await mb.searchArtists('Low');
  assert.equal(found[0].id, 'low');
  assert.equal(fetchMock.mock.callCount(), 5);
  assert.deepEqual(retryWaits(waits), [2, 4, 8, 16]);
});

test('a dropped connection is tried again, including one cut off partway through the response', async (t) => {
  const answers = [
    () => { throw new TypeError('Failed to fetch'); },
    () => ({ ...jsonResponse({}), json: async () => { throw new TypeError('terminated'); } }),
    () => jsonResponse({ artists: [{ id: 'low' }] }),
  ];
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => answers.shift()());
  const waits = skipTheWait(t);
  const found = await mb.searchArtists('Low');
  assert.equal(found[0].id, 'low');
  assert.equal(fetchMock.mock.callCount(), 3);
  assert.deepEqual(retryWaits(waits), [2, 4]);
});

test('a long discography load rides out 503s and dropped connections', async (t) => {
  const groups = Array.from({ length: 250 }, (_, i) => albumGroup(`g${i}`, { type: 'Single' }));
  const fake = fakeDiscographyServer({ groups, releases: groups.map((group, i) => browsed(`r${i}`, group, {}, '7" Vinyl')), studio: [] });
  let call = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    call += 1;
    if ([2, 3, 4].includes(call)) return jsonResponse({}, 503);
    if (call === 6) throw new TypeError('Failed to fetch');
    return fake.fetch(url);
  });
  const waits = skipTheWait(t);
  const result = await mb.getDiscography('a1');
  assert.equal(result.groups.filter((group) => group.small).length, 250);
  assert.equal(result.vinylComplete, true);
  assert.deepEqual(retryWaits(waits), [2, 4, 8, 2]);
});

test('network errors that never stop give up after 5 attempts and about 30 seconds', async (t) => {
  const waits = skipTheWait(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(mb.searchArtists('Low'), /Couldn't reach MusicBrainz/);
  assert.equal(fetchMock.mock.callCount(), 5);
  assert.deepEqual(retryWaits(waits), [2, 4, 8, 16]);
});

test('503s that never stop give up after 5 attempts and say MusicBrainz is busy', async (t) => {
  skipTheWait(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse({}, 503));
  await assert.rejects(mb.searchArtists('Low'), /MusicBrainz is busy/);
  assert.equal(fetchMock.mock.callCount(), 5);
});

test('an error other than 503 is not tried again', async (t) => {
  skipTheWait(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse({}, 400));
  await assert.rejects(mb.searchArtists('Low'), /error \(400\)/);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('on a device that says it is offline, a network error gives up after the first wait', async (t) => {
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
  t.after(() => delete navigator.onLine);
  const waits = skipTheWait(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(mb.searchArtists('Low'), /Couldn't reach MusicBrainz/);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(retryWaits(waits), [2]);
});

test('a search cancelled while it waits to try again stops at once', async (t) => {
  const controller = new AbortController();
  let answeredAt = 0;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    answeredAt = Date.now();
    setTimeout(() => controller.abort(), 50);
    return jsonResponse({}, 503);
  });
  await assert.rejects(mb.search('radiohead', controller.signal), { name: 'AbortError' });
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.ok(Date.now() - answeredAt < 1000, 'it does not sit out the 2-second wait');
});

test('a search cancelled while another request waits to try again stops at once', async (t) => {
  const answers = [503, 200];
  let busy;
  const answeredBusy = new Promise((resolve) => { busy = resolve; });
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (!new URL(url).pathname.endsWith('/artist')) return jsonResponse({ 'release-groups': [] });
    const status = answers.shift();
    if (status === 503) setTimeout(busy, 50);
    return jsonResponse({ artists: [] }, status);
  });
  const backingOff = mb.searchArtists('Low');
  await answeredBusy;
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = mb.search('radiohead', controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  const took = Date.now() - startedAt;
  await backingOff;
  assert.ok(took < 500, 'it does not wait for the other request to try again');
});

test('searchAlbumCandidates searches by artist and title, then by alias when the name finds nothing', async (t) => {
  const calls = [];
  const group = { id: 'rg9', title: 'SEYCHELLES', 'primary-type': 'Album', 'first-release-date': '1976-07-25', 'artist-credit': [{ name: '高中正義', artist: { id: 'mt' } }] };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    if (parsed.pathname.endsWith('/artist')) return jsonResponse({ artists: [{ id: 'mt', score: 100 }, { id: 'other', score: 40 }] });
    const query = parsed.searchParams.get('query');
    return jsonResponse({ 'release-groups': query.startsWith('arid:') ? [group] : [] });
  });
  const found = await mb.searchAlbumCandidates('Masayoshi Takanaka', 'Seychelles');
  assert.equal(calls[0].searchParams.get('query'),
    '(artist:"Masayoshi Takanaka"^3 OR artist:(masayoshi~ takanaka~))'
    + ' AND ((releasegroup:"Seychelles"^3 OR releasegroup:(seychelles~)) OR (alias:"Seychelles"^3 OR alias:(seychelles~)))');
  assert.equal(calls[1].searchParams.get('query'), 'alias:"Masayoshi Takanaka" OR artist:"Masayoshi Takanaka"');
  assert.match(calls[2].searchParams.get('query'), /^arid:\("mt"\) AND /, 'only artists that clearly match');
  assert.deepEqual(found, [{
    releaseGroupId: 'rg9', title: 'SEYCHELLES', artist: '高中正義', artistId: 'mt', year: 1976, primaryType: 'Album', secondaryTypes: [], artistFound: true,
  }]);
});
