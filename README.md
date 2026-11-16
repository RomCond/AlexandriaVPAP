# Record Catalog

Record Catalog is a small web app that tracks the vinyl records you own and the ones you're looking for.

- **Add records fast.** One search box takes part of an album or artist name, like "ok comp" or "radiohead kid". It also takes the barcode from the sleeve. Matches show as you type. Records that match every word come first, a small typo still matches, and a well-known album ranks above an obscure one with the same name. When what you type starts or ends with an artist's name, a line above the results, like "Radiohead · Artist · See all albums", opens that artist's discography. Search lists only vinyl. Each album or single that came out on vinyl gets one line, however many pressings it has. Studio albums show even when MusicBrainz lists no vinyl pressing for them, marked "Vinyl not confirmed". A barcode for a CD or cassette gets a message saying so instead of a result. Search includes LPs and 12" records, and leaves out 45s (7") and 10" records unless you tick **Include 45s and 10" records** on the Add page. The **45s and 10"** chip in the discography is the same setting. One tap adds a record, and the app fills in its year and cover art. You can add anything that isn't in the database by hand. You keep one copy per album, so an album you already have shows "In collection" instead of an Add button. A deluxe edition counts as its own album.
- **Import what you have.** If your records are already in a note or a spreadsheet, tap **Import** on the Collection page. Paste a list with one record per line, like `Steely Dan - Aja`, or choose a file: a text list, an Excel or CSV spreadsheet, or a backup from this app. The app adds the records all at once, then looks each one up on MusicBrainz in the background for its cover, year and spelling. See [Importing records](#importing-records).
- **Browse your collection.** The buttons next to the search box switch between covers, three across on a phone, and a slim list. The app remembers your choice. The collection groups records under the first letter of the artist's name, ignoring a leading "The". On a list of more than 20 records sorted by artist or title, a strip of letters shows on the right side. Tap a letter, or slide a finger along the strip, to jump to it. **Filter** opens the format filter and the sort order: artist, recently added, year (grouped by decade) or title. Tap a record to edit or delete it, or to open the artist's discography.
- **Pick one at random.** You can limit the pick to a format or an artist. The app avoids repeating any of your last five picks. The background behind the pick is a gradient from the main color of its cover, and the top of a record's edit screen uses the same gradient.
- **See what you're missing.** Pick an artist, and the app compares their discography with your collection. It lists what you have and what you're missing, and **Copy list** puts the missing titles on your clipboard to take to the record store. Tap **Got it** when you find one, or **Wishlist** to save it for later.
- **Keep a wishlist.** The Collection tab switches between your records and your wishlist. Tap **Got it** on a wishlist record to move it into your collection. Adding a record any other way also takes it off the wishlist.

Lookups use [MusicBrainz](https://musicbrainz.org) and the [Cover Art Archive](https://coverartarchive.org). Both are free and need no API key. To read a cover's main color, the app needs the image server to allow cross-origin reads. If it doesn't, the app uses the record's placeholder color. The app reads each cover's color once and saves it with the record, and backups include it. Covers load at 500px in lists and the cover grid, and at 1200px for the random pick. Those sizes keep them sharp on phone screens. When the collection has already loaded a cover, or its color is already saved, the random pick shows the 500px cover first and fades the 1200px one in over it. A cover the collection has loaded shows straight away.

The colors are electric blue on cool white, or near-black in dark mode. The app follows the phone's light or dark setting. Headings use Inter Tight and text uses Inter, both from Google Fonts. Without a connection, they fall back to the system font.

## Running it

There is no build step. Open `index.html` in a browser, or serve the folder:

```sh
npm start   # python3 -m http.server 8080, then open http://localhost:8080
```

Any static host, such as GitHub Pages or Netlify, works too.

## Where the data lives

The app saves records in the browser's `localStorage`, so each browser and device has its own copy. **Export backup** at the bottom of the Collection page saves a JSON file of your records and wishlist. To load it somewhere else, tap **Import** and choose the file. Importing a backup merges it with what's there and skips albums you already have.

To keep the same collection on your phone and your computer, set up sync with Firebase. [Set up sync with Firebase](docs/firebase-setup.md) walks through it. You then sign in with Google under **Sync between devices** at the bottom of the Collection page, and each device syncs when you sign in and when you tap **Sync now**. Until `js/sync-config.js` is filled in, the app hides sync and loads nothing from Firebase.

MusicBrainz allows about one request per second. The search box waits for a short pause in typing and cancels searches you've typed past. The app saves each discography you open and shows the saved copy at once next time. Once it's a week old, the app also loads a new copy behind it and swaps it in when it's complete. After four weeks it loads from scratch. **Refresh** on an artist loads a new copy the same way. When MusicBrainz is busy or the connection drops, the app tries the request again after 2, 4, 8 and 16 seconds, then shows an error. On a device that's offline, the app shows the error after the first wait of 2 seconds.

## Importing records

**Import** opens one screen for everything. Paste text into the box, or tap **Choose a file**. A chosen file shows by name in place of the box, and **Paste instead** brings the box back. The app works out what the text or file is, and before you add anything it says what it found:

- A backup from **Export backup** shows how many records and wishlist records it holds. **Import backup** merges it, as described in [Where the data lives](#where-the-data-lives).
- A spreadsheet, as an Excel .xlsx file or saved as CSV or TSV, needs column names in its first row, with one for the artist and one for the title. The app knows names such as Artist, Band or Album Artist for the artist, and Title, Album or Release for the title. It also reads a year, format or notes column, with names such as Year, Released, Format, Media, Notes or Comments. A label, catalog number or condition column goes into the notes, like "Label: Mercury". Commas, tabs and semicolons all work between columns. The import screen names the columns it read and the ones it left out.
- Anything else is a typed list, one record per line.

Excel on Windows saves CSV in its own text encoding, and the app reads that too, so names like "Motörhead" keep their accents. From an Excel file, the app reads the first sheet whose first row names the columns, so a summary sheet in front is passed over. A date in the year column gives its year. It reads .xlsx files without an add-on, in browsers from 2023 on: Safari 16.4, Chrome 103 and Firefox 113. An older browser says to save the sheet as CSV. The app can't read Numbers or old Excel .xls files, so save those as .xlsx or CSV first.

A collection export from Discogs works as it is. The app drops the number Discogs adds to tell artists with the same name apart, so "Nirvana (2)" becomes "Nirvana", and keeps your collection notes. The label, the catalog number, the year of that pressing, and the media and sleeve condition go into the notes, like "Pressing year: 2015; Media condition: VG+". The record's year comes from MusicBrainz instead, as the year the album first came out.

In a typed list, each line is an artist, a dash with a space on each side, then the title. A tab between artist and title also works, so you can paste two columns from a spreadsheet without their names. The import ignores numbering and bullets at the start of a line.

Text in brackets at the end of a title becomes a note, like `(Signed)` or `(Test Press)`. This works in a spreadsheet's title column too. The words "Deluxe" and "Expanded" stay in the title instead, so the deluxe edition counts as its own album. `(45)` or `(Single)` makes the record a 45. The app leaves that text out of the notes, since the format already says it. A spreadsheet's format column, like `2xLP`, `7"` or `Vinyl`, sets the format. The app keeps vinyl only, so it leaves out rows whose format is a CD or cassette, like `CD, Album`, and lists them on the import screen. A vinyl record that comes with a CD, like `2xLP + CD`, still counts. Every other record gets the format chosen under **Add as**. The import screen also lists any lines or rows it can't read.

You keep one copy per album, so the import skips albums already in your collection. Lines or rows that name the same album become one record with a note like "2 copies".

After adding, the app looks up each record on MusicBrainz, about one a second, and shows its progress above the collection. You can keep using the app while it works. If you close the app or it loses its connection, the lookups continue the next time it's open, or when you tap **Try again**. The app only takes a match when it's clear:

- Small typos in the artist or title still match, like "Metalica" or "Random Access Memory", and the record takes MusicBrainz's spelling. Numbers have to agree, so "Toto I" never matches "Toto IV".
- An artist name that's part of a longer credit, like "Prince" for "Prince and The Revolution", keeps your spelling, so it stays grouped with your other records.
- The app finds artists that MusicBrainz lists under another name by their alias. Masayoshi Takanaka, for example, is 高中正義 on MusicBrainz.
- When a studio album shares its name with a single or a live album, the studio album is the match. A record marked as a 45 matches the single.
- When two different albums fit about equally well, like Weezer's several albums called "Weezer", the app leaves the record unmatched.

The panel above the collection lists the records the app couldn't match. They have no cover or year. Tap one to fix its artist or title, and the app looks it up again. **Dismiss** hides the list.

## How the missing list works

1. The app finds the artist's studio albums on MusicBrainz with one search and lists them straight away.
2. Then it reads the artist's official and promotional albums, EPs and singles, 100 at a time, and fills in the list as they arrive. It checks which ones have at least one vinyl pressing: an LP or 12" record, or a 45 or 10" record when you've turned those on. Flexi-discs, VinylDisc hybrids, bootlegs and pressings with no status on MusicBrainz don't count. At one request a second, big catalogs take longer to check, about 20 seconds for David Bowie and 28 for the Beatles. Until the check ends, no album says "Vinyl not confirmed".
3. Deluxe and expanded editions get their own line right after the original, since they add songs. MusicBrainz usually files them under the original album, so the app finds them by releases whose title or note says "deluxe" or "expanded". All of an album's deluxe releases share one line. Owning the original doesn't count as owning the deluxe edition, and owning the deluxe edition doesn't count as owning the original.
4. A record you added through search or barcode matches by its MusicBrainz release group id.
5. A record you typed in by hand matches by title, ignoring case, accents, punctuation and notes like "(2009 Remaster)". If its title says "Deluxe" or "Expanded", it goes on the deluxe line.
6. Records by that artist that match nothing appear under "Yours, but not matched", so you can fix the title.

**Vinyl only** is on by default, so the missing list shows only releases that came out on vinyl, one line per album however many pressings exist. Studio albums are the exception. MusicBrainz often lacks the vinyl pressings of albums that have them, so studio albums show anyway, marked "Vinyl not confirmed". Singles, EPs, live albums, compilations and deluxe editions still need a vinyl pressing in MusicBrainz. Albums, EPs and singles with no official release at all, mostly bootlegs, only show with Vinyl only off. The app loads them the first time you turn it off.

If you know a release came out on vinyl, tap **Confirm** under "Vinyl not confirmed" in the discography or in search results. The app then counts it as vinyl. **Undo** takes the confirmation back. Owning a record in a vinyl format also confirms it. The app saves confirmations on the device and includes them in backups. Records you already own always show. Turn **Vinyl only** off to see everything.

The discography shows studio albums by default. The toggles at the top switch on EPs, singles, live albums, compilations and other types. The choice applies to every artist.

## Project layout

```
index.html            page markup for all four views
css/styles.css        styles, light and dark
js/store.js           records, backups, caching, and the matching logic
js/xlsx.js            reads the sheets of an Excel file
js/musicbrainz.js     MusicBrainz and Cover Art Archive client
js/sync.js            sync between devices through Firebase
js/sync-config.js     your Firebase project's web config
js/app.js             the UI
firestore.rules       the access rules to publish in the Firebase console
docs/                 setup guide and design notes
tests/                unit tests and browser tests
```

## Tests

```sh
npm test            # unit tests, no install needed (Node 18+)
npm run test:e2e    # browser tests with Playwright
```

The browser tests need Playwright (`npm install`, then `npx playwright install chromium`). They answer MusicBrainz calls with fixed sample data, so they run offline and give the same result every time. Set `SCREENSHOT_DIR=some/folder` to save screenshots of each view.

The Excel files in `tests/fixtures` come from xlsxwriter, openpyxl and LibreOffice. To make them again, run `python3 tests/fixtures/make-xlsx-fixtures.py`.
