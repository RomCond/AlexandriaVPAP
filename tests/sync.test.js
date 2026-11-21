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

// What a Firebase project holds: each account's buckets, as { state, version }, its version document,
// and the access records. The owner is OWNER, as the rules would name it.
function memoryServer() {
  const buckets = new Map();
  const versions = new Map();
  return {
    access: new Map(),
    bucketsOf: (id) => buckets.get(id) || buckets.set(id, new Map()).get(id),
    versionsOf: (id) => versions.get(id) || null,
    setVersions: (id, value) => (value ? versions.set(id, value) : versions.delete(id)),
  };
}

// What firestore.rules checks when a transaction writes `buckets` and `next` over what `held` and
// `versions` hold: each bucket's counter rises and matches the version document written with it, and
// the version document has 16 whole counters that never go down.
function rulesAllow(held, versions, buckets, next) {
  const after = next || versions;
  const counters = (value) => value && Object.keys(value).length === 16 && Sync.BUCKETS.every((id) => Number.isInteger(value[id]) && value[id] >= 0);
  if (next && (!counters(next) || (versions && Sync.BUCKETS.some((id) => next[id] < versions[id])))) return false;
  for (const [id, data] of buckets) {
    const before = held.get(id);
    const keys = Object.keys(data).sort().join();
    if (!Sync.BUCKETS.includes(id) || keys !== 'state,version' || typeof data.state !== 'string' || data.state.length > Sync.STATE_LIMIT) return false;
    if (!Number.isInteger(data.version) || data.version <= ((before && before.version) || 0)) return false;
    if (!after || after[id] !== data.version) return false;
  }
  return true;
}

