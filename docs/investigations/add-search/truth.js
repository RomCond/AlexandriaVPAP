// Prints the top artist matches for each artist in the query set, through the app's own artist
// search, so the right MusicBrainz ids can be picked by hand and written into truth.json.
'use strict';
const { mb } = require('./appmb');
const { cases } = require('./cases');

(async () => {
  const names = [...new Set(cases.map((c) => c.artist))];
  for (const name of names) {
    const found = await mb.searchArtists(name.toLowerCase());
    console.log(`\n${name}`);
    for (const a of found.slice(0, 4)) console.log(`  ${a.score}  ${a.id}  ${a.name}  (${[a.disambiguation, a.type, a.country].filter(Boolean).join(', ')})`);
  }
})();
