/*
 * firestore.rules against the Firestore emulator. Run with `npm run test:rules`, which starts the
 * emulator, so it needs Java and the packages from `npm install`. The rules are the ones in this
 * repository, with the owner placeholder swapped for OWNER in memory.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, serverTimestamp, Timestamp, writeBatch, runTransaction, setLogLevel } = require('firebase/firestore');

setLogLevel('silent');

const OWNER = 'owner-uid';
const RULES = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
const LIMIT = 400000;

const people = {
  owner: { uid: OWNER, token: { name: 'Site Owner', email: 'owner@example.com' } },
  ana: { uid: 'ana-uid', token: { name: 'Ana', email: 'ana@example.com' } },
  ben: { uid: 'ben-uid', token: { name: 'Ben', email: 'ben@example.com' } },
};

let env;

test.before(async () => {
  assert.equal(RULES.split('PASTE_YOUR_ACCOUNT_ID_HERE').length, 2, 'the committed rules hold the placeholder once, in isOwner()');
  env = await initializeTestEnvironment({
    projectId: 'demo-record-catalog',
    firestore: { rules: RULES.replace('PASTE_YOUR_ACCOUNT_ID_HERE', OWNER) },
  });
});

test.after(() => env && env.cleanup());

test.beforeEach(() => env.clearFirestore());

const as = (who) => env.authenticatedContext(people[who].uid, people[who].token).firestore();
const stranger = () => env.unauthenticatedContext().firestore();
const bucket = (db, uid, id = '0') => doc(db, 'users', uid, 'sync', id);
const access = (db, uid) => doc(db, 'access', uid);
const versions = (db, uid) => doc(db, 'users', uid, 'sync', 'versions');
const BUCKETS = [...'0123456789abcdef'];
const counters = (changes = {}) => ({ ...Object.fromEntries(BUCKETS.map((id) => [id, 0])), ...changes });

// Writes buckets, as { id: data }, and the version document, as the app does in one transaction.
function syncWrite(db, uid, buckets, next) {
  const batch = writeBatch(db);
  for (const [id, data] of Object.entries(buckets)) batch.set(bucket(db, uid, id), data);
  if (next) batch.set(versions(db, uid), next);
  return batch.commit();
}

const request = (who) => ({ status: 'pending', name: people[who].token.name, email: people[who].token.email, requestedAt: serverTimestamp() });

// Puts documents in place as the console would, without the rules.
function given(docs) {
  return env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const [where, data] of Object.entries(docs)) await setDoc(doc(db, ...where.split('/')), data);
  });
}

const status = (value) => ({ status: value, name: 'x', email: 'x@example.com', requestedAt: Timestamp.now() });

test('a signed-in account can ask for access with its own name and email', async () => {
  await assertSucceeds(setDoc(access(as('ana'), 'ana-uid'), request('ana')));
  await assertSucceeds(getDoc(access(as('ana'), 'ana-uid')));
});

test('a request must be pending, from the account itself, with only the fields a request has', async () => {
  const db = as('ana');
  await assertFails(setDoc(access(db, 'ana-uid'), { ...request('ana'), status: 'approved' }));
  await assertFails(setDoc(access(db, 'ana-uid'), { ...request('ana'), status: 'denied' }));
  await assertFails(setDoc(access(db, 'ben-uid'), request('ana')));
  await assertFails(setDoc(access(db, 'ana-uid'), { ...request('ana'), decidedAt: serverTimestamp() }));
  await assertFails(setDoc(access(db, 'ana-uid'), { ...request('ana'), isAdmin: true }));
  const { requestedAt, ...noTime } = request('ana');
  await assertFails(setDoc(access(db, 'ana-uid'), noTime));
  await assertFails(setDoc(access(db, 'ana-uid'), { ...request('ana'), requestedAt: Timestamp.fromDate(new Date('2020-01-01')) }));
  await assertFails(setDoc(access(stranger(), 'ana-uid'), request('ana')));
});

test('a request cannot claim a name or email the account does not have', async () => {
  const db = as('ana');
  await assertFails(setDoc(access(db, 'ana-uid'), { ...request('ana'), email: 'owner@example.com' }));
  await assertFails(setDoc(access(db, 'ana-uid'), { ...request('ana'), name: 'Site Owner' }));
});

test('a name or email longer than the cap is refused, even when the account has it', async () => {
  const ask = (token) => setDoc(access(env.authenticatedContext('long-uid', token).firestore(), 'long-uid'), { status: 'pending', ...token, requestedAt: serverTimestamp() });
  await assertFails(ask({ name: 'N'.repeat(201), email: 'e@example.com' }));
  await assertFails(ask({ name: 'N', email: `${'e'.repeat(309)}@example.com` }));
  await assertSucceeds(ask({ name: 'N'.repeat(200), email: `${'e'.repeat(308)}@example.com` }));
});

test('a guest cannot approve themselves or change a request once it is made', async () => {
  await given({ 'access/ana-uid': status('pending'), 'access/ben-uid': status('denied') });
  await assertFails(updateDoc(access(as('ana'), 'ana-uid'), { status: 'approved', decidedAt: serverTimestamp() }));
  await assertFails(setDoc(access(as('ana'), 'ana-uid'), { ...request('ana'), status: 'approved' }));
  await assertFails(updateDoc(access(as('ana'), 'ben-uid'), { status: 'approved', decidedAt: serverTimestamp() }));
  await assertFails(updateDoc(access(as('ben'), 'ben-uid'), { status: 'pending' }));
  await assertFails(setDoc(access(as('ben'), 'ben-uid'), request('ben')));
});

test('only the owner can list the requests, and a guest reads only their own', async () => {
  await given({ 'access/ana-uid': status('pending'), 'access/ben-uid': status('approved') });
  const listed = await assertSucceeds(getDocs(collection(as('owner'), 'access')));
  assert.deepEqual(listed.docs.map((d) => d.id).sort(), ['ana-uid', 'ben-uid']);
  await assertFails(getDocs(collection(as('ana'), 'access')));
  await assertFails(getDocs(collection(as('ben'), 'access')));
  await assertFails(getDoc(access(as('ana'), 'ben-uid')));
  await assertFails(getDoc(access(stranger(), 'ana-uid')));
  await assertSucceeds(getDoc(access(as('owner'), 'ana-uid')));
});

test('the owner approves, denies and removes, and changes nothing else', async () => {
  await given({ 'access/ana-uid': status('pending'), 'access/ben-uid': status('pending') });
  const db = as('owner');
  await assertSucceeds(updateDoc(access(db, 'ana-uid'), { status: 'approved', decidedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(access(db, 'ben-uid'), { status: 'denied', decidedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(access(db, 'ana-uid'), { status: 'denied', decidedAt: serverTimestamp() }));

  await given({ 'access/ana-uid': status('pending') });
  await assertFails(updateDoc(access(db, 'ana-uid'), { status: 'approved' }));
  await assertFails(updateDoc(access(db, 'ana-uid'), { status: 'approved', decidedAt: Timestamp.fromDate(new Date('2020-01-01')) }));
  await assertFails(updateDoc(access(db, 'ana-uid'), { status: 'approved', decidedAt: serverTimestamp(), email: 'other@example.com' }));
  await assertFails(updateDoc(access(db, 'ana-uid'), { status: 'owner', decidedAt: serverTimestamp() }));
  await assertFails(updateDoc(access(db, 'ana-uid'), { status: 'pending', decidedAt: serverTimestamp() }));
  await assertFails(deleteDoc(access(db, 'ana-uid')));
});

test('a denied or removed account stays denied', async () => {
  await given({ 'access/ana-uid': status('denied') });
  await assertFails(updateDoc(access(as('owner'), 'ana-uid'), { status: 'approved', decidedAt: serverTimestamp() }));
  await assertFails(updateDoc(access(as('owner'), 'ana-uid'), { status: 'pending', decidedAt: serverTimestamp() }));
});

test('a requester can withdraw a pending request, and only a pending one', async () => {
  await given({ 'access/ana-uid': status('pending'), 'access/ben-uid': status('denied') });
  await assertFails(deleteDoc(access(as('ben'), 'ana-uid')));
  await assertSucceeds(deleteDoc(access(as('ana'), 'ana-uid')));
  await assertFails(deleteDoc(access(as('ben'), 'ben-uid')));
  await given({ 'access/ben-uid': status('approved') });
  await assertFails(deleteDoc(access(as('ben'), 'ben-uid')));
});

test('the owner syncs without an access document', async () => {
  const db = as('owner');
  await assertSucceeds(syncWrite(db, OWNER, { a: { state: '{}', version: 1 } }, counters({ a: 1 })));
  await assertSucceeds(getDoc(bucket(db, OWNER, 'a')));
  await assertSucceeds(getDoc(versions(db, OWNER)));
  await assertSucceeds(getDocs(collection(db, 'users', OWNER, 'sync')));
});

test('only an approved guest syncs', async () => {
  const write = (who, n) => syncWrite(as(who), people[who].uid, { 0: { state: '{}', version: n } }, counters({ 0: n }));
  const sync = async (who, n) => {
    await write(who, n);
    await getDoc(bucket(as(who), people[who].uid));
    await getDoc(versions(as(who), people[who].uid));
  };
  await assertFails(sync('ana', 1), 'no access document');
  await given({ 'access/ana-uid': status('pending') });
  await assertFails(write('ana', 1));
  await assertFails(getDoc(bucket(as('ana'), 'ana-uid')));
  await assertFails(getDoc(versions(as('ana'), 'ana-uid')));
  await assertFails(setDoc(versions(as('ana'), 'ana-uid'), counters()));
  await given({ 'access/ana-uid': status('approved') });
  await assertSucceeds(sync('ana', 1));
  await given({ 'access/ana-uid': status('denied') });
  await assertFails(getDoc(bucket(as('ana'), 'ana-uid')), 'removed');
  await assertFails(getDoc(versions(as('ana'), 'ana-uid')), 'removed');
  await assertFails(write('ana', 2), 'removed');
  await assertFails(setDoc(versions(as('ana'), 'ana-uid'), counters({ 0: 9 })), 'removed');
});

test('nobody reads or writes anyone else\'s collection, the owner included', async () => {
  await given({
    'access/ana-uid': status('approved'),
    'access/ben-uid': status('approved'),
    'users/ana-uid/sync/0': { state: '{"records":[]}', version: 1 },
    'users/ana-uid/sync/versions': counters({ 0: 1 }),
    [`users/${OWNER}/sync/0`]: { state: '{"records":[]}', version: 1 },
    [`users/${OWNER}/sync/versions`]: counters({ 0: 1 }),
  });
  const write = (db, uid) => syncWrite(db, uid, { 0: { state: '{}', version: 2 } }, counters({ 0: 2 }));
  await assertFails(getDoc(bucket(as('ben'), 'ana-uid')));
  await assertFails(getDoc(versions(as('ben'), 'ana-uid')));
  await assertFails(write(as('ben'), 'ana-uid'));
  await assertFails(setDoc(versions(as('ben'), 'ana-uid'), counters({ 0: 5 })));
  await assertFails(getDocs(collection(as('ben'), 'users', 'ana-uid', 'sync')));
  await assertFails(getDoc(bucket(as('ana'), OWNER)));
  await assertFails(write(as('ana'), OWNER));
  await assertFails(getDoc(bucket(as('owner'), 'ana-uid')));
  await assertFails(getDoc(versions(as('owner'), 'ana-uid')));
  await assertFails(write(as('owner'), 'ana-uid'));
  await assertFails(getDoc(bucket(stranger(), 'ana-uid')));
  await assertFails(write(stranger(), OWNER));
});

test('a sync document is one of 16 buckets with one state field and its counter, up to the size cap', async () => {
  const db = as('owner');
  const one = (id, data, n = 1) => syncWrite(db, OWNER, { [id]: data }, BUCKETS.includes(id) ? counters({ [id]: n }) : counters());
  await assertSucceeds(one('f', { state: 'x'.repeat(LIMIT), version: 1 }));
  await assertFails(one('f', { state: 'x'.repeat(LIMIT + 1), version: 2 }, 2));
  await assertFails(one('g', { state: '{}', version: 1 }));
  await assertFails(one('10', { state: '{}', version: 1 }));
  await assertFails(one('0', { state: '{}', version: 1, extra: 1 }));
  await assertFails(one('0', { state: 5, version: 1 }));
  await assertFails(one('0', { state: '{}', version: '1' }));
  await assertFails(one('0', { state: '{}', version: 1.5 }));
  await assertFails(one('0', { version: 1 }));
  await assertFails(deleteDoc(bucket(db, OWNER, 'f')));
  await assertFails(deleteDoc(versions(db, OWNER)));
});

test('a bucket write without a counter, from the app before counters existed, is refused', async () => {
  const db = as('owner');
  await assertFails(setDoc(bucket(db, OWNER, '3'), { state: '{}' }), 'with no version document');
  await assertSucceeds(syncWrite(db, OWNER, { 3: { state: '{}', version: 1 } }, counters({ 3: 1 })));
  await assertFails(setDoc(bucket(db, OWNER, '3'), { state: '{"records":[]}' }), 'with a version document');
  await assertFails(runTransaction(db, async (t) => {
    await t.get(bucket(db, OWNER, '3'));
    t.set(bucket(db, OWNER, '3'), { state: '{"records":[]}' });
  }), 'in a transaction, as the old app wrote');
  await assertFails(updateDoc(bucket(db, OWNER, '3'), { state: '{"records":[]}' }), 'keeping the counter as it was');
});

test('a bucket\'s counter rises with each write, and the version document must rise with it', async () => {
  const db = as('owner');
  await assertSucceeds(syncWrite(db, OWNER, { 5: { state: 'a', version: 1 } }, counters({ 5: 1 })));
  await assertFails(setDoc(bucket(db, OWNER, '5'), { state: 'b', version: 2 }), 'without the version document');
  await assertFails(syncWrite(db, OWNER, { 5: { state: 'b', version: 1 } }, counters({ 5: 1 })), 'a counter that stays the same');
  await assertFails(syncWrite(db, OWNER, { 5: { state: 'b', version: 2 } }, counters({ 5: 3 })), 'a version document that disagrees');
  await assertFails(syncWrite(db, OWNER, { 5: { state: 'b', version: 2 } }, counters({ 5: 1, 6: 4 })), 'a version document that moves another bucket only');
  await assertSucceeds(syncWrite(db, OWNER, { 5: { state: 'b', version: 2 }, 6: { state: 'c', version: 1 } }, counters({ 5: 2, 6: 1 })));
  const stored = await getDoc(versions(db, OWNER));
  assert.deepEqual(stored.data(), counters({ 5: 2, 6: 1 }));
});

test('a collection synced before counters existed takes its first counters', async () => {
  await given({ [`users/${OWNER}/sync/2`]: { state: 'old' }, [`users/${OWNER}/sync/9`]: { state: 'old' } });
  const db = as('owner');
  await assertSucceeds(syncWrite(db, OWNER, { 2: { state: 'new', version: 1 } }, counters({ 2: 1 })));
  await assertSucceeds(syncWrite(db, OWNER, { 9: { state: 'new', version: 1 } }, counters({ 2: 1, 9: 1 })));
});

test('the version document holds 16 whole counters that never go down', async () => {
  const db = as('owner');
  await assertFails(setDoc(versions(db, OWNER), { 0: 1 }), 'too few');
  await assertFails(setDoc(versions(db, OWNER), { ...counters(), g: 0 }), 'an extra field');
  await assertFails(setDoc(versions(db, OWNER), counters({ a: -1 })), 'below zero');
  await assertFails(setDoc(versions(db, OWNER), counters({ a: 1.5 })), 'not whole');
  await assertFails(setDoc(versions(db, OWNER), counters({ a: '1' })), 'not a number');
  await assertSucceeds(setDoc(versions(db, OWNER), counters({ a: 4 })));
  await assertFails(setDoc(versions(db, OWNER), counters({ a: 3 })), 'going down');
  await assertFails(updateDoc(versions(db, OWNER), { a: 3 }), 'going down, as an update');
  const { f, ...fifteen } = counters({ a: 4 });
  await assertFails(setDoc(versions(db, OWNER), fifteen), 'losing a counter');
  await assertSucceeds(setDoc(versions(db, OWNER), counters({ a: 4 })), 'staying the same');
  await assertSucceeds(setDoc(versions(db, OWNER), counters({ a: 9, b: 2 })), 'going up');
  await assertFails(deleteDoc(versions(db, OWNER)));
});

test('everything else is denied', async () => {
  await assertFails(setDoc(doc(as('owner'), 'notes', 'n1'), { text: 'hi' }));
  await assertFails(getDoc(doc(as('owner'), 'notes', 'n1')));
  await assertFails(setDoc(doc(as('owner'), 'users', OWNER), { name: 'x' }));
  await assertFails(setDoc(doc(as('owner'), 'users', OWNER, 'other', 'x'), { state: '{}' }));
});
