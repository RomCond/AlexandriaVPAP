// Runs the app's own getDiscography against live MusicBrainz and records every request.
//   NODE_USE_ENV_PROXY=1 node scripts/discography-speed/measure-current.mjs <artist-mbid> <slug>
// Writes data/<slug>.json.gz: every request (503s included), the release groups and every release
// MusicBrainz returned, and what getDiscography made of them. The simulation reads that file.
// MB_MODULE=<absolute path> runs another copy of musicbrainz.js, such as the loader before the change.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { instrumentedFetch } from './mbclient.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const mb = require(process.env.MB_MODULE || '../../js/musicbrainz.js');
mkdirSync(join(here, 'data'), { recursive: true });

const [artistId, slug] = process.argv.slice(2);
if (!artistId || !slug) throw new Error('usage: measure-current.mjs <artist-mbid> <slug>');

const requests = [];
const responses = [];
// groups and browse page through the database; studio, vinyl and deluxe are searches.
const phaseOf = (url) => {
  const u = new URL(url);
  const query = u.searchParams.get('query') || '';
  if (u.pathname.endsWith('/release-group')) return query ? 'studio' : 'groups';
  if (!query) return 'browse';
  return /deluxe/.test(query) ? 'deluxe' : 'vinyl';
};

// Other agents share this machine's address, so MusicBrainz answers many requests with 503. Those
// are retried here, patiently and out of the app's sight. busyMs is the time spent on them. It
// overlaps the app's own 1.1 s gaps, so wall time minus busyMs undercounts a run without 503s.
const BUSY_WAITS_MS = [3000, 6000, 12000, 20000, 30000, 45000, 60000, 60000];
let busyMs = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let currentUrl = '';
const doFetch = instrumentedFetch((entry) => requests.push(entry), () => phaseOf(currentUrl));
globalThis.fetch = async (url, options) => {
  currentUrl = String(url);
  let res = await doFetch(currentUrl, options);
  for (const wait of BUSY_WAITS_MS) {
    if (res.status !== 503) break;
    const busyStart = Date.now();
    await sleep(wait);
    res = await doFetch(currentUrl, options);
    busyMs += Date.now() - busyStart;
  }
  if (res.status === 200) responses.push({ phase: phaseOf(currentUrl), params: Object.fromEntries(new URL(currentUrl).searchParams), data: res.data });
  return res;
};

const progress = [];
const started = Date.now();
// The new loader hands over what it has so far. The time and request count of the first such
// report is when the list can first show.
const answered = () => requests.filter((r) => r.status === 200).length;
const result = await mb.getDiscography(artistId, ({ step, loaded, total, discography }) => {
  progress.push({ ms: Date.now() - started, requests: answered(), step, loaded, total, shows: Boolean(discography) });
});
const wallMs = Date.now() - started;

const compactRelease = (r) => ({
  id: r.id,
  title: r.title || '',
  note: r.disambiguation || '',
  status: r.status || null,
  date: r.date || '',
  events: (r['release-events'] || []).map((e) => e.date || ''),
  formats: (r.media || []).map((m) => m.format || null),
  group: r['release-group'] ? {
    id: r['release-group'].id,
    title: r['release-group'].title,
    primaryType: r['release-group']['primary-type'] || null,
    secondaryTypes: r['release-group']['secondary-types'] || [],
  } : null,
});

const groups = [];
const releases = { vinyl: new Map(), deluxe: new Map(), browse: new Map() };
const searchPages = [];
for (const { phase, params, data } of responses) {
  if (phase === 'studio') continue;
  if (phase === 'groups') {
    for (const g of data['release-groups'] || []) {
      groups.push({ id: g.id, title: g.title, date: g['first-release-date'] || '', primaryType: g['primary-type'] || null, secondaryTypes: g['secondary-types'] || [] });
    }
    continue;
  }
  searchPages.push({ phase, query: params.query, offset: Number(params.offset), count: data.count, ids: (data.releases || []).map((r) => r.id) });
  for (const r of data.releases || []) releases[phase].set(r.id, compactRelease(r));
}

const out = {
  artistId,
  slug,
  measuredAt: new Date(started).toISOString(),
  wallMs,
  busyMs,
  requests,
  progress,
  groups,
  searchPages,
  vinylReleases: [...releases.vinyl.values()],
  deluxeReleases: [...releases.deluxe.values()],
  browseReleases: [...releases.browse.values()],
  result,
};
const file = join(here, 'data', `${slug}.json.gz`);
writeFileSync(file, gzipSync(JSON.stringify(out)));

const ok = requests.filter((r) => r.status === 200);
const byPhase = Object.fromEntries(['studio', 'groups', 'browse', 'vinyl', 'deluxe'].map((phase) => [phase, ok.filter((r) => r.tag === phase).length]));
const firstList = progress.find((p) => p.shows);
console.log(JSON.stringify({
  slug,
  wallSeconds: wallMs / 1000,
  requests: ok.length,
  busy503s: requests.filter((r) => r.status === 503).length,
  otherErrors: requests.filter((r) => r.status !== 200 && r.status !== 503).map((r) => r.status),
  byPhase,
  firstListAfterRequests: firstList ? firstList.requests : ok.length,
  releaseGroups: result.groups.length,
  vinylGroups: result.groups.filter((g) => g.vinyl).length,
  vinylComplete: result.vinylComplete,
  medianMs: ok.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(ok.length / 2)],
  maxMs: Math.max(...ok.map((r) => r.ms)),
}, null, 2));
console.log(`wrote ${file}`);
