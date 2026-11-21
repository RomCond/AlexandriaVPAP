# Options for syncing the collection between devices

Today each browser keeps its own copy of your records in `localStorage`. Your phone and your PC match only after you use **Export backup** on one and **Import backup** on the other. This doc lists what has to sync, compares four ways to sync, and recommends one. Nothing here is built yet. The next step is your choice.

Written 15 November 2026. Prices and limits come from web searches on that date. Check each vendor's pricing page before you sign up.

## What syncs and what stays on each device

`js/store.js` saves six kinds of state. Three of them sync, and one syncs in part.

| State | Saved under | Syncs | Why |
| --- | --- | --- | --- |
| Records | `recordcatalog.records.v1` | Yes | This is the collection. |
| Wishlist | `recordcatalog.wishlist.v1` | Yes | **Got it** moves a wish into the collection, so the two lists change together. |
| Vinyl confirmations | `recordcatalog.confirmed.v1` | Yes | You typed them in, and nothing can rebuild them. Backups already carry them. |
| Pending lookups | The `pendingLookup` flag on each record, and the `lookup` preference | The flag syncs. The `lookup` preference stays. | The flag is part of the record, so the other device shows the record as still waiting. The `lookup` preference holds this device's import panel, with its progress and the records it could not match. |
| Preferences | `recordcatalog.prefs.v1` | No | `collectionView`, `sort`, `addFormat`, `vinylOnly`, `discoTypes` and `smallRecords` set how you browse on one screen. A phone shows covers three across, and a PC may show the list. |
| Discography cache | `recordcatalog.discographies.v5` | No | It is a copy of public MusicBrainz data. Each device fetches it again when needed, and it expires after a week. It is also the largest item in storage. |

One preference could follow you. `smallRecords`, the **Include 45s and 10" records** setting, says what you collect rather than how you browse. It stays on each device by default, as the section on [two defaults you can change](#two-defaults-you-can-change) explains.

Two smaller things stay on the device as well. A `.unreadable` copy is a recovery file for that browser. The last five random picks live only in memory.

Either device can finish a pending lookup. The device that looks a record up writes the match, and the other device gets it with the next sync. `finishLookup` in `js/app.js` already skips a record whose flag has cleared, so a device that syncs first does not repeat the work. Two devices that run lookups at the same moment send twice the requests to MusicBrainz. The retry that already handles a busy MusicBrainz covers that.

## Two decisions hold under every option

### Each device keeps a full copy and works offline

The app keeps reading and writing `localStorage` as it does now. The sync copy is a second copy that each device merges into in the background. Nothing waits on the network. Offline use matters in a record store, where the phone often has weak signal and **Got it** still has to work.

A copy off the device also guards against browser cleanup. WebKit announced in 2020 that Safari deletes a site's script-written storage, `localStorage` included, after 7 days of Safari use without a visit to that site. This doc could not confirm whether that still applies.

**Export backup** and **Import backup** stay. They are a copy you hold outside any service.

### Merge one record at a time, never the whole list

Saving one device's whole list over the other's loses records. Before iteration 2 the store lost records that way with two tabs open. In a Node test, two stores shared one storage, the way two tabs in one browser share `localStorage`. One store added Aja and the other added OK Computer. Only OK Computer was saved, because each store wrote its own whole list. Sync that copies whole lists would lose records the same way. Iteration 2 fixed the two-tab case. A tab now reads the lists again when another tab saves them.

The merge follows these rules:

1. Each record and wish carries `updatedAt`, the time it last changed. When both devices hold a copy, the newer copy wins, as a whole record. A record saved before `updatedAt` existed counts from its `addedAt`.
2. A delete leaves a marker with the id and the time. Removing a wish, getting a wish and taking back a vinyl confirmation leave one too. The marker beats any copy that is not newer than it, so the other device does not bring the record back. An edit made after the delete wins and brings the record back. A delete and an edit at the same moment count as a delete.
3. You still keep one copy per album. If both devices add the same album while apart, the merge keeps the copy added first and drops the other. Both devices pick the same copy, so they end up equal. Notes typed on the dropped copy go with it.
4. A wish for an album you own leaves the wishlist, as it does today.
5. Vinyl confirmations follow rules 1 and 2. Each one is a key that is on or off, with the time it changed. Confirmations saved before they had times count as older than any change.
6. The first sync of a device that already has records works like **Import backup**. Albums from either device end up on both. Records that came over in an earlier backup have the same id on both devices, so they match.

The merge is safe to repeat. Merging the same two copies twice gives the same result, so a sync that stops halfway runs again from the start. The times come from each device's clock. A clock that is a few minutes off matters only when both devices edit the same record within those minutes. Deletion markers stay for now. Removing old ones safely needs to know when each device last synced, so that comes with the sync code.

**Import backup** brings back anything in the backup that you deleted. That counts as a change made at the time of the import, so the next sync keeps it instead of deleting it again.

### Two defaults you can change

- **The newer edit wins for the whole record.** The other choice is a merge field by field, which keeps the notes from one device and the format from the other. It handles a rare case at the cost of more rules.
- **Every preference stays on its own device**, `smallRecords` included. Any preference can sync later by moving it into the sync state.

### What iteration 2 built

Iteration 2 built the rules above in `js/store.js`, with no network code.

- `S.mergeSyncStates(mine, theirs)` is the merge. It is a pure function of the two states.
- `store.syncState()` returns the records, the wishlist, the vinyl confirmations with their times, and the deletion markers.
- `store.applySyncState(theirs)` reads another device's state, merges it in, saves the result, and redraws the page only when something changed.
- `store.reload()` reads the lists again. The app calls it when another tab saves.

One copy per album uses an index instead of comparing every pair of records. Comparing pairs took 2.2 seconds for 3,000 records. The merge takes about 50 milliseconds for two devices with 3,000 records each. Both numbers were measured in Node on the development machine.

## Four ways to sync

All four use the merge above. They differ in where the sync copy lives, how you sign in, and what you set up.

- **Firebase.** Google's hosted database, Cloud Firestore, with Firebase sign-in.
- **Supabase.** A hosted Postgres database with sign-in by email code.
- **Google Drive app data folder.** A hidden file in your own Google Drive. It needs no server.
- **Sync link.** A small server you deploy on Cloudflare Workers holds an encrypted copy. It needs no account, because a secret link pairs the devices.