// One device's view of a sync service, signed in as `account` once signIn runs. Devices given the same
// server share it, and it refuses what firestore.rules refuses. `writes` lists the buckets each sync
// wrote, and `reads` how many documents each sync read.
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
    reads: [],
    user: null,
    failExchange: null,
    failSignIn: null,
    // Runs between the reads and the writes of the next exchange, as another device writing would.
    beforeCommit: null,
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
    // A transaction: it runs again when the documents it read changed before it commits.
    async exchange(plan) {
      if (service.failExchange) throw service.failExchange;
      if (!isOwner() && (mine() || {}).status !== 'approved') deny();
      const held = server.bucketsOf(service.user.id);
      for (;;) {
        const versions = server.versionsOf(service.user.id);
        const ids = plan.need(versions && { ...versions });
        const seen = new Map(ids.map((id) => [id, held.get(id) || null]));
        const stored = new Map([...seen].map(([id, bucket]) => [id, bucket && { ...bucket }]));
        const { buckets, versions: next } = plan.change(versions && { ...versions }, stored);
        if (service.beforeCommit) {
          const run = service.beforeCommit;
          service.beforeCommit = null;
          await run();
        }
        const moved = server.versionsOf(service.user.id) !== versions || [...seen].some(([id, bucket]) => (held.get(id) || null) !== bucket);
        if (moved) continue;
        if (!rulesAllow(held, versions, buckets, next)) deny();
        service.reads.push(1 + ids.length);
        service.writes.push([...buckets.keys()]);
        for (const [id, bucket] of buckets) held.set(id, { ...bucket });
        if (next) server.setVersions(service.user.id, { ...next });
        return;
      }
    },
    // A write from the app before counters existed: buckets alone, as { state }.
    async oldExchange(change) {
      const held = server.bucketsOf(service.user.id);
      const writes = change(new Map([...held].map(([id, bucket]) => [id, bucket.state])));
      const buckets = new Map([...writes].map(([id, state]) => [id, { state }]));
      if (!rulesAllow(held, server.versionsOf(service.user.id), buckets, null)) deny();
      for (const [id, bucket] of buckets) held.set(id, bucket);
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
  assert.equal([...server.bucketsOf(ANA.id).values()].some((bucket) => bucket.state.includes('Faust')), false, 'a removed person syncs nothing more');
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

// ---- Counters: a sync reads only what changed ----

// Record ids whose entries land in the bucket `id`, or in different buckets when `id` is null.
function idsIn(id, count) {
  const found = [];
  for (let i = 0; found.length < count; i++) {
    const bucket = Sync.bucketOf(`records:r${i}`);
    if (id ? bucket === id : !found.some((other) => Sync.bucketOf(`records:${other}`) === bucket)) found.push(`r${i}`);
  }
  return found;
}

// Two signed-in devices of OWNER that share a server, each with a store, and syncs that return
// [reads, buckets written].
function twoDevices() {
  const server = memoryServer();
  const make = () => {
    const store = S.createStore(S.memoryStorage());
    const service = Object.assign(memoryService({ server }), { user: OWNER });
    const sync = async () => {
      await Sync.syncOnce(store, service, OWNER.id);
      return [service.reads.at(-1), service.writes.at(-1).length];
    };
    return { store, service, sync };
  };
  return { server, pc: make(), phone: make() };
}

const stateOf = (store) => JSON.stringify(S.mergeSyncStates(store.syncState(), S.readSyncState({})));
const serverState = (server, id = OWNER.id) => JSON.stringify(S.mergeSyncStates(S.readSyncState(Sync.joinBuckets([...server.bucketsOf(id).values()].map((b) => b.state))), S.readSyncState({})));

test('a sync reads the version document, then only the buckets that changed on either side', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-04-01T00:00:00Z') });
  const { server, pc, phone } = twoDevices();
  const [a, b, c] = idsIn(null, 3);
  pc.store.addMany([{ id: a, artist: 'Steely Dan', title: 'Aja' }, { id: b, artist: 'Can', title: 'Tago Mago' }]);
  assert.deepEqual(await pc.sync(), [17, 2], 'a new device reads the version document and all 16 buckets');
  assert.deepEqual(await phone.sync(), [17, 0], 'and so does a second new device, which has nothing to add');
  assert.deepEqual(await pc.sync(), [1, 0], 'nothing changed: one read');
  assert.deepEqual(await phone.sync(), [1, 0]);

  pc.store.add({ id: c, artist: 'Faust', title: 'IV' });
  assert.deepEqual(await pc.sync(), [2, 1], 'one record added here: its bucket is read and written');
  assert.deepEqual(await phone.sync(), [2, 0], 'one record added on the other device: its bucket is read');
  assert.ok(phone.store.all().some((record) => record.id === c));

  t.mock.timers.setTime(Date.parse('2026-04-02T00:00:00Z'));
  pc.store.remove(a);
  phone.store.update(b, { notes: 'Signed' });
  assert.deepEqual(await pc.sync(), [2, 1]);
  assert.deepEqual(await phone.sync(), [3, 1], 'both changed while apart: both buckets are read, one written');
  assert.deepEqual(await pc.sync(), [2, 0]);
  assert.equal(stateOf(pc.store), stateOf(phone.store));
  assert.equal(serverState(server), stateOf(pc.store));
  assert.deepEqual(server.versionsOf(OWNER.id)[Sync.bucketOf(`records:${b}`)], 2, 'a counter rises once for each write');
  for (const [id, bucket] of server.bucketsOf(OWNER.id)) assert.equal(bucket.version, server.versionsOf(OWNER.id)[id], 'each bucket keeps its own counter');
});

