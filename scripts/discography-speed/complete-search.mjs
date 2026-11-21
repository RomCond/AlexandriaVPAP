// Collects every vinyl and deluxe release of an artist through search, splitting each query until
// it has at most 100 results. A query that fits in one page is complete. Paging deeper is not:
// MusicBrainz returns results that tie on score in a different order from one request to the next.
//   NODE_USE_ENV_PROXY=1 node scripts/discography-speed/complete-search.mjs <artist-mbid> <slug>
// Writes data/<slug>-complete.json.gz: every query with its count, and every release found.
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { get, logTo } from './mbclient.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [artistId, slug] = process.argv.slice(2);
if (!artistId || !slug) throw new Error('usage: complete-search.mjs <artist-mbid> <slug>');
mkdirSync(join(here, 'data'), { recursive: true });
const log = logTo(join(here, 'data', `${slug}-complete.jsonl`));

const FORMATS = ['vinyl', '12vinyl', '7vinyl', '10vinyl'];
const DELUXE = '(release:(deluxe OR expanded) OR comment:(deluxe OR expanded))';
const LAST_YEAR = new Date().getFullYear() + 1;
// A year and format with more than 100 is split by country, with one part for everywhere else.
const COUNTRIES = ['GB', 'US', 'DE', 'JP', 'FR', 'NL', 'IT', 'CA', 'AU', 'SE', 'ES'];
const DECADES = [[null, 1959], [1960, 1969], [1970, 1979], [1980, 1989], [1990, 1999], [2000, 2009], [2010, 2019], [2020, null]];

const queries = [];
const releases = new Map();

function queryOf(part) {
  const formats = part.format ? `format:${part.format}` : `format:(${FORMATS.join(' OR ')})`;
  const what = part.kind === 'deluxe' ? DELUXE : formats;
  let when = '';
  if (part.nodate) when = ' AND NOT date:[* TO *]';
  else if (part.days) when = ` AND date:[${part.days[0]} TO ${part.days[1]}]`;
  else if (part.from !== undefined) when = ` AND date:[${part.from ?? '*'} TO ${part.to ?? '*'}]`;
  let where = '';
  if (part.country) where = ` AND country:${part.country}`;
  else if (part.notCountries) where = ` AND NOT country:(${part.notCountries.join(' OR ')})`;
  if (part.official !== undefined) where += part.official ? ' AND status:official' : ' AND NOT status:official';
  return `arid:"${artistId}" AND ${what}${when}${where}`;
}

async function run(part) {
  const query = queryOf(part);
  const { status, data } = await get('release', { query, limit: 100, offset: 0 }, { log, tag: part.kind });
  if (status !== 200) throw new Error(`${status} for ${query}: ${JSON.stringify(data)}`);
  const list = data.releases || [];
  queries.push({ part, query, count: data.count, returned: list.length, complete: data.count <= list.length });
  for (const r of list) {
    if (!releases.has(r.id)) {
      releases.set(r.id, {
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
        kinds: [],
      });
    }
    const kinds = releases.get(r.id).kinds;
    if (!kinds.includes(part.kind)) kinds.push(part.kind);
  }
  console.log(`${String(data.count).padStart(5)} ${list.length === data.count ? 'complete' : 'split   '} ${query.replace(`arid:"${artistId}" AND `, '')}`);
  return data.count <= list.length;
}

async function years(part) {
  if (await run(part)) return;
  const from = part.from ?? 1900;
  const to = part.to ?? LAST_YEAR;
  if (from < to) {
    const middle = Math.floor((from + to) / 2);
    await years({ ...part, from: part.from, to: middle });
    await years({ ...part, from: middle + 1, to: part.to });
  } else if (!part.format && part.kind === 'vinyl') {
    for (const format of FORMATS) {
      if (!(await run({ ...part, format }))) await byCountry({ ...part, format });
    }
  } else {
    console.log(`  still over 100: ${queryOf(part)}`);
  }
}

// A country still over 100 is split into official releases and the rest.
async function byStatus(part) {
  for (const official of [true, false]) {
    if (!(await run({ ...part, official }))) await byHalfYear({ ...part, official });
  }
}

// A part still over 100 after that is split into the two halves of its year. A release dated only
// by its year comes up in both halves (the Beatles' 110 US singles of 1964 gave 94 and 49).
async function byHalfYear(part) {
  const year = part.from;
  const before = releases.size;
  let sum = 0;
  for (const days of [[`${year}-01-01`, `${year}-06-30`], [`${year}-07-01`, `${year}-12-31`]]) {
    if (!(await run({ ...part, days }))) console.log(`  still over 100: ${queryOf({ ...part, days })}`);
    sum += queries.at(-1).count;
  }
  const whole = queries.find((q) => q.query === queryOf(part)).count;
  console.log(`  halves of ${year}: ${sum} results for ${whole} releases, ${releases.size - before} new`);
}

async function byCountry(part) {
  for (let n = 1; n <= COUNTRIES.length; n++) {
    const countries = COUNTRIES.slice(0, n);
    const latest = countries[n - 1];
    if (!(await run({ ...part, country: latest }))) await byStatus({ ...part, country: latest });
    if (await run({ ...part, notCountries: countries })) return;
  }
  console.log(`  still over 100: ${queryOf({ ...part, notCountries: COUNTRIES })}`);
}

async function collect(kind) {
  if (await run({ kind })) return;
  if (!(await run({ kind, nodate: true }))) {
    for (const format of FORMATS) await run({ kind, nodate: true, format });
  }
  for (const [from, to] of DECADES) await years({ kind, from, to });
}

const started = Date.now();
await collect('vinyl');
await collect('deluxe');
const file = join(here, 'data', `${slug}-complete.json.gz`);
writeFileSync(file, gzipSync(JSON.stringify({ artistId, slug, measuredAt: new Date(started).toISOString(), wallMs: Date.now() - started, queries, releases: [...releases.values()] })));
console.log(`${queries.length} requests, ${releases.size} releases, wrote ${file}`);
