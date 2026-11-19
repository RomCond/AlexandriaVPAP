/*
 * Syncs the collection between your devices: sign-in with an email and password through Firebase,
 * and a copy of the sync state in Firestore that only your account can read or write. Nothing loads until js/sync-config.js
 * is filled in. Loaded as a plain script in the browser (window.RC.sync), after js/store.js, and with
 * require() in Node tests.
 */
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./store.js') : root.RC.store);
  if (node) module.exports = api;
  else (root.RC = root.RC || {}).sync = api;
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  const FIREBASE_VERSION = '12.19.0';
  const FIREBASE_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const CONFIG_KEYS = ['apiKey', 'authDomain', 'projectId', 'appId'];

  // The sync state is split across 16 Firestore documents, so none comes near Firestore's 1 MiB limit
  // and a sync reads 16 documents however big the collection is.
  const BUCKETS = [...'0123456789abcdef'];

  // FNV-1a, so every device puts an entry in the same bucket.
  function bucketOf(key) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return BUCKETS[(hash >>> 0) % BUCKETS.length];
  }

  // Objects without a prototype, so an id like "__proto__" is kept like any other.
  const table = () => Object.create(null);
  const emptyPart = () => ({ records: [], wishlist: [], confirmed: table(), deleted: { records: table(), wishlist: table(), confirmed: table() } });
  const EMPTY_BUCKET = JSON.stringify(emptyPart());
  const LISTS = ['records', 'wishlist', 'confirmed'];

  // A sync state as the text of each bucket. Each entry goes to the bucket for its list and key.
  function splitState(state) {
    const parts = new Map(BUCKETS.map((id) => [id, emptyPart()]));
    const part = (list, key) => parts.get(bucketOf(`${list}:${key}`));
    for (const list of ['records', 'wishlist']) {
      for (const item of state[list]) part(list, item.id)[list].push(item);
    }
    for (const [key, at] of Object.entries(state.confirmed)) part('confirmed', key).confirmed[key] = at;
    for (const list of LISTS) {
      for (const [key, at] of Object.entries(state.deleted[list])) part(list, key).deleted[list][key] = at;
    }
    return new Map([...parts].map(([id, value]) => [id, JSON.stringify(value)]));
  }

  // The buckets' texts as one sync state. Text that isn't a bucket is left out, and S.readSyncState
  // leaves out entries it can't read.
  function joinBuckets(texts) {
    const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
    const joined = emptyPart();
    for (const text of texts) {
      let part;
      try {
        part = object(JSON.parse(text));
      } catch (e) {
        continue;
      }
      for (const list of ['records', 'wishlist']) if (Array.isArray(part[list])) joined[list] = joined[list].concat(part[list]);
      Object.assign(joined.confirmed, object(part.confirmed));
      for (const list of LISTS) Object.assign(joined.deleted[list], object(object(part.deleted)[list]));
    }
    return joined;
  }

  /*
   * One sync. service.exchange reads every bucket and writes the ones `change` returns, as one
   * transaction, and calls `change` again if another device wrote in between. The merge takes this
   * device's state and the stored one, and only buckets whose text changed are written. Then this
   * device takes the merged state too, keeping anything it changed while the sync ran.
   */
  async function syncOnce(store, service) {
    let merged = null;
    await service.exchange((stored) => {
      merged = S.mergeSyncStates(store.syncState(), S.readSyncState(joinBuckets(stored.values())));
      const writes = new Map();
      for (const [id, text] of splitState(merged)) if (text !== (stored.get(id) || EMPTY_BUCKET)) writes.set(id, text);
      return writes;
    });
    store.applySyncState(merged);
  }

  // Filled in when each value Firebase needs is set and none is still a PASTE_ placeholder.
  function isConfigured(config) {
    return Boolean(config) && CONFIG_KEYS.every((key) => typeof config[key] === 'string' && config[key] && !config[key].includes('PASTE_'));
  }

  /*
   * The sync service on Firebase, with Firebase's code loaded from Google's CDN at a pinned version.
   * Each bucket is the document users/{account id}/sync/{bucket}, holding the bucket's text as `state`.
   * The password goes to Firebase and nowhere else. Accounts are added in the Firebase console, so
   * nobody can create one from the site.
   */
  async function firebaseService(config) {
    const [app, auth, firestore] = await Promise.all(['app', 'auth', 'firestore'].map((name) => import(`${FIREBASE_URL}/firebase-${name}.js`)));
    const firebase = app.initializeApp(config);
    const session = auth.getAuth(firebase);
    const db = firestore.getFirestore(firebase);
    const asUser = (user) => user && { id: user.uid, email: user.email };
    return {
      watchUser: (callback) => auth.onAuthStateChanged(session, (user) => callback(asUser(user))),
      signIn: async (email, password) => asUser((await auth.signInWithEmailAndPassword(session, email, password)).user),
      resetPassword: (email) => auth.sendPasswordResetEmail(session, email),
      signOut: () => auth.signOut(session),
      exchange: (change) => firestore.runTransaction(db, async (transaction) => {
        const refs = BUCKETS.map((id) => firestore.doc(db, 'users', session.currentUser.uid, 'sync', id));
        const snapshots = await Promise.all(refs.map((ref) => transaction.get(ref)));
        const stored = new Map(snapshots.map((snapshot, i) => [BUCKETS[i], snapshot.exists() ? snapshot.get('state') : null]));
        for (const [id, text] of change(stored)) transaction.set(refs[BUCKETS.indexOf(id)], { state: text });
      }),
    };
  }

  // What went wrong, from the error code Firebase gives. Firebase answers a wrong email and a wrong
  // password alike, so nobody can find out which emails have an account.
  const PROBLEMS = {
    'permission-denied': 'notAllowed',
    unavailable: 'offline',
    'auth/network-request-failed': 'offline',
    'auth/invalid-credential': 'wrongPassword',
    'auth/wrong-password': 'wrongPassword',
    'auth/user-not-found': 'wrongPassword',
    'auth/invalid-email': 'wrongPassword',
    'auth/too-many-requests': 'tooManyAttempts',
    'auth/operation-not-allowed': 'passwordSignInOff',
    'auth/unauthorized-domain': 'domainNotAuthorized',
  };

  function problemOf(error) {
    const code = error && error.code;
    const kind = Object.prototype.hasOwnProperty.call(PROBLEMS, code) ? PROBLEMS[code] : 'failed';
    return { kind, message: error && error.message ? String(error.message) : '' };
  }

  /*
   * The sync session the page shows. state.phase is one of:
   *   off          sync isn't set up, and the page shows nothing about it
   *   starting     Firebase's code is loading
   *   unavailable  Firebase's code didn't load
   *   signedOut, signingIn, idle (signed in), syncing
   * state.problem is what went wrong last, as { kind, message }, or null. state.syncedAt is when this
   * device last synced. Pass `service` to use one other than Firebase, as the browser tests do.
   */
  function startSync(store, { config, service, loadService = firebaseService } = {}) {
    const listeners = new Set();
    let active = null;
    let state = { phase: 'off', user: null, problem: null, syncedAt: store.getPref('syncedAt', null) };
    const busy = () => state.phase === 'signingIn' || state.phase === 'syncing';

    function set(patch) {
      state = { ...state, ...patch };
      listeners.forEach((listener) => listener(state));
    }

    function use(found) {
      active = found;
      active.watchUser((user) => set({ user, phase: busy() ? state.phase : user ? 'idle' : 'signedOut' }));
    }

    if (service) {
      use(service);
    } else if (isConfigured(config)) {
      state = { ...state, phase: 'starting' };
      loadService(config).then(use, (error) => set({ phase: 'unavailable', problem: problemOf(error) }));
    }

    async function syncNow() {
      if (!active || !state.user || busy()) return;
      set({ phase: 'syncing', problem: null });
      try {
        await syncOnce(store, active);
        const syncedAt = new Date().toISOString();
        store.setPref('syncedAt', syncedAt);
        set({ phase: state.user ? 'idle' : 'signedOut', syncedAt });
      } catch (error) {
        set({ phase: state.user ? 'idle' : 'signedOut', problem: problemOf(error) });
      }
    }

    // Signing in syncs right away, so the first sign-in on a device brings the collection over. The
    // password goes to the service and isn't kept. Returns whether the sign-in worked.
    async function signIn(email, password) {
      if (!active || busy()) return false;
      set({ phase: 'signingIn', problem: null });
      let user;
      try {
        user = await active.signIn(email, password);
      } catch (error) {
        set({ phase: 'signedOut', problem: problemOf(error) });
        return false;
      }
      set({ user, phase: 'idle' });
      await syncNow();
      return true;
    }

    // Asks Firebase to email a link for setting a new password. Returns whether it was sent.
    async function resetPassword(email) {
      if (!active || busy()) return false;
      try {
        await active.resetPassword(email);
      } catch (error) {
        set({ problem: problemOf(error) });
        return false;
      }
      set({ problem: null });
      return true;
    }

    // Signing out keeps this device's records. It only stops syncing them.
    async function signOut() {
      if (!active || busy()) return;
      try {
        await active.signOut();
      } catch (error) {
        set({ problem: problemOf(error) });
        return;
      }
      store.setPref('syncedAt', null);
      set({ user: null, phase: 'signedOut', syncedAt: null, problem: null });
    }

    return {
      get state() {
        return state;
      },
      onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      signIn,
      resetPassword,
      signOut,
      syncNow,
    };
  }

  return {
    FIREBASE_VERSION,
    BUCKETS,
    bucketOf,
    splitState,
    joinBuckets,
    syncOnce,
    isConfigured,
    startSync,
  };
});
