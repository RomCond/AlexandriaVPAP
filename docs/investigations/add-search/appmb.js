// Loads the app's own js/musicbrainz.js with fetch pointed at the cache, so the baseline and every
// query variant go through the app's real grouping and sorting code. withQuery(fn) swaps the Lucene
// query the app builds for fn(text) while keeping everything else the same.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const mbcache = require('./mbcache');

// The approaches are measured on the app as it was before this investigation (commit bf604df), so
// "current" stays today's search after the app changes. APP_SOURCE=worktree loads js/musicbrainz.js
// as it is now instead, to check that the app does what an approach scored.
const APP_SOURCE = process.env.APP_SOURCE || 'bf604df';
const original = APP_SOURCE === 'worktree'
  ? fs.readFileSync(path.join(__dirname, '../../../js/musicbrainz.js'), 'utf8')
  : execFileSync('git', ['show', `${APP_SOURCE}:js/musicbrainz.js`], { cwd: __dirname, encoding: 'utf8' });

// The cache does its own pacing, so the app's queue doesn't need to wait between cached replies.
const source = original.replace('const MIN_GAP_MS = 1100;', 'const MIN_GAP_MS = 0;');

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
// MusicBrainz reply rides along on the results as .raw, for re-ranking. The app now also names an
// artist for the row above the albums; that rides along as .artist (undefined on the old app).
// SMALL=1 searches with 45s and 10" records on.
async function searchWith(text, queryFor) {
  rewrite = queryFor ? () => queryFor(text) : null;
  try {
    const out = await mb.searchReleaseGroups(text, undefined, process.env.SMALL === '1');
    const results = Array.isArray(out) ? out : out.results;
    Object.defineProperty(results, 'raw', { value: lastRaw });
    if (!Array.isArray(out)) Object.defineProperty(results, 'artist', { value: out.artist });
    return results;
  } finally {
    rewrite = null;
  }
}

module.exports = { mb, searchWith };
