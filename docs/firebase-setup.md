# Set up sync with Firebase

Sync keeps the same collection on your phone and your computer. You sign in with your Google account on each device, and the app keeps a copy of your collection in your own Firebase project. Only your account can read or write that copy.

This guide takes about 15 minutes. You need a Google account. Firebase's free Spark plan covers the app.

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

The web config is public by design. Anyone who opens your site can read these values from the page, and Firebase expects that. The access rules in step 7 are what keep your collection private. You don't need to send the values to anyone.

## 6. Sign in and copy your account id

1. Open your site, go to the **Collection** page, and scroll to **Sync between devices**.
2. Click **Sign in with Google** and choose your account.
3. The panel says "This Google account can't sync." Until you publish the rules in step 7, that message is expected.
4. Open **Account id for the access rules** and click **Copy**.

The Firebase console shows the same id under **Authentication**, on the **Users** tab, in the **User UID** column.

## 7. Publish the access rules

1. Open `firestore.rules` in this repository and copy all of it.
2. In the Firebase console, open **Firestore Database**, then the **Rules** tab.
3. Replace everything in the editor with what you copied.
4. Replace `PASTE_YOUR_ACCOUNT_ID_HERE` with your account id. Keep the quotes around it.
5. Click **Publish**.

Keep the filled-in rules in the console only. Don't commit them, because the repository is public.

## 8. Sync your devices

1. In the app, click **Sync now**. The panel says "Synced just now."
2. On your other device, open the site and sign in with the same Google account. Signing in syncs right away, so the device gets your collection, and its own records go up to Firebase.
3. Back on the first device, click **Sync now** to get the other device's records.

For now, a device syncs only when you sign in and when you click **Sync now**. Signing out stops syncing and keeps the records on that device.

## Fix a sync message

| The panel says | What to do |
| --- | --- |
| Firebase doesn't allow sign-in from this site's address yet. | Add the site's domain in step 3. |
| Google sign-in isn't turned on in the Firebase console yet. | Turn on Google in step 2. |
| This Google account can't sync. | Check that the id in the published rules matches the id the message shows. If you signed in with a different account, click **Sign out** and sign in with the right one. |
| Your browser blocked the sign-in window. | Allow pop-ups for the site, then click **Sign in with Google** again. |
| Couldn't reach the sync service. | Check the connection, then click **Sync now**. |
| Sync didn't work, followed by Firebase's message. | Check that the Firestore database exists, from step 4. |
| Sync couldn't start. | The app couldn't load Firebase's code from Google. Check the connection and reload the page. |

## What the app keeps in Firebase

The app keeps your collection, wishlist, vinyl confirmations and deletions in 16 documents under `users/<your account id>/sync/`. Each document has one text field, `state`. A sync reads all 16 and writes only the ones that changed. The Spark plan allows 50,000 reads a day, which is about 3,000 syncs.

Deleting these documents in the console doesn't delete anything from your devices. The next sync writes them again from the device that syncs.
