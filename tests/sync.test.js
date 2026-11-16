const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/store.js');
const Sync = require('../js/sync.js');

const OWNER = { id: 'account-1', email: 'owner@example.com' };
const PLACEHOLDERS = { apiKey: 'PASTE_API_KEY_HERE', authDomain: 'PASTE_PROJECT_ID_HERE.firebaseapp.com', projectId: 'PASTE_PROJECT_ID_HERE', appId: 'PASTE_APP_ID_HERE' };
const titles = (store) => store.all().map((record) => record.title).sort();

// One device's view of a sync service that keeps its buckets in memory. Devices given the same
// buckets share them. `writes` lists the buckets each sync wrote.
function memoryService(buckets = new Map()) {
  const service = {
    buckets,
    writes: [],
    user: null,
    failExchange: null,
    failSignIn: null,
    watchUser(callback) {
      service.notify = callback;
      callback(service.user);
    },
    async signIn() {
      if (service.failSignIn) throw service.failSignIn;
      service.user = OWNER;
      return OWNER;
    },
    async signOut() {
      service.user = null;
    },
    async exchange(change) {
      if (service.failExchange) throw service.failExchange;
      const writes = change(new Map(buckets));
      service.writes.push([...writes.keys()]);
      for (const [id, text] of writes) buckets.set(id, text);
    },
  };
  return service;
}

const firebaseError = (code) => Object.assign(new Error(`Firebase: ${code}`), { code });

test('every device puts an entry in the same bucket', () => {
  // Expected buckets from an FNV-1a written separately in Python.
  assert.deepEqual(['records:aja', 'wishlist:w1', 'confirmed:rg-a:deluxe', 'records:'].map(Sync.bucketOf), ['9', '4', 'e', '5']);
  const used = new Set(Array.from({ length: 1000 }, (_, i) => Sync.bucketOf(`records:${i}`)));
  assert.equal(used.size, 16);
});

test('a sync state split into buckets and put back together is the same state', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const store = S.createStore(S.memoryStorage());
  store.addMany(Array.from({ length: 3000 }, (_, i) => ({ id: `r${i}`, artist: `Artist ${i % 400}`, title: `Album ${i}`, notes: 'Signed; 2 copies', releaseGroupId: `rg-${i}` })));
  store.addToWishlist({ artist: 'Can', title: 'Tago Mago' });
  store.addToWishlist({ id: '__proto__', artist: 'Can', title: 'Future Days' });
  store.confirmVinyl('__proto__');
  store.confirmVinyl('rg-a');
  store.confirmVinyl('rg-b');
  store.unconfirmVinyl('rg-b');
  store.remove('r1');
  const state = store.syncState();

  const buckets = Sync.splitState(state);
  assert.deepEqual([...buckets.keys()], Sync.BUCKETS);
  assert.ok(Math.max(...[...buckets.values()].map((text) => text.length)) < 1024 * 1024, 'each bucket fits in one Firestore document');
  // The order of a list doesn't matter, since a merge sorts it. A plain comparison keeps a failure from diffing 3,000 records.
  const sorted = (value) => {
    const read = S.readSyncState(value);
    for (const list of ['records', 'wishlist']) read[list].sort((a, b) => (a.id < b.id ? -1 : 1));
    return JSON.stringify(read);
  };
  assert.ok(sorted(Sync.joinBuckets(buckets.values())) === sorted(state), 'the same records, wishes, confirmations and deletions');
});

test('putting buckets together leaves out text that is not a bucket', () => {
  const good = Sync.splitState({ records: [{ id: 'aja', artist: 'Steely Dan', title: 'Aja', addedAt: '2026-01-01T00:00:00.000Z' }], wishlist: [], confirmed: {}, deleted: { records: {}, wishlist: {}, confirmed: {} } });
  const joined = S.readSyncState(Sync.joinBuckets([null, 'not json', 'null', '[1]', '{"records":"x","confirmed":"abc","deleted":5}', ...good.values()]));
  assert.deepEqual(joined.records.map((record) => record.title), ['Aja']);
  assert.deepEqual(joined.confirmed, {});
});

