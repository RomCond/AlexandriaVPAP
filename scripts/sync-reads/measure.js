/*
 * Measures what a sync reads in the Firestore emulator, for the owner and for an approved friend,
 * with the app's own Firebase calls. Run it with:
 *
 *   npx firebase emulators:exec --config tests/firebase.json --only firestore,auth \
 *     --project demo-record-catalog "node scripts/sync-reads/measure.js new"
 *
 * Pass `old` instead of `new` to measure the app and rules as they were before counters, taken from
 * git at OLD_REVISION. It prints one JSON line per account and scenario.
 *
 * Reads are counted from the emulator's stream of rules evaluations. The emulator evaluates each
 * document twice: a first pass that ends in "error" while it loads the documents the rules look up,
 * then the real pass. Only real passes count here. A transaction's reads each show as one `get`. Its
 * commit evaluates each document it writes, and each document it read without writing, which the
 * Firebase SDK checks again at commit.
 *
 * Firestore bills one read for each document a transaction reads, found or not, and one read for
 * each document the rules look up with get() or getAfter(). A friend's rules look up their access
 * document in every evaluation. A bucket write looks up the version document with getAfter (new
 * rules only). Firebase's documentation leaves open whether a commit pays for the same lookup once or
 * once per document it evaluates, so a commit's lookups are given as a range from the one to the other.
 *
 * In `new` mode it also measures the listener on the version document. Firestore bills one read for
 * each snapshot of a document a listener receives, and the emulator evaluates the rules each time it
 * starts or resumes a listener and each time it sends one a change, so a friend's listener also pays
 * an access lookup each time. A listener's evaluations are told apart from a sync's by count: a sync
 * reads the version document once. Reconnecting is measured by turning the client's network off and
 * on. The emulator doesn't say what a reconnect bills: Firestore's documentation says a listener that
 * comes back within 30 minutes pays only for documents that changed, and one that was gone longer
 * pays as if it were new.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const S = require('../../js/store.js');

const OLD_REVISION = '4c99473';
const PROJECT = 'demo-record-catalog';
const mode = process.argv[2] === 'old' ? 'old' : 'new';
const root = path.join(__dirname, '..', '..');
const fromGit = (file) => execFileSync('git', ['show', `${OLD_REVISION}:${file}`], { cwd: root, encoding: 'utf8' });

// The old js/sync.js, loaded from git with the current store, which syncs the same state.
function oldSync() {
  const module = { exports: {} };
  new Function('module', 'require', fromGit('js/sync.js'))(module, () => S);
  return module.exports;
}

const Sync = mode === 'old' ? oldSync() : require('../../js/sync.js');
const RULES = mode === 'old' ? fromGit('firestore.rules') : fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');

const accounts = {
  owner: { sub: 'google-owner', name: 'Site Owner', email: 'owner@example.com' },
  friend: { sub: 'google-friend', name: 'Friend', email: 'friend@example.com' },
};

// Every real rules evaluation the emulator reports, as { method, id, inTransaction, outcome }.
function watchEvaluations() {
  const host = process.env.FIRESTORE_EMULATOR_HOST.split(':')[0];
  const port = 9150;
  const seen = [];
  const socket = new WebSocket(`ws://${host}:${port}/requests`);
  socket.onmessage = (message) => {
    for (const event of [].concat(JSON.parse(message.data))) {
      if (!event.rulesContext || event.outcome === 'error') continue;
      const fields = event.rulesContext.request.mapValue.fields;
      seen.push({
        method: event.rulesContext.method,
        id: event.rulesContext.path.split('/').slice(-3).join('/'),
        inTransaction: Boolean(fields.inTransaction && fields.inTransaction.boolValue),
        outcome: event.outcome,
      });
    }
  };
  return { seen, ready: new Promise((resolve) => { socket.onopen = resolve; }), close: () => socket.close() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 800));

async function main() {
  const load = (name) => import(`firebase/${name}`);
  const [{ getApp }, auth, firestore] = await Promise.all(['app', 'auth', 'firestore'].map(load));
  firestore.setLogLevel('silent');
  const service = await Sync.firebaseService({ apiKey: 'demo-key', authDomain: `${PROJECT}.firebaseapp.com`, projectId: PROJECT, appId: 'demo-app' }, load);
  const session = auth.getAuth(getApp());
  auth.connectAuthEmulator(session, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  firestore.connectFirestoreEmulator(firestore.getFirestore(getApp()), host, Number(port));
  const signIn = async (who) => {
    await auth.signOut(session);
    const credential = auth.GoogleAuthProvider.credential(JSON.stringify({ ...accounts[who], email_verified: true }));
    return (await auth.signInWithCredential(session, credential)).user.uid;
  };

  const ids = { owner: await signIn('owner'), friend: await signIn('friend') };
  const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host, port: Number(port), rules: RULES.replace('PASTE_YOUR_ACCOUNT_ID_HERE', ids.owner) } });
  await env.clearFirestore();
  const admin = require('firebase/firestore');
  await env.withSecurityRulesDisabled((context) => admin.setDoc(admin.doc(context.firestore(), 'access', ids.friend), { status: 'approved', name: 'Friend', email: 'friend@example.com', requestedAt: admin.Timestamp.now() }));

  const evaluations = watchEvaluations();
  await evaluations.ready;

  // Runs `step` and sorts the rules evaluations it caused.
  async function measure(step) {
    await settle();
    evaluations.seen.length = 0;
    await step();
    await settle();
    const all = evaluations.seen.slice();
    const sync = all.filter((e) => e.id.includes('/sync/'));
    const bucket = (e) => /\/sync\/[0-9a-f]$/.test(e.id);
    const counts = {
      denied: all.filter((e) => e.outcome !== 'allow').length,
      // Each read in the transaction.
      reads: sync.filter((e) => !e.inTransaction && e.method === 'get').length,
      bucketWrites: sync.filter((e) => e.inTransaction && e.method !== 'get' && bucket(e)).length,
      versionWrites: sync.filter((e) => e.inTransaction && e.method !== 'get' && !bucket(e)).length,
      verifies: sync.filter((e) => e.inTransaction && e.method === 'get').length,
      access: all.filter((e) => !e.id.includes('/sync/')).map((e) => `${e.method} ${e.id.split('/').slice(-2)[0]}`),
    };
    return counts;
  }

  // What Firestore bills for one sync's transaction, as [fewest, most].
  function billed(who, { reads, bucketWrites, versionWrites, verifies }) {
    const evaluated = bucketWrites + versionWrites + verifies;
    const range = (n) => (n ? [1, n] : [0, 0]);
    const access = who === 'friend' ? [reads + range(evaluated)[0], reads + range(evaluated)[1]] : [0, 0];
    const after = mode === 'new' ? range(bucketWrites) : [0, 0];
    return [0, 1].map((i) => reads + access[i] + after[i]);
  }

  const titles = Array.from({ length: 60 }, (_, i) => ({ artist: `Artist ${i % 9}`, title: `Album ${i}` }));
  const report = (scenario, result) => console.log(JSON.stringify({ mode, who: current, scenario, ...result, billed: result.reads ? billed(current, result) : undefined }));
  let current = null;
  for (const who of ['owner', 'friend']) {
    current = who;
    const uid = await signIn(who);
    const device = () => S.createStore(S.memoryStorage());
    const a = device();
    const b = device();
    a.addMany(titles);
    const syncOf = (store) => () => Sync.syncOnce(store, service, uid);

    report('first device uploads 60 records', await measure(syncOf(a)));
    report('a new device', await measure(syncOf(b)));
    report('nothing changed', await measure(syncOf(a)));
    a.add({ artist: 'Steely Dan', title: 'Aja' });
    report('one record added locally', await measure(syncOf(a)));
    report('one record added on the other device', await measure(syncOf(b)));
    a.add({ artist: 'Can', title: 'Tago Mago' });
    b.add({ artist: 'Faust', title: 'IV' });
    await syncOf(a)();
    report('both devices changed while apart', await measure(syncOf(b)));
    report('access check when the page opens or on Sync now', await measure(async () => {
      try {
        await service.listAccess();
      } catch (error) {
        await service.readAccess();
      }
    }));
    if (mode === 'new') await measureListener(who, a, b, syncOf);
  }

  // The listener on device `a`'s version document, while `b` and `a` write. Each report gives the
  // snapshots the listener received and the rules evaluations it caused, and what Firestore bills
  // for the listener alone. A sync in the same step is reported on its own line above.
  async function measureListener(who, a, b, syncOf) {
    for (const store of [a, b, a]) await syncOf(store)();
    let snapshots = 0;
    let first;
    const started = new Promise((resolve) => {
      first = resolve;
    });
    let stop = () => {};
    const live = (scenario, result, received, syncReadsVersions) => {
      const evaluations = result.versionReads - syncReadsVersions;
      const lookups = who === 'friend' ? evaluations : 0;
      console.log(JSON.stringify({ mode, who, scenario, snapshots: received, evaluations, denied: result.denied, billed: [received + lookups, received + lookups] }));
    };
    const versionReads = (counted) => ({ ...counted, versionReads: evaluations.seen.filter((e) => e.method === 'get' && !e.inTransaction && e.id.endsWith('/sync/versions')).length });
    const step = async (fn) => {
      const before = snapshots;
      const counted = versionReads(await measure(fn));
      return [counted, snapshots - before];
    };

    let [counted, received] = await step(async () => {
      stop = service.watchVersions((versions, meta) => {
        if (meta.fromCache) return;
        snapshots += 1;
        first();
      }, (error) => console.error('listener failed', error.code));
      await started;
    });
    live('listener starts', counted, received, 0);

    b.add({ artist: 'Neu!', title: 'Neu! 2' });
    [counted, received] = await step(syncOf(b));
    live('a change from another device reaches the listener', counted, received, 1);
    report('the sync that change starts', await measure(syncOf(a)));

    a.add({ artist: 'Cluster', title: 'Zuckerzeit' });
    [counted, received] = await step(syncOf(a));
    live('this device\'s own write comes back to its listener', counted, received, 1);

    [counted, received] = await step(syncOf(a));
    live('a sync that writes nothing', counted, received, 1);

    const db = firestore.getFirestore(getApp());
    [counted, received] = await step(async () => {
      await firestore.disableNetwork(db);
      await settle();
      await firestore.enableNetwork(db);
    });
    live('reconnecting, with nothing changed', counted, received, 0);
    stop();
  }
  evaluations.close();
  await auth.signOut(session);
  await env.cleanup();
  await firestore.terminate(firestore.getFirestore(getApp()));
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
