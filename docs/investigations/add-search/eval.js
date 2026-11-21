// Runs each search approach on the query set and scores it.
//   node eval.js                 every approach, fetching what isn't cached yet
//   node eval.js current boosted just those approaches
//   OFFLINE=1 node eval.js       rescore from the cache only
// A case looking for an album is a hit when that album is in the top 3. A case browsing an artist is
// a hit when the top 3 are all that artist's records. "Rank" is where the album (or, for an artist,
// the deeper album) first shows up, if at all.
'use strict';
const fs = require('fs');
const path = require('path');
const mbcache = require('./mbcache');
const { searchWith } = require('./appmb');
const sets = require('./cases');

// SET=holdout runs the second query set and writes results-holdout.json instead.
const HOLDOUT = process.env.SET === 'holdout';
const cases = HOLDOUT ? sets.holdout : sets.cases;
const truth = require('./truth.json');

// ---------- Lucene pieces, written like js/musicbrainz.js ----------

const esc = (w) => w.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, '\\$1');
const words = (text) => text.toLowerCase().split(/\s+/).filter(Boolean).map(esc);
const phrase = (text) => `"${text.trim().replace(/["\\]/g, '\\$&')}"`;
// SMALL=1 counts 45s and 10" records too, like the app's "Include 45s and 10" records".
const SMALL = process.env.SMALL === '1';
const VINYL = `(format:(vinyl OR 12vinyl${SMALL ? ' OR 7vinyl OR 10vinyl' : ''}) OR primarytype:album)`;

// One word's forms: as typed, as a prefix when it's the half-typed last word, and with one typo allowed.
// The app only treats a last word of 3 letters or more as a prefix; shortPrefix drops that limit, which
// is safe where the other words have to match too ("dark side of the mo").
function forms(word, { prefix, fuzzy, shortPrefix }) {
  const out = [word];
  if (prefix && (word.length >= 3 || shortPrefix)) out.push(`${word}*`);
  if (fuzzy && word.length >= 4 && /^[\p{L}\p{N}]+$/u.test(word)) out.push(`${word}~1`);
  return out.join(' ');
}

// The app's field(): the whole text as a phrase, or any of its words.
function field(name, text, opts = {}) {
  const ws = words(text);
  const loose = ws.map((w, i) => forms(w, { prefix: i === ws.length - 1, fuzzy: opts.fuzzy })).join(' ');
  return `(${name}:${phrase(text)}^3 OR ${name}:(${loose}))`;
}

// Every word has to turn up in one of the fields, in any order: "radiohead kid" needs "radiohead"
// somewhere and "kid" somewhere.
function allWords(fields, text, opts = {}) {
  const ws = words(text);
  return `(${ws.map((w, i) => {
    const f = forms(w, { prefix: i === ws.length - 1, fuzzy: opts.fuzzy, shortPrefix: opts.shortPrefix });
    return `(${fields.map((name) => `${name}:(${f})`).join(' OR ')})`;
  }).join(' AND ')})`;
}

// ---------- Approaches ----------
// Each takes a case and returns { results } (albums, best first), and for the two-step ones also
// { artists } (the artist list a person would pick from).

const releaseSearch = (text, query) => searchWith(text, () => query);

