// A MusicBrainz client for the search investigation. Every response is saved, trimmed to the fields
// the app reads, in cache.json.gz next to this file. Live calls go one at a time, at least 3 s apart,
// with the User-Agent MusicBrainz asks for. Set OFFLINE=1 to fail instead of fetching.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CACHE_FILE = process.env.CACHE_FILE || path.join(__dirname, 'cache.json.gz');
const GAP_MS = 3000;
const WAITS_MS = [2000, 4000, 8000, 16000, 32000];
const UA = 'recordcatalogapp-dev/0.1';

let cache = {};
if (fs.existsSync(CACHE_FILE)) cache = JSON.parse(zlib.gunzipSync(fs.readFileSync(CACHE_FILE)).toString('utf8'));
let lastLive = 0;
let live = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function save() {
  const sorted = Object.fromEntries(Object.keys(cache).sort().map((key) => [key, cache[key]]));
  fs.writeFileSync(CACHE_FILE, zlib.gzipSync(JSON.stringify(sorted)));
}

const credit = (c) => (c || []).map((p) => ({ name: p.name, joinphrase: p.joinphrase || '', artist: p.artist && { id: p.artist.id, name: p.artist.name } }));
const group = (g) => g && { id: g.id, title: g.title, 'primary-type': g['primary-type'], 'secondary-types': g['secondary-types'] || [] };

function trim(kind, data) {
  if (kind === 'release') {
    return {
      count: data.count,
      releases: (data.releases || []).map((r) => ({
        id: r.id, title: r.title, disambiguation: r.disambiguation, status: r.status, date: r.date, score: r.score,
        'release-group': group(r['release-group']), 'artist-credit': credit(r['artist-credit']),
        media: (r.media || []).map((m) => ({ format: m.format })),
      })),
    };
  }
  if (kind === 'artist') {
    return {
      count: data.count,
      artists: (data.artists || []).map((a) => ({
        id: a.id, name: a.name, 'sort-name': a['sort-name'], score: a.score, disambiguation: a.disambiguation, type: a.type, country: a.country,
        aliases: (a.aliases || []).map((x) => x.name),
      })),
    };
  }
  if (kind === 'release-group') {
    return {
      count: data.count, 'release-group-count': data['release-group-count'],
      'release-groups': (data['release-groups'] || []).map((g) => ({
        ...group(g), score: g.score, 'first-release-date': g['first-release-date'], disambiguation: g.disambiguation,
        'artist-credit': credit(g['artist-credit']), count: g.count,
      })),
    };
  }
  return data;
}

function keyOf(kind, params) {
  const p = new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
  return `${kind}?${p}`;
}

async function get(kind, params) {
  const key = keyOf(kind, params);
  if (cache[key]) return cache[key];
  if (process.env.OFFLINE) throw new Error(`Not cached: ${key}`);
  const url = new URL(kind, 'https://musicbrainz.org/ws/2/');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('fmt', 'json');
  for (let attempt = 0; ; attempt++) {
    const wait = lastLive + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastLive = Date.now();
    live += 1;
    let res = null;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    } catch (e) {
      res = null;
    }
    if (res && res.ok) {
      cache[key] = trim(kind, await res.json());
      save();
      return cache[key];
    }
    if (res && res.status !== 503) throw new Error(`MusicBrainz ${res.status} for ${key}: ${(await res.text()).slice(0, 200)}`);
    const backoff = WAITS_MS[attempt];
    if (backoff === undefined) throw new Error(`Gave up on ${key}`);
    process.stderr.write(`  ${res ? 503 : 'network error'}, retrying in ${backoff / 1000}s\n`);
    await sleep(backoff);
  }
}

module.exports = { get, liveCalls: () => live };
