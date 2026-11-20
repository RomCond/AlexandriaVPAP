const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/store.js');
const Sync = require('../js/sync.js');

const OWNER = { id: 'account-1', name: 'Site Owner', email: 'owner@example.com' };
const ANA = { id: 'account-2', name: 'Ana', email: 'ana@example.com' };
const BEN = { id: 'account-3', name: 'Ben', email: 'ben@example.com' };
const PLACEHOLDERS = { apiKey: 'PASTE_API_KEY_HERE', authDomain: 'PASTE_PROJECT_ID_HERE.firebaseapp.com', projectId: 'PASTE_PROJECT_ID_HERE', appId: 'PASTE_APP_ID_HERE' };
const titles = (store) => store.all().map((record) => record.title).sort();

const firebaseError = (code) => Object.assign(new Error(`Firebase: ${code}`), { code });

// What a Firebase project holds: each account's buckets and the access records. The owner is OWNER,
// as the rules would name it.
function memoryServer() {
  const buckets = new Map();
  return { access: new Map(), bucketsOf: (id) => buckets.get(id) || buckets.set(id, new Map()).get(id) };
}

// One device's view of a sync service, signed in as `account` once signIn runs. Devices given the same
// server share it, and it refuses what firestore.rules refuses. `writes` lists the buckets each sync wrote.
function memoryService({ account = OWNER, server = memoryServer() } = {}) {
  const deny = () => {
    throw firebaseError('permission-denied');
  };
  const isOwner = () => service.user && service.user.id === OWNER.id;
  const mine = () => server.access.get(service.user.id);
  const moves = { pending: ['approved', 'denied'], approved: ['denied'] };
  const service = {
    server,
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
      service.user = account;
      return account;
    },
    async signOut() {
      service.user = null;
    },
    async exchange(change) {
      if (service.failExchange) throw service.failExchange;
      if (!isOwner() && (mine() || {}).status !== 'approved') deny();
      const buckets = server.bucketsOf(service.user.id);
      const writes = change(new Map(buckets));
      service.writes.push([...writes.keys()]);
      for (const [id, text] of writes) buckets.set(id, text);
    },
    async listAccess() {
      if (!isOwner()) deny();
      return [...server.access.values()].map((record) => ({ ...record }));
    },
    async readAccess() {
      return mine() ? { ...mine() } : null;
    },
    async requestAccess() {
      if (mine()) deny();
      const { id, name, email } = service.user;
      server.access.set(id, { id, name, email, status: 'pending', requestedAt: new Date().toISOString(), decidedAt: null });
    },
    async withdrawAccess() {
      if ((mine() || {}).status !== 'pending') deny();
      server.access.delete(service.user.id);
    },
    async decideAccess(id, status) {
      service.decisions = (service.decisions || 0) + 1;
      const record = server.access.get(id);
      if (!isOwner() || !record || !(moves[record.status] || []).includes(status)) deny();
      server.access.set(id, { ...record, status, decidedAt: new Date().toISOString() });
    },
  };
  return service;
}

// Signs `account` in on a new device with `records`, and returns the device's store and session.
async function device(account, server, records = []) {
  const store = S.createStore(S.memoryStorage());
  for (const [artist, title] of records) store.add({ artist, title });
  const service = memoryService({ account, server });
  const sync = Sync.startSync(store, { service });
  await sync.signIn();
  return { store, service, sync };
}

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
  const server = memoryServer();
  const pc = S.createStore(S.memoryStorage());
  const phone = S.createStore(S.memoryStorage());
  const pcService = memoryService({ server });
  const phoneService = memoryService({ server });
  pcService.user = OWNER;
  phoneService.user = OWNER;
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

