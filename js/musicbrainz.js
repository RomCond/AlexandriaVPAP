/*
 * Small client for the MusicBrainz API and the Cover Art Archive. Both are free and need no key.
 * MusicBrainz asks for no more than one request per second, so every call goes through one queue.
 * API docs: https://musicbrainz.org/doc/MusicBrainz_API
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.Alexandria = root.Alexandria || {}).mb = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const API = 'https://musicbrainz.org/ws/2/';
  const COVERS = 'https://coverartarchive.org/release-group/';
  const MIN_GAP_MS = 1100;
  const MAX_DISCOGRAPHY_PAGES = 15;
  // 5,000 releases. The Beatles have 2,308 official and promotional albums, EPs and singles.
  const MAX_RELEASE_PAGES = 50;
  // MusicBrainz scores text only, so a tribute album titled "Radiohead" can outrank Radiohead's own
  // records. How many pressings of an album a search returns is a fair sign of how well known it is,
  // so an album's best score gets this times the natural log of its pressings on top.
  const PRESSINGS_WEIGHT = 5;

  // The vinyl formats that count. Flexi-disc and VinylDisc (a CD/vinyl hybrid) don't. LPs and 12"
  // records always count; 45s (7") and 10" records are "small" and count only when turned on.
  // MusicBrainz's search index stores each format as a single squashed, lowercase word
  // ('12" Vinyl' becomes "12vinyl"), so searching for plain "vinyl" would miss most pressings.
  const LARGE_FORMATS = ['vinyl', '12vinyl'];
  const SMALL_FORMATS = ['7vinyl', '10vinyl'];
  const LARGE_VINYL = /^(12" )?Vinyl$/i;
  const SMALL_VINYL = /^(7|10)" Vinyl$/i;
  const ANY_VINYL = /^((7|10|12)" )?Vinyl$/i;

  function vinylQuery(small) {
    return `format:(${[...LARGE_FORMATS, ...(small ? SMALL_FORMATS : [])].join(' OR ')})`;
  }

  function allowedVinyl(format, small) {
    return LARGE_VINYL.test(format) || (small && SMALL_VINYL.test(format));
  }
  const SKIPPED_STATUSES = ['Bootleg', 'Pseudo-Release'];

  // Deluxe and expanded editions add songs, so they get their own line next to the original.
  // store.js uses the same words to spot them in records you typed in.
  const DELUXE_WORDS = /\b(deluxe|expanded)\b/i;

  const RETRY_WAITS_MS = [2000, 4000, 8000, 16000];
  const OFFLINE = "Couldn't reach MusicBrainz. Check your connection and try again.";
  const BUSY = 'MusicBrainz is busy right now. Try again in a minute.';

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      let timer = null;
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
    });
  }

  let queue = Promise.resolve();
  let lastCall = 0;

  const abortError = () => new DOMException('Search cancelled', 'AbortError');

  // A call cancelled while it waits its turn never reaches MusicBrainz, so it doesn't use up the rate limit.
  function throttled(task, signal) {
    const run = queue.then(async () => {
      const wait = lastCall + MIN_GAP_MS - Date.now();
      if (wait > 0 && !(signal && signal.aborted)) await sleep(wait);
      if (signal && signal.aborted) throw abortError();
      lastCall = Date.now();
      return task();
    });
    queue = run.catch(() => {});
    return run;
  }

  async function get(path, params, signal) {
    const url = new URL(path, API);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('fmt', 'json');

    for (let attempt = 0; ; attempt++) {
      let reply = null;
      try {
        reply = await throttled(async () => {
          const res = await fetch(url, { signal });
          return { status: res.status, data: res.ok ? await res.json() : null };
        }, signal);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
      if (reply && reply.status >= 200 && reply.status < 300) return reply.data;
      // 503 means MusicBrainz is busy or we hit the rate limit.
      if (reply && reply.status !== 503) throw new Error(`MusicBrainz returned an error (${reply.status}). Try again in a moment.`);
      const wait = RETRY_WAITS_MS[attempt];
      if (wait === undefined) throw new Error(reply ? BUSY : OFFLINE);
      await sleep(wait, signal);
      if (!reply && typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error(OFFLINE);
    }
  }

  // ---------- Search query building (Lucene syntax) ----------

  function escapeWord(word) {
    return word.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, '\\$1');
  }

  // Lowercasing keeps words like AND, OR and NOT in a title from acting as operators.
  // With prefixLast, a half-typed last word also matches as a prefix, so "radioh" finds "Radiohead".
  function terms(text, prefixLast) {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean).map(escapeWord);
    const last = words[words.length - 1];
    if (prefixLast && last && last.length >= 3) words.push(`${last}*`);
    return words.join(' ');
  }

  function phrase(text) {
    return `"${text.replace(/["\\]/g, '\\$&')}"`;
  }

  // An exact phrase match ranks first; loose word matches still show up below it.
  function field(name, text, prefixLast) {
    return `(${name}:${phrase(text.trim())}^3 OR ${name}:(${terms(text, prefixLast)}))`;
  }

  // Matches only when every word turns up in one of the fields, in any order, so "radiohead kid"
  // needs "radiohead" somewhere and "kid" somewhere. A word of 4 letters or more may have one typo
  // ("metalica"), and the last word also counts as a prefix however short it is, since the other
  // words narrow it down ("dark side of the mo").
  function everyWord(fields, text) {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean).map(escapeWord);
    return `(${words.map((word, i) => {
      const forms = [word];
      if (i === words.length - 1) forms.push(`${word}*`);
      if (word.length >= 4 && /^[\p{L}\p{N}]+$/u.test(word)) forms.push(`${word}~1`);
      return `(${fields.map((name) => `${name}:(${forms.join(' ')})`).join(' OR ')})`;
    }).join(' AND ')})`;
  }

  // Words with an allowance for typos: "metalica~" also finds "Metallica". Punctuation splits words
  // ("T.Rex" is "t rex"); short words and ones with apostrophes are matched as typed.
  function fuzzyTerms(text) {
    return text.toLowerCase().replace(/[^\p{L}\p{N}'’]+/gu, ' ').split(/\s+/).filter(Boolean)
      .map((word) => (word.length >= 4 && /^[\p{L}\p{N}]+$/u.test(word) ? `${word}~` : escapeWord(word)))
      .join(' ');
  }

  // 8 to 14 digits (spaces and dashes allowed) is a barcode. Shorter numbers are titles like "1989".
  function looksLikeBarcode(text) {
    return /^\d{8,14}$/.test(text.replace(/[\s-]/g, ''));
  }

  // Tiebreak for results MusicBrainz scores the same: plain albums, then EPs, singles, and the rest.
  function typeRank(group) {
    if ((group['secondary-types'] || []).length) return 3;
    const rank = { Album: 0, EP: 1, Single: 2 }[group['primary-type']];
    return rank === undefined ? 4 : rank;
  }

  // ---------- Response mapping ----------

  function creditName(credit) {
    return (credit || []).map((part) => part.name + (part.joinphrase || '')).join('').trim();
  }

  function mainArtistId(credit) {
    return (credit && credit[0] && credit[0].artist && credit[0].artist.id) || null;
  }

  // A release's medium formats, like ['12" Vinyl', 'CD'].
  function formatsOf(release) {
    return (release.media || []).map((medium) => medium.format).filter(Boolean);
  }

  function yearOf(date) {
    const match = /^(\d{4})/.exec(date || '');
    return match ? Number(match[1]) : null;
  }

  function formatFromMedia(media, primaryType) {
    if (!media.length) return null;
    const every = (pattern) => media.every((format) => pattern.test(format));
    if (!every(ANY_VINYL)) return null;
    if (media.length >= 3) return 'Box set';
    if (media.length === 2) return 'Double LP';
    if (every(/^7"/)) return '45';
    if (every(/^10"/)) return '10"';
    if (primaryType === 'Single') return '12" single';
    if (primaryType === 'EP') return 'EP';
    return 'LP';
  }

  function mediaLabel(media) {
    const counts = new Map();
    for (const format of media) counts.set(format, (counts.get(format) || 0) + 1);
    return [...counts].map(([format, n]) => (n > 1 ? `${n} x ${format}` : format)).join(' + ');
  }

  // ---------- The artist a search names ----------

  // Lowercase, accents off, and anything but letters and digits as a space: "Sigur Rós" is "sigur ros".
  function plain(text) {
    return (text || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  function editDistance(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let diagonal = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const next = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
        diagonal = row[j];
        row[j] = next;
      }
    }
    return row[b.length];
  }

  /*
   * A search for just "radiohead" or "low" lists albums, and MusicBrainz ranks albums titled after the
   * band above the band's own records. So the search also names an artist, for a row above the albums,
   * when their name is what was typed or the words at its start or end ("radiohead kid"). One typo is
   * fine in a name of 5 letters or more, and a leading "The" can be left off. A two-word name also
   * matches by its last word when that has 4 letters or more ("bowie"); shorter ones are too common
   * ("Toner Low" would match "low"). The artist comes from the pressings already found, so it costs
   * no extra request; with several, the one with the most pressings wins. Returns { id, name } or null.
   * The name is the one that matched what was typed: the artist's own name when that matched, or else
   * the name the records credit most often, so "takanaka" shows "Masayoshi Takanaka", not 高中正義.
   */
  function artistInResults(releases, text) {
    const words = plain(text).split(' ').filter(Boolean);
    const runs = [];
    for (let k = words.length; k >= 1; k--) {
      runs.push(words.slice(0, k).join(' '));
      if (k < words.length) runs.push(words.slice(words.length - k).join(' '));
    }
    const close = (run, name) => run === name || (name.length >= 5 && editDistance(run, name) <= 1);
    const formsOf = (name) => {
      const full = plain(name);
      if (!full) return [];
      const parts = full.split(' ');
      return [full, full.replace(/^the /, ''), ...(parts.length === 2 && parts[1].length >= 4 ? [parts[1]] : [])];
    };
    const matches = (run, names) => names.some((name) => close(run, name));

    const artists = new Map();
    for (const release of releases) {
      const part = (release['artist-credit'] || [])[0];
      if (!part || !part.artist || !part.artist.id || SKIPPED_STATUSES.includes(release.status)) continue;
      const artist = artists.get(part.artist.id)
        || { id: part.artist.id, name: part.artist.name, own: formsOf(part.artist.name), credits: new Map(), pressings: 0 };
      artist.pressings += 1;
      const credited = part.name || part.artist.name;
      const credit = artist.credits.get(credited) || { forms: formsOf(credited), pressings: 0 };
      credit.pressings += 1;
      artist.credits.set(credited, credit);
      artists.set(artist.id, artist);
    }

    let best = null;
    for (const artist of artists.values()) {
      const credits = [...artist.credits].sort((a, b) => b[1].pressings - a[1].pressings);
      const run = runs.find((r) => matches(r, artist.own) || credits.some(([, credit]) => matches(r, credit.forms)));
      if (!run) continue;
      const length = run.split(' ').length;
      if (!best || artist.pressings > best.pressings || (artist.pressings === best.pressings && length > best.length)) {
        const name = matches(run, artist.own) ? artist.name : credits.find(([, credit]) => matches(run, credit.forms))[0];
        best = { id: artist.id, name, pressings: artist.pressings, length };
      }
    }
    return best && { id: best.id, name: best.name };
  }

  // ---------- Public calls ----------

  /*
   * Free text matched against release titles and artist names, so any part of either works.
   * Searches vinyl pressings plus studio albums' releases (bootlegs left out), then groups them back
   * into albums: each album or single shows once however many pressings match, and a deluxe or
   * expanded edition gets its own line, like in the discography.
   * Anything needs a vinyl pressing to show, except studio albums: MusicBrainz is often missing the
   * vinyl pressings of albums that have them, so those show anyway with vinyl: false
   * ("Vinyl not confirmed"). The year is the earliest vinyl pressing, or the earliest release when
   * there's none. 45s and 10" records count only when small is on.
   * Resolves to { results, artist }, where artist is the one artistInResults names, or null.
   */
  async function searchReleaseGroups(text, signal, small) {
    // Results matching every word, in the title, the artist or a release note like "blue album", rank
    // well above those matching only some.
    const words = `${field('release', text, true)} OR ${field('artist', text, true)} OR ${everyWord(['release', 'artist', 'comment'], text)}^4`;
    const query = `(${words}) AND (${vinylQuery(small)} OR primarytype:album)`;
    const data = await get('release', { query, limit: 100 }, signal);

    // Every pressing counts here, CDs too, as a sign of how well known the album is.
    const pressings = new Map();
    const albums = new Map();
    for (const release of data.releases || []) {
      const group = release['release-group'] || {};
      if (!group.id || SKIPPED_STATUSES.includes(release.status)) continue;
      const seen = pressings.get(group.id) || { count: 0, score: 0 };
      pressings.set(group.id, { count: seen.count + 1, score: Math.max(seen.score, release.score || 0) });
      const vinyl = formatsOf(release).some((format) => allowedVinyl(format, small));
      const studio = group['primary-type'] === 'Album' && !(group['secondary-types'] || []).length;

      const groupTitle = group.title || release.title;
      const words = `${release.title || ''} ${release.disambiguation || ''}`;
      const edition = DELUXE_WORDS.test(words) && !DELUXE_WORDS.test(groupTitle) ? (/\bdeluxe\b/i.test(words) ? 'Deluxe' : 'Expanded') : null;
      if (!vinyl && (edition || !studio)) continue;

      const key = edition ? `${group.id}:deluxe` : group.id;
      const album = albums.get(key) || { group, groupTitle, edition, credit: release['artist-credit'], score: 0, vinyl: false, vinylDate: '', anyDate: '' };
      if (edition === 'Deluxe') album.edition = 'Deluxe';
      album.score = Math.max(album.score, release.score || 0);
      const earlier = (date, than) => date && (!than || date < than);
      if (earlier(release.date, album.anyDate)) album.anyDate = release.date;
      if (vinyl) {
        album.vinyl = true;
        if (earlier(release.date, album.vinylDate)) album.vinylDate = release.date;
      }
      albums.set(key, album);
    }

    const dateOf = (album) => (album.vinyl ? album.vinylDate : album.anyDate) || '';
    const rank = (album) => {
      const { count, score } = pressings.get(album.group.id);
      return score + PRESSINGS_WEIGHT * Math.log(count);
    };
    const results = [...albums.values()]
      .sort((a, b) => rank(b) - rank(a)
        || b.score - a.score
        || Number(b.vinyl) - Number(a.vinyl)
        || typeRank(a.group) - typeRank(b.group)
        || (dateOf(a) || '9999').localeCompare(dateOf(b) || '9999'))
      .map((album) => ({
        releaseGroupId: album.group.id,
        releaseId: null,
        title: album.edition ? `${album.groupTitle} (${album.edition} Edition)` : album.groupTitle,
        deluxe: Boolean(album.edition),
        artist: creditName(album.credit),
        artistId: mainArtistId(album.credit),
        year: yearOf(dateOf(album)),
        primaryType: album.group['primary-type'] || null,
        secondaryTypes: album.group['secondary-types'] || [],
        vinyl: album.vinyl,
        formatHint: null,
        media: '',
      }));
    return { results, artist: artistInResults(data.releases || [], text) };
  }

  // Only vinyl pressings come back (45s and 10" only when small is on). hiddenNonVinyl counts the
  // CD and cassette matches left out, and hiddenSmall the 45s and 10" records left out.
  async function searchBarcode(barcode, signal, small) {
    const data = await get('release', { query: `barcode:${barcode}`, limit: 10 }, signal);
    const all = data.releases || [];
    const matches = (release, test) => {
      const media = formatsOf(release);
      return !media.length || media.some(test);
    };
    const isVinyl = (release) => matches(release, (format) => ANY_VINYL.test(format));
    const allowed = (release) => matches(release, (format) => allowedVinyl(format, small));
    const results = all.filter(allowed).map((release) => {
      const group = release['release-group'] || {};
      const media = formatsOf(release);
      // Keep "deluxe edition" and the like in the title so the record shows which version it is.
      const note = release.disambiguation || '';
      const title = DELUXE_WORDS.test(note) && !DELUXE_WORDS.test(release.title) ? `${release.title} (${note})` : release.title;
      return {
        releaseGroupId: group.id || null,
        releaseId: release.id,
        title,
        artist: creditName(release['artist-credit']),
        artistId: mainArtistId(release['artist-credit']),
        year: yearOf(release.date),
        primaryType: group['primary-type'] || null,
        secondaryTypes: group['secondary-types'] || [],
        vinyl: true,
        formatHint: formatFromMedia(media, group['primary-type']),
        media: mediaLabel(media),
      };
    });
    return {
      results,
      hiddenNonVinyl: all.filter((release) => !isVinyl(release)).length,
      hiddenSmall: all.filter((release) => isVinyl(release) && !allowed(release)).length,
    };
  }

  // What the single search box on the Add page calls. Pass { small: true } to include 45s and 10"
  // records. Resolves to { results, artist, hiddenNonVinyl, hiddenSmall }; artist is null for a barcode.
  async function search(text, signal, { small = false } = {}) {
    if (looksLikeBarcode(text)) return { ...(await searchBarcode(text.replace(/\D/g, ''), signal, small)), artist: null };
    return { ...(await searchReleaseGroups(text, signal, small)), hiddenNonVinyl: 0, hiddenSmall: 0 };
  }

  /*
   * Releases that might be what a typed-in record means, typos and all, for store.bestAlbumMatch to
   * choose from. When nothing turns up, the artist may be filed under another name (Masayoshi Takanaka
   * is 高中正義), so they're looked up by alias and their releases searched by id; those candidates
   * come back with artistFound set.
   */
  async function searchAlbumCandidates(artist, title, signal) {
    const part = (name, text) => `(${name}:${phrase(text.trim())}^3 OR ${name}:(${fuzzyTerms(text)}))`;
    const titlePart = `(${part('releasegroup', title)} OR ${part('alias', title)})`;
    const groupsFor = async (artistPart, extra) => {
      const data = await get('release-group', { query: `${artistPart} AND ${titlePart}`, limit: 25 }, signal);
      return (data['release-groups'] || []).map((group) => ({
        releaseGroupId: group.id,
        title: group.title,
        artist: creditName(group['artist-credit']),
        artistId: mainArtistId(group['artist-credit']),
        year: yearOf(group['first-release-date']),
        primaryType: group['primary-type'] || null,
        secondaryTypes: group['secondary-types'] || [],
        ...extra,
      }));
    };
    const byName = await groupsFor(part('artist', artist), {});
    if (byName.length) return byName;
    const name = phrase(artist.trim());
    const data = await get('artist', { query: `alias:${name} OR artist:${name}`, limit: 3 }, signal);
    const ids = (data.artists || []).filter((found) => (found.score || 0) >= 95).map((found) => `"${found.id}"`);
    return ids.length ? groupsFor(`arid:(${ids.join(' OR ')})`, { artistFound: true }) : [];
  }

  async function searchArtists(name) {
    const data = await get('artist', { query: field('artist', name.trim()), limit: 8 });
    return (data.artists || []).map((artist) => ({
      id: artist.id,
      name: artist.name,
      disambiguation: artist.disambiguation || '',
      type: artist.type || '',
      country: artist.country || '',
      score: artist.score,
    }));
  }

  // A release group as the discography keeps it, before any of its releases are looked at.
  function newGroup(group) {
    return {
      id: group.id,
      title: group.title,
      date: group['first-release-date'] || '',
      primaryType: group['primary-type'] || null,
      secondaryTypes: group['secondary-types'] || [],
      vinyl: false,
      small: false,
      deluxe: null,
    };
  }

  /*
   * Folds one release into its release group: an LP or 12" pressing sets vinyl, a 45 or 10" one
   * small. A release that says deluxe or expanded, when its album's own title doesn't, goes into the
   * group's deluxe entry instead, which every such release of the album shares. The entry is named
   * "Deluxe" if any of them says so.
   */
  function addRelease(byId, release) {
    const found = release['release-group'];
    if (!found || !found.id) return;
    if (!byId.has(found.id)) byId.set(found.id, newGroup(found));
    const group = byId.get(found.id);
    const formats = formatsOf(release);
    const large = formats.some((format) => LARGE_VINYL.test(format));
    const small = formats.some((format) => SMALL_VINYL.test(format));
    const words = `${release.title || ''} ${release.disambiguation || ''}`;
    if (!DELUXE_WORDS.test(words) || DELUXE_WORDS.test(group.title)) {
      if (large) group.vinyl = true;
      if (small) group.small = true;
      return;
    }
    const entry = group.deluxe || (group.deluxe = { title: `${group.title} (Expanded Edition)`, date: '', vinyl: false, small: false, releaseIds: [] });
    entry.releaseIds.push(release.id);
    if (/\bdeluxe\b/i.test(words)) entry.title = `${group.title} (Deluxe Edition)`;
    if (large) entry.vinyl = true;
    if (small) entry.small = true;
    if (release.date && (!entry.date || release.date < entry.date)) entry.date = release.date;
  }

  // Every album, EP and single credited to the artist, 100 at a time, added to byId.
  async function browseGroups(artistId, byId, signal, onPage) {
    let loaded = 0;
    let total = 0;
    for (let page = 0; page < MAX_DISCOGRAPHY_PAGES; page++) {
      const data = await get('release-group', { artist: artistId, type: 'album|ep|single', limit: 100, offset: loaded }, signal);
      total = data['release-group-count'] || 0;
      const batch = data['release-groups'] || [];
      for (const group of batch) if (!byId.has(group.id)) byId.set(group.id, newGroup(group));
      loaded += batch.length;
      onPage(loaded, total);
      if (!batch.length || loaded >= total) break;
    }
    return { total, truncated: loaded < total };
  }

  /*
   * An artist's albums, EPs and singles. Each says whether the original has an LP or 12" pressing
   * (vinyl) and a 45 or 10" one (small), and carries a `deluxe` entry, with the same two flags, when
   * MusicBrainz has a deluxe or expanded edition filed under it.
   *
   * Studio albums come first, from one search, so they can show at once. Then the artist's official
   * and promotional releases are browsed 100 at a time with their formats. Browsing pages through the
   * database in a fixed order. Paging through a search doesn't: MusicBrainz returns results that tie
   * on score in a different order each time, which used to lose about a fifth of the pressings.
   * Bootlegs, pseudo-releases and releases with no status don't count.
   *
   * Release groups with no official or promotional release, mostly bootlegs, are left out. They only
   * show with Vinyl only off, and addAllReleaseGroups fetches them then. An artist with more studio
   * albums than one search page holds gets every group up front instead (allGroups).
   *
   * onProgress gets { step, loaded, total, discography } after each request, with what's known so far.
   * Pass a signal to stop it.
   */
  async function getDiscography(artistId, onProgress, { signal } = {}) {
    const byId = new Map();
    const state = { total: 0, truncated: false, vinylComplete: true, allGroups: false };
    // A copy, since later pages keep changing the groups.
    const copy = (group) => ({ ...group, deluxe: group.deluxe && { ...group.deluxe, releaseIds: [...group.deluxe.releaseIds] } });
    const snapshot = () => ({ ...state, groups: [...byId.values()].map(copy), total: state.allGroups ? state.total : byId.size });
    const report = (step) => (loaded, total) => onProgress && onProgress({ step, loaded, total, discography: snapshot() });

    const query = `arid:"${artistId}" AND primarytype:album AND NOT secondarytype:[* TO *]`;
    const studio = await get('release-group', { query, limit: 100 }, signal);
    const albums = studio['release-groups'] || [];
    if ((studio.count || 0) > albums.length) {
      Object.assign(state, await browseGroups(artistId, byId, signal, report('groups')), { allGroups: true });
    } else {
      for (const group of albums) byId.set(group.id, newGroup(group));
      report('studio')(albums.length, albums.length);
    }

    let loaded = 0;
    let total = 0;
    for (let page = 0; page < MAX_RELEASE_PAGES; page++) {
      const data = await get('release', {
        artist: artistId, type: 'album|ep|single', status: 'official|promotion', inc: 'media+release-groups', limit: 100, offset: loaded,
      }, signal);
      total = data['release-count'] || 0;
      const batch = data.releases || [];
      for (const release of batch) addRelease(byId, release);
      loaded += batch.length;
      report('vinyl')(loaded, total);
      if (!batch.length || loaded >= total) break;
    }
    state.vinylComplete = loaded >= total;
    return snapshot();
  }

  // The discography with every album, EP and single added, including those with no official release.
  // onProgress gets { step: 'groups', loaded, total }.
  async function addAllReleaseGroups(discography, artistId, onProgress, { signal } = {}) {
    const byId = new Map(discography.groups.map((group) => [group.id, group]));
    const done = await browseGroups(artistId, byId, signal, (loaded, total) => onProgress && onProgress({ step: 'groups', loaded, total }));
    return { ...discography, ...done, groups: [...byId.values()], allGroups: true };
  }

  function coverUrl(releaseGroupId, size) {
    return `${COVERS}${releaseGroupId}/front-${size}`;
  }

  return {
    search,
    searchReleaseGroups,
    searchBarcode,
    searchArtists,
    searchAlbumCandidates,
    looksLikeBarcode,
    getDiscography,
    addAllReleaseGroups,
    coverUrl,
    yearOf,
    internals: { field, formatFromMedia, mediaLabel, creditName },
  };
});
