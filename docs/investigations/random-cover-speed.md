# Random pick: showing the cover sooner

Iteration 1 measured the first hop and compared options. Iteration 2 measured the archive.org hops, built what the user chose, and measured the result before and after.

## How it is now

Time from tapping **Pick a record** to the cover showing, on a throttled 4G connection, with real covers from the Cover Art Archive (medians, measured):

| Case | Before | After |
| --- | --- | --- |
| A cover the collection grid has already loaded | 1.21 s | **0.005 s**. The sharp 1200px version fades in at 1.29 s. |
| A cover the grid has not loaded, first time that record is picked | 1.17 s | Unchanged, about 1.2 s. Both versions make the same two downloads. |
| A cover the grid has not loaded, picked before | 1.17 s | A 500px cover at 1.05 s, the sharp one at 1.22 s |
| The colored background behind the pick, once the record has been picked or opened before | about 0.9 s | **0.006 s** |

- The app opens on the collection, and the grid loads **63 covers** on a phone before any scrolling (measured, local). So in a collection of up to about 60 records, every pick shows its cover at once, as long as the collection has been on screen since the app opened.
- In a bigger collection, the instant case covers the first 63 covers and any the person scrolled past. The rest take about 1.2 s, as before.
- The colored background now shows at once for any record whose color the app has read before, on any visit, because the color is saved with the record and in backups.

The 4G profile adds 165 ms of latency per request and limits the connection to 8.1 Mbps down. It sits on top of this cloud container's own network, which already takes about 150 ms per round trip through its proxy. So a phone on good 4G should see shorter absolute times (estimated). The before and after picks ran interleaved on the same setup, so the comparison holds.

Every number below is labeled:

- **Measured**: taken in this investigation.
- **Estimated**: reasoned from measured numbers or from how browsers and networks work.

## What changed in iteration 2

The user's decisions after iteration 1: allow archive.org for measuring, no preloading, show the 500px cover first and fade in the 1200px one, keep 1200px, and keep each cover's color with the record.

1. **The 500px cover shows first** (`cover()` in `js/app.js`). The big random pick lays the 1200px cover over the 500px one in two cases. One is when the collection has already loaded the 500px cover, which then shows at once from the browser's memory with no request. The other is when the record's color is already saved. Otherwise it asks for 1200px alone, and falls back to 500px if there is no 1200px cover, as before. Each cover image now fades in on its own (`.cover img.shown`).
2. **The color is kept with the record** (`js/store.js`). The first color read is saved as `coverColor`, in the form `rgb(12 34 56)`. Later picks and the edit screen use it at once. Backups include it, because they export records as they are. A record whose release group changes loses its saved color. The store change is one field in `cleanRecord`, one line in `update`, and a `setCoverColor` method that saves without redrawing the screen. It merges cleanly with `claude/account-sync`, and the unit tests pass on the merged tree.
3. **Tests.** The main browser test checks that a cover the list has loaded shows at once without a new request. A new browser test checks the 1200px-alone first pick, the saved color after a reload, the 500px-first display, and the fallback when a 1200px cover is missing. Two unit tests cover `coverColor`.

### Why the 500px cover is not always requested

The user left open what to do for a cover the grid has not loaded, and asked for a measurement. One candidate was to request 500px and 1200px together and show whichever arrives first. Measured on the 4G profile, for covers the grid had not loaded:

| Requests | Picks | First cover shows | Sharp cover shows | Downloaded |
| --- | --- | --- | --- | --- |
| 1200px alone, color still to read (before, and after on a first pick) | 25 | 1,185 ms | 1,185 ms | 288 KB |
| 500px and 1200px together, color still to read | 15 | 1,017 ms | **1,783 ms** | 376 KB |
| 1200px alone, color saved | 10 | 1,316 ms | 1,316 ms | 260 KB |
| 500px and 1200px together, color saved (after) | 20 | **1,052 ms** | 1,222 ms | 346 KB |

With 90% bootstrap intervals for the differences (measured):

