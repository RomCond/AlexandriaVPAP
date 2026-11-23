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

  // Beside the buckets, one document holds a counter for each bucket. A sync that writes a bucket adds
  // one to its counter in the same transaction, and the bucket keeps its own counter as `version`.
  // Counters, not times, since device clocks differ.
  const VERSIONS = 'versions';

  // What this device saw at its last sync, saved as a preference: the account, each bucket's counter,
  // and a hash of each bucket's text. A device with no memory, or one for another account, reads every bucket.
  const MEMORY = 'syncMemory';

  // cyrb53, a 53-bit hash, so remembering a bucket costs a few bytes instead of its whole text.
  function hashText(text) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  const EMPTY_STATE = { records: [], wishlist: [], confirmed: {}, deleted: { records: {}, wishlist: {}, confirmed: {} } };

  // The memory, when it is this account's and whole.
  function memoryOf(store, account) {
    const saved = store.getPref(MEMORY, null);
    const whole = (value) => value && typeof value === 'object' && BUCKETS.every((id) => id in value);
    return saved && saved.account === account && whole(saved.counters) && whole(saved.hashes) ? saved : null;
  }

  /*
   * One sync, as one transaction through service.exchange, which calls `need` with the version document
   * (null when there is none), reads the buckets it names, then calls `change` with them and writes what
   * it returns. It calls both again if another device wrote in between.
   *
   * A bucket is read when its counter differs from the one this device remembers, or when this device's
   * own text for it no longer matches the hash it remembers, which means it changed here. Every other
   * bucket holds exactly what this device last saw, and this device still holds the same text, so the
   * merge needs nothing from it. Only buckets whose merged text differs from what Firebase holds are
   * written. A missing version document means every bucket is read and the document is made again from
   * the buckets' own counters, which covers collections synced before counters existed.
   *
   * Then this device takes the merged state, keeping anything it changed while the sync ran, and
   * remembers the counters and hashes. A bucket past STATE_LIMIT fails the sync before anything is
   * written, since the rules would refuse it.
   */
  async function syncOnce(store, service, account = '') {
    const memory = memoryOf(store, account);
    let local = null;
    let mine = null;
    let result = null;
    await service.exchange({
      need(versions) {
        // The merge puts a state in a set order, so the same entries always give the same text.
        local = S.mergeSyncStates(store.syncState(), EMPTY_STATE);
        mine = splitState(local);
        if (!versions || !memory) return BUCKETS.slice();
        return BUCKETS.filter((id) => versions[id] !== memory.counters[id] || hashText(mine.get(id)) !== memory.hashes[id]);
      },
      change(versions, stored) {
        const merged = S.mergeSyncStates(local, S.readSyncState(joinBuckets([...stored.values()].map((held) => held && held.state))));
        const counters = {};
        const hashes = {};
        const buckets = new Map();
        for (const [id, text] of splitState(merged)) {
          // A bucket left unread holds what this device holds. One copy per album can still change it,
          // when a bucket that was read brings an older copy of an album this one has.
          const held = stored.has(id) ? stored.get(id) : { state: mine.get(id), version: versions[id] };
          const version = held && Number.isInteger(held.version) ? held.version : 0;
          const counter = versions && Number.isInteger(versions[id]) ? versions[id] : version;
          hashes[id] = hashText(text);
          counters[id] = counter;
          if (text === ((held && held.state) || EMPTY_BUCKET)) continue;
          counters[id] = Math.max(counter, version) + 1;
          buckets.set(id, { state: text, version: counters[id] });
        }
        if ([...buckets.values()].some((bucket) => bucket.state.length > STATE_LIMIT)) {
          throw Object.assign(new Error('The collection is too big to sync.'), { code: 'record-catalog/too-big' });
        }
        result = { merged, memory: { account, counters, hashes } };
        return { buckets, versions: buckets.size || !versions ? counters : null };
      },
    });
    store.applySyncState(result.merged);
    store.setPref(MEMORY, result.memory);
  }

  // Filled in when each value Firebase needs is set and none is still a PASTE_ placeholder.
  function isConfigured(config) {
    return Boolean(config) && CONFIG_KEYS.every((key) => typeof config[key] === 'string' && config[key] && !config[key].includes('PASTE_'));
  }

  /*
   * The sync service on Firebase, with Firebase's code loaded from Google's CDN at a pinned version.
   * Node tests pass `load` to use the same version from npm against the emulator.
   *
   *   users/{account id}/sync/{bucket}   one bucket's text, as `state`, and its counter, as `version`
   *   users/{account id}/sync/versions   every bucket's counter, under the bucket's id
   *   access/{account id}                an access record: status, name, email, requestedAt, decidedAt
   *
   * Only the owner can list access/, so listAccess failing with permission-denied means "not the owner".
   *
   * watchVersions listens to the version document. It calls `onVersions` with the counters, or null
   * when there is no version document, and with whether the snapshot came from the local cache or holds
   * writes Firebase hasn't confirmed. It calls `onError` once if Firebase ends the listener. It returns
   * a function that stops listening.
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
      exchange: (plan) => firestore.runTransaction(db, async (transaction) => {
        const ref = (id) => firestore.doc(db, 'users', me().uid, 'sync', id);
        const found = await transaction.get(ref(VERSIONS));
        const versions = found.exists() ? found.data() : null;
        const ids = plan.need(versions);
        const snapshots = await Promise.all(ids.map((id) => transaction.get(ref(id))));
        const stored = new Map(snapshots.map((snapshot, i) => [ids[i], snapshot.exists() ? { state: snapshot.get('state'), version: snapshot.get('version') } : null]));
        const { buckets, versions: next } = plan.change(versions, stored);
        for (const [id, bucket] of buckets) transaction.set(ref(id), bucket);
        if (next) transaction.set(ref(VERSIONS), next);
      }),
      watchVersions: (onVersions, onError) => firestore.onSnapshot(
        firestore.doc(db, 'users', me().uid, 'sync', VERSIONS),
        (snapshot) => onVersions(snapshot.exists() ? snapshot.data() : null, { fromCache: snapshot.metadata.fromCache, hasPendingWrites: snapshot.metadata.hasPendingWrites }),
        onError,
      ),
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

  // How automatic syncs are paced, in milliseconds. A change syncs once edits pause for CHANGE_DELAY,
  // and within CHANGE_MAX_WAIT of the first one however long the edits go on.
  // Coming back into view syncs unless a sync finished within VISIBLE_GAP. A failed automatic sync
  // tries again after each wait in RETRY, then keeps the last.
  // With live updates, a change from another device syncs LIVE_DELAY after the version document
  // shows it, so a burst of snapshots makes one sync. The listener stops once the page has been
  // hidden for HIDDEN_GRACE, so quick switches between apps don't pay to start it again.
  const AUTO = {
    CHANGE_DELAY: 5000,
    CHANGE_MAX_WAIT: 30000,
    VISIBLE_GAP: 30000,
    RETRY: [15000, 60000, 300000, 900000, 1800000],
    LIVE_DELAY: 500,
    HIDDEN_GRACE: 60000,
  };

  // What the page gives automatic syncing: timers, whether the browser is online and the page visible,
  // and calls for when it comes back online, goes offline, comes back into view and is hidden. Node
  // has none of these, so tests pass their own.
  function browserEnvironment(win) {
    return {
      now: () => Date.now(),
      setTimeout: (fn, ms) => win.setTimeout(fn, ms),
      clearTimeout: (id) => win.clearTimeout(id),
      online: () => win.navigator.onLine !== false,
      onOnline: (fn) => win.addEventListener('online', fn),
      onOffline: (fn) => win.addEventListener('offline', fn),
      visible: () => win.document.visibilityState !== 'hidden',
      onVisible: (fn) => win.document.addEventListener('visibilitychange', () => {
        if (win.document.visibilityState === 'visible') fn();
      }),
      onHidden: (fn) => win.document.addEventListener('visibilitychange', () => {
        if (win.document.visibilityState === 'hidden') fn();
      }),
    };
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
   *
   * Pass `auto`, from browserEnvironment, to sync without a tap: when the page opens with an account
   * that syncs, when it comes back into view, and CHANGE_DELAY after this device's records change.
   * Nothing syncs while the browser says it is offline, and it syncs once it is back. Then
   * state.offline says the browser is offline, and state.waiting says this device has changes it
   * hasn't synced. A used-up quota, a collection too big to sync, or rules that refuse an account
   * that still has access stop automatic syncs until Sync now.
   *
   * With `auto`, and a service that has watchVersions, the page also listens to the version document
   * while automatic syncs may run, and state.live says so. A snapshot from Firebase's servers whose
   * counters are higher than the ones this device remembers syncs LIVE_DELAY later, which reads only
   * the buckets that changed. This device's own writes come back with the counters it just
   * remembered, so they sync nothing. A snapshot that comes while a step runs is checked once the
   * step ends, against the counters that step saved. See updateLive for when the listener runs.
   */
  function startSync(store, { config, service, loadService = firebaseService, auto = null } = {}) {
    const listeners = new Set();
    let active = null;
    const signedOut = { user: null, access: null, people: [] };
    let state = {
      phase: 'off',
      ...signedOut,
      problem: null,
      syncedAt: store.getPref('syncedAt', null),
      offline: Boolean(auto) && !auto.online(),
      waiting: false,
      live: false,
    };
    const busy = () => !['off', 'starting', 'unavailable', 'signedOut', 'idle'].includes(state.phase);

    function set(patch) {
      state = { ...state, ...patch };
      updateLive();
      if (state.live !== Boolean(unwatch)) state = { ...state, live: Boolean(unwatch) };
      listeners.forEach((listener) => listener(state));
    }

    // Changes this device makes count towards state.waiting. Taking in a sync's merged state doesn't.
    let applying = false;
    let changes = 0;
    const syncStore = {
      syncState: () => store.syncState(),
      applySyncState(theirs) {
        applying = true;
        try {
          store.applySyncState(theirs);
        } finally {
          applying = false;
        }
      },
      getPref: (key, fallback) => store.getPref(key, fallback),
      setPref: (key, value) => store.setPref(key, value),
    };

    // Runs one step for the signed-in account, starting in `phase`, and settles back to idle. Returns
    // the error, if any.
    async function run(phase, step) {
      if (!active || !state.user || busy()) return undefined;
      set({ phase, problem: null });
      let failed = null;
      try {
        await step();
        set({ phase: state.user ? 'idle' : 'signedOut' });
      } catch (error) {
        failed = error || new Error('Sync failed');
        set({ phase: state.user ? 'idle' : 'signedOut', problem: problemOf(error) });
      }
      failedLast = Boolean(failed);
      settled();
      return failed;
    }

    let lastSynced = 0;
    let failedLast = false; // the last step failed
    async function syncStep() {
      const seen = changes;
      set({ phase: 'syncing' });
      await syncOnce(syncStore, active, state.user.id);
      const syncedAt = new Date().toISOString();
      store.setPref('syncedAt', syncedAt);
      lastSynced = auto ? auto.now() : 0;
      liveBroken = false;
      set({ syncedAt, waiting: state.waiting && changes !== seen });
    }

    // Checks the account's access, then syncs if it may and `andSync` is set.
    const refresh = (andSync) => run('checking', async () => {
      const found = await accessOf(active);
      const syncs = andSync && SYNCS.has(found.access);
      set({ ...found });
      if (syncs) await syncStep();
    });

    // ---- Automatic syncing ----
    let timer = null;
    let dueAt = 0;
    let again = false; // a sync was due while another step ran
    let failures = 0;
    let stopped = false; // a used-up quota or a collection too big, until Sync now

    const mayAuto = () => Boolean(auto) && Boolean(active) && Boolean(state.user) && SYNCS.has(state.access) && !stopped;

    function cancel() {
      if (timer !== null) auto.clearTimeout(timer);
      timer = null;
    }

    // Stops automatic syncs, and the listener with them, until Sync now.
    function stop() {
      stopped = true;
      cancel();
      set({});
    }

    // Syncs after `delay`, or sooner if one is already due sooner. A change pushes back a sync that
    // another change set, up to CHANGE_MAX_WAIT after the first.
    let byChange = false;
    let firstChange = 0;
    function schedule(delay, change = false) {
      if (!mayAuto()) return;
      const now = auto.now();
      if (change) {
        if (!(timer !== null && byChange)) firstChange = now;
        delay = Math.max(0, Math.min(delay, firstChange + AUTO.CHANGE_MAX_WAIT - now));
      }
      const at = now + delay;
      if (timer !== null && dueAt <= at && !(change && byChange)) return;
      cancel();
      dueAt = at;
      byChange = change;
      timer = auto.setTimeout(() => {
        timer = null;
        autoSync();
      }, delay);
    }

    async function autoSync() {
      if (!mayAuto() || !auto.online()) return;
      if (busy()) {
        again = true;
        return;
      }
      const error = await run('syncing', syncStep);
      if (error === undefined) return;
      if (!error) {
        failures = 0;
        return;
      }
      const code = error.code;
      if (code === 'resource-exhausted' || code === 'record-catalog/too-big') {
        stop();
      } else if (code === 'permission-denied') {
        await recheck(state.problem);
      } else {
        schedule(AUTO.RETRY[Math.min(failures, AUTO.RETRY.length - 1)]);
        failures += 1;
      }
    }

    // Access may have been removed. Checking costs a read or two, and a removed account stops here.
    // An account that still has access was refused by the rules, such as rules not yet updated for
    // this version of the app, so the problem stays and automatic syncs stop until Sync now.
    async function recheck(problem) {
      await refresh(false);
      if (SYNCS.has(state.access)) {
        stop();
        if (!state.problem) set({ problem });
      }
    }

    function settled() {
      if (again) {
        again = false;
        schedule(0);
      }
      check();
    }

    // ---- Live updates ----
    let unwatch = null; // stops the listener
    let watching = null; // the account it listens for
    let latest = null; // the counters in the last snapshot from Firebase's servers
    let liveBroken = false; // the listener failed, until the next sync, view or reconnect
    let hidden = Boolean(auto) && typeof auto.visible === 'function' && !auto.visible();
    let hideTimer = null;
    let signingOut = false;

    const canLive = () => Boolean(auto) && Boolean(active) && typeof active.watchVersions === 'function';

    /*
     * Starts or stops the listener to match the state. It runs while automatic syncs may run: signed in,
     * with access, and not stopped by a used-up quota or refusal. So signing out, losing access, a
     * used-up quota and enabled: false all stop it. It also stops once the page has been hidden for
     * HIDDEN_GRACE: a hidden page would pay a read for every change another device makes, and starting
     * the listener again on return costs one read, the same as the sync that coming back made before.
     * It keeps running while offline, since Firebase picks it up again by itself on reconnecting.
     */
    function updateLive() {
      const want = canLive() && mayAuto() && !hidden && !liveBroken && !signingOut ? state.user.id : null;
      if (watching === want) return;
      if (unwatch) {
        const stopListening = unwatch;
        unwatch = null;
        watching = null;
        latest = null;
        stopListening();
      }
      if (!want) return;
      watching = want;
      const mine = () => watching === want;
      const listener = active.watchVersions((versions, meta = {}) => {
        if (!mine() || meta.fromCache || meta.hasPendingWrites) return;
        latest = versions;
        check();
      }, (error) => {
        if (!mine()) return;
        unwatch = null;
        watching = null;
        latest = null;
        liveFailed(error || new Error('Live updates failed'));
      });
      if (mine()) unwatch = listener;
    }

    // Firebase ends a listener that fails. A used-up quota stops automatic syncs, as it does for a
    // sync, and a refusal checks access again. Otherwise the listener waits for the next successful
    // sync, the page coming back into view or the browser coming back online, so a failing listener
    // can't start again in a loop.
    function liveFailed(error) {
      liveBroken = true;
      const code = error.code;
      if (code === 'resource-exhausted') {
        stopped = true;
        cancel();
        set({ problem: problemOf(error) });
      } else if (code === 'permission-denied' && !busy()) {
        recheck(problemOf(error));
      } else {
        set({});
      }
    }

    // Whether the counters in `versions` show a write this device hasn't seen.
    function newer(versions) {
      const memory = memoryOf(store, state.user.id);
      if (!memory) return true;
      return BUCKETS.some((id) => Number.isInteger(versions[id]) && versions[id] > memory.counters[id]);
    }

    // Syncs soon when the last snapshot shows another device's write. While a step runs, this waits
    // for settled(), which checks again against the counters the step saved. After a failed step,
    // the retry, view or reconnect that comes next picks the change up, so snapshots don't cut the
    // backoff short.
    function check() {
      if (!latest || !mayAuto() || busy() || failedLast) return;
      if (newer(latest)) schedule(AUTO.LIVE_DELAY);
    }

    if (auto) {
      store.onChange(() => {
        if (applying || !state.user || !SYNCS.has(state.access)) return;
        changes += 1;
        if (!state.waiting) set({ waiting: true });
        schedule(AUTO.CHANGE_DELAY, true);
      });
      auto.onOnline(() => {
        failures = 0;
        liveBroken = false;
        set({ offline: false });
        // An access check that couldn't run offline runs now, and syncs if the account may. A running
        // listener catches up by itself, so only changes made here need a sync.
        if (state.user && !state.access && !busy()) refresh(true);
        else if (!unwatch || state.waiting || failedLast) schedule(0);
      });
      auto.onOffline(() => set({ offline: true }));
      auto.onVisible(() => {
        if (hideTimer !== null) auto.clearTimeout(hideTimer);
        hideTimer = null;
        hidden = false;
        liveBroken = false;
        set({});
        // A listener that is running, or starting again, brings what other devices changed: its first
        // snapshot is checked like any other. Only changes made here need a sync.
        if (unwatch) {
          if (state.waiting || failedLast) schedule(0);
        } else if (auto.now() - lastSynced >= AUTO.VISIBLE_GAP || state.waiting) {
          schedule(0);
        }
      });
      if (typeof auto.onHidden === 'function') {
        auto.onHidden(() => {
          if (hideTimer !== null) return;
          hideTimer = auto.setTimeout(() => {
            hideTimer = null;
            hidden = true;
            set({});
          }, AUTO.HIDDEN_GRACE);
        });
      }
    }

    // A session Firebase restores when the page opens gets its access checked, and syncs when it may
    // and syncing is automatic.
    function use(found) {
      active = found;
      active.watchUser((user) => {
        const same = (user && user.id) === (state.user && state.user.id);
        if (busy()) set({ user });
        else if (!user) {
          cancel();
          set({ ...signedOut, phase: 'signedOut', waiting: false });
        } else if (!same || !state.access) {
          set({ ...signedOut, user, phase: 'idle' });
          refresh(Boolean(auto) && auto.online());
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

    // Signing out keeps this device's records. It only stops syncing them, and forgets what it last saw.
    // The listener stops first, so Firebase never holds one for an account that has signed out.
    async function signOut() {
      if (!active || busy()) return;
      signingOut = true;
      set({});
      try {
        await active.signOut();
      } catch (error) {
        signingOut = false;
        set({ problem: problemOf(error) });
        return;
      }
      signingOut = false;
      cancel();
      stopped = false;
      store.setPref('syncedAt', null);
      store.setPref(MEMORY, null);
      set({ ...signedOut, phase: 'signedOut', syncedAt: null, problem: null, waiting: false });
    }

    // Sync now checks access too, and starts automatic syncs again after a used-up quota.
    async function syncNow() {
      stopped = false;
      failures = 0;
      liveBroken = false;
      cancel();
      await refresh(true);
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
      syncNow,
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
    hashText,
    VERSIONS,
    MEMORY,
    STATE_LIMIT,
    DECISIONS,
    AUTO,
    browserEnvironment,
    isConfigured,
    firebaseService,
    startSync,
  };
});
