// Pages through every release of an artist with the browse API, which reads the database and
// returns a stable order, unlike search.
//   NODE_USE_ENV_PROXY=1 node scripts/discography-speed/browse-all.mjs <artist-mbid> <slug> [status]
// With status (like "official|promotion") only those releases come back. Albums, EPs and singles
// only, as in the app. Writes data/<slug>-browse.json.gz.
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { get, logTo } from './mbclient.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [artistId, slug, status] = process.argv.slice(2);
if (!artistId || !slug) throw new Error('usage: browse-all.mjs <artist-mbid> <slug> [status]');
mkdirSync(join(here, 'data'), { recursive: true });
const log = logTo(join(here, 'data', `${slug}-browse.jsonl`));

const pages = [];
const releases = new Map();
let total = null;
const started = Date.now();
for (let offset = 0; total === null || offset < total;) {
  const params = { artist: artistId, type: 'album|ep|single', inc: 'media+release-groups', limit: 100, offset };
  if (status) params.status = status;
  const { status: code, data } = await get('release', params, { log, tag: 'browse' });
  if (code !== 200) throw new Error(`${code} at offset ${offset}: ${JSON.stringify(data)}`);
  total = data['release-count'];
  const list = data.releases || [];
  pages.push({ offset, returned: list.length, tracks: list.reduce((n, r) => n + (r.media || []).reduce((t, m) => t + (m['track-count'] || 0), 0), 0) });
  for (const r of list) {
    const g = r['release-group'] || {};
    releases.set(r.id, {
      id: r.id,
      title: r.title || '',
      note: r.disambiguation || '',
      status: r.status || null,
      date: r.date || '',
      events: (r['release-events'] || []).map((e) => e.date || ''),
      formats: (r.media || []).map((m) => m.format || null),
      group: { id: g.id, title: g.title, date: g['first-release-date'] || '', primaryType: g['primary-type'] || null, secondaryTypes: g['secondary-types'] || [] },
    });
  }
  console.log(`offset ${offset}: ${list.length} of ${total}`);
  if (!list.length) break;
  offset += list.length;
}
const file = join(here, 'data', `${slug}-browse.json.gz`);
writeFileSync(file, gzipSync(JSON.stringify({ artistId, slug, status: status || null, measuredAt: new Date(started).toISOString(), total, pages, releases: [...releases.values()] })));
console.log(`${pages.length} requests, ${releases.size} releases of ${total}, wrote ${file}`);
