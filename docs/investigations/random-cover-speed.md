# Random pick: showing the cover sooner

Iteration 1 measured the first hop and compared options. Iteration 2 measures the archive.org hops and builds what the user chose. The options and recommendation below are still iteration 1's and will be updated at the end of iteration 2.

## Short answer

Preload the next pick. Today nothing loads before the tap, so the person waits for the whole redirect chain and a 1200px download every time. If the app picks the next record one tap ahead and loads its cover in the background, the next tap shows a cover the browser already holds. In a local check, showing a preloaded cover made no network request at all.

For the first pick, start that preload when the Random page opens. Also show the 500px cover from the collection grid straight away when the grid has already loaded it, and swap in the 1200px cover when it arrives.

Every number below is labeled:

- **Measured**: taken in this session.
- **Estimated**: reasoned from measured numbers or from how browsers and networks work. Iteration 2 should measure these.
- **Not measured**: could not be taken in this session.

## What happens today

When you tap **Pick a record**, `spin()` in `js/app.js` calls `showPick()`. In the same tick it does two things.

1. `tintWithAlbum()` calls `albumColor()`. That starts a detached `new Image()` for `front-250` with `crossOrigin = 'anonymous'`. When it loads, `mainColor()` draws it to a 32x32 canvas and picks the main color. The result is kept in memory per release group, for this page session only.
2. `cover(record, 'lg')` inserts an `<img loading="lazy">` for `front-1200`. If that fails, it tries `front-500`.

Both requests go to `https://coverartarchive.org/release-group/<id>/front-<size>`. Nothing is requested before the tap. The cover fades in over 0.25 s once loaded (`.cover img` transition in `css/styles.css`).

So the person waits for this:

```
tap -> hop 1: coverartarchive.org 307
    -> hop 2: archive.org/download/... 302
    -> hop 3: a storage server such as dn720706.ca.archive.org, 200
    -> 1200px JPEG bytes -> decode -> 0.25 s fade
```

In parallel, the 250px color image runs through the same chain.

## How this was measured

- Date: 2026-11-15. All requests ran from a cloud container through its egress proxy. A phone on Wi-Fi or 4G will see different round trip times.
- In iteration 1, archive.org was not on this environment's network allowlist, so only hop 1 was measured. For iteration 2 the user allowed it. `measure-archive.sh` then followed the whole chain for 5 covers at 250, 500 and 1200px, one request at a time. The raw output is in `random-cover-speed/results-archive.tsv`.
- The sandbox proxy reset two connections in the middle of a chain. Those two chains are missing a size. No request was refused.
- Requests were few and mostly sequential: about 30 curl requests and three browser runs of 13 to 21 requests each to coverartarchive.org in iteration 1, and about 80 curl requests across the whole chain in iteration 2, at most 2 a second. The app's grid loads its 4 covers at once, as it does in real use.
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
| 1 | coverartarchive.org 307, new connection (curl, 15 chains in iteration 2) | 381 to 631 ms, median 424 ms. Without the connection setup: median 145 ms. | Measured |
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

In Chromium, through this sandbox's proxy, every cover request used HTTP/1.1 and a new connection. Hop 1 took 520 to 743 ms in the app for 33 of 35 requests, with one at 232 ms and one at 1637 ms (measured). curl reached the same host over HTTP/2 and reused its connection. A phone without this proxy should behave more like curl. Treat the 520 to 743 ms as a sandbox worst case.

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
| Extra transfer time of 1200 over 500, phone, new connection | | | about 100 to 300 ms, 2 more round trips | Estimated |

Decode and sampling times use JPEGs generated in the page. They are not real covers, and a phone CPU is slower, perhaps 3 to 5 times.

The 250px files are large for their size, 22 to 40 KB. Some carry Photoshop metadata. The color read downloads a third of a 500px cover just to sample 32x32 pixels.

| Cover | 250px | 500px | 1200px |
| --- | --- | --- | --- |
| OK Computer (b1392450) | 41,268 B | 85,302 B | 268,304 B |
| Kid A (e75c0549) | 29,967 B | 91,925 B | 348,178 B |
| The Best Of (80975c59) | 22,901 B | 48,488 B | 194,721 B |
| I Might Be Wrong (e404b349) | 28,274 B | 90,093 B | 265,464 B |
| In Rainbows: From the Basement (d2f48ef0) | cut by a proxy reset | 42,117 B | 67,315 B |

### 3. Preloading and the color read

- **Nothing preloads today** (code and network log). Every request starts after the tap.
- The 1200px request starts **3 to 14 ms after the tap** (9 picks, measured). `loading="lazy"` delays it by **2 to 13 ms** after the `<img>` goes in (measured). Chromium starts it at Low priority and raises it to High after layout. This is not worth changing.
- The color read starts **1 to 4 ms after the tap** (measured), as a separate CORS request for the 250px cover. It runs in parallel with the cover, so it does not delay the cover directly. It does compete for bandwidth and goes through its own redirect chain.
- The color is kept in memory per release group. Picking the same record again made no new 250px request (measured). It is lost on reload.
- Sampling the color takes about 1 ms on this machine (measured). Almost all of the color's time is network.

