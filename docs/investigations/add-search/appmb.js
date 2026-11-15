// Loads the app's own js/musicbrainz.js with fetch pointed at the cache, so the baseline and every
// query variant go through the app's real grouping and sorting code. withQuery(fn) swaps the Lucene
// query the app builds for fn(text) while keeping everything else the same.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mbcache = require('./mbcache');

const source = fs.readFileSync(path.join(__dirname, '../../../js/musicbrainz.js'), 'utf8')
  // The cache does its own pacing, so the app's queue doesn't need to wait between cached replies.
  .replace('const MIN_GAP_MS = 1100;', 'const MIN_GAP_MS = 0;');

let rewrite = null;
let lastRaw = null;

async function fakeFetch(url) {
  const u = new URL(url);
  const kind = u.pathname.replace('/ws/2/', '');
  const params = Object.fromEntries([...u.searchParams].filter(([k]) => k !== 'fmt'));
  if (rewrite && params.query) params.query = rewrite(params.query);
  const data = await mbcache.get(kind, params);
  lastRaw = data;
  return { ok: true, status: 200, json: async () => data };
}

const sandbox = { module: { exports: {} }, fetch: fakeFetch, URL, DOMException, setTimeout, clearTimeout, console };
vm.runInNewContext(source, sandbox, { filename: 'musicbrainz.js' });
const mb = sandbox.module.exports;

// Runs the app's release search, with the query built by queryFor(text) when it's given. The raw
// MusicBrainz reply rides along on the results as .raw, for re-ranking.
async function searchWith(text, queryFor) {
  rewrite = queryFor ? () => queryFor(text) : null;
  try {
    const results = await mb.searchReleaseGroups(text, undefined, false);
    Object.defineProperty(results, 'raw', { value: lastRaw });
    return results;
  } finally {
    rewrite = null;
  }
}

module.exports = { mb, searchWith };