test('two devices that sync through the service end up with the same collection', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const buckets = new Map();
  const pc = S.createStore(S.memoryStorage());
  const phone = S.createStore(S.memoryStorage());
  const pcService = memoryService(buckets);
  const phoneService = memoryService(buckets);
  pc.add({ artist: 'Steely Dan', title: 'Aja' });
  pc.add({ artist: 'Steely Dan', title: 'Gaucho' });
  phone.add({ artist: 'Can', title: 'Tago Mago' });

  return (async () => {
    await Sync.syncOnce(pc, pcService);
    await Sync.syncOnce(phone, phoneService);
    await Sync.syncOnce(pc, pcService);
    assert.deepEqual(titles(pc), ['Aja', 'Gaucho', 'Tago Mago']);
    assert.deepEqual(phone.all(), pc.all());

    t.mock.timers.setTime(Date.parse('2026-02-01T00:00:00Z'));
    phone.remove(phone.all().find((record) => record.title === 'Gaucho').id);
    await Sync.syncOnce(phone, phoneService);
    await Sync.syncOnce(pc, pcService);
    assert.deepEqual(titles(pc), ['Aja', 'Tago Mago']);

    await Sync.syncOnce(pc, pcService);
    assert.deepEqual(pcService.writes.at(-1), [], 'a sync with nothing new writes no buckets');
  })();
});

test('sync is set up only when every value Firebase needs is filled in', () => {
  const filled = { apiKey: 'AIza-example', authDomain: 'example.firebaseapp.com', projectId: 'example', appId: '1:2:web:3' };
  assert.equal(Sync.isConfigured(filled), true);
  assert.equal(Sync.isConfigured(PLACEHOLDERS), false);
  assert.equal(Sync.isConfigured({ ...filled, appId: 'PASTE_APP_ID_HERE' }), false);
  assert.equal(Sync.isConfigured({ ...filled, appId: '' }), false);
  assert.equal(Sync.isConfigured({ apiKey: filled.apiKey }), false);
  assert.equal(Sync.isConfigured(undefined), false);
});

test('sync stays off and loads nothing until it is set up', () => {
  let loaded = false;
  const sync = Sync.startSync(S.createStore(S.memoryStorage()), { config: PLACEHOLDERS, loadService: () => { loaded = true; } });
  assert.equal(sync.state.phase, 'off');
  assert.equal(loaded, false);
});

test('sync is unavailable when Firebase code does not load', async () => {
  const filled = { apiKey: 'a', authDomain: 'b', projectId: 'c', appId: 'd' };
  const sync = Sync.startSync(S.createStore(S.memoryStorage()), { config: filled, loadService: () => Promise.reject(new TypeError('Failed to fetch')) });
  assert.equal(sync.state.phase, 'starting');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sync.state.phase, 'unavailable');
});

test('signing in syncs right away and remembers when, until you sign out', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-03-01T00:00:00Z') });
  const buckets = new Map();
  const pc = S.createStore(S.memoryStorage());
  pc.add({ artist: 'Steely Dan', title: 'Aja' });
  await Sync.syncOnce(pc, memoryService(buckets));

  const storage = S.memoryStorage();
  const phone = S.createStore(storage);
  phone.add({ artist: 'Can', title: 'Tago Mago' });
  const sync = Sync.startSync(phone, { service: memoryService(buckets) });
  const phases = [];
  sync.onChange((state) => phases.push(state.phase));
  assert.equal(sync.state.phase, 'signedOut');

  await sync.signIn();
  assert.deepEqual(phases, ['signingIn', 'idle', 'syncing', 'idle']);
  assert.deepEqual(sync.state.user, OWNER);
  assert.equal(sync.state.syncedAt, '2026-03-01T00:00:00.000Z');
  assert.deepEqual(titles(phone), ['Aja', 'Tago Mago']);
  assert.equal(S.createStore(storage).getPref('syncedAt'), '2026-03-01T00:00:00.000Z');

  await sync.signOut();
  assert.equal(sync.state.phase, 'signedOut');
  assert.equal(sync.state.syncedAt, null);
  assert.deepEqual(titles(phone), ['Aja', 'Tago Mago'], 'signing out keeps the records');
});

test('a sync problem says what went wrong, from the Firebase error code', async () => {
  const service = memoryService();
  const sync = Sync.startSync(S.createStore(S.memoryStorage()), { service });

  service.failSignIn = firebaseError('auth/popup-closed-by-user');
  await sync.signIn();
  assert.deepEqual([sync.state.phase, sync.state.problem], ['signedOut', null], 'closing the sign-in window is not a problem');

  service.failSignIn = firebaseError('auth/unauthorized-domain');
  await sync.signIn();
  assert.equal(sync.state.problem.kind, 'domainNotAuthorized');

  service.failSignIn = null;
  service.failExchange = firebaseError('permission-denied');
  await sync.signIn();
  assert.deepEqual([sync.state.phase, sync.state.problem.kind], ['idle', 'notAllowed']);

  service.failExchange = firebaseError('unavailable');
  await sync.syncNow();
  assert.equal(sync.state.problem.kind, 'offline');

  service.failExchange = firebaseError('toString');
  await sync.syncNow();
  assert.deepEqual(sync.state.problem, { kind: 'failed', message: 'Firebase: toString' });

  service.failExchange = null;
  await sync.syncNow();
  assert.equal(sync.state.problem, null);
});
