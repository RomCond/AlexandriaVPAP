# Set up sync with Firebase

Sync keeps the same collection on your phone and your computer. Each person signs in with Google, and the app keeps a copy of their collection in your Firebase project.

You own the site, so you decide who can sync. Anyone who opens the site can sign in and tap **Request access**. You see each request in the app and approve or deny it. Each approved person syncs their own collection, kept apart from yours. Nobody can read anyone else's collection, and that includes you reading theirs. You can remove someone's access later.

Only the access rules in your Firebase console know which account is yours. The repository is public, so your account id never goes in it.

This guide takes about 20 minutes. You need a Google account. Firebase's free Spark plan covers the app for you and a few friends. [What it costs](#what-it-costs) has the numbers.

Sync needs the app to be served over the web, such as from GitHub Pages, or from `npm start` at `http://localhost:8080`. It doesn't work when you open `index.html` as a file.

## 1. Create the Firebase project

1. Go to [the Firebase console](https://console.firebase.google.com) and sign in with your Google account.
2. Click **Create a project**. Some versions of the console call it **Add project**.
3. Give the project a name, such as `record-catalog`.
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
3. Give the app a nickname, such as `Record Catalog`. Leave **Firebase Hosting** off, and click **Register app**.
4. The console shows `const firebaseConfig = { ... }`. Open `js/sync-config.js` in this repository.
5. Replace each `PASTE_` value with the value of the same name from the console: `apiKey`, `authDomain`, `projectId` and `appId`. Keep the quotes.
6. Commit the change and push it. GitHub Pages publishes it within a few minutes.

The web config is public by design. Anyone who opens your site can read these values from the page, and Firebase expects that. The access rules in step 7 are what keep each collection private. You don't need to send the values to anyone.

## 6. Sign in and copy your account id

1. Open your site. A cloud button now shows at the top right, next to the tabs. On a phone it's next to the name, Record Catalog.
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
3. Back on the first device, tap **Sync now** to get the other device's records.

A device syncs when you sign in and when you tap **Sync now**. Signing out stops syncing and keeps the records on that device.

The cloud button shows how sync is doing without opening it. A green dot means synced, a blinking blue dot means it's working, a blue ring means waiting for approval, and a red dot means something went wrong. A number on the button is how many requests are waiting for you. The app checks for new requests when the page opens and each time you tap **Sync now**.

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

| Event | Reads |
| --- | --- |
| You sync | 16, plus one for each person who has asked, and at least one |
| An approved friend syncs | about 35, at most 50 |
| A page opens with someone signed in | 1 or 2 for a friend, and for you one for each person who has asked, at least one |

A sync reads the 16 documents that hold the collection. The access check is what makes a friend's sync cost more. Every time the rules look up a friend's access document, Firestore counts a read. A sync is one transaction, which sends each of the 16 reads as its own request, and the rules look the friend up once for each. Then the transaction's commit checks the rules again for each of the 16 documents. In the Firestore emulator, a friend's sync made 32 lookups, whether it wrote 16 documents, one, or none. The 16 reads are 16 requests, so they cost 16 lookups. The commit costs one more if Firebase counts the same lookup once for the whole commit, or 16 more if it counts each one. On top of that, the app reads the friend's access document once before it syncs. So a friend's sync costs 16 for the collection, 17 to 32 for the rules, and one or two for the check, or 34 to 50 reads in all. Your own syncs skip the lookup, since the rules know your id.

That works out to about 1,000 to 1,400 friend syncs a day, or 3,000 of your own. If the reads run out, the app says so, and sync works again the next day. The Firebase console shows the day's reads under **Firestore Database**, on the **Usage** tab.

## Turn sync off

To run the app only on each device, with nothing loaded from Firebase, open `js/sync-config.js`, change `enabled: true` to `enabled: false`, then commit and push. The cloud button goes away for everyone, and every record stays on the device it's on. To turn sync back on, change it back to `true`. Your Firebase project and its copies stay as they were, so the next sync merges each device with them again.

## Fix a sync message

| The window says | What to do |
| --- | --- |
| Firebase doesn't allow sign-in from this site's address yet. | Add the site's domain in step 3. |
| Google sign-in isn't turned on in the Firebase console yet. | Turn on Google in step 2. |
| Firebase didn't allow that. | If you run the site, check that the rules are published and that the id in `isOwner()` matches the one under **Setting up this site?** If you signed in with a different account, tap **Sign out** and sign in with the right one. |
| Request access, when you're the owner. | The published rules still have the placeholder, or a different id. Fix the id in step 7. |
| This site has used up today's free Firebase reads. | Wait until the next day, or see [What it costs](#what-it-costs). |
| Your collection is too big to sync. | Each person can sync about 14,000 records. |
| Your browser blocked the sign-in window. | Allow pop-ups for the site, then tap **Sign in with Google** again. |
| Couldn't reach the sync service. | Check the connection, then tap **Sync now**. |
| Sync didn't work, followed by Firebase's message. | Check that the Firestore database exists, from step 4. |
| Sync couldn't start. | The app couldn't load Firebase's code from Google. Check the connection and reload the page. |

## What the app keeps in Firebase

| Where | What |
| --- | --- |
| `access/<account id>` | One document per person who asked: `status` (pending, approved or denied), their `name` and `email` from Google, `requestedAt`, and `decidedAt` once you decide. You have none, since the rules name you. |
| `users/<account id>/sync/` | That person's collection, wishlist, vinyl confirmations and deletions, in 16 documents with one text field, `state`, each up to 400,000 characters. |

Deleting someone's sync documents in the console doesn't delete anything from their devices. Their next sync writes them again, if they still have access.

## Check the rules on your computer

`npm run test:rules` runs the rules in Firebase's emulator, on your computer, against cases such as a stranger reading someone else's collection, a guest approving themselves, and a pending guest syncing. It also runs the app's own Firebase calls through a request, an approval and a removal. It needs Java and `npm install`, and the first run downloads the emulator. It never touches your Firebase project.