### 4. Reusing covers the browser already has

The random pick asks for `front-1200`. The grid asked for `front-500`. Different URLs, so **the grid's cover is never reused today** (measured: Kid A's 500px loaded in the grid, and the pick then requested 1200 and 250 anyway).

`check-browser-reuse.js` tests Chromium's reuse rules against a local server that sends the same headers as the real 307. This tests browser behavior only, not archive.org's speed. It ran twice: once with an image that has `Cache-Control: max-age=86400`, and once with an image that has no cache headers. In iteration 2 the real storage-server headers turned out to sit in between: `Last-Modified` and `ETag`, plus `max-age=21600` on the `.us` servers only.

| Case | Requests made (redirect / image) | Label |
| --- | --- | --- |
| Same page, new `<img>` with a URL already loaded | 0 / 0, with either image cache header | Measured (local) |
| Same page, preloaded with `new Image()`, then `<img>` with the same URL | 0 / 0 | Measured (local) |
| Preload still in flight when the `<img>` is added | 1 / 1 for both together: the `<img>` joins the preload | Measured (local) |
| Loaded in CORS mode (like the color read), then a plain `<img>` of the same URL | 1 / 0 if the image is cacheable, 1 / 1 if not | Measured (local) |
| After a page reload, a URL loaded before | 1 / 0 if the image is cacheable, 1 / 1 if not | Measured (local) |

What this means:

- In one page session, reusing a loaded cover or a preloaded cover is free. No round trip at all.
- A CORS load and a plain load of the same URL do not share. Mixing them costs at least hop 1 again.
- After a reload, hops 1 and 2 are always paid again, because neither redirect is cacheable (measured headers). The image itself can come from the HTTP cache. `.us` servers allow 6 hours. `.ca` servers send only `Last-Modified`, so browsers guess a lifetime, usually a tenth of the file's age. Covers last changed months or years ago get days to weeks (estimated, from how browsers treat `Last-Modified`). The storage server can differ on the next visit, and the cache is keyed by the full address, so a cached cover is missed when the server changes.

## Options

Times saved are per pick on a phone, compared with today. Effort is for a no-build change in `js/app.js`.

