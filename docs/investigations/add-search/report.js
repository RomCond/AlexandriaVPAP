// Prints the markdown tables for add-search.md from results.json.
//   node report.js cases                    the query set
//   node report.js summary <approach...>    hit rates by kind of query
//   node report.js matrix <approach...>     one row per query, one column per approach
//   node report.js detail <approach>        one approach's top 3 for every query
'use strict';
// SET=holdout reads the second query set's results.
const HOLDOUT = process.env.SET === 'holdout';
const results = require(HOLDOUT ? './results-holdout.json' : './results.json');
const sets = require('./cases');
const cases = HOLDOUT ? sets.holdout : sets.cases;

const GROUPS = {
  'Artist only': ['radiohead', 'miles', 'television', 'low', 'yes', 'can', 'thethe'],
  'Album only': ['okc', 'rumours'],
  'Artist plus album': ['rhkid', 'aja', 'kidarh', 'tago', 'soulmining', 'bowielow'],
  'Self-titled': ['weezer', 'weezerblue', 'boston'],
  'Typos, half-typed': ['okcomp', 'dsotm', 'puppets', 'radiohed', 'rumors'],
  'Other scripts, accents': ['takanaka', 'kino', 'sigur'],
};

const md = (s) => String(s).replace(/\|/g, '\\|');

// Toggles as a whole: someone browsing an artist sets Artist and types the name; someone after an
// album sets Album and types the title. Each pair names the approach for each kind of case. This
// assumes the person always picks the right toggle and leaves out the other words.
const COMBOS = {
  'toggles (today\'s ranking)': { artist: 'toggle:artist-field', album: 'toggle:album-field' },
  'toggles (pick artist / smart album)': { artist: 'toggle:artist-pick', album: 'toggle:album-smart' },
};
for (const [name, { artist, album }] of Object.entries(COMBOS)) {
  if (!results[artist] || !results[album]) continue;
  results[name] = Object.fromEntries(cases.map((c) => [c.id, c.title ? results[album][c.id] : results[artist][c.id]]));
}

const cell = (row) => (row ? row.cell : 'n/a');

function summary(names) {
  if (HOLDOUT) {
    console.log('| Approach | Hits |\n|---|---:|');
    for (const name of names) {
      const rows = Object.values(results[name]);
      console.log(`| ${name} | ${rows.filter((r) => r.hit).length}/${rows.length} |`);
    }
    return;
  }
  const head = ['Approach', 'All', ...Object.keys(GROUPS)];
  console.log(`| ${head.join(' | ')} |`);
  console.log(`|${head.map((_, i) => (i ? '---:' : '---')).join('|')}|`);
  for (const name of names) {
    const byCase = results[name];
    const count = (ids) => {
      const rows = ids.map((id) => byCase[id]).filter(Boolean);
      return rows.length ? `${rows.filter((r) => r.hit).length}/${rows.length}` : 'n/a';
    };
    console.log(`| ${name} | ${count(cases.map((c) => c.id))} | ${Object.values(GROUPS).map(count).join(' | ')} |`);
  }
}

function matrix(names) {
  console.log(`| Query | ${names.join(' | ')} |`);
  console.log(`|---|${names.map(() => '---:').join('|')}|`);
  for (const c of cases) console.log(`| \`${md(c.q)}\` | ${names.map((n) => cell(results[n][c.id])).join(' | ')} |`);
}

function detail(name) {
  console.log('| Query | Typed | Result | Top 3 |');
  console.log('|---|---|---:|---|');
  for (const c of cases) {
    const row = results[name][c.id];
    if (!row) continue;
    const shown = row.top.length ? row.top.slice(0, 3) : (row.artists || []).slice(0, 3).map((a) => `Artist: ${a}`);
    const artistRow = row.top.length && row.artists && row.artists.length ? [`Artist row: ${row.artists.join(', ')}`] : [];
    console.log(`| ${c.id} | \`${md(row.input)}\` | ${cell(row)} | ${[...artistRow, ...shown].map(md).join('<br>') || 'nothing'} |`);
  }
}

function querySet() {
  console.log('| Query | Kind | Wanted | Artist toggle | Album toggle |');
  console.log('|---|---|---|---|---|');
  for (const c of cases) {
    const wanted = c.title ? `${c.artist}, *${c.title}*${c.rg ? ` (the ${c.rg} album)` : ''}` : `${c.artist}'s records (deeper: *${c.deep}*)`;
    console.log(`| \`${md(c.q)}\` | ${md(c.kind)} | ${md(wanted)} | \`${md(c.artistText)}\` | ${c.title ? `\`${md(c.albumText)}\`` : 'n/a'} |`);
  }
}

const [mode, ...names] = process.argv.slice(2);
if (mode === 'cases') querySet();
else if (mode === 'summary') summary(names);
else if (mode === 'matrix') matrix(names);
else if (mode === 'detail') names.forEach(detail);
else console.error('node report.js summary|matrix|detail <approach...>');