test('two devices that edit the same bucket while apart both keep their edits', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-04-01T00:00:00Z') });
  const { server, pc, phone } = twoDevices();
  const [x, y, z] = idsIn('7', 3);
  pc.store.add({ id: x, artist: 'Neu!', title: 'Neu!' });
  await pc.sync();
  await phone.sync();
  t.mock.timers.setTime(Date.parse('2026-04-02T00:00:00Z'));
  pc.store.add({ id: y, artist: 'Neu!', title: 'Neu! 2' });
  t.mock.timers.setTime(Date.parse('2026-04-03T00:00:00Z'));
  phone.store.add({ id: z, artist: 'Neu!', title: "Neu! '75" });
  phone.store.update(x, { notes: 'First press' });
  assert.deepEqual(await pc.sync(), [2, 1]);
  assert.deepEqual(await phone.sync(), [2, 1], 'the phone reads the bucket the PC wrote, merges, and writes it');
  assert.deepEqual(await pc.sync(), [2, 0]);
  assert.deepEqual(titles(pc.store), ['Neu!', "Neu! '75", 'Neu! 2']);
  assert.equal(pc.store.all().find((record) => record.id === x).notes, 'First press');
  assert.equal(stateOf(pc.store), stateOf(phone.store));
  assert.equal(server.versionsOf(OWNER.id)['7'], 3);
});

test('another device writing during a sync makes it run again with what that device wrote', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-04-01T00:00:00Z') });
  const { pc, phone } = twoDevices();
  const [x, y] = idsIn('3', 2);
  await pc.sync();
  await phone.sync();
  pc.store.add({ id: x, artist: 'Can', title: 'Ege Bamyasi' });
  phone.store.add({ id: y, artist: 'Can', title: 'Soon Over Babaluma' });
  pc.service.beforeCommit = () => phone.sync();
  await pc.sync();
  await phone.sync();
  assert.deepEqual(titles(pc.store), ['Ege Bamyasi', 'Soon Over Babaluma']);
  assert.equal(stateOf(pc.store), stateOf(phone.store));
});

test('a collection synced before counters existed is read in full, and its version document made', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-04-01T00:00:00Z') });
  const { server, pc, phone } = twoDevices();
  const old = S.createStore(S.memoryStorage());
  old.add({ artist: 'Steely Dan', title: 'Aja' });
  old.add({ artist: 'Can', title: 'Tago Mago' });
  for (const [id, state] of Sync.splitState(old.syncState())) if (state !== Sync.splitState(S.readSyncState({})).get(id)) server.bucketsOf(OWNER.id).set(id, { state });
  assert.equal(server.versionsOf(OWNER.id), null);

  assert.deepEqual(await pc.sync(), [17, 0]);
  assert.deepEqual(titles(pc.store), ['Aja', 'Tago Mago']);
  assert.deepEqual(server.versionsOf(OWNER.id), Object.fromEntries(Sync.BUCKETS.map((id) => [id, 0])), 'every counter starts at 0');
  pc.store.add({ artist: 'Faust', title: 'IV' });
  assert.deepEqual(await pc.sync(), [2, 1]);
  assert.deepEqual(await phone.sync(), [17, 0]);
  assert.deepEqual(titles(phone.store), ['Aja', 'IV', 'Tago Mago']);
});

test('a deleted version document is made again from the buckets\' own counters', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-04-01T00:00:00Z') });
  const { server, pc, phone } = twoDevices();
  pc.store.add({ artist: 'Steely Dan', title: 'Aja' });
  await pc.sync();
  pc.store.add({ artist: 'Steely Dan', title: 'Gaucho' });
  await pc.sync();
  await phone.sync();
  const before = server.versionsOf(OWNER.id);
  server.setVersions(OWNER.id, null);

  phone.store.add({ artist: 'Can', title: 'Tago Mago' });
  const [reads] = await phone.sync();
  assert.equal(reads, 17, 'a missing version document means every bucket is read');
  const after = server.versionsOf(OWNER.id);
  for (const id of Sync.BUCKETS) assert.ok(after[id] >= before[id], 'no counter goes back');
  for (const [id, bucket] of server.bucketsOf(OWNER.id)) assert.equal(after[id], bucket.version);
  assert.deepEqual(await pc.sync(), [2, 0], 'the PC still trusts the buckets it saw, and reads the one the phone wrote');
  assert.deepEqual(titles(pc.store), ['Aja', 'Gaucho', 'Tago Mago']);
  assert.deepEqual(await phone.sync(), [1, 0]);
});

