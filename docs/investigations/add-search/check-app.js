// Checks that the app's search as it is now returns what the "smart" approach scored on the app as it
// was: the same rank for the wanted album and the same top 5. Run: node check-app.js
process.env.OFFLINE = '1';
process.env.APP_SOURCE = 'worktree';
const dir = __dirname;
const e = require(`${dir}/eval.js`);
const { searchWith } = require(`${dir}/appmb.js`);
const { cases, holdout } = require(`${dir}/cases.js`);
const recorded = { ...require(`${dir}/results.json`).smart, ...require(`${dir}/results-holdout.json`).smart };
(async () => {
  let same = 0;
  let hits = 0;
  for (const c of [...cases, ...holdout]) {
    const app = await searchWith(c.q);
    const s = e.score(c, { results: app });
    const top = app.slice(0, 5).map((r) => `${r.artist} - ${r.title}${r.year ? ` (${r.year})` : ''}`);
    const was = recorded[c.id];
    if (s.rank === was.rank && s.hit === was.hit && JSON.stringify(top) === JSON.stringify(was.top)) same += 1;
    else console.log('differs:', c.id, s.rank, was.rank);
    if (s.hit) hits += 1;
  }
  console.log(`matches the recorded smart results for ${same} of ${cases.length + holdout.length}; hits ${hits}`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
