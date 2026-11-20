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
const { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, serverTimestamp, Timestamp, setLogLevel } = require('firebase/firestore');

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
  await assertSucceeds(setDoc(bucket(db, OWNER, 'a'), { state: '{}' }));
  await assertSucceeds(getDoc(bucket(db, OWNER, 'a')));
  await assertSucceeds(getDocs(collection(db, 'users', OWNER, 'sync')));
});

test('only an approved guest syncs', async () => {
  const sync = async (who) => {
    const db = as(who);
    await setDoc(bucket(db, people[who].uid), { state: '{}' });
    await getDoc(bucket(db, people[who].uid));
  };
  await assertFails(sync('ana'), 'no access document');
  await given({ 'access/ana-uid': status('pending') });
  await assertFails(setDoc(bucket(as('ana'), 'ana-uid'), { state: '{}' }));
  await assertFails(getDoc(bucket(as('ana'), 'ana-uid')));
  await given({ 'access/ana-uid': status('approved') });
  await assertSucceeds(sync('ana'));
  await given({ 'access/ana-uid': status('denied') });
  await assertFails(getDoc(bucket(as('ana'), 'ana-uid')), 'removed');
  await assertFails(setDoc(bucket(as('ana'), 'ana-uid'), { state: '{}' }), 'removed');
});

test('nobody reads or writes anyone else\'s collection, the owner included', async () => {
  await given({
    'access/ana-uid': status('approved'),
    'access/ben-uid': status('approved'),
    'users/ana-uid/sync/0': { state: '{"records":[]}' },
    [`users/${OWNER}/sync/0`]: { state: '{"records":[]}' },
  });
  await assertFails(getDoc(bucket(as('ben'), 'ana-uid')));
  await assertFails(setDoc(bucket(as('ben'), 'ana-uid'), { state: '{}' }));
  await assertFails(getDocs(collection(as('ben'), 'users', 'ana-uid', 'sync')));
  await assertFails(getDoc(bucket(as('ana'), OWNER)));
  await assertFails(setDoc(bucket(as('ana'), OWNER), { state: '{}' }));
  await assertFails(getDoc(bucket(as('owner'), 'ana-uid')));
  await assertFails(setDoc(bucket(as('owner'), 'ana-uid'), { state: '{}' }));
  await assertFails(getDoc(bucket(stranger(), 'ana-uid')));
  await assertFails(setDoc(bucket(stranger(), OWNER), { state: '{}' }));
});

test('a sync document is one of 16 buckets with one state field, up to the size cap', async () => {
  const db = as('owner');
  await assertSucceeds(setDoc(bucket(db, OWNER, 'f'), { state: 'x'.repeat(LIMIT) }));
  await assertFails(setDoc(bucket(db, OWNER, 'f'), { state: 'x'.repeat(LIMIT + 1) }));
  await assertFails(setDoc(bucket(db, OWNER, 'g'), { state: '{}' }));
  await assertFails(setDoc(bucket(db, OWNER, '10'), { state: '{}' }));
  await assertFails(setDoc(bucket(db, OWNER, '0'), { state: '{}', extra: 1 }));
  await assertFails(setDoc(bucket(db, OWNER, '0'), { state: 5 }));
  await assertFails(deleteDoc(bucket(db, OWNER, 'f')));
});

test('everything else is denied', async () => {
  await assertFails(setDoc(doc(as('owner'), 'notes', 'n1'), { text: 'hi' }));
  await assertFails(getDoc(doc(as('owner'), 'notes', 'n1')));
  await assertFails(setDoc(doc(as('owner'), 'users', OWNER), { name: 'x' }));
  await assertFails(setDoc(doc(as('owner'), 'users', OWNER, 'other', 'x'), { state: '{}' }));
});
