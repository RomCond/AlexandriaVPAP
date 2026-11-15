// Offline. Counts the requests each loading strategy needs for each measured artist, and checks
// what each one gets right, using the releases the live runs recorded in data/.
//   node scripts/discography-speed/simulate.mjs
// No network. The app's own getDiscography runs against a fake MusicBrainz built from the
// complete release lists, so its request count comes from the real code.
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const mb = require('../../js/musicbrainz.js');
const S = require('../../js/store.js');

const GAP_S = 1.1;
const LAST_YEAR = 2027; // the app searches up to next year
const ARTISTS = [
  { slug: 'bowie', name: 'David Bowie', id: '5441c29d-3602-4898-b1a1-b77fa23b8e50' },
  { slug: 'beatles', name: 'The Beatles', id: 'b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d' },
];

// The big data files are gzipped. probes.json is not.
const load = (name) => {
  const file = join(here, 'data', name);
  if (existsSync(`${file}.gz`)) return JSON.parse(gunzipSync(readFileSync(`${file}.gz`)).toString('utf8'));
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
};

// ---------- The search index, rebuilt from the complete release lists ----------

// The search index files a release under its earliest release event, which isn't always the
// date the API shows first ("2021" for a release first out in 2019).
const yearOf = (r) => {
  const dates = [...(r.events || []), r.date].filter(Boolean);
  return dates.length ? Math.min(...dates.map((d) => Number(d.slice(0, 4)))) : null;
};
const squash = (format) => (format || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const VINYL_TERMS = ['vinyl', '12vinyl', '7vinyl', '10vinyl'];
const LARGE_TERMS = ['vinyl', '12vinyl'];

// Which releases a search part matches: { kind, terms, nodate, from, to, country, notCountries }.
function matches(release, part) {
  if (part.kind === 'deluxe') {
    if (!release.kinds.includes('deluxe')) return false;
  } else {
    const terms = part.terms || VINYL_TERMS;
    if (!release.kinds.includes('vinyl') || !release.formats.some((f) => terms.includes(squash(f)))) return false;
  }
  const year = yearOf(release);
  if (part.nodate && year !== null) return false;
  if (part.from !== undefined || part.to !== undefined) {
    if (year === null) return false;
    if (part.from != null && year < part.from) return false;
    if (part.to != null && year > part.to) return false;
  }
  return true;
}

// Parses the app's own queries back into parts, for the fake server.
function partOf(query) {
  const part = { kind: /deluxe/.test(query) ? 'deluxe' : 'vinyl' };
  const formats = /format:\(([^)]*)\)/.exec(query) || /format:(\w+)/.exec(query);
  if (formats) part.terms = formats[1].split(' OR ');
  if (/NOT date:\[\* TO \*\]/.test(query)) part.nodate = true;
  else {
    const range = /date:\[(\S+) TO (\S+)\]/.exec(query);
    if (range) {
      part.from = range[1] === '*' ? null : Number(range[1]);
      part.to = range[2] === '*' ? null : Number(range[2]);
    }
  }
  return part;
}

const apiRelease = (r) => ({
  id: r.id, title: r.title, disambiguation: r.note, status: r.status, date: r.date,
  media: r.formats.map((format) => ({ format })),
  'release-group': r.group && { id: r.group.id, title: r.group.title, 'primary-type': r.group.primaryType, 'secondary-types': r.group.secondaryTypes },
});
const apiGroup = (g) => ({ id: g.id, title: g.title, 'first-release-date': g.date, 'primary-type': g.primaryType, 'secondary-types': g.secondaryTypes });

// A MusicBrainz that answers like the real one, except that results come in a stable order.
function fakeMusicBrainz(groups, releases) {
  const calls = [];
  const json = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
  const fetch = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const offset = Number(u.searchParams.get('offset') || 0);
    const limit = Number(u.searchParams.get('limit') || 25);
    if (u.pathname.endsWith('/release-group')) {
      return json({ 'release-group-count': groups.length, 'release-groups': groups.slice(offset, offset + limit).map(apiGroup) });
    }
    if (offset + limit > 500) return json({ error: `Must retrieve at most 500 search results, not ${offset + limit}.` }, 400);
    const part = partOf(u.searchParams.get('query'));
    const found = releases.filter((r) => matches(r, part));
    return json({ count: found.length, releases: found.slice(offset, offset + limit).map(apiRelease) });
  };
  return { calls, fetch };
}

// The app's queue waits 1.1 s between calls. Offline there's nothing to wait for.
globalThis.setTimeout = (callback) => {
  setImmediate(callback);
  return 0;
};

