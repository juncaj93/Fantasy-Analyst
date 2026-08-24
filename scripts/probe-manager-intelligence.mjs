#!/usr/bin/env node
/**
 * What the deployed manager-history subsystem actually holds.
 *
 * Read-only against a running deployment, through its own endpoints. It reports
 * what is there and never invents a number: a field the app does not publish is
 * printed as unknown rather than filled in from a plausible guess.
 *
 * With `--advance` it also posts one or more bounded backfill batches and prints
 * the progress after each — the honest way to answer "how many batches does this
 * league need?", which is a question no static reading can answer.
 *
 *   node scripts/probe-manager-intelligence.mjs
 *   node scripts/probe-manager-intelligence.mjs --advance=6
 *
 * The passphrase is only needed for `--advance`; the diagnostics read is public
 * like every other read in this app.
 */

const URL_BASE = (process.env.URL ?? 'https://fantasy-analyst.juncaj93.workers.dev').replace(/\/$/, '');
const PASSPHRASE = process.env.PASSPHRASE ?? '';
const advanceArg = process.argv.find((a) => a.startsWith('--advance'));
const ADVANCE = advanceArg ? Number(advanceArg.split('=')[1] ?? 1) || 1 : 0;

let cookie = '';

async function get(path) {
  const res = await fetch(`${URL_BASE}${path}`, { headers: cookie ? { cookie } : {} });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { error: text.slice(0, 200) } };
  }
}

async function post(path, body) {
  const res = await fetch(`${URL_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { error: text.slice(0, 200) } };
  }
}

function line(label, value) {
  console.log(`  ${label.padEnd(34)} ${value}`);
}

function unknown(value) {
  return value === null || value === undefined ? '(unknown)' : value;
}

async function main() {
  console.log(`\n=== manager intelligence @ ${URL_BASE} ===\n`);

  const status = await get('/api/setup/status');
  if (status.status !== 200 || !status.body?.league?.id) {
    console.log('  no league is selected on this deployment; nothing to report');
    process.exit(0);
  }
  const leagueId = status.body.league.id;
  line('league', `${status.body.league.name} (${leagueId})`);

  if (ADVANCE > 0) {
    if (!PASSPHRASE) {
      console.log('\n  --advance needs PASSPHRASE in the environment; skipping the batches\n');
    } else {
      const login = await post('/api/auth/login', { passphrase: PASSPHRASE });
      if (login.status !== 200) {
        console.log(`\n  could not unlock (${login.status}); skipping the batches\n`);
      } else {
        console.log(`\n--- ${ADVANCE} bounded batch(es) ---`);
        let maxRequests = 0;
        for (let i = 1; i <= ADVANCE; i++) {
          const run = await post(`/api/leagues/${leagueId}/managers/refresh`);
          if (run.status === 429) {
            console.log(`  batch ${i}: on cooldown — ${run.body.error}`);
            break;
          }
          if (run.status !== 200) {
            console.log(`  batch ${i}: HTTP ${run.status} — ${unknown(run.body.error)}`);
            break;
          }
          const b = run.body.backfill ?? {};
          maxRequests = Math.max(maxRequests, b.requestsUsed ?? 0);
          console.log(
            `  batch ${i}: ${b.unitsCompleted} unit(s), ${b.requestsUsed}/${b.requestBudget} requests, ` +
              `${b.outstanding} outstanding${b.complete ? ' — complete' : ''}`,
          );
          for (const err of run.body.errors ?? []) console.log(`    ! ${err}`);
          if (b.complete) break;
        }
        line('max requests in one invocation', maxRequests);
      }
    }
  }

  const diag = await get('/api/diagnostics/manager-intelligence');
  if (diag.status !== 200) {
    console.log(`\n  diagnostics answered ${diag.status}: ${unknown(diag.body.error)}\n`);
    process.exit(1);
  }
  const d = diag.body;

  console.log('\n--- coverage ---');
  line('seasons discovered', (d.seasonsDiscovered ?? []).join(', ') || '(none)');
  line('seasons complete', (d.seasonsComplete ?? []).join(', ') || '(none)');
  line('chain link still unresolved', unknown(d.chainUnresolved) || '(chain fully walked)');
  line('completed drafts ingested', `${d.drafts?.complete ?? 0} of ${d.drafts?.total ?? 0}`);
  line('historical picks stored', d.drafts?.picksStored ?? 0);
  line('transaction weeks read', d.transactions?.weeksRead ?? 0);
  line('transaction weeks settled', d.transactions?.weeksSettled ?? 0);
  line('transaction weeks still wanted', d.transactions?.weeksMissing ?? 0);
  line('raw transactions stored', d.transactions?.stored ?? 0);
  line('outstanding backfill units', d.outstandingUnits ?? 0);
  line('backfill has started', d.started ? 'yes' : 'no — nothing ingested');
  line('history complete', d.complete ? 'yes' : 'no');
  line('request budget per batch', d.requestBudget ?? '(unknown)');

  console.log('\n--- checkpoints ---');
  for (const c of d.checkpoints ?? []) {
    console.log(
      `  ${c.dataset.padEnd(13)} ${c.season}  cursor=${unknown(c.cursor)}  complete=${c.completed}  ` +
        `requests=${c.requestsUsed}  v${c.version}`,
    );
    if (c.lastError) console.log(`    last error: ${c.lastError}`);
    if (!c.lastSuccessAt) console.log('    never succeeded');
  }
  if ((d.checkpoints ?? []).length === 0) console.log('  (none — nothing has been ingested yet)');

  console.log('\n--- derived profiles ---');
  for (const p of d.profiles ?? []) {
    line(
      `${p.kind} profiles`,
      `${p.count} stored, ${p.usable} usable, median sample ${p.medianSample}, ` +
        `derived ${unknown(p.derivedAt)}, v${unknown(p.version)}`,
    );
  }

  /*
   * And what a manager actually looks like, from the app's own managers
   * endpoint. Names and sample sizes only — this prints what the app would say,
   * not a grade, and there is deliberately no ranking of anybody.
   */
  const managers = await get(`/api/leagues/${leagueId}/managers`);
  if (managers.status === 200) {
    console.log('\n--- sample size by manager ---');
    for (const m of managers.body.managers ?? []) {
      const picks = m.draft?.sample ?? 0;
      const trades = m.tradeTendencies?.sample ?? 0;
      const txns = m.transactions?.sample ?? 0;
      const bids = m.transactions?.bidSample ?? 0;
      const seasons = (m.draft?.profile?.seasons ?? []).join('/') || '-';
      line(
        m.ownerName ?? `Roster ${m.rosterId}`,
        `${picks} pick(s) · ${trades} trade(s) · ${txns} transaction(s) · ${bids} bid(s) · seasons ${seasons}`,
      );
    }
    const room = managers.body.baseline;
    if (room) {
      console.log('\n--- league baseline ---');
      line('claims per manager per week', room.claimsPerWeek);
      line('adds per manager per week', room.addsPerWeek);
      line('churn per manager per week', room.churnPerWeek);
      line('uses FAAB', room.usesFaab ? 'yes' : 'no');
      line('median winning bid, share of budget', unknown(room.medianBidShare));
      line('winning bids behind that', room.bidSample);
      line('position share of adds', (room.positionShare ?? []).map((p) => `${p.position} ${p.share}`).join(', ') || '(none)');
    }
  }

  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
