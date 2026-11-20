/*
 * Firebase settings for syncing your collection between devices. docs/firebase-setup.md says where
 * each value comes from. Until every PASTE_ value is replaced, the app hides sync and loads nothing
 * from Firebase.
 *
 * These values are public by design. Anyone who opens the site can read them. The access rules in
 * firestore.rules, published in the Firebase console, are what keep your collection private.
 */
(self.RC = self.RC || {}).syncConfig = {
  apiKey: 'AIzaSyDQLLkBfpRRbvI1FlTlOgL5klQFyZq8m2w',
  authDomain: 'alexandriavpap.firebaseapp.com',
  projectId: 'alexandriavpap',
  appId: '1:1075167182977:web:dfc7605ddc67b6c1714d80',
};
