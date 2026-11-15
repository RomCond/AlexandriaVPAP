// Checks that the app's search as it is now returns what the approaches scored on the app as it was:
// the albums of "smart" (same rank for the wanted album, same top 5) and the artist row of
// "smart+found-artist". Run: node check-app.js
'use strict';
process.env.OFFLINE = '1';
process.env.APP_SOURCE = 'worktree';
const e = require('./eval.js');
const { searchWith } = require('./appmb.js');
const { cases, holdout } = require('./cases.js');

const main = require('./results.json');
const fresh = require('./results-holdout.json');
const smart = { ...main.smart, ...fresh.smart };
const rows = { ...main['smart+found-artist'], ...fresh['smart+found-artist'] };

(async () => {
  let albums = 0;
  let artists = 0;
  let hits = 0;
  const all = [...cases, ...holdout];
  for (const c of all) {
    const app = await searchWith(c.q);
    const s = e.score(c, { results: app });
    const top = app.slice(0, 5).map((r) => `${r.artist} - ${r.title}${r.year ? ` (${r.year})` : ''}`);
    const was = smart[c.id];
    if (s.rank === was.rank && s.hit === was.hit && JSON.stringify(top) === JSON.stringify(was.top)) albums += 1;
    else console.log('albums differ:', c.id, s.rank, was.rank);
    const row = app.artist ? [app.artist.name] : [];
    if (JSON.stringify(row) === JSON.stringify(rows[c.id].artists)) artists += 1;
    else console.log('artist row differs:', c.id, row, rows[c.id].artists);
    if (e.score(c, { results: app, artists: app.artist ? [app.artist] : [] }, { artistRow: true }).hit) hits += 1;
  }
  console.log(`albums match smart for ${albums} of ${all.length}; artist row matches smart+found-artist for ${artists} of ${all.length}; hits ${hits}`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