test('a write from the app before counters existed is refused, so no device misses it', async () => {
  const { server, pc } = twoDevices();
  pc.store.add({ artist: 'Steely Dan', title: 'Aja' });
  await pc.sync();
  const before = JSON.stringify([...server.bucketsOf(OWNER.id)]);
  const write = (stored) => new Map([[Sync.bucketOf('records:x'), `${stored.get(Sync.bucketOf('records:x')) || ''} `]]);
  await assert.rejects(pc.service.oldExchange(write), { code: 'permission-denied' });
  assert.equal(JSON.stringify([...server.bucketsOf(OWNER.id)]), before);
  server.setVersions(OWNER.id, null);
  await assert.rejects(pc.service.oldExchange(write), { code: 'permission-denied' }, 'with or without a version document');
});

test('a device whose records went missing reads their buckets again, so it never writes over them', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-04-01T00:00:00Z') });
  const { server } = twoDevices();
  const storage = S.memoryStorage();
  const store = S.createStore(storage);
  const service = Object.assign(memoryService({ server }), { user: OWNER });
  store.addMany([{ artist: 'Steely Dan', title: 'Aja' }, { artist: 'Can', title: 'Tago Mago' }, { artist: 'Faust', title: 'IV' }]);
  await Sync.syncOnce(store, service, OWNER.id);
  // The records are lost on this device, and the memory of the last sync stays.
  storage.setItem(S.KEYS.records, '[]');
  const emptied = S.createStore(storage);
  assert.equal(emptied.all().length, 0);
  await Sync.syncOnce(emptied, service, OWNER.id);
  assert.equal(service.reads.at(-1), 4, 'the three buckets that no longer match are read');
  assert.deepEqual(service.writes.at(-1), []);
  assert.deepEqual(titles(emptied), ['Aja', 'IV', 'Tago Mago']);
});

test('a memory from another account is ignored, and signing out forgets it', async () => {
  const server = memoryServer();
  server.access.set(ANA.id, { id: ANA.id, status: 'approved' });
  const storage = S.memoryStorage();
  const store = S.createStore(storage);
  store.add({ artist: 'Can', title: 'Tago Mago' });
  const owner = await device(OWNER, server);
  await owner.sync.syncNow();
  const service = Object.assign(memoryService({ account: ANA, server }), { user: ANA });
  store.setPref(Sync.MEMORY, owner.store.getPref(Sync.MEMORY));
  await Sync.syncOnce(store, service, ANA.id);
  assert.equal(service.reads.at(-1), 17);
  assert.equal(store.getPref(Sync.MEMORY).account, ANA.id);
  await owner.sync.signOut();
  assert.equal(owner.store.getPref(Sync.MEMORY), null);
});

test('devices that sync in any order end up equal to each other and to Firebase', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-05-01T00:00:00Z') });
  // A small fixed-seed generator, so a failure repeats.
  let seed = 7;
  const random = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const server = memoryServer();
  const devices = Array.from({ length: 3 }, () => {
    const store = S.createStore(S.memoryStorage());
    return { store, service: Object.assign(memoryService({ server }), { user: OWNER }) };
  });
  const albums = Array.from({ length: 30 }, (_, i) => ({ artist: `Artist ${i % 7}`, title: `Album ${i}` }));
  for (let step = 0; step < 300; step++) {
    t.mock.timers.setTime(Date.parse('2026-05-01T00:00:00Z') + step * 60000);
    const { store, service } = devices[random(3)];
    const action = random(6);
    const records = store.all();
    const album = albums[random(albums.length)];
    const owned = store.all().some((record) => record.title === album.title);
    if (action === 0 && !owned) store.add(album);
    else if (action === 1 && records.length) store.remove(records[random(records.length)].id);
    else if (action === 2 && records.length) store.update(records[random(records.length)].id, { notes: `n${step}` });
    else if (action === 3 && !owned && !store.wishlist().some((wish) => wish.title === album.title)) store.addToWishlist(album);
    else if (action >= 4) await Sync.syncOnce(store, service, OWNER.id);
  }
  for (let round = 0; round < 2; round++) for (const { store, service } of devices) await Sync.syncOnce(store, service, OWNER.id);
  for (const { store } of devices) assert.equal(stateOf(store), stateOf(devices[0].store));
  assert.equal(serverState(server), stateOf(devices[0].store));
  for (const { store, service } of devices) await Sync.syncOnce(store, service, OWNER.id);
  assert.deepEqual(devices.map(({ service }) => [service.reads.at(-1), service.writes.at(-1).length]), [[1, 0], [1, 0], [1, 0]], 'once all are equal, a sync is one read');
});