| | Firebase | Supabase | Google Drive | Sync link |
| --- | --- | --- | --- | --- |
| What you set up | A Firebase project on the free Spark plan. Turn on Google sign-in and add the site's address. Create a Firestore database and paste the access rules. Paste the web config into `js/sync-config.js`. | A Supabase project on the free plan. Run one SQL script for the table and its access policy. Change the sign-in email to send a code. Paste the project address and public key into `js/sync-config.js`. | A Google Cloud project with the Drive API turned on. Set up the sign-in consent screen and add yourself as a test user. Create a web client ID for the site's address. Paste it into `js/sync-config.js`. | A Cloudflare account. Deploy a short Worker from this repo and give it a KV store, from the dashboard or with `wrangler`. Paste the Worker's address into `js/sync-config.js`. |
| Cost at this scale | $0. Spark allows 1 GiB of data, plus 50,000 reads and 20,000 writes a day. 1,000 records take at most about 410 KiB. | $0, but the free plan pauses a project after 7 days of low activity. Paid plans never pause. | $0. The file counts against your Drive storage, at most about 410 KiB per 1,000 records. | $0. Workers allow 100,000 requests a day. KV allows 1 GB of data and 1,000 writes a day, and one sync is one write. |
| Sign-in on a phone | Tap **Sign in with Google** once. A Google window opens and closes. Firebase keeps you signed in. | Type your email, then the code from the email. Nothing opens in a new window. Supabase keeps you signed in. | Tap **Sync** and approve in a Google window. Access lasts about an hour, and the browser cannot renew it without another tap. Expect one tap each time you open the app. | You do not sign in. On the PC, tap **Link a device** and scan the QR code with the phone. The phone keeps the link. |
| Offline | Yes. Changes go up on the next sync. | Yes. Changes go up on the next sync. | Yes. Changes go up on the next sync. | Yes. Changes go up on the next sync. |
| Same record changed on both devices | 16 Firestore documents hold the merged state. A sync reads them, merges, and writes the changed ones in one transaction, which runs again if the other device wrote in between. The newer `updatedAt` wins. | One table row per record. The newer `updatedAt` wins, and a database function replaces only an older row. | One file holds everything. Each sync reads it, merges, and writes it back. If both devices write in the same second, Drive keeps one write. The other device still has its change and sends it on its next sync. | Same as Google Drive, with one encrypted file per link. |
| Security | Access rules let each account read and write only its own records. Google can read the data. The web config is public by design. | A row policy lets each account read only its own rows. The public key is public by design, so the policy is the only lock. A table without it is open to anyone. Supabase can read the data. | The file sits in your own Drive, in a folder only this app can open. Google can read it. No other server is involved. | The server stores only encrypted data. The key sits in the link after the `#`, which browsers never send to a server. Anyone with the link can read and change your collection. |
| Changes in `store.js` and the app | The merge in `store.js`. A new `js/sync.js` loads Firebase's sign-in and Firestore libraries from Google's CDN as ES modules. It sends changed records and fetches records changed since the last sync. | The merge in `store.js`. A new `js/sync.js` loads `supabase-js` from a CDN, or calls the REST API with `fetch`. Same per-record flow as Firebase. | The merge in `store.js`. A new `js/sync.js` loads Google's sign-in library and reads and writes one file with `fetch`. | The merge in `store.js`. A new `js/sync.js` encrypts with the browser's Web Crypto and reads and writes with `fetch`. A new `server/worker.js` for Cloudflare. |
| Main drawback | Google holds a readable copy, and the app depends on Firebase's libraries. | Sync stops after a week without use until you restore the project in the Supabase dashboard. | A tap and a Google window every session. | Lose every copy of the link and nothing can recover the server copy. This repo owns the server and the encryption code. |

### Firebase

Firestore caps one document at 1 MiB. A 3,000-record collection is about 1.2 MiB of JSON, so one document per account is too small. One document per record would cost one read per record on every sync, and Spark allows 50,000 reads a day. The app splits the sync state across 16 documents by a hash of each entry's key instead, so a sync costs 16 reads. The app uses the sign-in popup. Firebase's redirect sign-in needs extra setup on Safari when the site is not hosted on Firebase, and the popup avoids it. The site is public, so the access rules should also allow only your account unless you want other people to sign up. Firebase can also sign you in with a link sent by email if you would rather not use Google.

### Supabase

The sign-in code works without leaving the app, which suits a phone. The 7-day pause is the problem. A record collection can go untouched for weeks, and the next visit would show sync as stopped until you restore the project. A scheduled ping can keep the project awake, but that is one more thing to set up and watch.

### Google Drive app data folder

Google classes the `drive.appdata` scope as non-sensitive, so a personal app needs only basic verification. In test mode Google likely shows an unverified-app warning at sign-in. The hourly access is the main cost. Google's browser sign-in gives no refresh token, so the app asks again each session. Dropbox's app folder avoids that, because its browser sign-in returns a refresh token. If you want your data in your own cloud storage, Dropbox fits better than Drive.

### Sync link

The first device makes a random sync id and a random 256-bit key. The link carries both. The Worker stores the encrypted copy under the id and never sees the key. To cut off a lost phone, make a new link on the PC. The Worker deletes the copy under the old id, and you link your new phone with the new link. KV can return a slightly old copy at another Cloudflare location. A stale read loses nothing under the merge rules, and the next sync catches up. Keep the link in a password manager, because there is no "forgot password".

