// Checks that the app's search as it is now returns what the approaches scored on the app as it was:
// the albums of "smart" (same rank for the wanted album, same top 5) and the artist of
// "smart+found-artist" (same MusicBrainz id). The app may show that artist under the name the records
// credit, so names that differ from MusicBrainz's are listed. Run: node check-app.js, with SMALL=1
// for 45s and 10" records.
'use strict';
process.env.OFFLINE = '1';
process.env.APP_SOURCE = 'worktree';
const e = require('./eval.js');
const { searchWith } = require('./appmb.js');
const { cases, holdout } = require('./cases.js');

const small = process.env.SMALL === '1' ? '-small' : '';
const main = require(`./results${small}.json`);
const fresh = require(`./results-holdout${small}.json`);
const smart = { ...main.smart, ...fresh.smart };

(async () => {
  let albums = 0;
  let artists = 0;
  let hits = 0;
  const renamed = [];
  const all = [...cases, ...holdout];
  for (const c of all) {
    const app = await searchWith(c.q);
    const s = e.score(c, { results: app });
    const top = app.slice(0, 5).map((r) => `${r.artist} - ${r.title}${r.year ? ` (${r.year})` : ''}`);
    const was = smart[c.id];
    if (s.rank === was.rank && s.hit === was.hit && JSON.stringify(top) === JSON.stringify(was.top)) albums += 1;
    else console.log('albums differ:', c.id, s.rank, was.rank);
    const [scored] = e.artistsInResults(app.raw, c.q);
    if ((app.artist ? app.artist.id : null) === (scored ? scored.id : null)) artists += 1;
    else console.log('artist differs:', c.id, app.artist, scored && scored.name);
    if (app.artist && scored && app.artist.name !== scored.name) renamed.push(`${c.q}: ${app.artist.name} (MusicBrainz: ${scored.name})`);
    if (e.score(c, { results: app, artists: app.artist ? [app.artist] : [] }, { artistRow: true }).hit) hits += 1;
  }
  console.log(`albums match smart for ${albums} of ${all.length}; artist matches smart+found-artist for ${artists} of ${all.length}; hits ${hits}`);
  for (const line of renamed) console.log(`  shown as credited: ${line}`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