// ---- Automatic syncing ----

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

// What startSync's `auto` takes, with a clock that moves only when a test moves it.
function fakeEnvironment() {
  const env = { time: 0, timers: [], isOnline: true, handlers: { online: [], offline: [], visible: [] } };
  Object.assign(env, {
    now: () => env.time,
    setTimeout(fn, ms) {
      const timer = { at: env.time + ms, fn };
      env.timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      env.timers = env.timers.filter((other) => other !== timer);
    },
    online: () => env.isOnline,
    onOnline: (fn) => env.handlers.online.push(fn),
    onOffline: (fn) => env.handlers.offline.push(fn),
    onVisible: (fn) => env.handlers.visible.push(fn),
    fire: async (name) => {
      if (name === 'online') env.isOnline = true;
      if (name === 'offline') env.isOnline = false;
      env.handlers[name].forEach((fn) => fn());
      await settle();
    },
    // Moves the clock on by `ms`, running each timer that comes due.
    async advance(ms) {
      const end = env.time + ms;
      for (;;) {
        const next = env.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        env.time = next.at;
        env.clearTimeout(next);
        next.fn();
        await settle();
      }
      env.time = end;
      await settle();
    },
  });
  return env;
}

// A signed-in device of `account` whose page has just opened, with automatic syncing.
async function autoDevice({ account = OWNER, server = memoryServer(), env = fakeEnvironment() } = {}) {
  const store = S.createStore(S.memoryStorage());
  const service = memoryService({ account, server });
  service.user = account;
  const sync = Sync.startSync(store, { service, auto: env });
  await settle();
  const syncs = () => service.writes.length;
  return { store, service, sync, env, server, syncs };
}

test('with automatic syncing, opening the page syncs once the access check says the account may', async () => {
  const server = memoryServer();
  const owner = await autoDevice({ server });
  assert.deepEqual([owner.sync.state.phase, owner.sync.state.access, owner.syncs()], ['idle', 'owner', 1]);
  assert.notEqual(owner.sync.state.syncedAt, null);

  server.access.set(ANA.id, { id: ANA.id, status: 'pending' });
  const ana = await autoDevice({ account: ANA, server });
  assert.deepEqual([ana.sync.state.access, ana.syncs()], ['pending', 0], 'an account without access only checks');
  ana.store.add({ artist: 'Can', title: 'Tago Mago' });
  await ana.env.advance(60000);
  assert.deepEqual([ana.syncs(), ana.sync.state.waiting], [0, false], 'and changes start nothing');
});

test('changes sync a few seconds after the last edit, once', async () => {
  const device = await autoDevice();
  device.store.add({ artist: 'Steely Dan', title: 'Aja' });
  assert.equal(device.sync.state.waiting, true);
  await device.env.advance(3000);
  device.store.add({ artist: 'Steely Dan', title: 'Gaucho' });
  await device.env.advance(Sync.AUTO.CHANGE_DELAY - 1);
  assert.equal(device.syncs(), 1, 'the second edit pushed the sync back');
  await device.env.advance(1);
  assert.deepEqual([device.syncs(), device.sync.state.waiting], [2, false]);
  assert.deepEqual(device.service.writes.at(-1).length > 0, true);
  await device.env.advance(10 * 60000);
  assert.equal(device.syncs(), 2, "taking in a sync's merged state starts no further sync");
});

