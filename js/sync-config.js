/*
 * Firebase settings for syncing your collection between devices. docs/firebase-setup.md says where
 * each value comes from. Until every PASTE_ value is replaced, the app hides sync and loads nothing
 * from Firebase. Set enabled to false to turn sync off and run the app only on each device.
 *
 * These values are public by design. Anyone who opens the site can read them. The access rules in
 * firestore.rules, published in the Firebase console, are what keep your collection private.
 */
(self.RC = self.RC || {}).syncConfig = {
  enabled: true,
  apiKey: 'PASTE_API_KEY_HERE',
  authDomain: 'PASTE_PROJECT_ID_HERE.firebaseapp.com',
  projectId: 'PASTE_PROJECT_ID_HERE',
  appId: 'PASTE_APP_ID_HERE',
};
