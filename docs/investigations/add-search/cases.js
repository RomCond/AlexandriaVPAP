// The query set. q is what someone types into today's single box. artistText and albumText are what
// they would type with an Artist or Album toggle instead. A case with a title is looking for that
// album; a case without one is browsing the artist, and deep is an album further down the catalog
// that should still be reachable. truth.js looks up the MusicBrainz ids that tell the right artist and album apart.
'use strict';


const cases = [
  // Artist only
  { id: 'radiohead', q: 'radiohead', kind: 'Artist only', artist: 'Radiohead', artistText: 'radiohead', deep: 'Hail to the Thief' },
  { id: 'miles', q: 'miles davis', kind: 'Artist only, huge catalog', artist: 'Miles Davis', artistText: 'miles davis', deep: 'In a Silent Way' },
  { id: 'television', q: 'television', kind: 'Short or common name', artist: 'Television', artistText: 'television', deep: 'Adventure' },
  { id: 'low', q: 'low', kind: 'Short or common name', artist: 'Low', artistText: 'low', deep: 'Things We Lost in the Fire' },
  { id: 'yes', q: 'yes', kind: 'Short or common name', artist: 'Yes', artistText: 'yes', deep: 'Close to the Edge' },
  { id: 'can', q: 'can', kind: 'Short or common name', artist: 'Can', artistText: 'can', deep: 'Tago Mago' },
  { id: 'thethe', q: 'the the', kind: '"The The"', artist: 'The The', artistText: 'the the', deep: 'Soul Mining' },
  // Album only
  { id: 'okc', q: 'ok computer', kind: 'Album only', artist: 'Radiohead', title: 'OK Computer', albumText: 'ok computer', artistText: 'radiohead' },
  { id: 'rumours', q: 'rumours', kind: 'Album only', artist: 'Fleetwood Mac', title: 'Rumours', albumText: 'rumours', artistText: 'fleetwood mac' },
  // Artist plus album
  { id: 'rhkid', q: 'radiohead kid', kind: 'Artist plus album (README example)', artist: 'Radiohead', title: 'Kid A', albumText: 'kid', artistText: 'radiohead' },
  { id: 'aja', q: 'steely dan aja', kind: 'Artist plus album', artist: 'Steely Dan', title: 'Aja', albumText: 'aja', artistText: 'steely dan' },
  { id: 'kidarh', q: 'kid a radiohead', kind: 'Album then artist', artist: 'Radiohead', title: 'Kid A', albumText: 'kid a', artistText: 'radiohead' },
  { id: 'tago', q: 'can tago mago', kind: 'Short name plus album', artist: 'Can', title: 'Tago Mago', albumText: 'tago mago', artistText: 'can' },
  { id: 'soulmining', q: 'the the soul mining', kind: '"The The" plus album', artist: 'The The', title: 'Soul Mining', albumText: 'soul mining', artistText: 'the the' },
  { id: 'bowielow', q: 'bowie low', kind: 'Album named like another artist', artist: 'David Bowie', title: 'Low', albumText: 'low', artistText: 'bowie' },
  // Self-titled
  { id: 'weezer', q: 'weezer', kind: 'Self-titled', artist: 'Weezer', title: 'Weezer', rg: 'blue', albumText: 'weezer', artistText: 'weezer' },
  { id: 'weezerblue', q: 'weezer blue', kind: 'Self-titled, with its nickname', artist: 'Weezer', title: 'Weezer', rg: 'blue', albumText: 'weezer', artistText: 'weezer' },
  { id: 'boston', q: 'boston', kind: 'Self-titled', artist: 'Boston', title: 'Boston', albumText: 'boston', artistText: 'boston' },
  // Half-typed and typos
  { id: 'okcomp', q: 'ok comp', kind: 'Half-typed (README example)', artist: 'Radiohead', title: 'OK Computer', albumText: 'ok comp', artistText: 'radiohead' },
  { id: 'dsotm', q: 'dark side of the mo', kind: 'Half-typed', artist: 'Pink Floyd', title: 'The Dark Side of the Moon', albumText: 'dark side of the mo', artistText: 'pink floyd' },
  { id: 'puppets', q: 'metalica master of puppets', kind: 'Typo in artist', artist: 'Metallica', title: 'Master of Puppets', albumText: 'master of puppets', artistText: 'metalica' },
  { id: 'radiohed', q: 'radiohed ok computer', kind: 'Typo in artist', artist: 'Radiohead', title: 'OK Computer', albumText: 'ok computer', artistText: 'radiohed' },
  { id: 'rumors', q: 'fleetwod mac rumors', kind: 'Two typos', artist: 'Fleetwood Mac', title: 'Rumours', albumText: 'rumors', artistText: 'fleetwod mac' },
  // Names MusicBrainz spells differently
  { id: 'takanaka', q: 'takanaka rainbow goblins', kind: 'Non-Latin name (高中正義)', artist: 'Masayoshi Takanaka', title: '虹伝説 THE RAINBOW GOBLINS', albumText: 'rainbow goblins', artistText: 'takanaka' },
  { id: 'kino', q: 'кино группа крови', kind: 'Cyrillic', artist: 'Кино', title: 'Группа крови', albumText: 'группа крови', artistText: 'кино' },
  { id: 'sigur', q: 'sigur ros agaetis', kind: 'Accents left off (Sigur Rós, Ágætis byrjun)', artist: 'Sigur Rós', title: 'Ágætis byrjun', albumText: 'agaetis', artistText: 'sigur ros' },
];

// A second set, written after the rules above were tuned and never used to tune them. It checks that
// the gains aren't just fitted to the first set.
const holdout = [
  { id: 'h-portishead', q: 'portishead', kind: 'Artist only', artist: 'Portishead', artistText: 'portishead', deep: 'Third' },
  { id: 'h-chic', q: 'chic', kind: 'Short or common name', artist: 'Chic', artistText: 'chic', deep: 'Risqué' },
  { id: 'h-nevermind', q: 'nevermind', kind: 'Album only', artist: 'Nirvana', title: 'Nevermind', albumText: 'nevermind', artistText: 'nirvana' },
  { id: 'h-abbey', q: 'abbey road', kind: 'Album only', artist: 'The Beatles', title: 'Abbey Road', albumText: 'abbey road', artistText: 'beatles' },
  { id: 'h-petsounds', q: 'pet sounds', kind: 'Album only', artist: 'The Beach Boys', title: 'Pet Sounds', albumText: 'pet sounds', artistText: 'beach boys' },
  { id: 'h-revolver', q: 'beatles revolver', kind: 'Artist plus album, no "The"', artist: 'The Beatles', title: 'Revolver', albumText: 'revolver', artistText: 'beatles' },
  { id: 'h-joni', q: 'joni mitchell blue', kind: 'Artist plus a common word', artist: 'Joni Mitchell', title: 'Blue', albumText: 'blue', artistText: 'joni mitchell' },
  { id: 'h-autobahn', q: 'kraftwerk autobahn', kind: 'Artist plus album', artist: 'Kraftwerk', title: 'Autobahn', albumText: 'autobahn', artistText: 'kraftwerk' },
  { id: 'h-remain', q: 'talking heads remain in li', kind: 'Half-typed', artist: 'Talking Heads', title: 'Remain in Light', albumText: 'remain in li', artistText: 'talking heads' },
  { id: 'h-bjork', q: 'bjork homogenic', kind: 'Accent left off (Björk)', artist: 'Björk', title: 'Homogenic', albumText: 'homogenic', artistText: 'bjork' },
];

module.exports = { cases, holdout };
