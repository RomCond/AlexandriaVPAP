# Set up sync with Firebase

Sync keeps the same collection on your phone and your computer. Each person signs in with Google, and the app keeps a copy of their collection in your Firebase project.

You own the site, so you decide who can sync. Anyone who opens the site can sign in and tap **Request access**. You see each request in the app and approve or deny it. Each approved person syncs their own collection, kept apart from yours. Nobody can read anyone else's collection, and that includes you reading theirs. You can remove someone's access later.

Only the access rules in your Firebase console know which account is yours. The repository is public, so your account id never goes in it.

This guide takes about 20 minutes. You need a Google account. Firebase's free Spark plan covers the app for you and a few friends. [What it costs](#what-it-costs) has the numbers.

Live updates need no new rules. The rules that let you read `versions` already let you listen to it. If your published rules mention `versions`, you have nothing to publish for live updates.

**Already set up sync, and your published rules don't mention `versions`?** Publish the new access rules from `firestore.rules`, as in [step 7](#7-publish-the-access-rules), as soon as the updated app is live. Until you do, every sync fails with "Firebase didn't allow that." [Update the rules after an app update](#update-the-rules-after-an-app-update) explains why.

Sync needs the app to be served over the web, such as from GitHub Pages, or from `npm start` at `http://localhost:8080`. It doesn't work when you open `index.html` as a file.

## 1. Create the Firebase project