| Option | Expected time saved | Effort | Tradeoffs |
| --- | --- | --- | --- |
| **A. Preload the next pick.** Pick one tap ahead. Load its 1200px cover with `new Image()` and start its color read. On the tap, show it. | Nearly the whole wait, about 0.4 to 2 s (estimated), on every pick after the first, if the person looks at a pick longer than the preload takes. A quicker tap still saves whatever has loaded (measured: the `<img>` joins the preload). Shown from memory with 0 requests (measured, local). | Small. About 30 lines. | One extra 1200px download per pick, about 150 to 500 KB (estimated), wasted when the person leaves. The next pick must be redone when a filter changes. Should be skipped when Save-Data is on. Randomness is unchanged. |
| **A2. Preload a few candidates.** | Same as A at best. The pick can be decided ahead, so more candidates add nothing. | Small | 2 to 3 times A's extra data. Not recommended. |
| **B. Show 500px first, swap in 1200px.** | When the 500px is not in memory: only the transfer difference, about 100 to 300 ms (estimated). All hops are the same for both sizes (measured for hop 1). | Small to medium | Two downloads per pick. A visible sharpening when 1200px lands. |
| **C. Reuse the grid's 500px cover.** Show it at once when it is already loaded, then swap in 1200px. `loadedCovers` in `app.js` already records which covers loaded. | The whole wait for the first image, when the grid loaded that cover in this page session. 0 requests (measured, local). Otherwise nothing. | Small. Builds on B. | Only helps covers the grid actually loaded. The grid loads lazily, so in a large collection most covers are not loaded unless the person scrolled. Softer image at first. |
| **D. Cache the redirect target.** Store the archive.org address per record and load from it directly. | Hop 1 on every cover in every view, including after a reload: 149 ms warm, 484 ms cold, medians from this container (measured). | Medium to high. A page cannot read a redirect's `Location` (measured: `fetch` with `redirect: 'manual'` gives an opaque result). The app would have to `fetch` the image in CORS mode and keep `response.url`, which is the final storage-server address. | Shows a stale cover if someone replaces it on the Cover Art Archive. Storage-server addresses may move (not measured). Needs a fallback to the normal URL, and storage per record. |
| **E1. Keep the color with the record.** Save it once, reuse it on every later pick and in the edit screen. | Little for the cover, about 0 to 50 ms (estimated, one fewer parallel download). The gradient shows at once instead of after the 250px chain. | Small to medium. New record field, kept in backups. | Changes the stored data and backup format. A color does not update if the cover changes. |
| **E2. Read the color from the shown cover.** Load the 1200px cover with `crossorigin` and sample it. | One fewer request chain. The gradient waits for the 1200px instead of the 250px, so it comes later. | Small | If any hop lacks CORS headers, the cover itself fails instead of only the color. Needs a retry without `crossorigin`. Sampling costs 13.2 ms instead of 0.9 ms here (measured). Mixing modes defeats reuse (measured). |
| **F. Use 500px for the random pick.** | About 100 to 300 ms of transfer (estimated) and 17 ms of decode on this machine (measured). | Tiny | Soft on 3x phones: 500px for a 756 device px sleeve. The README chose 1200px for sharpness. |
| **G. Drop `loading="lazy"` on the big cover, add `fetchpriority="high"`.** | Under 15 ms (measured). | Tiny | Not worth it alone. Could ride along with A. |
| **H. Service worker that caches covers.** | The whole wait for any cover seen before, even after a reload (estimated). | High. New `sw.js`, cache rules, storage limits. Chrome pads each opaque response to about 7 MB of storage quota (Chrome's documented behavior, not measured). | A bigger change to how the app works. Also gives offline covers. |

## Recommendation

Do **A** and **C** together, then **E1**.

1. **A: preload the next pick.** This is the largest saving for the least work. It removes the whole wait, estimated at 0.4 to 2 s, from every pick after the first. The browser behavior it relies on is measured: a preloaded cover shows with 0 requests, and a tap during the preload joins it instead of starting again.
2. **C: show the grid's 500px cover at once when it is loaded.** This covers the first pick, and taps that come before the preload finishes. The app already tracks loaded covers in `loadedCovers`, so this is a small change.
3. **E1: keep the color with the record.** The gradient then shows at once too, and one request chain per pick goes away.

Start the first preload when the Random page opens. Do not start it at app start: most visits never open the Random page, and the end-to-end test expects no 250px requests on the Collection page.

Leave **D** and **H** for later. They help every view and survive a reload, but cost more and risk stale covers. Whether they are worth it depends on archive.org's cache headers and hop times, which are not measured yet.

## Decisions for you

1. **Allow archive.org for this environment?** Hops 2 and 3, real image sizes and archive.org's cache headers could not be measured, because the network policy blocks `archive.org`. To measure them, add `archive.org` and `*.archive.org` under Network access, Allowed domains, in the cloud environment settings. Recommended: yes. Without it, iteration 2 can build the prototype but cannot measure its real gain.
2. **Is one extra cover download per pick acceptable?** Preloading costs about 150 to 500 KB per pick (estimated), wasted when you leave the page. Recommended: yes, but skip preloading when the phone's Save-Data setting is on.
3. **Is a visible sharpening acceptable?** Option C shows the 500px cover first, then the 1200px one. Recommended: yes, with the existing 0.25 s fade.
4. **Keep 1200px for the random pick?** 500px alone (option F) is faster but soft on 3x phones. Recommended: keep 1200px.
5. **Keep the cover color in each record (E1)?** This adds a field to records and backups. Recommended: yes, in a later iteration.

## Next iterations

- **Iteration 2: prototype A and C.** Build them on this branch with an end-to-end test that checks the preload request goes out before the tap. Measure the time from tap to visible cover, before and after, in Chromium with a throttled network ("Fast 4G" and "Slow 4G"). If archive.org is allowed by then, also measure hops 2 and 3, the bytes of 250, 500 and 1200px for about 5 covers, and archive.org's cache headers.
- **Iteration 3: E1.** Keep the color with the record, include it in backups, and fall back to the read when it is missing.
- **Iteration 4: decide on D or H** using the iteration 2 numbers. Do it only if hop 1 or the archive.org hops are still a large share of the first pick.

## Rerunning

From the repository root. Playwright must be installed. Both scripts keep their requests few and sequential.

```sh
# Hop 1 timings with curl, cold and kept-alive
bash docs/investigations/random-cover-speed/measure-redirect.sh \
  b1392450-e666-3926-a536-22c65f834433 e75c0549-ad55-39e3-8025-c72c5d4a3c5d

# The real app in Chromium at phone size: request timing per pick, plus decode and color times
node docs/investigations/random-cover-speed/measure-random-pick.js
# Where archive.org is reachable, let the whole chain through:
ALLOW_ARCHIVE=1 node docs/investigations/random-cover-speed/measure-random-pick.js

# Chromium's reuse rules against a local server, no outside network
node docs/investigations/random-cover-speed/check-browser-reuse.js
```

`measure-random-pick.js` uses `HTTPS_PROXY` when it is set. The release groups are OK Computer, Kid A, The Best Of and I Might Be Wrong by Radiohead.