const approaches = {
  // Today's search, through the app's own code.
  current: { box: 'single', run: (c) => searchWith(c.q) },

  // Every word must match the title or the artist.
  allwords: {
    box: 'single',
    run: (c) => releaseSearch(c.q, `(release:${phrase(c.q)}^3 OR artist:${phrase(c.q)}^3 OR ${allWords(['release', 'artist'], c.q)}) AND ${VINYL}`),
  },

  // Today's query, plus a strong boost for results where every word matched somewhere.
  boosted: {
    box: 'single',
    run: (c) => releaseSearch(c.q, `(${field('release', c.q)} OR ${field('artist', c.q)} OR ${allWords(['release', 'artist'], c.q)}^4) AND ${VINYL}`),
  },

  // The same, with one typo allowed per word of four letters or more inside the every-word part.
  'boosted+fuzzy': {
    box: 'single',
    run: (c) => releaseSearch(c.q, `(${field('release', c.q)} OR ${field('artist', c.q)} OR ${allWords(['release', 'artist'], c.q, { fuzzy: true })}^4) AND ${VINYL}`),
  },

  // Artist toggle, sending only the artist field.
  'toggle:artist-field': {
    box: 'artist',
    run: (c) => releaseSearch(c.artistText, `${field('artist', c.artistText)} AND ${VINYL}`),
  },

  // Album toggle, sending only the title field.
  'toggle:album-field': {
    box: 'album',
    run: (c) => releaseSearch(c.albumText, `${field('release', c.albumText)} AND ${VINYL}`),
  },

  // Artist toggle as two steps: a list of artists to pick from, then that artist's discography, which
  // lists every album. A hit means the right artist is in the first three to pick from.
  'toggle:artist-pick': {
    box: 'artist',
    pickOnly: true,
    run: async (c) => ({ results: [], artists: await artistLookup(c.artistText) }),
  },
  'toggle:artist-pick-wide': {
    box: 'artist',
    pickOnly: true,
    run: async (c) => ({ results: [], artists: await artistLookupWide(c.artistText) }),
  },

  // Everything that helped, in one call: the every-word boost with a typo allowed and a short last
  // word as a prefix, release notes searched too ("blue album"), then the popularity re-rank.
  smart: {
    box: 'single',
    run: async (c) => rerank(await releaseSearch(c.q, smartQuery(c.q, 1)), 5),
  },

  // The same with the artist field weighed three times as much.
  'smart+artist-boost': {
    box: 'single',
    run: async (c) => rerank(await releaseSearch(c.q, smartQuery(c.q, 3)), 5),
  },

  // The smart list plus a row on top for an artist whose name is the start or end of what was typed.
  // The row needs a second call, so it would show a second or so after the albums.
  'smart+artist-row': {
    box: 'single',
    artistRow: true,
    run: async (c) => {
      const results = await approaches.smart.run(c);
      return { results, artists: artistRows(await artistLookup(c.q), c.q) };
    },
  },

  // The smart list plus one artist row taken from the albums it found, with no second call: the
  // artist with the most pressings among those whose name is the start or end of what was typed.
  'smart+found-artist': {
    box: 'single',
    artistRow: true,
    run: async (c) => {
      const results = await approaches.smart.run(c);
      return { results, artists: artistsInResults(results.raw, c.q).slice(0, 1) };
    },
  },

  // Album toggle with the same ranking fixes as smart, so the toggle isn't judged on today's ranking.
  'toggle:album-smart': {
    box: 'album',
    run: async (c) => {
      const t = c.albumText;
      const opts = { fuzzy: true, shortPrefix: true };
      return rerank(await releaseSearch(t, `(${field('release', t, opts)} OR ${allWords(['release', 'comment'], t, opts)}^4) AND ${VINYL}`), 5);
    },
  },
};

function smartQuery(text, artistWeight) {
  const opts = { fuzzy: true, shortPrefix: true };
  const artist = artistWeight === 1 ? field('artist', text) : `${field('artist', text)}^${artistWeight}`;
  return `(${field('release', text)} OR ${artist} OR ${allWords(['release', 'artist', 'comment'], text, opts)}^4) AND ${VINYL}`;
}

// Re-ranks an approach's albums without another call. MusicBrainz scores text only, so a tribute
// album titled "Radiohead" can outscore Radiohead's own records. How many of the 100 pressings an
// album has is a fair sign of how well known it is: each album's best score gets weight * ln(pressings).
function popular(baseName, weight) {
  return {
    box: 'single',
    offline: true,
    run: async (c) => rerank(await approaches[baseName].run(c), weight),
  };
}

function rerank(results, weight) {
  const stats = new Map();
  for (const release of results.raw.releases || []) {
    const id = release['release-group'] && release['release-group'].id;
    if (!id || ['Bootleg', 'Pseudo-Release'].includes(release.status)) continue;
    const s = stats.get(id) || { n: 0, score: 0 };
    s.n += 1;
    s.score = Math.max(s.score, release.score || 0);
    stats.set(id, s);
  }
  const key = (r) => {
    const s = stats.get(r.releaseGroupId) || { n: 1, score: 0 };
    return s.score + weight * Math.log(s.n);
  };
  const out = results.map((r, i) => ({ r, i, k: key(r) })).sort((a, b) => b.k - a.k || a.i - b.i).map((x) => x.r);
  Object.defineProperty(out, 'raw', { value: results.raw });
  return out;
}

approaches['current+pop'] = popular('current', 5);
approaches['boosted+fuzzy+pop'] = popular('boosted+fuzzy', 5);

// Two steps in the single box: look up an artist first. When one's name is the start or end of what
// was typed, search only their records for the other words (or list their albums when nothing is
// left or nothing matches). Otherwise fall back to smart. Both calls happen one after the other.
approaches['two-step'] = {
  box: 'single',
  run: async (c) => {
    const rows = artistRows(await artistLookup(c.q), c.q);
    if (!rows.length) return { results: await approaches.smart.run(c), artists: [] };
    const [best] = rows;
    if (best.rest) {
      const opts = { fuzzy: true, shortPrefix: true };
      const found = await releaseSearch(best.rest, `arid:"${best.id}" AND ${allWords(['release', 'comment'], best.rest, opts)} AND ${VINYL}`);
      if (found.length) return { results: rerank(found, 5), artists: rows };
    }
    return { results: await artistAlbums(best.id), artists: rows };
  },
};

