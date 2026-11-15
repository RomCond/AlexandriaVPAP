// Single live requests, one at a time, for questions one response answers.
//   NODE_USE_ENV_PROXY=1 node scripts/discography-speed/probe.mjs <probes.json>
// probes.json is [{ name, path, params }]. Every attempt goes to data/probes.jsonl, each response
// body to data/raw/<name>.json (not committed), and a summary of each to data/probes.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { get, logTo } from './mbclient.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const probes = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const log = logTo(join(here, 'data', 'probes.jsonl'));
const summaryFile = join(here, 'data', 'probes.json');
mkdirSync(join(here, 'data', 'raw'), { recursive: true });
const summary = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, 'utf8')) : {};

for (const { name, path, params } of probes) {
  const { status, data } = await get(path, params, { log, tag: name });
  writeFileSync(join(here, 'data', 'raw', `${name}.json`), JSON.stringify(data));
  summary[name] = summarize(path, params, status, data);
  writeFileSync(summaryFile, JSON.stringify(summary, null, 1));
  console.log(name, status, JSON.stringify({ count: summary[name].count, returned: summary[name].returned, error: summary[name].error }));
}

function summarize(path, params, status, data) {
  const list = data && (data.releases || data['release-groups'] || data.artists);
  const tally = (key) => {
    const out = {};
    for (const item of list || []) out[key(item)] = (out[key(item)] || 0) + 1;
    return out;
  };
  return {
    path,
    params,
    status,
    count: data ? data.count ?? data['release-count'] ?? data['release-group-count'] ?? null : null,
    returned: list ? list.length : null,
    error: (data && data.error) || null,
    ids: list ? list.map((item) => item.id) : [],
    statuses: data && data.releases ? tally((r) => r.status) : undefined,
    tracksOnPage: data && data.releases ? data.releases.reduce((n, r) => n + (r.media || []).reduce((t, m) => t + (m['track-count'] || 0), 0), 0) : undefined,
  };
}