test('a change made while a sync runs syncs again once it ends', async () => {
  const device = await autoDevice();
  device.service.beforeCommit = () => device.store.add({ artist: 'Can', title: 'Future Days' });
  device.store.add({ artist: 'Can', title: 'Tago Mago' });
  await device.env.advance(Sync.AUTO.CHANGE_DELAY);
  assert.equal(device.syncs(), 2);
  assert.equal(device.sync.state.waiting, true, 'the change made during the sync is still waiting');
  await device.env.advance(Sync.AUTO.CHANGE_DELAY);
  assert.deepEqual([device.syncs(), device.sync.state.waiting], [3, false]);
  assert.ok([...device.server.bucketsOf(OWNER.id).values()].some((bucket) => bucket.state.includes('Future Days')));
});

test('a timer that comes due during another step waits for it, then syncs', async () => {
  const device = await autoDevice();
  let release;
  device.service.listAccess = () => new Promise((resolve) => {
    release = () => resolve([]);
  });
  const check = device.sync.syncNow();
  await settle();
  assert.equal(device.sync.state.phase, 'checking');
  device.store.add({ artist: 'Can', title: 'Tago Mago' });
  await device.env.advance(Sync.AUTO.CHANGE_DELAY);
  assert.equal(device.syncs(), 1, 'nothing runs alongside the check');
  release();
  await check;
  await device.env.advance(0);
  assert.deepEqual([device.syncs(), device.sync.state.waiting], [3, false], 'Sync now syncs, then the waiting sync runs');
});

test('nothing syncs while offline, and changes sync once back online', async () => {
  const env = fakeEnvironment();
  env.isOnline = false;
  const device = await autoDevice({ env });
  assert.deepEqual([device.sync.state.offline, device.sync.state.access, device.syncs()], [true, 'owner', 0], 'opening offline checks nothing it cannot reach');
  device.store.add({ artist: 'Steely Dan', title: 'Aja' });
  await env.advance(60000);
  await env.fire('visible');
  assert.deepEqual([device.syncs(), device.sync.state.waiting], [0, true]);
  await env.fire('online');
  await env.advance(0);
  assert.deepEqual([device.syncs(), device.sync.state.offline, device.sync.state.waiting], [1, false, false]);
  await env.fire('offline');
  assert.equal(device.sync.state.offline, true);
});

test('coming back into view syncs, unless a sync just finished', async () => {
  const device = await autoDevice();
  await device.env.advance(Sync.AUTO.VISIBLE_GAP - 1000);
  await device.env.fire('visible');
  assert.equal(device.syncs(), 1, 'synced on opening, too recently to sync again');
  await device.env.advance(1000);
  await device.env.fire('visible');
  await device.env.advance(0);
  assert.equal(device.syncs(), 2);
  for (let i = 0; i < 5; i++) await device.env.fire('visible');
  await device.env.advance(0);
  assert.equal(device.syncs(), 2, 'switching back and forth quickly costs nothing more');
});

test('a failed automatic sync tries again later, waiting longer each time', async () => {
  const device = await autoDevice();
  device.service.failExchange = firebaseError('unavailable');
  device.store.add({ artist: 'Can', title: 'Tago Mago' });
  await device.env.advance(Sync.AUTO.CHANGE_DELAY);
  assert.equal(device.sync.state.problem.kind, 'offline');
  const attempts = [];
  const exchange = device.service.exchange;
  device.service.exchange = (plan) => {
    attempts.push(device.env.now());
    return exchange(plan);
  };
  await device.env.advance(Sync.AUTO.RETRY[0] + Sync.AUTO.RETRY[1] + Sync.AUTO.RETRY[2]);
  const start = Sync.AUTO.CHANGE_DELAY;
  assert.deepEqual(attempts, [start + Sync.AUTO.RETRY[0], start + Sync.AUTO.RETRY[0] + Sync.AUTO.RETRY[1], start + Sync.AUTO.RETRY[0] + Sync.AUTO.RETRY[1] + Sync.AUTO.RETRY[2]]);
  device.service.failExchange = null;
  await device.env.advance(Sync.AUTO.RETRY[3]);
  assert.deepEqual([device.sync.state.problem, device.sync.state.waiting], [null, false]);
  assert.equal(device.syncs(), 2);
});