- **While the color is still being read**, asking for both sizes means three downloads at once. The soft cover came 168 ms sooner, but the interval of -272 to +158 ms includes no gain. The sharp cover came **598 ms later**, interval +388 to +823 ms. So on a first pick the app asks for 1200px alone.
- **With the color saved**, there are only two downloads. A cover showed **264 ms sooner**, interval -384 to -146 ms. The sharp one was no later: -94 ms, interval -208 to +104 ms. So once a record's color is saved, the app asks for both.

One result is odd. "1200px alone, color saved" was slower than "1200px alone, color still to read", although it downloads less. Those picks all came from two runs made close together, so this is most likely drift in the network between runs. It shows how noisy single runs are. In the final run, two conditions that make identical requests differed by 176 ms. Treat differences under about 0.2 s as noise unless the pooled intervals say otherwise.

## How this was measured

- Date: 2026-11-15. All outside requests ran from a cloud container through its egress proxy. A phone will see different round trip times.
- In iteration 1, archive.org was not on this environment's network allowlist, so only hop 1 was measured. For iteration 2 the user allowed it. `measure-archive.sh` then followed the whole chain for 5 covers at 250, 500 and 1200px, one request at a time. The raw output is in `random-cover-speed/results-archive.tsv`.
- `measure-tap-to-cover.js` ran 90 picks across five runs: one pick at a time, a fresh browser context for each, at phone size (390x844 at 3x), on the 4G profile, with the conditions interleaved and rotated. It uses no Playwright routes, because routing turns Chromium's HTTP cache off (measured). The raw picks are in `random-cover-speed/results-tap-to-cover.json`.
- The sandbox proxy reset two connections in the middle of a chain. Each of those chains lost one size. No request was refused, and no browser pick failed.
- Requests to the Cover Art Archive and archive.org: about 30 curl requests and 55 browser requests in iteration 1. About 85 curl requests and 90 picks of about 9 requests each in iteration 2. At most 2 a second from curl, and one pick at a time in the browser.
- Scripts are in `docs/investigations/random-cover-speed/`. See [Rerunning](#rerunning).

## Findings

### 1. The redirect chain

Hop 1 always returns `307`. Real response headers (measured):

```
HTTP/2 307
content-type: text/plain; charset=utf-8
location: https://archive.org/download/mbid-<release-id>/mbid-<release-id>-<image-id>_thumb1200.jpg
access-control-allow-origin: *
```

There is no `Cache-Control` and no `Expires`, so browsers do not cache it. `access-control-allow-origin` comes back only when the request sends an `Origin` header, as the color read does. The target encodes the size (`_thumb250`, `_thumb500`, `_thumb1200`), so one lookup gives the target for every size. The JSON index at `/release-group/<id>` also redirects to archive.org, so it cannot skip archive.org either.

Hop 2 is a `302` from `archive.org/download/` to a storage server, such as `dn720706.ca.archive.org` or `ia801403.us.archive.org`. Hop 3 is that server sending the JPEG. Real headers (measured):

```
hop 2: HTTP/2 302, location: https://dn720706.ca.archive.org/0/items/mbid-.../..._thumb500.jpg,
       access-control-allow-origin: *, no cache-control, no expires
hop 3: HTTP/2 200, content-type: image/jpeg, last-modified, etag, access-control-allow-origin: *,
       no cache-control on *.ca.archive.org, cache-control: max-age=21600 on *.us.archive.org
```

Pass 1 times every hop on a new connection, so it shows the most a hop can cost. Subtracting the connection setup shows roughly what a hop costs on a connection that is already open.

| Hop | What | Time | Label |
| --- | --- | --- | --- |
| 1 | coverartarchive.org 307, new connection (curl, 15 chains) | 381 to 631 ms, median 424 ms. Without the connection setup: median 145 ms. | Measured |
| 1 | coverartarchive.org 307, kept-alive connection (curl, 14 requests) | 138 to 161 ms, median 149 ms | Measured |
| 1 | Same, from Chromium (`fetch` with `redirect: 'manual'`, 14 requests) | 180 to 244 ms, after a first request of 607 to 671 ms | Measured |
| 1 | `robots.txt` on the same host, kept-alive, for comparison | 148 to 154 ms, against 144 to 148 ms for lookups on that connection | Measured |
| 2 | archive.org 302, new connection (15 chains) | 307 to 720 ms, median 338 ms. Without the connection setup: median 128 ms. | Measured |
| 3 | Storage server 200 with the image, new connection (15 chains) | 434 to 1026 ms, median 658 ms. Without the connection setup: median 410 ms. | Measured |
| 1 to 3 | Whole chain, every hop on a new connection (15 chains) | 1130 to 2167 ms, median about 1.5 s | Measured |
| 1 to 3 | Whole chain, one connection pool (curl, 10 chains) | 563 to 1499 ms. Redirects alone: 240 to 433 ms after the first chain. | Measured |

Hop 1 costs the same for 250, 500 and 1200. A static file on the same host takes as long as the lookup. So hop 1 is one network round trip, and the archive's own lookup time is too small to see. Hop 2 is also about one round trip.

**The storage server is the slow part.** It changes from cover to cover, and sometimes between the sizes of one cover or between two requests for the same file. For example, e404b349's 250px came once from `ia600601.us` and once from `dn710800.ca`. So almost every cover opens a new connection to a new host, and the browser cannot keep one open in advance. In the warm pass, a 1200px file from a storage server whose connection was already open took 563 to 622 ms in total. From a new storage server it took 944 to 977 ms (measured).

In Chromium, through this sandbox's proxy, every cover request used HTTP/1.1 and a new connection. Hop 1 took 520 to 743 ms in the app for 33 of 35 requests, with one at 232 ms and one at 1637 ms (measured, iteration 1). curl reached the same hosts over HTTP/2. A phone without this proxy should behave more like curl.

### 2. Image size

- The sleeve on the Random page draws at **252 CSS px** on a 390px-wide phone. At 3x that is **756 device px** (measured).
- 500px covers 66% of that, so it looks soft on a 3x phone. 1200px is 1.6 times what the screen can show.
- The Cover Art Archive only offers 250, 500 and 1200. There is no size in between, so `srcset` would not help on 2x or 3x phones.

| | 250px | 500px | 1200px | Label |
| --- | --- | --- | --- | --- |
| Decode time on this machine | 1.3 ms | 3.6 ms | 20.6 ms | Measured |
| Color sampling (`mainColor`) on this machine | 0.9 ms | 2.8 ms | 13.2 ms | Measured |
| Bytes of a real cover (4 or 5 covers) | 22 to 40 KB, median 28 KB | 41 to 90 KB, median 83 KB | 66 to 340 KB, median 259 KB | Measured |
| 1200px size compared with 500px, same cover | | | 1.6 to 4.0 times, median 3.2 | Measured |

Decode and sampling times use JPEGs generated in the page. They are not real covers, and a phone CPU is slower, perhaps 3 to 5 times (estimated).

The 250px files are large for their size, 22 to 40 KB. Some carry Photoshop metadata. The color read downloads a third of a 500px cover only to sample 32x32 pixels. Saving the color means this happens once per record.

| Cover | 250px | 500px | 1200px |
| --- | --- | --- | --- |
| OK Computer (b1392450) | 41,268 B | 85,302 B | 268,304 B |
| Kid A (e75c0549) | 29,967 B | 91,925 B | 348,178 B |
| The Best Of (80975c59) | 22,901 B | 48,488 B | 194,721 B |
| I Might Be Wrong (e404b349) | 28,274 B | 90,093 B | 265,464 B |
| In Rainbows: From the Basement (d2f48ef0) | cut by a proxy reset | 42,117 B | 67,315 B |

### 3. When requests start, and the color read

- Before this work, nothing loaded before the tap (code and network log, iteration 1).
- The 1200px request starts **3 to 14 ms after the tap** (9 picks, measured). `loading="lazy"` delays it by **2 to 13 ms** after the `<img>` goes in (measured). Chromium starts it at Low priority and raises it to High after layout. This is not worth changing.
- The color read starts **1 to 4 ms after the tap** (measured), as a separate CORS request for the 250px cover, through its own redirect chain. Before this work it ran on every visit. Now it runs once per record.
- Sampling the color takes about 1 ms on this machine (measured). Almost all of the color's time is network.

### 4. Reusing covers the browser already has

Before this work, the random pick asked for `front-1200` and the grid for `front-500`. Different addresses, so the grid's cover was never reused (measured in iteration 1). Now the pick lays the grid's 500px cover underneath when it is loaded.

`check-browser-reuse.js` tests Chromium's reuse rules against a local server that sends the same headers as the real 307. This tests browser behavior only, not archive.org's speed. It ran with an image that has `Cache-Control: max-age=86400`, and with one that has no cache headers. The real storage servers sit in between: `Last-Modified` and `ETag`, plus `max-age=21600` on the `.us` servers only.

| Case | Requests made (redirect / image) | Label |
| --- | --- | --- |
| Same page, new `<img>` with a URL already loaded | 0 / 0, with either image cache header | Measured (local) |
| Same page, preloaded with `new Image()`, then `<img>` with the same URL | 0 / 0 | Measured (local) |
| Preload still in flight when the `<img>` is added | 1 / 1 for both together: the `<img>` joins the preload | Measured (local) |
| Loaded in CORS mode (like the color read), then a plain `<img>` of the same URL | 1 / 0 if the image is cacheable, 1 / 1 if not | Measured (local) |
| After a page reload, a URL loaded before | 1 / 0 if the image is cacheable, 1 / 1 if not | Measured (local) |
| Any of the above with Playwright routing turned on | Same-page reuse still 0 / 0. The HTTP cache is off, so the last two refetch the image. | Measured (local) |

What this means:

- In one page session, reusing a loaded cover is free. No round trip at all. This is what makes the grid-loaded case take 5 ms.
- A CORS load and a plain load of the same URL do not share. Mixing them costs at least hop 1 again.
- After a reload, hops 1 and 2 are always paid again, because neither redirect is cacheable (measured headers). The image itself can come from the HTTP cache. `.us` servers allow 6 hours. `.ca` servers send only `Last-Modified`, so browsers guess a lifetime, usually a tenth of the file's age. Covers last changed months or years ago get days to weeks (estimated, from how browsers treat `Last-Modified`). The storage server can differ on the next visit, and the cache is keyed by the full address, so a cached cover is missed when the server changes.

### 5. How many covers the grid loads

`count-grid-covers.js` opens the collection on a 390x844 phone, with fake covers answered locally (measured, local, no throttling):

- 12 tiles fit on the screen.
- Chromium's lazy loading fetches **63 covers** before any scrolling, in a collection of 300. In a collection of 60, it fetches all 60.
- On slower connections Chromium starts lazy images from further away, so it may load more (estimated).

## Options

Status after iteration 2. Times are per pick on the 4G profile unless marked.

| Option | Status | Time saved | Effort | Tradeoffs |
| --- | --- | --- | --- | --- |
| **A. Preload the next pick.** | Declined by the user | Nearly the whole wait on later picks (estimated, iteration 1) | Small | One extra cover download per pick |
| **B and C. Show the 500px cover first, reusing the grid's copy.** | **Built**, with the rule above | 1.2 s when the grid loaded the cover (measured). On repeat picks of other covers, the first image comes 0.13 s sooner than before (measured). Nothing on first picks of other covers. | Small | A visible sharpening when 1200px lands. About 58 KB more on repeat picks of covers the grid has not loaded. |
| **D. Skip the redirects.** Store an archive.org address per record. | Open | Hop 1, about one round trip, on every cover in every view, including after a reload: median 145 ms on an open connection from this container (measured). Hop 2 could only be skipped by storing a storage-server address, which changes between requests (measured). | Medium to high. A page cannot read a redirect's `Location` (measured). | Stale covers if one is replaced on the Cover Art Archive. Needs a fallback. |
| **E1. Keep the color with the record.** | **Built** | The background shows in 6 ms instead of about 0.9 s on repeat visits (measured). It also lets repeat picks ask for both sizes. | Small | One more record field, carried in backups |
| **E2. Read the color from the 500px layer instead of a 250px download.** | Open | Would let first picks ask for both sizes without a third download. Based on the color-saved runs, the first image would come about 0.1 to 0.3 s sooner on first picks only (estimated). | Medium. The 500px layer would need `crossorigin`, which cannot reuse the grid's plain copy (measured), so the two cases need different handling. | If a hop lacked CORS headers, the 500px layer would fail too. All hops send them today (measured). |
| **F. Use 500px only.** | Declined by the user | | | Soft on 3x phones |
| **G. Drop `loading="lazy"` on the big cover.** | Not worth it | Under 15 ms (measured) | Tiny | |
| **H. Service worker that caches covers.** | Open | The whole wait, about 1.2 s, for any cover seen before on that device, even after a reload or in a large collection (estimated). | High. A new `sw.js`, cache rules and storage limits. Chrome pads each opaque response to about 7 MB of quota (Chrome's documented behavior, not measured), so it would need CORS requests. | A bigger change to how the app works. Also gives offline covers. |

## Recommendation

Keep what iteration 2 built. It makes the common case on a small or browsed collection instant, keeps first picks no slower, and makes the background instant on repeat visits.

The remaining slow case is a cover the grid has not loaded in this session: about 1.2 s on 4G, mostly the storage server's new connection and transfer. Only a cache that survives reloads, option H, can remove that wait. Option D removes one round trip at most. Option E2 helps first picks by about 0.1 to 0.3 s at most (estimated). If the user wants to go further, H is the option worth a prototype. Otherwise this is a good place to stop.

## Decisions for you

The decisions from iteration 1 are answered and done. These are new.

1. **The rule for covers the grid has not loaded.** You asked me to decide this from measurements. I chose: 1200px alone on a record's first pick, 500px and 1200px together once its color is saved. The alternative of always asking for both shows a soft cover about 0.17 s sooner on first picks, but delays the sharp one by about 0.6 s and downloads about 90 KB more. Recommended: keep my rule.
2. **Go further with a service worker (H)?** It is the only option that can make covers the grid has not loaded show at once. It adds offline cover caching and a new file, and needs a prototype to measure. Recommended: only if large collections are a real use. Otherwise stop here.
3. **When `claude/account-sync` merges, should saving a cover color count as a change for sync?** `setCoverColor` does not go through `cleanRecord`, so it will not touch `updatedAt`. Recommended: leave it that way. The color is derived from the cover, and any device can read it again.

## Next step

If the answer to question 2 is yes: prototype a service worker on a branch that caches covers by their Cover Art Archive address in CORS mode, then measure tap-to-cover for a cover seen on an earlier visit, on the same 4G profile. If no: this branch is ready for review as it stands.

## Rerunning

From the repository root. Playwright must be installed. The scripts keep their requests few and one at a time.

```sh
# Hop 1 timings with curl, cold and kept-alive
bash docs/investigations/random-cover-speed/measure-redirect.sh \
  b1392450-e666-3926-a536-22c65f834433 e75c0549-ad55-39e3-8025-c72c5d4a3c5d

# The whole chain, hop by hop, with sizes and cache headers. PASSES=1 or PASSES=2 runs one pass.
bash docs/investigations/random-cover-speed/measure-archive.sh \
  b1392450-e666-3926-a536-22c65f834433 e75c0549-ad55-39e3-8025-c72c5d4a3c5d

# Tap to visible cover on 4G, before (bf604df) against this checkout, 5 covers by default.
# SET=strategy compares asking for both sizes (35f7d26) against this checkout instead.
node docs/investigations/random-cover-speed/measure-tap-to-cover.js

# Request timing per pick in the real app, plus decode and color times (iteration 1).
# Aborts archive.org unless ALLOW_ARCHIVE=1.
node docs/investigations/random-cover-speed/measure-random-pick.js

# Chromium's reuse rules against a local server, no outside network. ROUTED=1 turns on Playwright routing.
node docs/investigations/random-cover-speed/check-browser-reuse.js

# How many covers the grid loads before scrolling, no outside network
node docs/investigations/random-cover-speed/count-grid-covers.js 300
```

The browser scripts use `HTTPS_PROXY` when it is set. The release groups are OK Computer, Kid A, The Best Of, I Might Be Wrong and In Rainbows: From the Basement by Radiohead.
