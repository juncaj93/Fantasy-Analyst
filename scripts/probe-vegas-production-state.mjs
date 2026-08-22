/**
 * What does the deployed app say about its odds provider right now?
 *
 * Read-only, and deliberately free: it makes no provider call at all, so it can
 * be run before and after a deploy without touching the month's allowance. The
 * two endpoints it reads are public GETs that make no provider call of their
 * own either — they read the database and the ledger.
 *
 * The specific things worth proving after a provider change, in order:
 *   - which provider the Worker actually built (the var reached it);
 *   - whether that provider considers itself configured (the *key* reached it,
 *     which is a different fact and the one that was silently false before);
 *   - what Setup says out loud, since a status screen that overstates is worse
 *     than one that says nothing;
 *   - what has actually been stored, and what it cost.
 *
 * Prints only. Changes nothing.
 */

const APP = process.env.PRODUCTION_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

async function getJson(path) {
  const res = await fetch(`${APP}${path}`);
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text), text };
  } catch {
    return { status: res.status, json: null, text };
  }
}

const status = await getJson('/api/setup/status');
console.log(`GET /api/setup/status -> ${status.status}\n`);

const v = status.json?.vegas;
if (!v) {
  console.log(`no vegas block: ${(status.text ?? '').slice(0, 400)}`);
  process.exit(1);
}

console.log('=== provider ===');
console.log(`  name          : ${v.provider}`);
console.log(`  live          : ${v.live}   (provider is real AND its key is present)`);
console.log(`  note          : ${v.note}`);

const step = (status.json?.steps ?? []).find((s) => s.id === 'vegas');
console.log('\n=== what Setup shows the user ===');
console.log(`  state         : ${step?.state}`);
console.log(`  summary       : ${step?.summary}`);
console.log(`  action        : ${step?.action ?? '(none)'}`);

console.log('\n=== what is stored ===');
console.log(`  events        : ${v.events}`);
console.log(`  last refresh  : ${v.lastRefreshedAt ?? 'never'}`);

console.log('\n=== the month ===');
console.log(
  `  budget        : ${v.budget?.used} of ${v.budget?.limit} used ` +
    `(${v.budget?.state}, source=${v.budget?.source}, month=${v.budget?.month})`,
);
console.log(`  by source     : ${JSON.stringify(v.budget?.bySource ?? null)}`);
console.log(`  note          : ${v.budget?.note}`);

console.log('\n=== season-long markets ===');
console.log(`  ${JSON.stringify(v.season ?? null)}`);
console.log('  (this provider publishes none; an empty set with a reason is the honest answer)');

const budget = await getJson('/api/vegas/budget');
console.log(`\nGET /api/vegas/budget -> ${budget.status}`);
console.log(`  ${(budget.text ?? '').slice(0, 1200)}`);
