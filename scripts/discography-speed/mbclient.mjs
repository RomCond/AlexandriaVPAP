// Live MusicBrainz access for the discography speed measurements.
// One request at a time, at least 1.1 s apart, with the User-Agent MusicBrainz asks for.
// Node's own User-Agent gets a 403. Run with NODE_USE_ENV_PROXY=1 behind a proxy.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UA = 'alexandria-dev/0.1';
export const GAP_MS = 1100;
// Other agents share this machine's address, so 503s come in bursts. Wait them out patiently.
const RETRY_WAITS_MS = [2000, 4000, 8000, 16000, 30000, 30000, 60000, 60000, 60000];
// Answers already received, so a run cut short can start again without asking twice.
const CACHE = join(dirname(fileURLToPath(import.meta.url)), 'data', 'cache');

// Kept before anything replaces globalThis.fetch to watch the app's own calls.
const realFetch = globalThis.fetch;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastStart = 0;
let chain = Promise.resolve();

// A log line per HTTP attempt, 503s included, so they can be left out of the counts.
export function logTo(path) {
  mkdirSync(dirname(path), { recursive: true });
  return (entry) => appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

// fetch with the right User-Agent, timed and logged. Used directly by the instrumented app run,
// which brings its own queue, and by get() below.
export function instrumentedFetch(log, tag) {
  return async (url, options = {}) => {
    const started = Date.now();
    const res = await realFetch(url, { ...options, headers: { ...(options.headers || {}), 'User-Agent': UA, Accept: 'application/json' } });
    const text = await res.text();
    const ms = Date.now() - started;
    let data = null;
    try { data = JSON.parse(text); } catch (ignored) {}
    const u = new URL(url);
    log({
      tag: typeof tag === 'function' ? tag() : tag,
      at: new Date(started).toISOString(),
      path: u.pathname,
      params: Object.fromEntries(u.searchParams),
      status: res.status,
      ms,
      count: data ? data.count ?? data['release-count'] ?? data['release-group-count'] ?? null : null,
      returned: data ? (data.releases || data['release-groups'] || data.artists || []).length : null,
      error: data && data.error ? data.error : null,
    });
    return { ok: res.ok, status: res.status, json: async () => data, text: async () => text, data };
  };
}

// One GET, queued behind every other one, retried through 503s like the app does.
export function get(path, params, { log, tag }) {
  const url = new URL(path, 'https://musicbrainz.org/ws/2/');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('fmt', 'json');
  const cached = join(CACHE, `${createHash('sha1').update(url.toString()).digest('hex')}.json`);
  if (existsSync(cached)) return Promise.resolve(JSON.parse(readFileSync(cached, 'utf8')));
  const doFetch = instrumentedFetch(log, tag);
  const run = chain.then(async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastStart + GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
      let res = null;
      try {
        res = await doFetch(url.toString());
      } catch (e) {
        log({ tag, at: new Date().toISOString(), path: url.pathname, params: Object.fromEntries(url.searchParams), status: 0, error: String(e) });
      }
      if (res && res.status !== 503) {
        const answer = { status: res.status, data: res.data };
        mkdirSync(CACHE, { recursive: true });
        writeFileSync(cached, JSON.stringify(answer));
        return answer;
      }
      const backoff = RETRY_WAITS_MS[attempt];
      if (backoff === undefined) throw new Error(`gave up on ${url} after ${attempt + 1} tries`);
      await sleep(backoff);
    }
  });
  chain = run.catch(() => {});
  return run;
}