1. Go to [the Firebase console](https://console.firebase.google.com) and sign in with your Google account.
2. Click **Create a project**. Some versions of the console call it **Add project**.
3. Give the project a name, such as `alexandria`.
4. The app doesn't use Google Analytics. Turn it off.
5. Click **Create project** and wait until the project is ready.

## 2. Turn on Google sign-in

1. In the menu on the left, open **Build**, then **Authentication**.
2. Click **Get started**.
3. On the **Sign-in method** tab, click **Google**.
4. Turn on **Enable**, choose your email address as the support email, and click **Save**.

## 3. Allow sign-in from your site's address

1. In **Authentication**, open the **Settings** tab, then **Authorized domains**.
2. Click **Add domain**.
3. Enter your site's domain, without `https://` and without a path. Click **Add**.

Your site's domain is probably `romcond.github.io`. To check it, open the app in your browser and look at the address bar. The domain is the part between `https://` and the next `/`. On GitHub, the repository's **Settings**, then **Pages**, also shows the address after "Your site is live at".

Firebase puts `localhost` on the list by default, so sync also works from `npm start` on your computer.

## 4. Create the Firestore database

1. In the menu on the left, open **Build**, then **Firestore Database**.
2. Click **Create database**. If the console asks for an edition, choose **Standard**.
3. Choose a location near you. You can't change it later.
4. Choose **Start in production mode**. Production mode blocks all access until you publish the rules in step 7.
5. Click **Create**.

## 5. Put the web config in the app

1. Click the gear next to **Project Overview**, then **Project settings**.
2. Under **Your apps**, click the web icon, `</>`.
3. Give the app a nickname, such as `Alexandria`. Leave **Firebase Hosting** off, and click **Register app**.
4. The console shows `const firebaseConfig = { ... }`. Open `js/sync-config.js` in this repository.
5. Replace each `PASTE_` value with the value of the same name from the console: `apiKey`, `authDomain`, `projectId` and `appId`. Keep the quotes.
6. Commit the change and push it. GitHub Pages publishes it within a few minutes.

The web config is public by design. Anyone who opens your site can read these values from the page, and Firebase expects that. The access rules in step 7 are what keep each collection private. You don't need to send the values to anyone.

## 6. Sign in and copy your account id

1. Open your site. A cloud button now shows at the top right, next to the tabs. On a phone it's next to the name, Alexandria.
2. Tap the cloud button, then **Sign in with Google**, and choose your account.
3. The window says "Firebase didn't allow that." Until you publish the rules in step 7, that message is expected.
4. Open **Setting up this site?** and click **Copy**. That's your account id.

The Firebase console shows the same id under **Authentication**, on the **Users** tab, in the **User UID** column.

## 7. Publish the access rules

1. Open `firestore.rules` in this repository and copy all of it.
2. In the Firebase console, open **Firestore Database**, then the **Rules** tab.
3. Replace everything in the editor with what you copied.
4. Find `PASTE_YOUR_ACCOUNT_ID_HERE`. It appears once, in `isOwner()`. Replace it with your account id, and keep the quotes around it.
5. Click **Publish**.

Keep the filled-in rules in the console only. Don't commit them, because the repository is public. The copy in the repository keeps the placeholder, so nobody is the owner until you fill it in.

## 8. Check that you're the owner, and sync your devices

1. In the app, tap the cloud button, then **Sign out** and **Sign in with Google** again. The window now says "Synced just now." Under it are **Requests** and **People who sync**, which only you see.
2. On your other device, open the site and sign in with the same Google account. Signing in syncs right away, so the device gets your collection, and its own records go up to Firebase.
3. If the first device is still open, it gets the other device's records within a second or two, with no tap.

You don't need to tap anything after that. A signed-in device syncs on its own:

- when the app opens
- within a second or two of a change on another device, while the app is open
- 5 seconds after you change something, or at most 30 seconds after the first change when you keep editing
- when it comes back online with changes waiting

### Live updates

While the app is open, it listens to `versions`, the small document that counts the changes to each part of your collection. When another device syncs, Firebase sends the new counts, and the app syncs half a second later. That sync reads only the parts that changed. Several changes in quick succession make one sync.

Your own syncs change `versions` too, and Firebase sends those counts back. The app already holds them, so they start nothing. A count that arrives while a sync runs is checked once that sync ends.

The app stops listening:

- when you sign out, before it signs out
- when you lose access, or were never approved
- when the day's free reads run out, until you tap **Sync now**
- when sync is turned off with `enabled: false`
- once the app has been out of view for a minute

A minute out of view covers a quick look at another app, which costs nothing. After that, a hidden page would pay a read for every change another device makes. Starting to listen again when you come back costs one read, about what the sync on coming back used to cost, and the first counts it gets bring anything that changed while you were away. So coming back no longer syncs unless the counts say something changed, or this device has changes waiting.

The app keeps listening while the device is offline. Firebase picks the listener up again on reconnecting and sends the counts only if they changed, so coming back online syncs only when this device has changes waiting.

If the listener fails for another reason, the app doesn't start it again in a loop. It waits for the next sync that works, for you to switch back to the app, or for the device to come back online. Until then, syncs on opening, after a change and on **Sync now** work as before.

Nothing syncs while the device is offline. Changes wait on the device and go up once it's back online. When a sync fails, the app tries again after 15 seconds, then 1, 5, 15 and 30 minutes, and changes from other devices don't cut that wait short. When the day's free reads run out, it stops syncing on its own until you tap **Sync now**. **Sync now** still works at any time. Signing out stops syncing and keeps the records on that device.

The cloud button shows how sync is doing without opening it. A green dot means synced, a blinking blue dot means it's working, and a red dot means something went wrong. A blue ring means changes are waiting to sync, or, for a friend, that they're waiting for your approval. No dot means signed out or offline, and the button's label says which. A number on the button is how many requests are waiting for you. The app checks for new requests when the page opens and each time you tap **Sync now**.

## 9. A friend's first request

What your friend does:

1. They open your site, tap the cloud button, and tap **Sign in with Google**.
2. They tap **Request access**. The window tells them first that asking shares their name and email with you, and that their collection is kept in your Firebase project.
3. The window says they're waiting for you to approve. They can tap **Withdraw request** to take it back, with their name and email, until you decide.

What you do:

1. Open the site. The cloud button shows **1**.
2. Tap it. Under **Requests**, you see your friend's name and email. Google provides both, and the rules check that they belong to the account that asked, so nobody can ask under someone else's name.
3. Tap **Approve**, or tap **Deny** and then **Deny** again to confirm.

Then your friend taps **Check again**. Once you've approved, their collection syncs. If you denied the request, the window says they don't have access.

## Remove someone's access

Tap the cloud button. Under **People who sync**, tap **Remove access** next to the person, then **Remove access** again to confirm. Their next sync stops, and the records on their devices stay there. Their copy in Firebase stays too, and only the Firebase console can delete it, under `users/<their account id>/`.

Denying and removing can't be undone in the app. The rules don't let a denied person ask again, so a stranger you turned away can't keep asking. To let someone back in, open **Firestore Database** in the console, open the `access` collection, and delete their document. They can then ask again, and you approve them as before.

## What it costs

Firebase's free Spark plan allows 50,000 document reads a day, shared by everyone who syncs. Writes and storage have their own allowances, and the app stays well inside them.

A sync reads one small document first, `versions`, which counts how often each part of the collection has changed. Then it reads only the parts that changed, on this device or another one. These are the reads for one sync, measured in the Firestore emulator:

| Sync | You, before | You, now | A friend, before | A friend, now |
| --- | --- | --- | --- | --- |
| Nothing changed | 16 | 1 | 33 to 48 | 3 |
| One record added on this device | 16 | 3 | 33 to 48 | 6 or 7 |
| One record added on the other device | 16 | 2 | 33 to 48 | 5 or 6 |
| Both devices changed while apart | 16 | 4 | 33 to 48 | 8 to 10 |
| A new device | 16 | 17 | 33 to 48 | 35 to 51 |

On top of that, when the page opens and when you tap **Sync now**, the app checks who has access. That costs you one read for each person who has asked, and at least one. It costs a friend one or two. Syncs after a change or when you switch back skip the check.

Listening to `versions` costs one read each time Firebase sends it. For a friend, the rules also look up their access document each time the listener starts or gets new counts, and that lookup is another read. These are the reads for the listener alone, measured in the Firestore emulator:

| Listener | You | A friend |
| --- | --- | --- |
| Starting, when the app opens or you come back after a minute away | 1 | 2 |
| Each change from another device, plus the sync it starts | 1, plus 2 or 3 | 2, plus 5 to 8 |
| Each of your own syncs that writes, as its counts come back | 1 | 2 |
| A sync that writes nothing | 0 | 1 |
| Reconnecting after less than 30 minutes, nothing changed | 0 | 1 |
| Reconnecting after more than 30 minutes | 1 | 2 |

The emulator checks the rules when a listener starts, when it reconnects, and each time it gets new counts, so the friend's column counts an access lookup each time. It also checked them once after a sync that wrote nothing. The emulator doesn't bill, so the reconnect rows follow Firebase's documentation: a listener that comes back within 30 minutes pays only for documents that changed, and one that was gone longer pays as if it were new.

Compared with syncing on coming back, listening costs you one more read for each change you make, as its counts come back, and costs nothing extra to come back to the app. For a friend, coming back is cheaper, 2 reads instead of 3, and each change costs 2 more.

Each device's first sync after this update costs the same as a new device. After that, most syncs cost a few reads.

A friend's sync costs more because the rules look up the friend's access document for every document the sync touches, and Firestore counts each lookup as a read. A sync is one transaction. Each document it reads is checked once when it's read, and again when the transaction commits. Each part it writes also looks up `versions`, to check that its count went up. Firebase doesn't say whether a commit pays for the same lookup once or once for each document, so the table gives both ends. Your own syncs skip the access lookup, since the rules know your id.

As a rough guide, a person who opens or switches back to the app 20 times a day and makes 30 changes uses about 180 reads a day, or about 300 for a friend. Each change another device makes while the app is open adds about 3 reads for you, or about 9 for a friend. The free reads cover about 150 people at that pace. If they run out, the app says so and stops syncing on its own, and sync works again the next day. The Firebase console shows the day's reads under **Firestore Database**, on the **Usage** tab.

`scripts/sync-reads/measure.js` measures these numbers in the emulator, for this version and the one before it, and the listener's in this version.

## Update the rules after an app update

Some app updates need new access rules. This one does. The app now stores a count with each part of the collection, and the old rules refuse it. The new rules refuse writes from the old app, which doesn't keep the counts. Without that, another device would never notice what the old app wrote.

1. Wait until the updated app is live on your site. GitHub Pages takes a few minutes after the merge.
2. Publish the new `firestore.rules`, as in [step 7](#7-publish-the-access-rules). Put your account id in `isOwner()` again.
3. Reload the app on each device, so none keeps running the old page.

Until you publish, syncs fail with "Firebase didn't allow that." A device that still runs the old page gets the same message until it reloads. Nothing is lost either way. Records stay on each device and sync once the rules and the page match.

## Turn sync off

To run the app only on each device, with nothing loaded from Firebase, open `js/sync-config.js`, change `enabled: true` to `enabled: false`, then commit and push. The cloud button goes away for everyone, and every record stays on the device it's on. To turn sync back on, change it back to `true`. Your Firebase project and its copies stay as they were, so the next sync merges each device with them again.

## Fix a sync message

| The window says | What to do |
| --- | --- |
| Firebase doesn't allow sign-in from this site's address yet. | Add the site's domain in step 3. |
| Google sign-in isn't turned on in the Firebase console yet. | Turn on Google in step 2. |
| Firebase didn't allow that. | If you just updated the app, publish the new rules, as in [Update the rules after an app update](#update-the-rules-after-an-app-update), and reload the app on each device. Otherwise, if you run the site, check that the rules are published and that the id in `isOwner()` matches the one under **Setting up this site?** If you signed in with a different account, tap **Sign out** and sign in with the right one. |
| Request access, when you're the owner. | The published rules still have the placeholder, or a different id. Fix the id in step 7. |
| This site has used up today's free Firebase reads. | Wait until the next day, then tap **Sync now**. Until you do, the app doesn't sync on its own. See [What it costs](#what-it-costs). |
| Your collection is too big to sync. | Each person can sync about 14,000 records. |
| Your browser blocked the sign-in window. | Allow pop-ups for the site, then tap **Sign in with Google** again. |
| Couldn't reach the sync service. | Check the connection, then tap **Sync now**. |
| Sync didn't work, followed by Firebase's message. | Check that the Firestore database exists, from step 4. |
| Sync couldn't start. | The app couldn't load Firebase's code from Google. Check the connection and reload the page. |

## What the app keeps in Firebase

| Where | What |
| --- | --- |
| `access/<account id>` | One document per person who asked: `status` (pending, approved or denied), their `name` and `email` from Google, `requestedAt`, and `decidedAt` once you decide. You have none, since the rules name you. |
| `users/<account id>/sync/0` to `f` | That person's collection, wishlist, vinyl confirmations and deletions, in 16 documents. Each has `state`, a text of up to 400,000 characters, and `version`, how many times it has been written. |
| `users/<account id>/sync/versions` | One count for each of the 16 documents, under fields `0` to `f`. A sync reads this first and reads only the documents whose count changed. The counts never go down. |

Deleting someone's sync documents in the console doesn't delete anything from their devices. Their next sync writes them again, if they still have access. If you delete only `versions`, the next sync reads all 16 documents and writes `versions` again.

## Check the rules on your computer

`npm run test:rules` runs the rules in Firebase's emulator, on your computer, against cases such as a stranger reading someone else's collection, a guest approving themselves, a pending guest syncing, a count going down, and a write from the old app. It also runs the app's own Firebase calls through a request, an approval and a removal. It needs Java and `npm install`, and the first run downloads the emulator. It never touches your Firebase project.
