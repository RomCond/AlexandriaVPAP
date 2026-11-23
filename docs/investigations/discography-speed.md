# Discography load speed

Iteration 1 measured the options below. Iterations 2 and 3 built the recommendation. Their results are near the end.

## Summary

Load a discography in two steps, and show cached ones at once.

1. One search for the artist's studio albums. Show them right away.
2. Browse the artist's official and promotional releases with `inc=media+release-groups`. Fill in the vinyl labels, the other types and the deluxe lines as each page arrives.
3. Show a cached discography at once, even an old one, and refresh it in the background.

The main numbers:

| | Today | Recommended |
|---|---|---|
| David Bowie, first list on screen | 15 requests, 16.5 s | 1 request, 1.1 s |
| David Bowie, fully loaded | 15 requests, 16.5 s | 18 requests, 19.8 s |
| The Beatles, first list on screen | 36 requests, 39.6 s | 1 request, 1.1 s |
| The Beatles, fully loaded | 36 requests, 39.6 s | 25 requests, 27.5 s |
| Vinyl pressings found, Bowie | 377 of 491 (77%) | 487 of 491 (99%) |
| Vinyl pressings found, Beatles | 1,264 of 1,453 (87%) | 1,437 of 1,453 (99%) |
| Repeat visit after a week | full load | 0 s wait |

The request counts and pressing counts are measured. Times are estimated at 1.1 s a request. The pressings counted leave out bootlegs and pseudo-releases, as the app does. The recommended load misses only pressings that have no status in MusicBrainz (4 Bowie, 12 Beatles) and 4 Beatles interview and broadcast records, which the app ignores anyway.

Bowie takes 3 more requests to load fully than today. Today's load is faster for Bowie only because its paging loses data. See the next section.