async function appDiscography(artist, groups, releases) {
  const fake = fakeMusicBrainz(groups, releases);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    const result = await mb.getDiscography(artist.id);
    const phase = (u) => (u.pathname.endsWith('/release-group') ? 'groups' : /deluxe/.test(u.searchParams.get('query')) ? 'deluxe' : 'vinyl');
    const count = (name) => fake.calls.filter((u) => phase(u) === name).length;
    return { result, requests: fake.calls.length, groups: count('groups'), vinyl: count('vinyl'), deluxe: count('deluxe') };
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------- Splitting a search until every part fits on one page of 100 ----------

const FORMAT_SPLIT = ['vinyl', '12vinyl', '7vinyl', '10vinyl'];

// Requests to collect every release of a kind with no paging, halving year ranges from the full span
// (the app's current shape), or starting from decades (what complete-search.mjs did live).
function splitCost(releases, { kind = 'vinyl', terms, start = 'halving' } = {}) {
  let requests = 0;
  const count = (part) => {
    requests += 1;
    return releases.filter((r) => matches(r, { kind, terms, ...part })).length;
  };
  const leaf = (part) => {
    // A year with more than 100: one query per format, then per country (estimated as 3 parts).
    for (const format of kind === 'vinyl' ? (terms || FORMAT_SPLIT) : []) {
      if (count({ ...part, terms: [format] }) > 100) requests += 3;
    }
  };
  const years = (from, to) => {
    if (count({ from, to }) <= 100) return;
    const a = from ?? 1900;
    const b = to ?? LAST_YEAR;
    if (a < b) {
      const middle = Math.floor((a + b) / 2);
      years(from, middle);
      years(middle + 1, to);
    } else leaf({ from, to });
  };
  if (count({}) <= 100) return requests;
  if (count({ nodate: true }) > 100) leaf({ nodate: true });
  if (start === 'decades') {
    for (const [from, to] of [[null, 1959], [1960, 1969], [1970, 1979], [1980, 1989], [1990, 1999], [2000, 2009], [2010, 2019], [2020, null]]) years(from, to);
  } else years(null, null);
  return requests;
}

// The fewest one-page queries when the year counts are already known, say from the last load:
// consecutive years packed into parts of at most 100. A busier year needs its own split.
function packedCost(releases, { kind = 'vinyl', terms } = {}) {
  const mine = releases.filter((r) => matches(r, { kind, terms }));
  const perYear = new Map();
  for (const r of mine) perYear.set(yearOf(r), (perYear.get(yearOf(r)) || 0) + 1);
  let parts = 0;
  let open = 0;
  const years = [...perYear.keys()].filter((y) => y !== null).sort((a, b) => a - b);
  for (const y of years) {
    const n = perYear.get(y);
    if (n > 100) {
      parts += Math.ceil(n / 90) + 1; // its own split, by format and country
      continue;
    }
    if (open + n > 100) {
      parts += 1;
      open = 0;
    }
    open += n;
  }
  if (open) parts += 1;
  const undated = perYear.get(null) || 0;
  parts += undated ? Math.ceil(undated / 100) : 0;
  return parts;
}

// ---------- What a strategy gets right ----------

// Lines that differ between two discographies, under the default view (studio albums, Vinyl only,
// no 45s) and with every type turned on.
function compare(truth, other) {
  const lines = (disco) => {
    const { items } = S.compareDiscography(disco.groups, [], { id: 'x', name: 'x' });
    return new Map(items.map((item) => [item.key, item]));
  };
  const a = lines(truth);
  const b = lines(other);
  const show = (item, allTypes) => item && (item.vinyl || (item.edition === 'standard' && S.categoryOf(item.group) === 'album')) && (allTypes || S.categoryOf(item.group) === 'album');
  const label = (item) => item && item.edition === 'standard' && S.categoryOf(item.group) === 'album' && !item.vinyl;
  const keys = new Set([...a.keys(), ...b.keys()]);
  const out = { defaultView: { missingLines: 0, extraLines: 0, wrongLabel: 0 }, allTypes: { missingLines: 0, extraLines: 0 }, vinylFlags: 0, smallFlags: 0, deluxeLines: 0 };
  for (const key of keys) {
    const x = a.get(key);
    const y = b.get(key);
    if (Boolean(x && x.vinyl) !== Boolean(y && y.vinyl)) out.vinylFlags += 1;
    if (Boolean(x && x.small) !== Boolean(y && y.small)) out.smallFlags += 1;
    if (key.endsWith(':deluxe') && Boolean(x) !== Boolean(y)) out.deluxeLines += 1;
    for (const [view, allTypes] of [['defaultView', false], ['allTypes', true]]) {
      if (show(x, allTypes) && !show(y, allTypes)) out[view].missingLines += 1;
      if (!show(x, allTypes) && show(y, allTypes)) out[view].extraLines += 1;
    }
    if (show(x, false) && show(y, false) && label(x) !== label(y)) out.defaultView.wrongLabel += 1;
  }
  return out;
}

// ---------- Report ----------

const seconds = (requests) => `${(requests * GAP_S).toFixed(1)} s`;
const row = (cells) => `| ${cells.join(' | ')} |`;

for (const artist of ARTISTS) {
  const current = load(`${artist.slug}.json`);
  const complete = load(`${artist.slug}-complete.json`);
  const probes = load('probes.json') || {};
  const browse = probes[`${artist.slug}-browse-media`];
  const studio = probes[`${artist.slug}-studio-rg`];
  if (!current || !complete) {
    console.log(`\n## ${artist.name}: missing data, skipped`);
    continue;
  }
  const releases = complete.releases;
  const vinyl = releases.filter((r) => r.kinds.includes('vinyl'));
  const deluxe = releases.filter((r) => r.kinds.includes('deluxe'));
  const groups = current.groups;

  // The live counts for every query complete-search.mjs made must match the rebuilt index.
  // Country isn't recorded per release, and the parts split further by status or half year all
  // filter by country, so those counts can't be checked.
  const checkable = complete.queries.filter((q) => !(q.part.country || q.part.notCountries || q.part.days || q.part.official !== undefined));
  const mismatches = checkable.filter((q) => {
    const part = { ...q.part, terms: q.part.format ? [q.part.format] : undefined };
    return releases.filter((r) => matches(r, part)).length !== q.count;
  });
  const liveAppQueries = current.requests.filter((r) => r.status === 200 && r.path.endsWith('/release'));
  const appMismatches = liveAppQueries.filter((r) => releases.filter((x) => matches(x, partOf(r.params.query))).length !== r.count);

  const app = await appDiscography(artist, groups, releases);
  const truth = app.result;
  const liveFound = new Set(current.vinylReleases.map((r) => r.id));
  const liveDiff = compare(truth, current.result);

  const largeOnly = vinyl.filter((r) => r.formats.some((f) => LARGE_TERMS.includes(squash(f))));
  const groupPages = Math.ceil(groups.length / 100);
  const studioCount = studio ? studio.count : null;
  const releaseCount = browse ? browse.count : null;
  const deluxeCost = splitCost(releases, { kind: 'deluxe' });
  const liveOk = current.requests.filter((r) => r.status === 200).length;

  console.log(`\n## ${artist.name}`);
  console.log(`release groups ${groups.length}, vinyl releases ${vinyl.length} (LP or 12" ${largeOnly.length}), deluxe releases ${deluxe.length}, all releases ${releaseCount}, studio albums ${studioCount}`);
  console.log(`check: ${checkable.length - mismatches.length}/${checkable.length} complete-search counts (${complete.queries.length - checkable.length} more filter by country) and ${liveAppQueries.length - appMismatches.length}/${liveAppQueries.length} app query counts match the rebuilt index`);
  for (const q of [...mismatches, ...appMismatches].slice(0, 5)) console.log('  mismatch', JSON.stringify(q.part || q.params.query), q.count);
  console.log(`live app run: ${liveOk} requests (${current.requests.length - liveOk} 503s left out), found ${liveFound.size} of ${vinyl.length} vinyl releases (${Math.round((100 * liveFound.size) / vinyl.length)}%)`);
  console.log(`live app run vs complete data: ${JSON.stringify(liveDiff)}`);
  console.log(`app on stable data: ${app.requests} requests (groups ${app.groups}, vinyl ${app.vinyl}, deluxe ${app.deluxe})`);

  const sizes = Object.fromEntries([...new Set(vinyl.map(yearOf))].sort().map((y) => [y, vinyl.filter((r) => yearOf(r) === y).length]));
  console.log(`vinyl releases per year: ${JSON.stringify(sizes)}`);

  const filtered = probes[`${artist.slug}-browse-aes-offpromo`];
  const filteredCount = filtered ? filtered.count : null;
  const allStatuses = probes[`${artist.slug}-browse-aes`];
  const browsed = load(`${artist.slug}-browse.json`);
  if (browsed) {
    // A discography built only from browsing releases: release groups come from the releases.
    const DELUXE = /\b(deluxe|expanded)\b/i;
    const byGroup = new Map();
    for (const r of browsed.releases) if (r.group.id && !byGroup.has(r.group.id)) byGroup.set(r.group.id, r.group);
    const browseGroups = [...byGroup.values()];
    const asSearch = browsed.releases.map((r) => ({
      ...r,
      kinds: [
        ...(r.formats.some((f) => VINYL_TERMS.includes(squash(f))) ? ['vinyl'] : []),
        ...(DELUXE.test(`${r.title} ${r.note}`) ? ['deluxe'] : []),
      ],
    })).filter((r) => r.kinds.length);
    const fromBrowse = await appDiscography(artist, browseGroups, asSearch);
    const groupIds = new Set(groups.map((g) => g.id));
    const missingGroups = groups.filter((g) => !byGroup.has(g.id));
    const truthLines = new Map(truth.groups.map((g) => [g.id, g]));
    const visibleMissing = missingGroups.filter((g) => {
      const t = truthLines.get(g.id);
      return (t && t.vinyl) || S.categoryOf(g) === 'album';
    });
    const pageSizes = [...new Set(browsed.pages.map((p) => p.returned))];
    console.log(`browse (${browsed.status || 'all statuses'}): ${browsed.pages.length} requests, page sizes ${pageSizes.join('/')}, most tracks on a page ${Math.max(...browsed.pages.map((p) => p.tracks))}`);
    console.log(`browse release groups: ${browseGroups.length} (${browseGroups.filter((g) => !groupIds.has(g.id)).length} not in the group browse), group browse ones missing: ${missingGroups.length}, of them studio albums or on vinyl: ${visibleMissing.length} ${JSON.stringify(visibleMissing.map((g) => g.title))}`);
    // Same release groups for both, so only the vinyl and deluxe flags differ.
    const withGroups = await appDiscography(artist, groups, asSearch);
    console.log(`browse flags vs complete search: ${JSON.stringify(compare(truth, withGroups.result))}`);
    console.log(`browse only vs complete search: ${JSON.stringify(compare(truth, fromBrowse.result))}`);
    // Option F: the studio album search first, then the browse. Its release groups are both sets.
    if (studio) {
      const known = new Map(groups.map((g) => [g.id, g]));
      const studioGroups = studio.ids.map((id) => known.get(id)).filter(Boolean);
      const union = [...browseGroups, ...studioGroups.filter((g) => !byGroup.has(g.id))];
      const studioFirst = await appDiscography(artist, union, asSearch);
      console.log(`studio search then browse vs complete search: ${JSON.stringify(compare(truth, studioFirst.result))}`);
    }
  }
  if (studio) {
    const fromBrowse = new Set(groups.filter((g) => S.categoryOf(g) === 'album').map((g) => g.id));
    const fromSearch = new Set(studio.ids);
    console.log(`studio album search: ${fromSearch.size} (all on one page: ${studio.returned === studio.count}), group browse: ${fromBrowse.size}, only in search ${[...fromSearch].filter((id) => !fromBrowse.has(id)).length}, only in browse ${[...fromBrowse].filter((id) => !fromSearch.has(id)).length}`);
  }

  const strategies = [
    ['A. Today: browse groups, vinyl and deluxe search paged to 500', app.requests, null],
    ['B. Search split until each part fits one page, as complete-search.mjs ran it', groupPages + complete.queries.length, groupPages],
    ['B2. Same, halving years from 1900 (country splits estimated)', groupPages + splitCost(releases) + deluxeCost, groupPages],
    ['C. Search split with year counts kept from the last load (estimated)', groupPages + packedCost(releases) + deluxeCost, groupPages],
    ['D. Browse albums, EPs and singles of any status with inc=media+release-groups', allStatuses ? Math.ceil(allStatuses.count / 100) : null, null],
    ['D2. Browse official and promo albums, EPs and singles only', filteredCount ? Math.ceil(filteredCount / 100) : null, null],
    ['D3. D2 plus the release group browse', filteredCount ? groupPages + Math.ceil(filteredCount / 100) : null, groupPages],
    ['E. Search split, LP and 12" only until the 45s chip is on (estimated)', groupPages + splitCost(releases, { terms: LARGE_TERMS, start: 'decades' }) + deluxeCost, groupPages],
    ['F. Studio albums first (one search), then D2', filteredCount ? 1 + Math.ceil(filteredCount / 100) : null, 1],
  ];
  console.log(row(['strategy', 'requests', 'time at 1.1 s', 'first list after']));
  for (const [name, requests, first] of strategies) {
    console.log(row([name, requests ?? 'n/a', requests ? seconds(requests) : 'n/a', first ? `${first} (${seconds(first)})` : 'end']));
  }
}
