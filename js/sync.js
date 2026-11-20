/*
 * Syncs the collection between devices: Google sign-in through Firebase, and a copy of the sync state
 * in Firestore that only its own account can read or write. The site's owner syncs, and so does each
 * person the owner approves. Nothing loads until js/sync-config.js is filled in. Loaded as a plain
 * script in the browser (window.RC.sync), after js/store.js, and with require() in Node tests.
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

  // The longest bucket text firestore.rules accepts, about 14,000 records across the 16 buckets.
  const STATE_LIMIT = 400000;

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
   * device takes the merged state too, keeping anything it changed while the sync ran. A bucket past
   * STATE_LIMIT fails the sync before anything is written, since the rules would refuse it.
   */
  async function syncOnce(store, service) {
    let merged = null;
    await service.exchange((stored) => {
      merged = S.mergeSyncStates(store.syncState(), S.readSyncState(joinBuckets(stored.values())));
      const writes = new Map();
      for (const [id, text] of splitState(merged)) if (text !== (stored.get(id) || EMPTY_BUCKET)) writes.set(id, text);
      if ([...writes.values()].some((text) => text.length > STATE_LIMIT)) {
        throw Object.assign(new Error('The collection is too big to sync.'), { code: 'record-catalog/too-big' });
      }
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
   * Node tests pass `load` to use the same version from npm against the emulator.
   *
   *   users/{account id}/sync/{bucket}   one bucket's text, as `state`
   *   access/{account id}                an access record: status, name, email, requestedAt, decidedAt
   *
   * Only the owner can list access/, so listAccess failing with permission-denied means "not the owner".
   */
  async function firebaseService(config, load = (name) => import(`${FIREBASE_URL}/firebase-${name}.js`)) {
    const [app, auth, firestore] = await Promise.all(['app', 'auth', 'firestore'].map(load));
    const firebase = app.initializeApp(config);
    const session = auth.getAuth(firebase);
    const db = firestore.getFirestore(firebase);
    const asUser = (user) => user && { id: user.uid, name: user.displayName || '', email: user.email || '' };
    const time = (value) => (value && typeof value.toDate === 'function' ? value.toDate().toISOString() : null);
    const asAccess = (snapshot) => ({
      id: snapshot.id,
      status: snapshot.get('status'),
      name: snapshot.get('name') || '',
      email: snapshot.get('email') || '',
      requestedAt: time(snapshot.get('requestedAt')),
      decidedAt: time(snapshot.get('decidedAt')),
    });
    const accessDoc = (id) => firestore.doc(db, 'access', id);
    const me = () => session.currentUser;
    return {
      watchUser: (callback) => auth.onAuthStateChanged(session, (user) => callback(asUser(user))),
      signIn: async () => asUser((await auth.signInWithPopup(session, new auth.GoogleAuthProvider())).user),
      signOut: () => auth.signOut(session),
      exchange: (change) => firestore.runTransaction(db, async (transaction) => {
        const refs = BUCKETS.map((id) => firestore.doc(db, 'users', me().uid, 'sync', id));
        const snapshots = await Promise.all(refs.map((ref) => transaction.get(ref)));
        const stored = new Map(snapshots.map((snapshot, i) => [BUCKETS[i], snapshot.exists() ? snapshot.get('state') : null]));
        for (const [id, text] of change(stored)) transaction.set(refs[BUCKETS.indexOf(id)], { state: text });
      }),
      readAccess: async () => {
        const snapshot = await firestore.getDoc(accessDoc(me().uid));
        return snapshot.exists() ? asAccess(snapshot) : null;
      },
      requestAccess: () => firestore.setDoc(accessDoc(me().uid), {
        status: 'pending',
        name: me().displayName || '',
        email: me().email || '',
        requestedAt: firestore.serverTimestamp(),
      }),
      withdrawAccess: () => firestore.deleteDoc(accessDoc(me().uid)),
      listAccess: async () => (await firestore.getDocs(firestore.collection(db, 'access'))).docs.map(asAccess),
      decideAccess: (id, status) => firestore.updateDoc(accessDoc(id), { status, decidedAt: firestore.serverTimestamp() }),
    };
  }

  // What went wrong, from the error code Firebase gives. Closing the sign-in window isn't a problem.
  const PROBLEMS = {
    'permission-denied': 'notAllowed',
    'resource-exhausted': 'quotaReached',
    'record-catalog/too-big': 'tooBig',
    unavailable: 'offline',
    'auth/network-request-failed': 'offline',
    'auth/unauthorized-domain': 'domainNotAuthorized',
    'auth/operation-not-allowed': 'googleSignInOff',
    'auth/popup-blocked': 'popupBlocked',
    'auth/popup-closed-by-user': null,
    'auth/cancelled-popup-request': null,
  };

  function problemOf(error) {
    const code = error && error.code;
    const kind = Object.prototype.hasOwnProperty.call(PROBLEMS, code) ? PROBLEMS[code] : 'failed';
    return kind && { kind, message: error && error.message ? String(error.message) : '' };
  }

  /*
   * Who a signed-in account is to this site, as `access`:
   *   owner     the account named in firestore.rules. It syncs and decides on requests.
   *   none      hasn't asked for access
   *   pending   asked, and the owner hasn't decided
   *   approved  syncs its own collection
   *   denied    the owner said no, or removed it later
   * The owner is whoever may list every access record, since only the rules know the owner's id.
   */
  const SYNCS = new Set(['owner', 'approved']);

  // The owner's decisions on a person, by the person's status now. The rules allow the same moves.
  const DECISIONS = { pending: ['approved', 'denied'], approved: ['denied'], denied: [] };

  async function accessOf(service) {
    try {
      return { access: 'owner', people: await service.listAccess() };
    } catch (error) {
      if (!error || error.code !== 'permission-denied') throw error;
    }
    const mine = await service.readAccess();
    return { access: mine ? mine.status : 'none', people: [] };
  }

  /*
   * The sync session the page shows. state.phase is one of:
   *   off          sync isn't set up or is turned off, and the page shows nothing about it
   *   starting     Firebase's code is loading
   *   unavailable  Firebase's code didn't load
   *   signedOut, signingIn
   *   checking     finding out the signed-in account's access
   *   idle         signed in, with nothing running
   *   syncing, requesting, withdrawing, deciding
   * state.access is the account's access once checked, or null (see accessOf). state.people lists every
   * access record, for the owner only. state.problem is what went wrong last, as { kind, message }, or
   * null. state.syncedAt is when this device last synced. Pass `service` to use one other than
   * Firebase, as the browser tests do.
   */
  function startSync(store, { config, service, loadService = firebaseService } = {}) {
    const listeners = new Set();
    let active = null;
    const signedOut = { user: null, access: null, people: [] };
    let state = { phase: 'off', ...signedOut, problem: null, syncedAt: store.getPref('syncedAt', null) };
    const busy = () => !['off', 'starting', 'unavailable', 'signedOut', 'idle'].includes(state.phase);

    function set(patch) {
      state = { ...state, ...patch };
      listeners.forEach((listener) => listener(state));
    }

    // Runs one step for the signed-in account, starting in `phase`, and settles back to idle.
    async function run(phase, step) {
      if (!active || !state.user || busy()) return;
      set({ phase, problem: null });
      try {
        await step();
        set({ phase: state.user ? 'idle' : 'signedOut' });
      } catch (error) {
        set({ phase: state.user ? 'idle' : 'signedOut', problem: problemOf(error) });
      }
    }

    // Checks the account's access, then syncs if it may and `andSync` is set.
    const refresh = (andSync) => run('checking', async () => {
      const found = await accessOf(active);
      const syncs = andSync && SYNCS.has(found.access);
      set({ ...found, phase: syncs ? 'syncing' : 'checking' });
      if (!syncs) return;
      await syncOnce(store, active);
      const syncedAt = new Date().toISOString();
      store.setPref('syncedAt', syncedAt);
      set({ syncedAt });
    });

    // A session Firebase restores when the page opens gets its access checked, without a sync.
    function use(found) {
      active = found;
      active.watchUser((user) => {
        const same = (user && user.id) === (state.user && state.user.id);
        if (busy()) set({ user });
        else if (!user) set({ ...signedOut, phase: 'signedOut' });
        else if (!same || !state.access) {
          set({ ...signedOut, user, phase: 'idle' });
          refresh(false);
        }
      });
    }

    const turnedOn = !(config && config.enabled === false);
    if (turnedOn && service) {
      use(service);
    } else if (turnedOn && isConfigured(config)) {
      state = { ...state, phase: 'starting' };
      loadService(config).then(use, (error) => set({ phase: 'unavailable', problem: problemOf(error) }));
    }

    // Signing in syncs right away when the account may, so a device's first sign-in brings the collection over.
    async function signIn() {
      if (!active || busy()) return;
      set({ phase: 'signingIn', problem: null });
      let user;
      try {
        user = await active.signIn();
      } catch (error) {
        set({ phase: 'signedOut', problem: problemOf(error) });
        return;
      }
      set({ ...signedOut, user, phase: 'idle' });
      await refresh(true);
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
      set({ ...signedOut, phase: 'signedOut', syncedAt: null, problem: null });
    }

    async function requestAccess() {
      if (state.access !== 'none') return;
      await run('requesting', async () => {
        await active.requestAccess();
        set({ access: 'pending' });
      });
    }

    async function withdrawAccess() {
      if (state.access !== 'pending') return;
      await run('withdrawing', async () => {
        await active.withdrawAccess();
        set({ access: 'none' });
      });
    }

    // The owner approves, denies or removes one person, who must be in state.people, which only the
    // owner has. `status` must be one of DECISIONS for them.
    async function decide(id, status) {
      const person = state.people.find((p) => p.id === id);
      if (!person || !DECISIONS[person.status].includes(status)) return;
      await run('deciding', async () => {
        await active.decideAccess(id, status);
        const decidedAt = new Date().toISOString();
        set({ people: state.people.map((p) => (p.id === id ? { ...p, status, decidedAt } : p)) });
      });
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
      signOut,
      syncNow: () => refresh(true),
      requestAccess,
      withdrawAccess,
      decide,
    };
  }

  return {
    FIREBASE_VERSION,
    BUCKETS,
    bucketOf,
    splitState,
    joinBuckets,
    syncOnce,
    STATE_LIMIT,
    DECISIONS,
    isConfigured,
    firebaseService,
    startSync,
  };
});