### Options left out

- **A self-hosted server with its own accounts.** Storing passwords, sending resets and managing sessions is the riskiest code in this list, and it gains nothing over Firebase or Supabase. The sync link covers the small-server case without accounts.
- **Peer-to-peer pairing with no server.** Both devices have to be online at the same time, so the phone would not match the PC while the PC is off.

## Firebase with Google sign-in fits best

- It is the account you asked for. Sign in on a new phone and the collection comes back. The sync link cannot do that if you lose the link.
- You sign in once per device and stay signed in. Google Drive asks again every session.
- It never pauses. Supabase's free plan stops syncing after a week of low activity.
- This repo writes no server code. The sync link needs a Worker and encryption that this repo would own.
- The free plan's 1 GiB holds a 1,000-record collection more than 2,000 times over.

The cost is that Google holds a readable copy of your collection. If privacy matters more to you than account recovery, choose the sync link. It is the runner-up.

## What the next iterations build

Iteration 2 is the same under every option, and it is built. The later iterations assume Firebase.

1. **Iteration 2. Merge in `store.js`, with no network.** Built. See [what iteration 2 built](#what-iteration-2-built).
2. **Iteration 3. Firebase sign-in and sync.** Built. `js/sync.js` syncs through Firebase, `js/sync-config.js` holds placeholders that you fill in, and `firestore.rules` allows only your account. **Sync between devices** on the Collection page signs in with Google, syncs at once, and offers **Sync now** and **Sign out**. [Set up sync with Firebase](firebase-setup.md) walks through the console. Later, access requests let other people sync their own collections once the owner approves them, and the sync controls moved to a cloud button at the top right.
3. **Iteration 4. Sync without tapping.** Built, except removing deletion markers. A device syncs when the app opens, when it comes back into view or back online, and a few seconds after each change. A version document counts each bucket's writes, so a sync reads only the buckets that changed. [What it costs](firebase-setup.md#what-it-costs) has the reads. Still to do: remove deletion markers that every device has seen, and update a device while the app is open by watching the version document.

## Where the facts come from

A web search on 15 November 2026 found the pages below. This environment could not open vendor pages directly, so each fact comes from the search summary of that page.

- [Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing) says Supabase pauses free projects after 7 days of low activity.
- [Passwordless email sign-in](https://supabase.com/docs/guides/auth/auth-email-passwordless) covers Supabase's sign-in code.
- [Firebase pricing plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans) lists the Spark quotas.
- [Best practices for using signInWithRedirect on browsers that block third-party storage access](https://firebase.google.com/docs/auth/web/redirect-best-practices) covers Firebase's redirect sign-in on Safari.
- [Using the token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model) says Google's browser access tokens are short-lived and renew only from a user action.
- [Choose Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) and [Store application-specific data](https://developers.google.com/workspace/drive/api/guides/appdata) cover the `drive.appdata` scope.
- [Using refresh token without client secret](https://www.dropboxforum.com/discussions/101000014/using-refresh-token-without-client-secret/584036) covers Dropbox refresh tokens in the browser.
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [KV limits](https://developers.cloudflare.com/kv/platform/limits) list the Cloudflare free limits.
- [Safari 13.1 and 7-Day Script-Writeable Storage](https://mjtsai.com/blog/2020/03/26/safari-13-1-third-party-cookie-blocking-and-7-day-script-writeable-storage/) covers Safari's 7-day storage cap.

This session did not check Firestore's 1 MiB document limit or Google's unverified-app warning in test mode.

Four numbers come from this repo. A record with every field filled is 420 bytes of JSON. Before iteration 2, two stores that shared one storage kept only the list of the store that saved last. Comparing every pair of records took 2.2 seconds for 3,000 records. The merge takes about 50 milliseconds for two devices with 3,000 records each.