test('a used-up quota stops automatic syncs until Sync now', async () => {
  const device = await autoDevice();
  device.service.failExchange = firebaseError('resource-exhausted');
  device.store.add({ artist: 'Can', title: 'Tago Mago' });
  await device.env.advance(Sync.AUTO.CHANGE_DELAY);
  assert.equal(device.sync.state.problem.kind, 'quotaReached');
  let tries = 0;
  const exchange = device.service.exchange;
  device.service.exchange = (plan) => {
    tries += 1;
    return exchange(plan);
  };
  device.store.add({ artist: 'Can', title: 'Future Days' });
  await device.env.fire('visible');
  await device.env.fire('online');
  await device.env.advance(24 * 3600000);
  assert.equal(tries, 0, 'no change, view or reconnect tries again');
  assert.equal(device.sync.state.problem.kind, 'quotaReached', 'and the problem stays in view');

  device.service.failExchange = null;
  await device.sync.syncNow();
  assert.deepEqual([tries, device.sync.state.problem, device.sync.state.waiting], [1, null, false]);
  device.store.add({ artist: 'Can', title: 'Soon Over Babaluma' });
  await device.env.advance(Sync.AUTO.CHANGE_DELAY);
  assert.equal(tries, 2, 'after Sync now, changes sync on their own again');
});

test('when an automatic sync is refused, the access is checked again, and a removed account stops', async () => {
  const server = memoryServer();
  server.access.set(ANA.id, { id: ANA.id, status: 'approved' });
  const ana = await autoDevice({ account: ANA, server });
  assert.equal(ana.syncs(), 1);
  server.access.set(ANA.id, { id: ANA.id, status: 'denied' });
  ana.store.add({ artist: 'Can', title: 'Tago Mago' });
  await ana.env.advance(Sync.AUTO.CHANGE_DELAY);
  assert.equal(ana.sync.state.access, 'denied');
  ana.store.add({ artist: 'Can', title: 'Future Days' });
  await ana.env.fire('visible');
  await ana.env.advance(3600000);
  assert.equal(ana.syncs(), 1);
});

test('edits that go on and on still sync within the longest wait', async () => {
  const device = await autoDevice();
  for (let i = 0; i < 20; i++) {
    device.store.add({ artist: 'Artist', title: `Album ${i}` });
    await device.env.advance(Sync.AUTO.CHANGE_DELAY - 1000);
  }
  assert.equal(device.syncs(), 1 + Math.floor((20 * (Sync.AUTO.CHANGE_DELAY - 1000)) / Sync.AUTO.CHANGE_MAX_WAIT));
});

test('an access check that failed offline runs again once back online, then syncs', async () => {
  const env = fakeEnvironment();
  env.isOnline = false;
  const server = memoryServer();
  const store = S.createStore(S.memoryStorage());
  const service = memoryService({ server });
  service.user = OWNER;
  const listAccess = service.listAccess;
  service.listAccess = async () => {
    if (!env.isOnline) throw firebaseError('unavailable');
    return listAccess();
  };
  const sync = Sync.startSync(store, { service, auto: env });
  await settle();
  assert.deepEqual([sync.state.access, sync.state.problem.kind], [null, 'offline']);
  await env.fire('online');
  assert.deepEqual([sync.state.access, sync.state.problem, service.writes.length], ['owner', null, 1]);
});

test('signing out stops automatic syncs', async () => {
  const device = await autoDevice();
  device.store.add({ artist: 'Can', title: 'Tago Mago' });
  await device.sync.signOut();
  await device.env.advance(3600000);
  await device.env.fire('visible');
  assert.deepEqual([device.syncs(), device.sync.state.waiting], [1, false]);
});
