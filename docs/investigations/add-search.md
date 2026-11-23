# Add search: a smarter box or artist and album toggles

Iterations 1 and 2 of the investigation. November 2026. The scripts, query set and saved MusicBrainz replies are in [add-search/](add-search/).

## The short answer

Keep one search box and make it smarter. Don't add toggles.

- Today's search puts the wanted record in the top 3 for **15 of 26** test queries. Both examples in the README miss: "ok comp" puts OK Computer 39th, and "radiohead kid" puts Kid A 6th.
- A better query plus a re-rank by how many pressings an album has gets **21 of 26**. It needs no new controls.
- Adding one artist row on top, taken from the same results, gets **26 of 26**. It still makes one call per search, like today.
- On **10 fresh queries** that I didn't use for tuning, today's search gets 7 and the smarter box gets 10.
- Toggles get **24 of 26** at best, and only if people always pick the right mode and type only that part. They add a control and a choice to every search.
- The ranking part, with no UI change, is on this branch to try.

## Iteration 2: the artist row is built

The answers to iteration 1's questions:

- The ranking change stays on this branch. It can ship before the artist row or with it.
- The row is one slim line above the albums, like "Radiohead · Artist · See all albums", with no cover.
- Tapping it opens the artist's page in the Discography tab.
- The row shows even when the text is also an album title.
- Toggles are dropped.
- `cache.json.gz` was taken out before merging. It is still in commit `fcc18ea`. To rescore offline, restore it with `git checkout fcc18ea -- docs/investigations/add-search/cache.json.gz`.

What's on the branch now:

- `search()` in `js/musicbrainz.js` returns `artist` next to the albums, using the rules scored as smart+found-artist. The artist comes from the pressings the search already found, so there's no extra request. A barcode search returns no artist.
- The Add page shows the row above the albums. A tap switches to the Discography tab and calls `loadDiscography` with the artist's MusicBrainz id, the same call the tab's own artist search makes. The discography code is unchanged.
- `check-app.js` runs the app's search on all 36 queries from the saved replies. The albums match smart and the row's artist matches smart+found-artist on all 36, so the app scores **26 of 26** on the main set and **10 of 10** on the fresh set.
- New unit tests cover the whole name, the words at the start, a typo, a surname, "Toner Low" not matching "low", a credited name, and no artist for a barcode. A new browser test covers the row, the tap, phone width and a barcode search. `npm test` passes 54 and `npm run test:e2e` passes 5.

After that, two more answers:

- The row shows the name that matched what was typed. That's the artist's own MusicBrainz name when it matched, and otherwise the name the matching records credit most often. So "takanaka" shows "Masayoshi Takanaka" instead of 高中正義, and a tap still loads the artist by MusicBrainz id. Takanaka is the only one of the 36 queries whose row name changed. A unit test and a browser test cover it.
- The new search was rescored with "Include 45s and 10" records" on.

### With 45s and 10" records on

With that setting on, the app sends a different query, so this took new requests. There were 36 replies, fetched one at a time, plus 29 retries after 503s. The replies are saved, and `SMALL=1` rescores them offline. Only the new search was run, not today's.

| Approach | Main set | Fresh set | Wrong artist rows on album queries |
|---|---:|---:|---:|
| smart | 21/26 | 10/10 | n/a |
| smart+found-artist (the branch) | 26/26 | 10/10 | 3 of 19, and 3 of 8 |

These are the same numbers as with the setting off. `SMALL=1 node check-app.js` confirms the app matches them on all 36 queries. What changed:

- "the the" has 2 of its top 3 by The The instead of 1. The row already named them either way.
- Kid A shows 2000 instead of 2016. Its first vinyl was a pair of 10" records, and with the setting off the app dates it by its first LP. That's how the app dates records, not a search problem.

## How it was tested

### The queries

26 queries cover what people type: artist only, album only, both, self-titled albums, typos and half-typed words, and names in other scripts or with accents. The last two columns are what someone would type with an Artist or an Album toggle.

| Query | Kind | Wanted | Artist toggle | Album toggle |
|---|---|---|---|---|
| `radiohead` | Artist only | Radiohead's records (deeper: *Hail to the Thief*) | `radiohead` | n/a |
| `miles davis` | Artist only, huge catalog | Miles Davis's records (deeper: *In a Silent Way*) | `miles davis` | n/a |
| `television` | Short or common name | Television's records (deeper: *Adventure*) | `television` | n/a |
| `low` | Short or common name | Low's records (deeper: *Things We Lost in the Fire*) | `low` | n/a |
| `yes` | Short or common name | Yes's records (deeper: *Close to the Edge*) | `yes` | n/a |
| `can` | Short or common name | Can's records (deeper: *Tago Mago*) | `can` | n/a |
| `the the` | "The The" | The The's records (deeper: *Soul Mining*) | `the the` | n/a |
| `ok computer` | Album only | Radiohead, *OK Computer* | `radiohead` | `ok computer` |
| `rumours` | Album only | Fleetwood Mac, *Rumours* | `fleetwood mac` | `rumours` |
| `radiohead kid` | Artist plus album (README example) | Radiohead, *Kid A* | `radiohead` | `kid` |
| `steely dan aja` | Artist plus album | Steely Dan, *Aja* | `steely dan` | `aja` |
| `kid a radiohead` | Album then artist | Radiohead, *Kid A* | `radiohead` | `kid a` |
| `can tago mago` | Short name plus album | Can, *Tago Mago* | `can` | `tago mago` |
| `the the soul mining` | "The The" plus album | The The, *Soul Mining* | `the the` | `soul mining` |
| `bowie low` | Album named like another artist | David Bowie, *Low* | `bowie` | `low` |
| `weezer` | Self-titled | Weezer, *Weezer* (the blue album) | `weezer` | `weezer` |
| `weezer blue` | Self-titled, with its nickname | Weezer, *Weezer* (the blue album) | `weezer` | `weezer` |
| `boston` | Self-titled | Boston, *Boston* | `boston` | `boston` |
| `ok comp` | Half-typed (README example) | Radiohead, *OK Computer* | `radiohead` | `ok comp` |
| `dark side of the mo` | Half-typed | Pink Floyd, *The Dark Side of the Moon* | `pink floyd` | `dark side of the mo` |
| `metalica master of puppets` | Typo in artist | Metallica, *Master of Puppets* | `metalica` | `master of puppets` |
| `radiohed ok computer` | Typo in artist | Radiohead, *OK Computer* | `radiohed` | `ok computer` |
| `fleetwod mac rumors` | Two typos | Fleetwood Mac, *Rumours* | `fleetwod mac` | `rumors` |
| `takanaka rainbow goblins` | Non-Latin name (高中正義) | Masayoshi Takanaka, *虹伝説 THE RAINBOW GOBLINS* | `takanaka` | `rainbow goblins` |
| `кино группа крови` | Cyrillic | Кино, *Группа крови* | `кино` | `группа крови` |
| `sigur ros agaetis` | Accents left off (Sigur Rós, Ágætis byrjun) | Sigur Rós, *Ágætis byrjun* | `sigur ros` | `agaetis` |