test('enabled: false keeps sync off and loads nothing, even when every value is filled in', async () => {
  const filled = { apiKey: 'a', authDomain: 'b', projectId: 'c', appId: 'd' };
  let loaded = false;
  const service = memoryService();
  const off = Sync.startSync(S.createStore(S.memoryStorage()), { config: { ...filled, enabled: false }, service, loadService: () => { loaded = true; } });
  assert.equal(off.state.phase, 'off');
  assert.equal(loaded, false);
  await off.signIn();
  await off.syncNow();
  await off.requestAccess();
  assert.deepEqual([off.state.phase, off.state.user, service.user, service.writes], ['off', null, null, []]);
  const on = Sync.startSync(S.createStore(S.memoryStorage()), { config: { ...filled, enabled: true }, loadService: () => new Promise(() => {}) });
  assert.equal(on.state.phase, 'starting');
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
  const server = memoryServer();
  const pc = S.createStore(S.memoryStorage());
  pc.add({ artist: 'Steely Dan', title: 'Aja' });
  await Sync.syncOnce(pc, Object.assign(memoryService({ server }), { user: OWNER }));

  const storage = S.memoryStorage();
  const phone = S.createStore(storage);
  phone.add({ artist: 'Can', title: 'Tago Mago' });
  const sync = Sync.startSync(phone, { service: memoryService({ server }) });
  const phases = [];
  sync.onChange((state) => phases.push(state.phase));
  assert.equal(sync.state.phase, 'signedOut');

  await sync.signIn();
  assert.deepEqual(phases.filter((phase, i) => phase !== phases[i - 1]), ['signingIn', 'idle', 'checking', 'syncing', 'idle']);
  assert.deepEqual(sync.state.user, OWNER);
  assert.equal(sync.state.access, 'owner');
  assert.equal(sync.state.syncedAt, '2026-03-01T00:00:00.000Z');
  assert.deepEqual(titles(phone), ['Aja', 'Tago Mago']);
  assert.equal(S.createStore(storage).getPref('syncedAt'), '2026-03-01T00:00:00.000Z');

  await sync.signOut();
  assert.equal(sync.state.phase, 'signedOut');
  assert.equal(sync.state.syncedAt, null);
  assert.equal(sync.state.access, null);
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

test('a person with no access can ask, waits while pending, and can take the request back', async () => {
  const server = memoryServer();
  const ana = await device(ANA, server, [['Can', 'Tago Mago']]);
  assert.deepEqual([ana.sync.state.phase, ana.sync.state.access, ana.sync.state.problem], ['idle', 'none', null]);
  assert.deepEqual(ana.service.writes, [], 'nothing syncs without access');

  await ana.sync.requestAccess();
  assert.equal(ana.sync.state.access, 'pending');
  const asked = server.access.get(ANA.id);
  assert.deepEqual(asked, { id: ANA.id, name: 'Ana', email: 'ana@example.com', status: 'pending', requestedAt: asked.requestedAt, decidedAt: null });

  await ana.sync.syncNow();
  assert.deepEqual([ana.sync.state.access, ana.sync.state.problem, ana.service.writes], ['pending', null, []]);

  await ana.sync.withdrawAccess();
  assert.equal(ana.sync.state.access, 'none');
  assert.equal(server.access.has(ANA.id), false);
});

test('the owner approves, denies and removes people, and an approved person syncs their own collection', async () => {
  const server = memoryServer();
  const ana = await device(ANA, server, [['Can', 'Tago Mago']]);
  const ben = await device(BEN, server, [['Neu!', 'Neu! 75']]);
  await ana.sync.requestAccess();
  await ben.sync.requestAccess();
  const owner = await device(OWNER, server, [['Steely Dan', 'Aja']]);
  const people = () => owner.sync.state.people.map((p) => [p.name, p.status]).sort();
  assert.equal(owner.sync.state.access, 'owner');
  assert.deepEqual(people(), [['Ana', 'pending'], ['Ben', 'pending']]);

  await owner.sync.decide(ANA.id, 'approved');
  await owner.sync.decide(BEN.id, 'denied');
  assert.deepEqual(people(), [['Ana', 'approved'], ['Ben', 'denied']]);
  assert.equal(owner.sync.state.problem, null);

  await ana.sync.syncNow();
  await ben.sync.syncNow();
  assert.deepEqual([ana.sync.state.access, ben.sync.state.access], ['approved', 'denied']);
  assert.notEqual(ana.sync.state.syncedAt, null);
  assert.deepEqual(ben.service.writes, []);

  const anaPhone = S.createStore(S.memoryStorage());
  await Sync.startSync(anaPhone, { service: memoryService({ account: ANA, server }) }).signIn();
  assert.deepEqual(titles(anaPhone), ['Tago Mago'], "Ana gets her own collection, not the owner's");
  await owner.sync.syncNow();
  assert.deepEqual(titles(owner.store), ['Aja'], 'the owner gets only their own collection');

  await owner.sync.decide(ANA.id, 'denied');
  assert.equal(server.access.get(ANA.id).status, 'denied');
  ana.store.add({ artist: 'Faust', title: 'IV' });
  await ana.sync.syncNow();
  assert.deepEqual([ana.sync.state.access, ana.sync.state.problem], ['denied', null]);
  assert.equal(server.bucketsOf(ANA.id).size > 0, true);
  assert.equal([...server.bucketsOf(ANA.id).values()].some((text) => text.includes('Faust')), false, 'a removed person syncs nothing more');
  assert.deepEqual(titles(ana.store), ['IV', 'Tago Mago'], 'and keeps the records on their device');
});

test('the owner makes only the moves the rules allow', async () => {
  const server = memoryServer();
  const ana = await device(ANA, server);
  await ana.sync.requestAccess();
  const owner = await device(OWNER, server);
  await owner.sync.decide(ANA.id, 'denied');
  await owner.sync.decide(ANA.id, 'approved');
  await owner.sync.decide(ANA.id, 'pending');
  await owner.sync.decide('nobody', 'approved');
  assert.equal(owner.service.decisions, 1);
  assert.equal(server.access.get(ANA.id).status, 'denied');
  assert.equal(owner.sync.state.problem, null);
});

test('a guest never gets the list of requests or decides on one', async () => {
  const server = memoryServer();
  const ana = await device(ANA, server);
  await ana.sync.requestAccess();
  const ben = await device(BEN, server);
  await ben.sync.requestAccess();
  server.access.set(BEN.id, { ...server.access.get(BEN.id), status: 'approved' });
  await ben.sync.syncNow();
  assert.deepEqual([ben.sync.state.access, ben.sync.state.people], ['approved', []]);
  await ben.sync.decide(ANA.id, 'approved');
  assert.equal(ben.service.decisions, undefined);
  assert.equal(server.access.get(ANA.id).status, 'pending');
});

test('a session restored when the page opens checks access without syncing', async () => {
  const server = memoryServer();
  server.access.set(ANA.id, { id: ANA.id, name: 'Ana', email: 'ana@example.com', status: 'approved', requestedAt: null, decidedAt: null });
  const service = memoryService({ account: ANA, server });
  service.user = ANA;
  const sync = Sync.startSync(S.createStore(S.memoryStorage()), { service });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([sync.state.phase, sync.state.access, service.writes], ['idle', 'approved', []]);

  service.user = null;
  service.notify(null);
  assert.deepEqual([sync.state.phase, sync.state.access], ['signedOut', null]);
});

test('a used-up free quota and a collection too big to sync each say so', async () => {
  const owner = await device(OWNER, memoryServer());
  owner.service.failExchange = firebaseError('resource-exhausted');
  await owner.sync.syncNow();
  assert.equal(owner.sync.state.problem.kind, 'quotaReached');

  owner.service.failExchange = null;
  owner.store.addMany(Array.from({ length: 40 }, (_, i) => ({ artist: 'A', title: `T${i}`, notes: 'n'.repeat(Sync.STATE_LIMIT / 2) })));
  const before = owner.service.writes.length;
  await owner.sync.syncNow();
  assert.equal(owner.sync.state.problem.kind, 'tooBig');
  assert.equal(owner.service.writes.length, before, 'nothing is written');
});

test('when Firebase refuses the access check, the account has no access and the problem shows', async () => {
  const service = memoryService({ account: ANA });
  service.readAccess = async () => {
    throw firebaseError('permission-denied');
  };
  const sync = Sync.startSync(S.createStore(S.memoryStorage()), { service });
  await sync.signIn();
  assert.deepEqual([sync.state.phase, sync.state.access, sync.state.problem.kind], ['idle', null, 'notAllowed']);
});
