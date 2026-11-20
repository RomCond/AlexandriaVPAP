/*
 * The app's Firebase service and sync session against the Auth and Firestore emulators, under the
 * rules in firestore.rules. Run with `npm run test:rules`. It loads Firebase from npm at the version
 * the app loads from Google's CDN, and signs in with the emulator's stand-in Google accounts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const S = require('../js/store.js');
const Sync = require('../js/sync.js');

const PROJECT = 'demo-record-catalog';
const RULES = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
const accounts = {
  owner: { sub: 'google-owner', name: 'Site Owner', email: 'owner@example.com' },
  ana: { sub: 'google-ana', name: 'Ana', email: 'ana@example.com' },
  ben: { sub: 'google-ben', name: 'Ben', email: 'ben@example.com' },
};

test('the owner approves and removes a guest, through the app\'s own Firebase calls', async () => {
  assert.equal(require('firebase/package.json').version, Sync.FIREBASE_VERSION);
  const load = (name) => import(`firebase/${name}`);
  const [{ getApp }, auth, firestore] = await Promise.all(['app', 'auth', 'firestore'].map(load));
  firestore.setLogLevel('silent');
  const service = await Sync.firebaseService({ apiKey: 'demo-key', authDomain: `${PROJECT}.firebaseapp.com`, projectId: PROJECT, appId: 'demo-app' }, load);
  const session = auth.getAuth(getApp());
  auth.connectAuthEmulator(session, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  firestore.connectFirestoreEmulator(firestore.getFirestore(getApp()), host, Number(port));

  // The emulator takes a stand-in Google token in place of the sign-in window.
  let who = null;
  service.signIn = async () => {
    const credential = auth.GoogleAuthProvider.credential(JSON.stringify({ ...accounts[who], email_verified: true }));
    const { user } = await auth.signInWithCredential(session, credential);
    return { id: user.uid, name: user.displayName, email: user.email };
  };
  const store = S.createStore(S.memoryStorage());
  const sync = Sync.startSync(store, { service });
  const as = async (name) => {
    await sync.signOut();
    who = name;
    await sync.signIn();
    return sync.state;
  };

  const ownerId = (await as('owner')).user.id;
  const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host, port: Number(port), rules: RULES.replace('PASTE_YOUR_ACCOUNT_ID_HERE', ownerId) } });
  await env.clearFirestore();
  // rules-unit-testing works with the CommonJS copy of Firebase, so its reads use that copy too.
  const admin = require('firebase/firestore');
  async function bucketsOf(id) {
    let size;
    await env.withSecurityRulesDisabled(async (context) => {
      size = (await admin.getDocs(admin.collection(context.firestore(), 'users', id, 'sync'))).size;
    });
    return size;
  }

  try {
    store.add({ artist: 'Steely Dan', title: 'Aja' });
    await sync.syncNow();
    assert.deepEqual([sync.state.access, sync.state.people, sync.state.problem], ['owner', [], null]);
    assert.equal(await bucketsOf(ownerId), 1, 'one record fills one bucket');

    const ana = await as('ana');
    const anaId = ana.user.id;
    assert.deepEqual([ana.access, ana.problem, ana.user.name, ana.user.email], ['none', null, 'Ana', 'ana@example.com']);
    await sync.requestAccess();
    assert.deepEqual([sync.state.access, sync.state.problem], ['pending', null]);
    await sync.syncNow();
    assert.deepEqual([sync.state.access, sync.state.problem, await bucketsOf(anaId)], ['pending', null, 0]);
    await assert.rejects(service.exchange(() => new Map()), { code: 'permission-denied' });

    await as('ben');
    await sync.requestAccess();
    assert.equal(sync.state.access, 'pending');
    await sync.withdrawAccess();
    assert.deepEqual([sync.state.access, sync.state.problem], ['none', null]);

    const owner = await as('owner');
    assert.equal(owner.access, 'owner');
    assert.deepEqual(owner.people.map(({ id, name, email, status }) => ({ id, name, email, status })), [{ id: anaId, name: 'Ana', email: 'ana@example.com', status: 'pending' }]);
    assert.ok(Date.parse(owner.people[0].requestedAt) > Date.now() - 60000, 'requestedAt is the server time, as an ISO string');
    await sync.decide(anaId, 'approved');
    assert.deepEqual([sync.state.people[0].status, sync.state.problem], ['approved', null]);

    store.add({ artist: 'Can', title: 'Tago Mago' });
    await as('ana');
    await sync.syncNow();
    assert.deepEqual([sync.state.access, sync.state.problem], ['approved', null]);
    assert.ok((await bucketsOf(anaId)) > 0, 'an approved guest stores a collection');

    await as('owner');
    await sync.decide(anaId, 'denied');
    assert.deepEqual([sync.state.people[0].status, sync.state.problem], ['denied', null]);
    assert.ok(sync.state.people[0].decidedAt);

    await as('ana');
    await sync.syncNow();
    assert.deepEqual([sync.state.access, sync.state.problem], ['denied', null]);
    await assert.rejects(service.exchange(() => new Map()), { code: 'permission-denied' });
  } finally {
    await sync.signOut();
    await env.cleanup();
    await firestore.terminate(firestore.getFirestore(getApp()));
  }
});