### How a result counts

- **Album queries:** a hit when the wanted album is in the top 3.
- **Artist-only queries:** someone who types only "radiohead" wants Radiohead's records. It's a hit when the top 3 are all theirs. For approaches with an artist row, it's a hit when the row names the right artist.
- **Toggles:** the query is what the person would type in that mode, from the table above. For "radiohead kid", that's "radiohead" with Artist on, or "kid" with Album on.
- **Right artist, right album:** results are matched by MusicBrainz artist id, so a tribute band with the same name doesn't count. Weezer's Blue Album is matched by its release group id, since Weezer has seven albums called "Weezer".

Every run goes through the app's own `searchReleaseGroups` code with only the query swapped. So the vinyl filter, the grouping into albums and the sort are the app's. Each MusicBrainz reply is saved, and every table here can be rebuilt without fetching again (see [Rerunning](#rerunning)).

## Why today's search misses

1. **A popular artist's name counts for little.** MusicBrainz scores a word by how rare it is in that field. "Radiohead" is in the artist field of thousands of pressings and in the titles of only a few. So four tribute records named after the band come first. Low, Can and Television have the same problem, and for Low the band's own records don't reach the top 3 at all.
2. **A half-typed word scores low.** A prefix match counts for less than a whole word. "ok comp" ranks "Workers Comp" above OK Computer, which comes 39th. "dark side of the mo" never matches "moon", because the app only treats a last word of 3 letters or more as a prefix.
3. **Well-known records lose to obscure exact matches.** MusicBrainz scores the text only. "rumours" puts a band called Rumours above Fleetwood Mac. "bowie low" puts records by LOW, Toner Low and Low Roar above David Bowie's Low.
4. **Each word can match anywhere.** "radiohead kid" ranks albums titled "Kid" above Kid A, because each word only has to match something.
5. **Typos find nothing.** "fleetwod mac rumors" doesn't find Rumours at all.

## The approaches

### One box, better query

| Name | What changes |
|---|---|
| current | Today's query: the text against titles or artists, the whole text weighted 3 times, the last word also as a prefix. |
| current+pop | Today's query, then a re-rank. Each album's score gets a bonus of 5 x ln(its pressings among the 100 returned). No extra call. |
| allwords | Every word has to match the title or the artist. |
| boosted | Today's query, plus a clause weighted 4 times for results where every word matched the title or the artist. Results with only some words still show, lower down. |
| boosted+fuzzy | The same, with one typo allowed in words of 4 letters or more. |
| boosted+fuzzy+pop | The same, re-ranked by pressings. |
| smart | boosted+fuzzy+pop, plus two fixes: a last word of 1 or 2 letters also counts as a prefix in the every-word clause, and release notes are searched too. Weezer's pressings carry the note "blue album". |
| smart+artist-boost | smart with the artist field weighted 3 times. |

### One box, finding the artist

| Name | What changes | Calls |
|---|---|---|
| two-step | Look up an artist first. If an artist's name is the start or end of the text, search only that artist's records for the other words. Otherwise use smart. | 2, one after the other |
| smart+artist-row | smart, plus up to two artist rows above the albums from a separate artist lookup. A row shows when the artist's name, alias or surname is the start or end of the text, allowing one typo. | 2 |
| smart+found-artist | smart, plus one artist row taken from the artists credited on the pressings smart already found. Among those whose name is the start or end of the text, it shows the one with the most pressings. A two-word name also matches by its last word, if it has 4 letters or more ("bowie", "takanaka"). | 1 |

### Toggles

| Name | What changes |
|---|---|
| toggle:artist-field | Artist on: today's query against the artist field only. |
| toggle:album-field | Album on: today's query against the title field only. |
| toggle:album-smart | Album on, with smart's fixes: typos, short prefixes, release notes and the re-rank. |
| toggle:artist-pick | Artist on, as two steps: a list of artists to pick from, then that artist's discography. A hit means the right artist is in the first three. The search allows a typo and checks aliases, so "takanaka" finds 高中正義. |
| toggle:artist-pick-wide | The same, also searching every word against aliases and sort names. |
| toggle:artist-then-albums | Artist on, pick the artist, then a one-call list of their vinyl pressings and studio albums instead of the full discography. |
| toggles (today's ranking) | The toggles together: artist-field for artist-only queries, album-field for the rest. |
| toggles (pick artist / smart album) | The best toggles together: artist-pick for artist-only queries, album-smart for the rest. |

The toggle rows assume the person always picks the right mode and types only that part. That is the best case for toggles.

## Results

### One box

| Approach | All | Artist only | Album only | Artist plus album | Self-titled | Typos, half-typed | Other scripts, accents |
|---|---:|---:|---:|---:|---:|---:|---:|
| current | 15/26 | 3/7 | 1/2 | 4/6 | 3/3 | 1/5 | 3/3 |
| current+pop | 19/26 | 3/7 | 2/2 | 6/6 | 3/3 | 2/5 | 3/3 |
| allwords | 16/26 | 3/7 | 1/2 | 6/6 | 2/3 | 1/5 | 3/3 |
| boosted | 18/26 | 3/7 | 1/2 | 6/6 | 3/3 | 2/5 | 3/3 |
| boosted+fuzzy | 19/26 | 3/7 | 1/2 | 6/6 | 2/3 | 4/5 | 3/3 |
| boosted+fuzzy+pop | 20/26 | 3/7 | 2/2 | 6/6 | 2/3 | 4/5 | 3/3 |
| smart | 21/26 | 2/7 | 2/2 | 6/6 | 3/3 | 5/5 | 3/3 |
| smart+artist-boost | 20/26 | 3/7 | 1/2 | 6/6 | 3/3 | 4/5 | 3/3 |
| two-step | 18/26 | 7/7 | 0/2 | 4/6 | 3/3 | 2/5 | 2/3 |
| smart+artist-row | 26/26 | 7/7 | 2/2 | 6/6 | 3/3 | 5/5 | 3/3 |
| smart+found-artist | 26/26 | 7/7 | 2/2 | 6/6 | 3/3 | 5/5 | 3/3 |

Both artist-row approaches hit all 26, but they differ in noise. smart+artist-row shows a wrong artist above the albums on 18 of the 19 album queries. smart+found-artist does on 3.

### Toggles

| Approach | All | Artist only | Album only | Artist plus album | Self-titled | Typos, half-typed | Other scripts, accents |
|---|---:|---:|---:|---:|---:|---:|---:|
| toggle:artist-field | 13/26 | 6/7 | 0/2 | 1/6 | 3/3 | 0/5 | 3/3 |
| toggle:album-field | 16/19 | n/a | 2/2 | 5/6 | 3/3 | 3/5 | 3/3 |
| toggle:album-smart | 17/19 | n/a | 2/2 | 5/6 | 3/3 | 4/5 | 3/3 |
| toggle:artist-pick-wide | 20/26 | 4/7 | 2/2 | 5/6 | 2/3 | 4/5 | 3/3 |
| toggle:artist-pick | 25/26 | 7/7 | 2/2 | 6/6 | 3/3 | 4/5 | 3/3 |
| toggle:artist-then-albums | 16/26 | 7/7 | 0/2 | 2/6 | 3/3 | 1/5 | 3/3 |
| toggles (today's ranking) | 22/26 | 6/7 | 2/2 | 5/6 | 3/3 | 3/5 | 3/3 |
| toggles (pick artist / smart album) | 24/26 | 7/7 | 2/2 | 5/6 | 3/3 | 4/5 | 3/3 |

`n/a`: the Album toggle doesn't apply to artist-only queries.

### Each query

A number is where the wanted album came. `2/3` means 2 of the top 3 were by the artist. Hits are bold. "(wrong row)" means the artist row named someone else.

**One box, better query**

| Query | current | current+pop | allwords | boosted | boosted+fuzzy | boosted+fuzzy+pop | smart | smart+artist-boost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `radiohead` | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 2/3 |
| `miles davis` | **3/3** | **3/3** | **3/3** | **3/3** | **3/3** | **3/3** | **3/3** | **3/3** |
| `television` | 1/3 | 1/3 | 1/3 | 1/3 | 1/3 | 1/3 | 1/3 | 1/3 |
| `low` | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| `yes` | **3/3** | **3/3** | **3/3** | **3/3** | **3/3** | **3/3** | **3/3** | **3/3** |
| `can` | 1/3 | 1/3 | 1/3 | 1/3 | 1/3 | 1/3 | 1/3 | 1/3 |
| `the the` | **3/3** | **3/3** | **3/3** | **3/3** | **3/3** | **3/3** | 1/3 | **3/3** |
| `ok computer` | **1** | **1** | **1** | **1** | **1** | **1** | **1** | **1** |
| `rumours` | 6 | **2** | 6 | 6 | 6 | **2** | **2** | 9 |
| `radiohead kid` | 6 | **3** | **3** | **2** | **2** | **1** | **1** | **1** |
| `steely dan aja` | **2** | **1** | **1** | **1** | **1** | **1** | **1** | **1** |
| `kid a radiohead` | **1** | **1** | **1** | **1** | **1** | **1** | **1** | **1** |
| `can tago mago` | **1** | **1** | **1** | **1** | **1** | **1** | **1** | **1** |
| `the the soul mining` | **1** | **1** | **1** | **1** | **1** | **1** | **1** | **1** |
| `bowie low` | 5 | **1** | **1** | **1** | **1** | **1** | **1** | **1** |
| `weezer` | **1** | **1** | **1** | **1** | **1** | **1** | **1** | **1** |
| `weezer blue` | **2** | **2** | none | **2** | 5 | 4 | **1** | **1** |
| `boston` | **1** | **1** | **1** | **1** | **1** | **1** | **1** | **1** |
| `ok comp` | 39 | 24 | **2** | **2** | **3** | **2** | **2** | 4 |
| `dark side of the mo` | 34 | 37 | none | 34 | 34 | 37 | **1** | **1** |
| `metalica master of puppets` | **3** | **1** | none | **3** | **1** | **1** | **1** | **1** |
| `radiohed ok computer` | 4 | **1** | none | 4 | **1** | **1** | **1** | **1** |
| `fleetwod mac rumors` | none | none | none | none | **2** | **1** | **1** | **1** |
| `takanaka rainbow goblins` | **1** | **1** | **1** | **1** | **1** | **1** | **1** | **1** |
| `кино группа крови` | **1** | **1** | **1** | **1** | **1** | **1** | **1** | **1** |
| `sigur ros agaetis` | **2** | **1** | **1** | **1** | **1** | **1** | **1** | **1** |

**One box, finding the artist**

| Query | two-step | smart+artist-row | smart+found-artist |
|---|---:|---:|---:|
| `radiohead` | **3/3** | **artist row** (+ wrong row) | **artist row** |
| `miles davis` | **3/3** | **artist row** | **artist row** |
| `television` | **3/3** | **artist row** (+ wrong row) | **artist row** |
| `low` | **3/3** | **artist row** (+ wrong row) | **artist row** |
| `yes` | **3/3** | **artist row** (+ wrong row) | **artist row** |
| `can` | **3/3** | **artist row** (+ wrong row) | **artist row** |
| `the the` | **3/3** | **artist row** | **artist row** |
| `ok computer` | none | **1** (wrong row) | **1** (wrong row) |
| `rumours` | none | **2** (wrong row) | **2** (wrong row) |
| `radiohead kid` | **1** | **1** (wrong row) | **1** |
| `steely dan aja` | **1** | **1** (wrong row) | **1** |
| `kid a radiohead` | **1** | **1** (wrong row) | **1** |
| `can tago mago` | none | **1** (wrong row) | **1** |
| `the the soul mining` | none | **1** (wrong row) | **1** |
| `bowie low` | **1** | **1** (wrong row) | **1** |
| `weezer` | **1** | **1** (wrong row) | **1** |
| `weezer blue` | **1** | **1** (wrong row) | **1** |
| `boston` | **1** | **1** (wrong row) | **1** |
| `ok comp` | none | **2** (wrong row) | **2** (wrong row) |
| `dark side of the mo` | none | **1** (wrong row) | **1** |
| `metalica master of puppets` | none | **1** (wrong row) | **1** |
| `radiohed ok computer` | **1** | **1** (wrong row) | **1** |
| `fleetwod mac rumors` | **1** | **1** (wrong row) | **1** |
| `takanaka rainbow goblins` | none | **1** (wrong row) | **1** |
| `кино группа крови` | **1** | **1** | **1** |
| `sigur ros agaetis` | **1** | **1** (wrong row) | **1** |

**Toggles**

| Query | toggle:artist-field | toggle:album-field | toggle:album-smart | toggle:artist-pick-wide | toggle:artist-pick | toggle:artist-then-albums |
|---|---:|---:|---:|---:|---:|---:|
| `radiohead` | **3/3** | n/a | n/a | **artist 1** | **artist 1** | **3/3** |
| `miles davis` | **3/3** | n/a | n/a | **artist 1** | **artist 1** | **3/3** |
| `television` | **3/3** | n/a | n/a | **artist 3** | **artist 1** | **3/3** |
| `low` | **3/3** | n/a | n/a | no artist | **artist 1** | **3/3** |
| `yes` | **3/3** | n/a | n/a | artist 10 | **artist 2** | **3/3** |
| `can` | 0/3 | n/a | n/a | artist 8 | **artist 2** | **3/3** |
| `the the` | **3/3** | n/a | n/a | **artist 1** | **artist 1** | **3/3** |
| `ok computer` | 8 | **1** | **1** | **artist 1** | **artist 1** | 8 |
| `rumours` | 17 | **1** | **1** | **artist 1** | **artist 1** | 17 |
| `radiohead kid` | 12 | 24 | 13 | **artist 1** | **artist 1** | 12 |
| `steely dan aja` | 8 | **1** | **1** | **artist 1** | **artist 1** | 8 |
| `kid a radiohead` | 12 | **1** | **1** | **artist 1** | **artist 1** | 12 |
| `can tago mago` | 12 | **1** | **1** | artist 8 | **artist 2** | **2** |
| `the the soul mining` | **2** | **1** | **1** | **artist 1** | **artist 1** | **2** |
| `bowie low` | 33 | **2** | **1** | **artist 2** | **artist 1** | 27 |
| `weezer` | **1** | **1** | **1** | **artist 1** | **artist 1** | **1** |
| `weezer blue` | **1** | **1** | **1** | **artist 1** | **artist 1** | **1** |
| `boston` | **1** | **1** | **1** | artist 9 | **artist 1** | **1** |
| `ok comp` | 8 | 9 | **1** | **artist 1** | **artist 1** | 8 |
| `dark side of the mo` | 4 | **2** | **1** | **artist 1** | **artist 1** | **3** |
| `metalica master of puppets` | none | **1** | **1** | artist 4 | artist 4 | none |
| `radiohed ok computer` | none | **1** | **1** | **artist 1** | **artist 1** | 8 |
| `fleetwod mac rumors` | none | none | 49 | **artist 1** | **artist 1** | 17 |
| `takanaka rainbow goblins` | **3** | **1** | **1** | **artist 1** | **artist 1** | **1** |
| `кино группа крови` | **3** | **1** | **1** | **artist 1** | **artist 1** | **3** |
| `sigur ros agaetis` | **2** | **1** | **1** | **artist 1** | **artist 1** | **2** |

### Fresh queries

I wrote these 10 queries after the rules above were final and ran them once. Nothing was tuned on them.

| Query | current | smart | smart+found-artist | toggle:album-smart | toggle:artist-pick | toggles (pick artist / smart album) |
|---|---:|---:|---:|---:|---:|---:|
| `portishead` | **3/3** | **3/3** | **artist row** | n/a | **artist 1** | **artist 1** |
| `chic` | **3/3** | **3/3** | **artist row** | n/a | **artist 1** | **artist 1** |
| `nevermind` | 6 | **2** | **2** (wrong row) | **1** | **artist 1** | **1** |
| `abbey road` | **2** | **1** | **1** (wrong row) | **1** | **artist 1** | **1** |
| `pet sounds` | **1** | **1** | **1** (wrong row) | **1** | **artist 1** | **1** |
| `beatles revolver` | 4 | **1** | **1** | **1** | **artist 1** | **1** |
| `joni mitchell blue` | 5 | **2** | **2** | 27 | **artist 1** | 27 |
| `kraftwerk autobahn` | **3** | **1** | **1** | **1** | **artist 1** | **1** |
| `talking heads remain in li` | **2** | **1** | **1** | **1** | **artist 1** | **1** |
| `bjork homogenic` | **1** | **1** | **1** | **1** | **artist 1** | **1** |

| Approach | Hits |
|---|---:|
| current | 7/10 |
| smart | 10/10 |
| smart+found-artist | 10/10 (wrong row on 3 of 8 album queries) |
| toggle:album-smart | 7/8 |
| toggle:artist-pick | 10/10 |
| toggles (pick artist / smart album) | 9/10 |

### The top 3 for each query

<details>
<summary>current</summary>

| Query | Typed | Result | Top 3 |
|---|---|---:|---|
| radiohead | `radiohead` | 0/3 | Greenhouse Effect vs. Radiohead - Greenhouse Effect vs. Radiohead (2005)<br>Cage - Radiohead (1997)<br>Wesley Willis - Radiohead (1994) |
| miles | `miles davis` | **3/3** | Miles Davis - Miles Davis Quartet (1954)<br>Miles Davis - Miles Davis Quartet (2009)<br>Miles Davis - Miles Davis, Volume 1 (1955) |
| television | `television` | 1/3 | Television - Television (1992)<br>TELEVISION - TELEVISION (2026)<br>Red Television - Red Television (1971) |
| low | `low` | 0/3 | LOW - LOW (2026)<br>Toner Low - Toner Low (2006)<br>Low Roar - Low Roar (2011) |
| yes | `yes` | **3/3** | Yes - Yes (1969)<br>Yes - Classic Yes (1981)<br>Yes - The Yes Album (1971) |
| can | `can` | 1/3 | Can Can - Can Can (2002)<br>Can Can Gang - Can Can (1993)<br>CAN - Can (1978) |
| thethe | `the the` | **3/3** | The The - Hanky Panky (1994)<br>The The - Hyena (A Soundtrack by The The) (2015)<br>The The - This Is the Day (1983) |
| okc | `ok computer` | **1** | Radiohead - OK Computer (1997)<br>Various Artists - OK Computer Turns 10 (2007)<br>ShitLips - OK Computer Part 2 (2018) |
| rumours | `rumours` | 6 | The Rumours - The Rumours (2014)<br>Rumours - How Many Roses (2020)<br>Rumours - Shapes (2016) |
| rhkid | `radiohead kid` | 6 | Alex Schaaf - Radiohead’s Kid A: Re‐imagined (2010)<br>Wooden Elephant - Landscapes, Knives & Glue – Radiohead's Kid a Recycled (2021)<br>KID - Kid (1989) |
| aja | `steely dan aja` | **2** | Steely Dan - Steely Dan (1978)<br>Steely Dan - Aja (1977)<br>Steely Dan - Aja (1977) |
| kidarh | `kid a radiohead` | **1** | Radiohead - Kid A (2016)<br>Radiohead - KID A MNESIA (2021)<br>KID - Kid (1989) |
| tago | `can tago mago` | **1** | Can - Tago Mago (1971)<br>Pez Mago - Pez Mago (2013)<br>Tago Mago - Traversée sauvage (2023) |
| soulmining | `the the soul mining` | **1** | The The - Soul Mining (1983)<br>The The - Soul Mining (Deluxe Edition) (2014)<br>The The - Soul Mining (1986) |
| bowielow | `bowie low` | 5 | LOW - LOW (2026)<br>Toner Low - Toner Low (2006)<br>Low Roar - Low Roar (2011) |
| weezer | `weezer` | **1** | Weezer - Weezer (1994)<br>Weezer - Weezer (2001)<br>Weezer - Weezer (2008) |
| weezerblue | `weezer blue` | **2** | Trashdog - Weezer's Blue Album (2024)<br>Weezer - Weezer (1994)<br>Weezer - Weezer (2001) |
| boston | `boston` | **1** | Boston - Boston (1976)<br>Eagle Boston - Eagle Boston (2010)<br>Boston Babies - Boston Babies (2024) |
| okcomp | `ok comp` | 39 | Workers Comp - Workers Comp (2024)<br>OK Go - OK Go<br>OK Go - Appendices (2026) |
| dsotm | `dark side of the mo` | 34 | Dark Side Of The Shroom - The Dark Side Of The Shroom EP (1994)<br>Dark Side of the Cop - Dark Side of the Cop (2006)<br>The Dark Side of the Force - The Dark Side of the Force (2022) |
| puppets | `metalica master of puppets` | **3** | Meat Puppets - Meat Puppets (1982)<br>Meat Puppets - Meat Puppets II (1984)<br>Metallica - Master of Puppets (1986) |
| radiohed | `radiohed ok computer` | 4 | Computer - Computer Dance (1979)<br>OK Vancouver OK - Outside Computer (2022)<br>P.R. Computer - P.R. Computer (1983) |
| rumors | `fleetwod mac rumors` | none | Vicious Rumors - Vicious Rumors (1990)<br>Fleetwood Mac - Peter Green’s Fleetwood Mac (1968)<br>Mac Davis - Mac Davis (1973) |
| takanaka | `takanaka rainbow goblins` | **1** | Masayoshi Takanaka - 虹伝説 THE RAINBOW GOBLINS (1981)<br>Blues Goblins - Blues Goblins (2003)<br>Gin Goblins - Gin Goblins (2007) |
| kino | `кино группа крови` | **1** | Кино - Группа крови (1989)<br>Кино - Чёрный альбом (1990)<br>Кино - Кино в Севкабеле (2021) |
| sigur | `sigur ros agaetis` | **2** | Sigur Rós - Sigur Rós Presents Liminal Sleep (2019)<br>Sigur Rós - Ágætis byrjun (2000)<br>Sigur Rós - In a Frozen Sea: A Year With Sigur Rós (2007) |

</details>

<details>
<summary>smart+found-artist</summary>

| Query | Typed | Result | Top 3 |
|---|---|---:|---|
| radiohead | `radiohead` | **artist row** | Artist row: Radiohead<br>Greenhouse Effect vs. Radiohead - Greenhouse Effect vs. Radiohead (2005)<br>Cage - Radiohead (1997)<br>Wesley Willis - Radiohead (1994) |
| miles | `miles davis` | **artist row** | Artist row: Miles Davis<br>Miles Davis - Miles Davis, Vol. 2 (1953)<br>Miles Davis - The Essential Miles Davis (2016)<br>Miles Davis - Miles Davis and Horns (1956) |
| television | `television` | **artist row** | Artist row: Television<br>Television - Television (1992)<br>TELEVISION - TELEVISION (2026)<br>Red Television - Red Television (1971) |
| low | `low` | **artist row** | Artist row: Low<br>LOW - LOW (2026)<br>Toner Low - Toner Low (2006)<br>Low Roar - Low Roar (2011) |
| yes | `yes` | **artist row** | Artist row: Yes<br>Yes - Yes (1969)<br>Yes - The Yes Album (1971)<br>Yes - Classic Yes (1981) |
| can | `can` | **artist row** | Artist row: Can<br>CAN - Can (1978)<br>Can Can Gang - Can Can (1993)<br>Can Can - Can Can (2002) |
| thethe | `the the` | **artist row** | Artist row: The The<br>The Band - The Band (2000)<br>The The - Hyena (A Soundtrack by The The) (2015)<br>The Beatles - The Beatles (1976) |
| okc | `ok computer` | **1** (wrong row) | Artist row: Computer<br>Radiohead - OK Computer (1997)<br>Radiohead - OK Computer (Deluxe Edition) (2017)<br>OK Vancouver OK - Outside Computer (2022) |
| rumours | `rumours` | **2** (wrong row) | Artist row: Vicious Rumours<br>The Rumours - The Rumours (2014)<br>Fleetwood Mac - Rumours (1977)<br>Rumours - How Many Roses (2020) |
| rhkid | `radiohead kid` | **1** | Artist row: Radiohead<br>Radiohead - Kid A (2016)<br>Alex Schaaf - Radiohead’s Kid A: Re‐imagined (2010)<br>Radiohead - KID A MNESIA (2021) |
| aja | `steely dan aja` | **1** | Artist row: Steely Dan<br>Steely Dan - Aja (1977)<br>Steely Dan - Aja (1977)<br>Steely Dan - Steely Dan (1978) |
| kidarh | `kid a radiohead` | **1** | Artist row: Radiohead<br>Radiohead - Kid A (2016)<br>Radiohead - KID A MNESIA (2021)<br>Alex Schaaf - Radiohead’s Kid A: Re‐imagined (2010) |
| tago | `can tago mago` | **1** | Artist row: Can<br>Can - Tago Mago (1971)<br>CAN - Can (1978)<br>Mägo de Oz - Mägo de Oz (1994) |
| soulmining | `the the soul mining` | **1** | Artist row: The The<br>The The - Soul Mining (1983)<br>The The - Soul Mining (Deluxe Edition) (2014)<br>The The - Soul Mining (1986) |
| bowielow | `bowie low` | **1** | Artist row: David Bowie<br>David Bowie - Low (1977)<br>Philip Glass - “Low” Symphony (1993)<br>David Bowie - ChangesOneBowie (1984) |
| weezer | `weezer` | **1** | Artist row: Weezer<br>Weezer - Weezer (1994)<br>Weezer - Weezer (2001)<br>Weezer - Weezer (2008) |
| weezerblue | `weezer blue` | **1** | Artist row: Weezer<br>Weezer - Weezer (1994)<br>Trashdog - Weezer's Blue Album (2024)<br>Weezer - SZNZ: Spring (2023) |
| boston | `boston` | **1** | Artist row: Boston<br>Boston - Boston (1976)<br>Eagle Boston - Eagle Boston (2010)<br>Boston Babies - Boston Babies (2024) |
| okcomp | `ok comp` | **2** (wrong row) | Artist row: Workers Comp<br>OK Vancouver OK - Outside Computer (2022)<br>Radiohead - OK Computer (1997)<br>Radiohead - OK Computer (Deluxe Edition) (2017) |
| dsotm | `dark side of the mo` | **1** | Pink Floyd - The Dark Side of the Moon (1973)<br>The Fargone Beauties - Dark Side of the Moo<br>The Moonies - The Dark Side of the Moonies (1985) |
| puppets | `metalica master of puppets` | **1** | Artist row: Metallica<br>Metallica - Master of Puppets (1986)<br>Metallica - Master of Puppets (Deluxe Edition) (2017)<br>The Scorched Earth Orchestra - Plays Metallica's Master of Puppets (2006) |
| radiohed | `radiohed ok computer` | **1** | Artist row: Radiohead<br>Radiohead - OK Computer (1997)<br>Radiohead - OK Computer (Deluxe Edition) (2017)<br>Vitamin String Quartet - Strung Out on OK Computer: The String Quartet Tribute to Radiohead (2001) |
| rumors | `fleetwod mac rumors` | **1** | Artist row: Fleetwood Mac<br>Fleetwood Mac - Rumours (1977)<br>Vitamin String Quartet - Rumors: The String Quartet Tribute To Fleetwood Mac (2000)<br>Fleetwood Mac - Rumours Live |
| takanaka | `takanaka rainbow goblins` | **1** | Artist row: 高中正義<br>Masayoshi Takanaka - 虹伝説 THE RAINBOW GOBLINS (1981)<br>Rainbow - Ritchie Blackmore’s Rainbow (1975)<br>Rainbow - The Best of Rainbow (1980) |
| kino | `кино группа крови` | **1** | Artist row: Кино<br>Кино - Группа крови (1989)<br>Кино - Кино в Севкабеле (2021)<br>Кино - Чёрный альбом (1990) |
| sigur | `sigur ros agaetis` | **1** | Artist row: Sigur Rós<br>Sigur Rós - Ágætis byrjun (2000)<br>Sigur Rós - Kveikur (2013)<br>Sigur Rós - ( ) (2002) |

</details>

<details>
<summary>toggles (pick artist / smart album)</summary>

| Query | Typed | Result | Top 3 |
|---|---|---:|---|
| radiohead | `radiohead` | **artist 1** | Artist: Radiohead<br>Artist: radiohead 3<br>Artist: DJ Radiohead |
| miles | `miles davis` | **artist 1** | Artist: Miles Davis<br>Artist: Miles Davis Quintet<br>Artist: Miles Davis Quartet |
| television | `television` | **artist 1** | Artist: Television<br>Artist: Television Personalities<br>Artist: TELEVISION |
| low | `low` | **artist 1** | Artist: Low<br>Artist: Gary Low<br>Artist: Low Profile |
| yes | `yes` | **artist 2** | Artist: Yes Yes Yes<br>Artist: Yes<br>Artist: YES |
| can | `can` | **artist 2** | Artist: Can Can<br>Artist: Can<br>Artist: Dead Can Dance |
| thethe | `the the` | **artist 1** | Artist: The The<br>Artist: The Beatles<br>Artist: The Rolling Stones |
| okc | `ok computer` | **1** | Radiohead - OK Computer (1997)<br>Radiohead - OK Computer (Deluxe Edition) (2017)<br>Various Artists - OK Computer Turns 10 (2007) |
| rumours | `rumours` | **1** | Fleetwood Mac - Rumours (1977)<br>Damage - Rumours (2000)<br>Freddie McGregor - Rumours (1996) |
| rhkid | `kid` | 13 | KID - Kid (1989)<br>木戸やすひろ - KiD (1978)<br>Scrubb - Kid (2010) |
| aja | `aja` | **1** | Steely Dan - Aja (1977)<br>Maija Vilkkumaa - Aja! (2015)<br>AJA - AJA (2018) |
| kidarh | `kid a` | **1** | Radiohead - Kid A (2016)<br>Radiohead - KID A MNESIA (2021)<br>Alex Schaaf - Radiohead’s Kid A: Re‐imagined (2010) |
| tago | `tago mago` | **1** | Can - Tago Mago (1971)<br>Billy Martin & John Medeski - Mago (2007)<br>Mägo de Oz - Mägo de Oz (1994) |
| soulmining | `soul mining` | **1** | The The - Soul Mining (1983)<br>The The - Soul Mining (Deluxe Edition) (2014)<br>The The - Soul Mining (1986) |
| bowielow | `low` | **1** | David Bowie - Low (1977)<br>Testament - Low (1994)<br>Cal in Red - Low Low (2024) |
| weezer | `weezer` | **1** | Weezer - Weezer (1994)<br>Weezer - Weezer (2001)<br>Weezer - Weezer (2008) |
| weezerblue | `weezer` | **1** | Weezer - Weezer (1994)<br>Weezer - Weezer (2001)<br>Weezer - Weezer (2008) |
| boston | `boston` | **1** | Boston - Boston (1976)<br>Charlie Mariano Quintet - Boston Days (1953)<br>Athenrye - Boston Rose (1996) |
| okcomp | `ok comp` | **1** | Radiohead - OK Computer (1997)<br>Radiohead - OK Computer (Deluxe Edition) (2017)<br>Various Artists - OK Computer Turns 10 (2007) |
| dsotm | `dark side of the mo` | **1** | Pink Floyd - The Dark Side of the Moon (1973)<br>Medicine Head - Dark Side of the Moon (1972)<br>Steve ’n’ Seagulls - Dark Side of the Moo (2025) |
| puppets | `master of puppets` | **1** | Metallica - Master of Puppets (1986)<br>Metallica - Master of Puppets (Deluxe Edition) (2017)<br>Dream Theater - Master of Puppets (2021) |
| radiohed | `ok computer` | **1** | Radiohead - OK Computer (1997)<br>Radiohead - OK Computer (Deluxe Edition) (2017)<br>Various Artists - OK Computer Turns 10 (2007) |
| rumors | `rumors` | 49 | Timex Social Club - Rumors (1986)<br>Frank Kimbrough - Rumors (2009)<br>Ambivalent - Rumors (2010) |
| takanaka | `rainbow goblins` | **1** | Masayoshi Takanaka - 虹伝説 THE RAINBOW GOBLINS (1981)<br>高中正義 - Debut 50th Anniversary The Rainbow Goblins Final (2025)<br>Mariah Carey - Rainbow (1999) |
| kino | `группа крови` | **1** | Кино - Группа крови (1989)<br>Сатана Печёт Блины - Глуппа Клови На Лукаве (2009)<br>Кровосток - Река Крови (2004) |
| sigur | `agaetis` | **1** | Sigur Rós - Ágætis byrjun (2000) |

</details>

## Where each one wins and loses

**Re-ranking by pressings** is the biggest gain for the least work. It changes no query and makes no extra call, and takes today's search from 15 to 19. It fixes "rumours", "radiohead kid", "bowie low" and "radiohed ok computer". The hit count is the same for any weight from 3 to 12, so 5 isn't a fine-tuned number. Its cost: it favors records with many pressings, so a new album can rank below an old one with the same name.

**Requiring every word** (allwords) fixes the mixed queries but is too strict. Every typo and the Weezer nickname fail outright, and it gets 16.

**Boosting all-word matches** (boosted) keeps today's results but ranks results that match every word first. It fixes "radiohead kid", "ok comp" and "bowie low" without losing anything (18).

**Allowing a typo** fixes "metalica", "radiohed" and "fleetwod mac rumors". On its own it hurt "weezer blue" (2nd to 5th), because "weezer" then also matched the band Geezer and "blue" matched "blues". Searching release notes put it back to 1st.

**Weighting the artist field 3 times** fixes part of "radiohead" but pushes Rumours to 9th and OK Computer to 4th for "ok comp". It loses more than it gains (20).

**No query change fixes artist-only queries.** Even smart leaves Radiohead, Low, Can and Television below other records. The fix has to name the artist some other way: a row or a toggle.

**Two-step (artist first)** gets 18. It has to guess which words are the artist, and many albums share a name with some band: ".computer..", "Rumours", "Tago Mago", "Master of Puppets", "The Rainbow Goblins". When it guesses wrong, it shows only that band's records. It also makes two calls one after the other, so results take about a second longer.

**A separate artist lookup for the row** names the right artist for all 7 artist-only queries. But it also shows a wrong artist on 18 of the 19 album queries, which is too noisy. It costs a second call too.

**The found-artist row** is right for all 7 artist-only queries and shows a wrong artist on 3 of 19 album queries: "Computer" for "ok computer", "Vicious Rumours" for "rumours" and "Workers Comp" for "ok comp". On the fresh set it showed a wrong artist for "nevermind", "abbey road" and "pet sounds". In every one of those, the wanted album was still in the top 3. The row comes from results already fetched, so it costs no call.

**The Artist toggle on the release search** (artist-field) gets the artist's records on top for 6 of 7 artist-only queries. It misses "can", where Can Can comes first. To add a specific album, though, the person scrolls: OK Computer comes 8th for "radiohead", Kid A 12th, and Low 33rd for "bowie".

**The Artist toggle as a pick list** finds the right artist in the first three for 25 of 26. But adding an album takes three steps: pick the artist, wait for the discography (about 20 seconds for David Bowie the first time), then scroll to the album. The faster one-call list puts the album in the top 3 for only 2 of 6 artist-plus-album queries, because an artist's best-known albums fill the 100 pressings.

**Searching aliases and sort names for every word** (artist-pick-wide) made short names worse. "low" brings up Jonathan Low ("Low, Jonathan") and no band Low in the first ten. Yes came 10th and Can 8th. The final lookup only matches an alias that contains the whole text.

**The Album toggle** is strong when the title is distinctive: 17 of 19 with smart's fixes. It is weak when the title is a common word, because the toggle drops the artist the person knows. "blue" for Joni Mitchell comes 27th and "kid" 13th. The typo "rumors" comes 49th, among the many records really titled "Rumors".

## The experience

**Toggles** remove ambiguity only when the text names one thing. "low" in Artist mode is the band, and in Album mode it's Bowie's album. But:

- Every search needs a choice first, or a default the person has to notice. The Add page already has a search box, a Search button, a hint, an "Add as" menu and a 45s checkbox.
- The wrong mode fails quietly. "ok computer" in Artist mode lists artists called ".computer.." and "Computer".
- They only help when the text alone is ambiguous, like "low". The smarter box handles those with the artist row. Mixed queries like "radiohead kid", the README's own example, get no help from either toggle.
- The Artist toggle repeats the Discography tab, which already searches artists and adds records with **Got it**.

**A smarter single box** keeps the page as it is and keeps today's habits: type any part of either name. The re-rank and the better query handle mixed queries, typos and half-typed words. The artist row covers people who type only a name. One tap on it can open that artist's discography, which lists every album and already has Got it and Wishlist.

Its weak spot is the wrong artist row when an album shares its name with an obscure band, as in "nevermind" and "abbey road". The row is one line, and the album is still in the top 3.

I'd pick the smarter box. It wins on the numbers without assuming people use a control perfectly, and it adds one line instead of a control.

## Recommendation

1. **Ship the ranking changes first.** Use the smart query and the re-rank by pressings in `searchReleaseGroups`, with no UI change. That takes the main set from 15 to 21 and the fresh set from 7 to 10. It still makes one call per search. **This branch already has it**, so you can try it in the app now. `check-app.js` confirms the app returns the same top 5 as the smart approach for all 36 queries.
2. **Then add the found-artist row.** It takes the main set to 26 of 26 and needs no extra call. Built in iteration 2.
3. **Don't add toggles.** At their best they score below the smarter box, and they add a step to every search.

## Caveats

- The sets are small: 26 queries, plus 10 fresh ones.
- I added the short-prefix rule, the release-note search and the row rules after seeing misses in the main set, so 26 of 26 is optimistic. The fresh set is the fairer check, and it is only 10 queries.
- MusicBrainz data changes daily, so exact ranks will drift.
- About 650 requests went to MusicBrainz, one at a time, 3 seconds apart: 381 distinct replies, and the rest retries after a 503. Other agents share this machine's address, so about every second request got a 503 at first.

## Questions for the user

None are open. Both questions from iteration 2 got a yes: the row shows the credited name that matched, and the 45s and 10" rescore ran on the new search only.

### Answered after iteration 1

1. **Should the ranking change ship on its own first?** It has no UI change, and it's on this branch to try. Recommended: yes.
2. **What should the artist row look like?** Recommended: one slim line above the albums, like "Radiohead · Artist · See all albums", with no cover.
3. **Where should tapping the artist row go?** Recommended: the artist's page in the Discography tab. It lists every album and already adds records. The first load of a big catalog takes 20 to 50 seconds. The other option is an inline list on the Add page, which is one call and fast but misses albums for big catalogs.
4. **Should the row show when the text is also an album title?** It shows "Nevermind" (a band) above Nirvana's Nevermind. Recommended: show it anyway for now. It's one line, and hiding it would also hide the band Low for "low". Tightening it can be its own iteration.
5. **Drop the toggle idea?** Recommended: yes. If you still want toggles, I'd suggest a default of "Any" (today's single box) with Artist and Album as options, not remembered between visits.
6. **Keep the saved MusicBrainz replies on the branch?** `add-search/cache.json.gz` is 1.5 MB. It lets anyone rescore without calling MusicBrainz. Recommended: keep it on this branch and drop it before merging to main.

## Next iterations

1. Done in iteration 2: the artist row, with unit and browser tests.
2. Try the search in real use for a while, and note any search that feels wrong. Those become test queries.
3. Grow the fresh set to 30 or more queries, ideally from records the user owns, and rerun all approaches on it.
4. Cut wrong artist rows. One idea: hide the row when an album titled exactly like the text is by a different artist that has many more pressings.
5. Done in iteration 2: the 45s and 10" setting. The new search scores the same with it on.

## Rerunning

From `docs/investigations/add-search/`:

```sh
OFFLINE=1 node eval.js                # rescore every approach from the saved replies
OFFLINE=1 SET=holdout node eval.js current smart smart+found-artist toggle:album-field toggle:album-smart toggle:artist-pick
node report.js summary current smart  # print a table; also: cases, matrix, detail
```

Without `OFFLINE=1`, a missing reply is fetched one request at a time, 3 seconds apart, with the `alexandria-dev/0.1` User-Agent, and saved to `cache.json.gz`.

The approaches run on the app's search code as it was before this work (commit `bf604df`), so "current" stays today's search. `node check-app.js` runs the app as it is now and checks its albums against the recorded smart results and its artist row against smart+found-artist. `SMALL=1` turns on 45s and 10" records and writes `results-small.json` and `results-holdout-small.json`. Replies are saved for smart and smart+found-artist only; other approaches would fetch.

| File | What it holds |
|---|---|
| `cases.js` | The 26 queries and the 10 fresh ones. |
| `truth.json` | MusicBrainz ids for the right artists and the Blue Album. |
| `truth.js` | Prints the artist matches the ids in `truth.json` were picked from. |
| `eval.js` | The approaches and the scoring. |
| `appmb.js` | Loads the app's `js/musicbrainz.js` with fetch pointed at the saved replies. |
| `check-app.js` | Checks that the app's search now returns what smart and smart+found-artist scored. |
| `mbcache.js` | Fetches and saves replies. |
| `report.js` | Prints the tables in this page. |
| `results.json`, `results-holdout.json` | Scores and the top 5 for each approach and query. |
| `results-small.json`, `results-holdout-small.json` | The same for smart and smart+found-artist with 45s and 10" records on. |
| `cache.json.gz` | The saved replies, trimmed to the fields the app reads. Taken out before merging. Restore it from commit `fcc18ea`. |