No server is needed for any of this. Whether to run one is a decision for you. See [Decisions for you](#decisions-for-you).

## Today's load misses vinyl pressings

This is a correctness bug, found while measuring.

MusicBrainz search has no sort order. Results that tie on score come back in a different order on each request. The app's vinyl search scores every result the same, so paging through it repeats some releases and skips others.

- Bowie's `date:[* TO *]` vinyl query had 500 results. Its 5 pages returned only 367 different releases. The first two pages shared 40. (measured)
- In a live run of the app's own `getDiscography`, Bowie came back with 377 of the 491 vinyl releases that count (77%). 17 release groups got the wrong LP flag. With every type turned on, 16 lines that should show were missing. In the default view, one studio album wrongly said "Vinyl not confirmed". (measured)
- The Beatles came back with 1,264 of 1,453 (87%). 9 wrong flags, 8 missing lines with every type on, one wrong label in the default view. (measured)
- Which releases go missing changes from run to run.

So any faster design must not page through search results. There are two exact ways to get every release:

- Split each search until it fits on one page of 100. A page that holds all the results can't skip any.
- Use the browse API. It reads the database and pages in a fixed order. Bowie's 17 pages and the Beatles' 24 pages returned 1,623 and 2,308 different releases, exactly the counts MusicBrainz reported. (measured)

## How I measured

The scripts are in `scripts/discography-speed/`. Every live call went out one at a time, at least 1.1 s apart, with `User-Agent: alexandria-dev/0.1`.

- `measure-current.mjs` runs the app's own `getDiscography` against live MusicBrainz and records every request and release.
- `complete-search.mjs` collects every vinyl and deluxe release by splitting each search until it fits on one page. This is the ground truth.
- `browse-all.mjs` pages through the browse API.
- `probe.mjs` sends single requests, like the 500-result check.
- `simulate.mjs` runs offline. It feeds the app's real `getDiscography` a fake MusicBrainz built from the ground truth, counts the requests each strategy needs, and compares the lines each one shows.

Checks on the method:

- The rebuilt search index gives the same count as MusicBrainz for every ground truth query it can check: all 19 for Bowie and 53 of 63 for the Beatles. The other 10 filter by country, which the recorded data doesn't keep. It also matches all 35 vinyl and deluxe queries of the app's live runs (8 and 27).
- Run on the fake MusicBrainz, the app makes 15 requests for Bowie and 36 for the Beatles, the same as the live runs.
- Other agents share this machine's address, so MusicBrainz answered 218 of my requests with 503. I left all of them out of the counts. They also make the live wall clock times useless: 79 s for Bowie and 535 s for the Beatles. So every time here is the request count times 1.1 s.
- That estimate holds because the gap, not the response, sets the pace. Search responses took a median of 274 to 329 ms and browse responses 624 to 631 ms. Only 2 of the 194 logged answers took longer than 1.1 s, the slower at 1.19 s. (measured)
- In all, about 220 requests got an answer over the session, all one at a time.

## Facts checked against the live API and current docs

- Search returns at most 500 results per query. Asking for offset 450 with limit 100 got HTTP 400, "Must retrieve at most 500 search results, not 550." (measured)
- Search and browse both allow at most 100 results per request. A bigger page size isn't possible. ([API docs](https://musicbrainz.org/doc/MusicBrainz_API), [search docs](https://musicbrainz.org/doc/MusicBrainz_API/Search))
- Browsing releases accepts `inc=media` and `inc=release-groups`. Browsing release groups takes no `inc` that lists releases or formats, so it can't say which groups have vinyl. (docs)
- The docs say a release browse page holds at most 500 tracks. That didn't happen without `inc=recordings`. Every page but the last held 100 releases, over 41 pages, and one page held 4,315 tracks. (measured)
- Release browse takes `type` and `status` filters, and `status=official|promotion` returns both. (measured)
- The release group search has no format field, so it can't find vinyl. (docs)
- One search, `arid:<id> AND primarytype:album AND NOT secondarytype:[* TO *]`, returns every studio album on one page: 35 for Bowie and 81 for the Beatles. They are exactly the groups the app's own release group browse calls studio albums. (measured)
- The search index files a release under its earliest release date. The API sometimes shows a later one first, like "2021" for a Bowie release first out in 2019. (measured)
- A page of 100 releases is about 130 KB of JSON either way, about 20 KB gzipped. (measured)
- MusicBrainz allows about one request a second per address and answers 503 above that. The docs date from 2012 and say the rules can change. ([rate limiting](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting))

What the two artists have (measured):

| | Bowie | Beatles |
|---|---|---|
| Release groups (albums, EPs, singles) | 633 | 875 |
| Studio albums | 35 | 81 |
| Vinyl releases, any size | 525 | 1,498 |
| of them LP or 12" | 360 | 820 |
| Deluxe or expanded releases, any format | 16 | 73 |
| Releases (albums, EPs, singles), any status | 2,031 | 3,138 |
| of them official or promotional | 1,623 | 2,308 |
| Busiest year for vinyl | 1983, 43 | 1964, 276 |

## Options

### Where the data comes from

Each row is a way to get the release groups and their vinyl and deluxe flags. "m" means measured, "e" means estimated from measured counts. Time is requests times 1.1 s.

| Option | Requests Bowie | Requests Beatles | Time Bowie | Time Beatles | Accuracy risk | Effort | Tradeoffs |
|---|---|---|---|---|---|---|---|
| A. Today: group browse, vinyl search and deluxe search, paged up to 500 | 15 (m) | 36 (m) | 16.5 s | 39.6 s | High. Misses 13% to 23% of vinyl pressings, at random (m). | None | Nothing shows until the end. |
| B. Search, split until each query fits one page | 26 (m) | 72 (m) | 28.6 s | 79.2 s | None. Exact (m). | Small | Slowest. The Beatles' 1964 needed splits by format, country, status and half year. |
| C. B, reusing the year counts saved by the last load | 15 (e) | 35 (e) | 16.5 s | 38.5 s | None | Medium | Helps only a refresh. A first load costs B. |
| D. Browse releases of any status | 21 (e) | 32 (e) | 23.1 s | 35.2 s | None expected. Not run in full. | Medium | Pages include bootlegs the app then throws away. |
| D2. Browse official and promotional releases | 17 (m) | 24 (m) | 18.7 s | 26.4 s | Low for vinyl: Bowie's LP flags match B and one 45 flag differs, the Beatles lose 5 lines whose only vinyl pressing has no status (m). High for the list: groups with no official release drop out, 7 Bowie and 61 Beatles lines in the default view (m). | Medium | Needs the studio album search beside it. That is option F. |
| D3. D2 plus the group browse | 24 (e) | 33 (e) | 26.4 s | 36.3 s | Low. D2's flags, today's list. | Medium | 7 to 9 more requests than F for lines that only show with Vinyl only off. |
| E. B for LPs and 12" only, 45s and 10" when that chip is on | 20 (e) | 43 (e) | 22.0 s | 47.3 s | None | Medium | Turning the chip on costs another load. Doesn't help browse, which gets every format anyway. |
| **F. Studio album search, then D2** | **18 (m)** | **25 (m)** | **19.8 s** | **27.5 s** | Low. Default view: the same lines as B for both artists, plus one extra Bowie line (Tin Machine, which a release credits to him). Every type on: 2 extra Bowie lines, 5 missing Beatles lines (no-status pressings) (m). | Medium | With Vinyl only off, groups with no official or promotional release are missing unless the group browse runs then (7 or 9 more requests). |

A small artist gets faster too. With up to 100 official releases and 100 release groups, today takes 3 requests and F takes 2. (estimated)

The artist lookup adds one request before any of these when your records don't carry the artist's MusicBrainz id yet. That doesn't change between options.

### When the list shows

| Option | First list, Bowie | First list, Beatles | Accuracy risk | Effort | Tradeoffs |
|---|---|---|---|---|---|
| G. Show results as they arrive | 1 request, 1.1 s, with F. 7 requests, 7.7 s, with A. | 1 request, 1.1 s, with F. 9 requests, 9.9 s, with A. | None. Labels stay pending until the vinyl check ends. | Medium | Lines change while loading. In the default view only the "Vinyl not confirmed" labels and the deluxe lines change, since studio albums show either way. Other type chips fill in. |
| H. Show the cached copy at once, refresh in the background, keep copies longer | 0 requests on any repeat visit | Same | Shows the cached copy, which can be more than a week old, until the refresh lands | Small | The refresh still costs a full load, but nobody waits for it. |
| I1. Start loading when a record's edit dialog opens | Saves the time spent in the dialog | Same | None | Small | Loads some artists that are never opened. Picking an artist from the list already starts the load at once, so there's nothing to gain there. |
| I2. Load collection artists in idle time | 0 s wait for any of them | Same | None | Medium | Background traffic and mobile data. Needs a low priority lane in the request queue, or typing in search waits behind it. |

For I2, an artist with up to 100 official releases takes 2 requests with F. A collection of 100 such artists is about 200 requests, or about 4 minutes of background traffic each week, at about 20 KB a page gzipped. (estimated)

### A server

| Option | Requests from the app | Time | Accuracy risk | Effort | Tradeoffs and cost |
|---|---|---|---|---|---|
| J. Shared cache, such as a Cloudflare Worker with KV storage | 1 when the server has the artist | Under 1 s when cached (e). A cold artist takes as long as today. | Same as the data path behind it | Medium, plus upkeep | Free plan: 1,000 KV writes and 100,000 KV reads a day. Paid plan: $5 a month minimum (Cloudflare docs, seen through search: I couldn't open the pricing page from this machine). Every user shares the server's address, so they share the one request a second. Cloudflare's outgoing addresses are shared with other customers, so 503s like the 218 I got here are likely. A small server with its own address avoids that, for roughly $5 a month (estimate). Helps only when several people look up the same artists. |
| K. Own MusicBrainz mirror ([musicbrainz-docker](https://github.com/metabrainz/musicbrainz-docker)) | 1 | Under 1 s (e) | None | Large, plus upkeep | No rate limit. A discography becomes one database query. Needs 2 CPU threads, 4 GB RAM and 100 GB disk without search indexes, or 16 threads, 16 GB and 350 GB with them (project README). Needs a MetaBrainz access token for the daily updates. A server that size costs roughly $20 to $40 a month (estimate, prices not checked). |

## Recommendation

Do F, G and H, in that order. Hold I2, J and K unless you want them.

1. **F and G: studio albums first, then browse.** Change `getDiscography` to run the studio album search, report the albums, then browse official and promotional releases with `inc=media+release-groups`, reporting after each page. `loadDiscography` renders after the first report with a "Checking vinyl" note.
   - First list: 1.1 s for both artists (estimated), instead of 16.5 s for Bowie and 39.6 s for the Beatles.
   - Fully loaded: Bowie 19.8 s, the Beatles 27.5 s (estimated).
   - The deluxe search and the 500-result splitting both go away. Browse returns every format and every title, so deluxe and 45s come with it.
   - The vinyl flags become right. For Bowie they match the exact search except one 45 flag. For the Beatles they match except 5 lines whose only vinyl pressing has no status (measured on recorded data).
   - When Vinyl only is turned off, fetch the group browse then, so groups with no official release still show.
2. **H: cached copy first.** Show any cached discography at once and refresh it in the background when it's more than a week old. Repeat visits wait 0 s.

Why not the others:

- B and C are exact but slower than F, or only faster on a refresh.
- D costs 4 to 8 more requests than D2 for releases the app mostly throws away.
- E does nothing for browse.
- I1 saves a few seconds at best.
- I2, J and K cost traffic or money. I2 can come later if you want it.

## Decisions for you

1. **Should we pay for or host a server?** My recommendation: no. A cache server only helps when several people open the same artists. A cold artist loads no faster. A mirror would make every load instant but costs about $20 to $40 a month and needs upkeep.
2. **May the app use the network in the background?** This covers refreshing stale discographies (H) and, separately, loading every collection artist ahead of time (I2), on phones too. My recommendation: yes for refreshing artists you've already opened, no for the whole collection for now.
3. **May the vinyl check ignore pressings that have no status in MusicBrainz?** It saves 4 requests for Bowie and 8 for the Beatles. It drops 5 Beatles lines when every type is on, none in the default view, and no Bowie lines. They're obscure ones like "Rare Beatles" (1982) and "Golden Greatest Hits" (1979). My recommendation: yes.
4. **With Vinyl only off, should groups with no official or promotional release still show?** Their releases are all bootlegs, pseudo-releases or have no status. Today they show. Bowie has 292 (227 live, 52 compilations) and the Beatles 473 (346 compilations, 107 live). Keeping them costs the group browse (7 or 9 more requests) when you turn Vinyl only off. My recommendation: keep them, loaded only then.
5. **May the app show a cached discography older than a week while it refreshes?** My recommendation: yes, up to four weeks, the age at which the app already deletes cached copies. After that, load from scratch.

## Proposed next iterations

1. **Iteration 2: prototype F and G.** Change `getDiscography` and `loadDiscography`, update the unit test fakes and the browser test mocks for the browse calls, and bump the discography cache key. Measure it live with these scripts: requests, time to the first list, and the lines it shows against the recorded ground truth. `npm test` and `npm run test:e2e` must pass.
2. **Iteration 3: H.** Show stale copies at once and refresh in the background, with whatever age limit you choose.
3. **Iteration 4, if you agree to background loading: I2.** Add a low priority lane to the request queue and warm the collection artists in idle time.
4. **Along the way:** measure 3 or 4 small and mid-sized artists to confirm F never needs more requests than today for them. Also fix today's loader if F is delayed. Making each search query fit one page fixes the missing pressings on its own, at B's cost.

## Iteration 2: option F built

The answers came back: no server, background refresh only for artists you've opened, pressings with no status don't count, groups with no official release load when Vinyl only is turned off, and cached copies show at once up to four weeks old.

The app now runs option F. One search lists the studio albums, then the official and promotional releases are browsed 100 at a time, and the list fills in as each page arrives. Until the vinyl check ends, no line says "Vinyl not confirmed". Turning Vinyl only off loads the release group browse once and keeps it with the discography. Picking another artist stops the requests for the last one. The cache key moved to v6.

Each loader ran live once per artist (measured, 503s left out):

| Artist | Requests before | Requests now | First list now | Groups with an LP, before and now |
|---|---|---|---|---|
| Portishead | 3 | 3 | after 1 | 10, 10 |
| Boards of Canada | 3 | 3 | after 1 | 11, 11 |
| Khruangbin | 3 | 3 | after 1 | 15, 15 |
| Radiohead | 8 | 7 | after 1 | 33, 33 |
| David Bowie | 15 | 18 | after 1 | see below |
| The Beatles | 36 | 25 | after 1 | see below |

The small and mid-sized artists need no more requests than before. Bowie needs 3 more, as option F predicted.

Pressings found, against the complete lists from iteration 1 (measured):

- Bowie: 487 of 491 (before: 377). The 4 missed have no status.
- The Beatles: 1,437 of 1,453 (before: 1,264). 12 missed have no status. 4 are interview and broadcast records, which the app ignores anyway.
- Lines: the same as the exact search in the default view for both, except one extra Bowie line (Tin Machine). With every type on, Bowie shows 2 extra lines and the Beatles miss 5 whose only vinyl pressing has no status. These match the iteration 1 prediction exactly.

A new unit test fakes a search that returns tied results in a new order on each page. The old loader found 215 of 300 pressings with it. The new one finds all 300.

## Iteration 3: saved copies first

A saved discography now shows at once for up to four weeks. Once it's a week old, a new copy loads behind it and takes its place when complete. Refresh works the same way. After four weeks the copy is deleted and the artist loads from scratch, the age at which the app already deleted saved copies.

- Repeat visit, any age up to four weeks: the list shows before any request (measured in the browser test, which holds back MusicBrainz's answer while it checks the page).
- The refresh behind it costs the same requests as a first load: 18 for Bowie and 25 for the Beatles (estimated from iteration 2's live counts). Nobody waits for them.
- Only the artist on screen is refreshed. Nothing loads for other artists in the background.

## Reproducing

```sh
node scripts/discography-speed/simulate.mjs    # offline, from the recorded data
NODE_USE_ENV_PROXY=1 node scripts/discography-speed/measure-current.mjs 5441c29d-3602-4898-b1a1-b77fa23b8e50 bowie
NODE_USE_ENV_PROXY=1 node scripts/discography-speed/complete-search.mjs 5441c29d-3602-4898-b1a1-b77fa23b8e50 bowie
NODE_USE_ENV_PROXY=1 node scripts/discography-speed/browse-all.mjs 5441c29d-3602-4898-b1a1-b77fa23b8e50 bowie 'official|promotion'
```

`measure-current.mjs` runs the app's current loader. To run the one from before iteration 2, set `MB_MODULE` to the absolute path of `scripts/discography-speed/old-musicbrainz.js`. `NODE_USE_ENV_PROXY=1` is only needed behind a proxy. The live scripts keep each answer in `data/cache/`, which isn't committed, so a run that stops partway can start again without asking twice. The recorded data, measured on 2026-11-15, was taken out before merging to keep the repository small. It is still in commit `16d30d9`. To run `simulate.mjs` again, restore it first with `git checkout 16d30d9 -- scripts/discography-speed/data`.