// Artist toggle, then the album list of the artist picked. The person taps the right artist when it's
// in the first three; the album list is the one-call list above, not the full discography.
approaches['toggle:artist-then-albums'] = {
  box: 'artist',
  run: async (c) => {
    const artists = await artistLookup(c.artistText);
    const picked = artists.slice(0, 3).find((a) => a.id === artistId(c));
    return { results: picked ? await artistAlbums(picked.id) : [], artists };
  },
};


// Artists by name, alias or sort name, allowing one typo per longer word. Today's app searches the
// name only, so "takanaka" can't find 高中正義. This wide version turned out to bury short names:
// "low" brings up Jonathan Low (sort name "Low, Jonathan") and no band Low in the first ten.
async function artistLookupWide(text) {
  const opts = { fuzzy: true };
  const query = `${field('artist', text, opts)} OR ${field('alias', text, opts)} OR ${field('sortname', text, opts)}`;
  const data = await mbcache.get('artist', { query, limit: 10 });
  return data.artists || [];
}

// The app's name search, with one typo allowed, plus an alias that contains the whole text.
async function artistLookup(text) {
  const query = `${field('artist', text, { fuzzy: true })} OR alias:${phrase(text)}`;
  const data = await mbcache.get('artist', { query, limit: 10 });
  return data.artists || [];
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

// The names a person might type for an artist: the name, its aliases, either without a leading
// "The", and a person's surname ("bowie").
function namesOf(artist) {
  const names = new Set();
  const sort = (artist['sort-name'] || '').split(',').map((s) => s.trim()).reverse().join(' ');
  for (const raw of [artist.name, sort, ...(artist.aliases || [])]) {
    const n = norm(raw);
    if (!n) continue;
    names.add(n);
    names.add(n.replace(/^the /, ''));
    const parts = n.split(' ');
    if (artist.type === 'Person' && parts.length > 1) names.add(parts[parts.length - 1]);
  }
  return names;
}

// Artists whose name is the whole text, or the words at its start or end, allowing one typo in a
// name of five letters or more. At most two rows, best match first.
// Each row keeps rest, the words that weren't the artist's name.
function artistRows(artists, text) {
  const ws = norm(text).split(' ').filter(Boolean);
  const runs = [];
  for (let k = ws.length; k >= 1; k--) {
    runs.push({ run: ws.slice(0, k).join(' '), rest: ws.slice(k).join(' ') });
    if (k < ws.length) runs.push({ run: ws.slice(ws.length - k).join(' '), rest: ws.slice(0, ws.length - k).join(' ') });
  }
  const close = (run, name) => run === name || (name.length >= 5 && distance(run, name) <= 1);
  const rows = [];
  for (const artist of artists) {
    const names = namesOf(artist);
    const found = runs.find(({ run }) => [...names].some((name) => close(run, name)));
    if (found) rows.push({ ...artist, ...found, words: found.run.split(' ').length });
  }
  return rows.sort((a, b) => b.words - a.words || b.score - a.score).slice(0, 2);
}

// The same matching, but over the artists credited on the pressings a search already returned, most
// pressings first. Names come from the credit and the artist; a two-word name also matches by a last
// word of 4 letters or more ("bowie", "takanaka"). Longer names don't, or "Greenhouse Effect vs.
// Radiohead" would match "radiohead", and nor do short last words, or "Toner Low" would match "low".
function artistsInResults(raw, text) {
  const byId = new Map();
  for (const release of raw.releases || []) {
    const part = (release['artist-credit'] || [])[0];
    if (!part || !part.artist || ['Bootleg', 'Pseudo-Release'].includes(release.status)) continue;
    const a = byId.get(part.artist.id) || { id: part.artist.id, name: part.artist.name, n: 0, forms: new Set() };
    a.n += 1;
    for (const name of [part.name, part.artist.name]) {
      const n = norm(name);
      if (!n) continue;
      a.forms.add(n);
      a.forms.add(n.replace(/^the /, ''));
      const parts = n.split(' ');
      if (parts.length === 2 && parts[1].length >= 4) a.forms.add(parts[1]);
    }
    byId.set(a.id, a);
  }
  const ws = norm(text).split(' ').filter(Boolean);
  const runs = [];
  for (let k = ws.length; k >= 1; k--) {
    runs.push(ws.slice(0, k).join(' '));
    if (k < ws.length) runs.push(ws.slice(ws.length - k).join(' '));
  }
  const close = (run, name) => run === name || (name.length >= 5 && distance(run, name) <= 1);
  const rows = [];
  for (const a of byId.values()) {
    const run = runs.find((r) => [...a.forms].some((name) => close(r, name)));
    if (run) rows.push({ id: a.id, name: a.name, n: a.n, words: run.split(' ').length });
  }
  return rows.sort((x, y) => y.n - x.n || y.words - x.words);
}

// An artist's vinyl pressings and studio albums, grouped by the app: the list a two-step search shows
// once it knows the artist. One call, at most 100 pressings, so big catalogs come back incomplete.
const artistAlbums = (id) => releaseSearch(id, `arid:"${id}" AND ${VINYL}`);

// ---------- Scoring ----------

const norm = (s) => (s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function artistId(c) {
  const id = truth.artists[c.artist];
  if (!id) throw new Error(`No artist id for ${c.artist}`);
  return id;
}

function isAlbum(result, c, title) {
  if (result.artistId !== artistId(c)) return false;
  if (c.rg && title === c.title) return result.releaseGroupId === truth.releaseGroups[c.rg];
  return norm(result.title) === norm(title);
}

function rankOf(results, test) {
  const i = results.findIndex(test);
  return i < 0 ? null : i + 1;
}

// Which input a case gives an approach, or null when the approach doesn't apply to the case.
function inputFor(approach, c) {
  if (approach.box === 'single') return c.q;
  if (approach.box === 'artist') return c.artistText;
  if (approach.box === 'album') return c.title ? c.albumText : null;
  return null;
}

// pickOnly: the hit is the right artist among the first three to pick from.
// artistRow: an artist-only case is a hit when the artist row is right; an album case still needs
// the album in the top 3 of the list.
// Each score carries cell, the short text for the results tables: an album's rank ("none" when
// missing), "2/3" for how many of the top 3 are the artist's, or the artist's place in a list to pick
// from. Hits are bold.
function score(c, out, approach = {}) {
  const results = out.results || [];
  const artistRank = out.artists ? rankOf(out.artists, (a) => a.id === artistId(c)) : null;
  const bold = (hit, text) => (hit ? `**${text}**` : text);
  if (approach.pickOnly) {
    const hit = artistRank !== null && artistRank <= 3;
    return { hit, rank: null, artistRank, count: out.artists.length, cell: bold(hit, artistRank ? `artist ${artistRank}` : 'no artist') };
  }
  // An artist row naming someone else is noise above the albums, so it's counted.
  const wrongRow = approach.artistRow ? out.artists.some((a) => a.id !== artistId(c)) : undefined;
  if (c.title) {
    const rank = rankOf(results, (r) => isAlbum(r, c, c.title));
    const hit = rank !== null && rank <= 3;
    return { hit, rank, artistRank, wrongRow, count: results.length, cell: bold(hit, rank || 'none') + (wrongRow ? ' (wrong row)' : '') };
  }
  const byArtist = results.slice(0, 3).filter((r) => r.artistId === artistId(c)).length;
  const deep = rankOf(results, (r) => isAlbum(r, c, c.deep));
  if (approach.artistRow) {
    const hit = artistRank !== null;
    return { hit, byArtist, rank: deep, artistRank, wrongRow, count: results.length, cell: bold(hit, hit ? 'artist row' : `no row, ${byArtist}/3`) + (wrongRow ? ' (+ wrong row)' : '') };
  }
  const hit = byArtist === 3 && results.length >= 3;
  return { hit, byArtist, rank: deep, artistRank, count: results.length, cell: bold(hit, `${byArtist}/3`) };
}

async function main() {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(approaches);
  const report = {};
  for (const name of names) {
    const approach = approaches[name];
    if (!approach) throw new Error(`No approach called ${name}`);
    process.stderr.write(`${name}\n`);
    report[name] = {};
    for (const c of cases) {
      const input = inputFor(approach, c);
      if (input === null) continue;
      const out = await approach.run(c, input);
      const normalized = Array.isArray(out) ? { results: out } : out;
      report[name][c.id] = {
        input,
        ...score(c, normalized, approach),
        top: normalized.results.slice(0, 5).map((r) => `${r.artist} - ${r.title}${r.year ? ` (${r.year})` : ''}`),
        artists: normalized.artists && normalized.artists.slice(0, 3).map((a) => a.name),
      };
    }
  }
  const file = path.join(__dirname, `results${HOLDOUT ? '-holdout' : ''}${SMALL ? '-small' : ''}.json`);
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, `${JSON.stringify({ ...previous, ...report }, null, 1)}\n`);
  for (const [name, byCase] of Object.entries(report)) {
    const rows = Object.values(byCase);
    console.log(`${name}: ${rows.filter((r) => r.hit).length}/${rows.length} hits`);
  }
  process.stderr.write(`live calls: ${mbcache.liveCalls()}\n`);
}

if (require.main === module) main().catch((e) => {
  console.error(e);
  process.exit(1);
});

module.exports = { approaches, field, allWords, words, phrase, forms, VINYL, norm, score, artistId, isAlbum, rankOf, rerank, artistLookup, artistRows, artistsInResults };
