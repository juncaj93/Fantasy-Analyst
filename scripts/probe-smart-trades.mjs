#!/usr/bin/env node
/**
 * What Smart Bilateral Trades actually says about a real league.
 *
 * Read-only against a running deployment, through its own endpoints. It mutates
 * nothing: every request below is a GET, and the two it makes are the same two
 * a phone makes when a reader opens Trades.
 *
 *   node scripts/probe-smart-trades.mjs
 *   URL=http://127.0.0.1:8788 node scripts/probe-smart-trades.mjs
 *   node scripts/probe-smart-trades.mjs --rejections
 *
 * The point of this file is to make nonsense easy to spot. §24 lists the
 * failures worth looking for in a real league — stars for piles of junk,
 * opponent-harming offers, bench-for-bench noise, near-duplicates, history
 * overpowering value, new managers treated as inactive — and every one of them
 * is either printed as a line or flagged by `lib/smartTradeReview.mjs`, whose
 * checks are exercised against real violations in `probe.smartTradeReview.test.ts`.
 * A clean run says so; a dirty one says which check failed and on which offer.
 *
 * It also answers the free-plan question §20 asks, by measuring rather than
 * asserting: the Sleeper request counter published by the diagnostics endpoint
 * is read before and after a Trades page load, and the difference is printed.
 * The target is zero.
 */

import { MANAGER_FIT_CAP, orderingEffect, reviewFindings } from './lib/smartTradeReview.mjs';

const URL_BASE = (process.env.URL ?? 'https://fantasy-analyst.juncaj93.workers.dev').replace(/\/$/, '');

/*
 * Both switches are readable from the environment as well as from argv.
 *
 * Not a convenience. The repository's own authenticated probe runner
 * (`.github/workflows/probe.yml`) is the supported way to reach production —
 * §31 says to use it rather than route around a proxy that blocks the host —
 * and it invokes `node scripts/<name>.mjs` with **no arguments**, passing its
 * inputs as environment variables. A probe whose only switch is a flag is a
 * probe that cannot be driven from the one place it is meant to run.
 */
const SHOW_REJECTIONS = process.argv.includes('--rejections') || truthy(process.env.REJECTIONS);

/** Ask about a specific league rather than whichever one is selected. */
const LEAGUE_ID = (process.env.LEAGUE_ID ?? '').trim();

function truthy(value) {
  return value != null && value !== '' && value !== '0' && value.toLowerCase?.() !== 'false';
}

/** `?leagueId=…` when one was named, and nothing when it was not. */
function scoped(path) {
  return LEAGUE_ID ? `${path}${path.includes('?') ? '&' : '?'}leagueId=${encodeURIComponent(LEAGUE_ID)}` : path;
}

async function get(path) {
  let res;
  try {
    res = await fetch(`${URL_BASE}${path}`);
  } catch (err) {
    /*
     * Unreachable is not an answer, and must never be printed as one.
     *
     * This probe exists to tell "the engine found nothing" from "the engine was
     * never asked", and a transport failure reported as an empty board would be
     * exactly the confusion it was written to prevent.
     */
    return { status: 0, unreachable: true, body: { error: String(err?.cause?.message ?? err?.message ?? err) } };
  }
  const text = await res.text();
  try {
    return { status: res.status, unreachable: false, body: JSON.parse(text) };
  } catch {
    return { status: res.status, unreachable: false, body: { error: text.slice(0, 200) } };
  }
}

function line(label, value) {
  console.log(`  ${label.padEnd(32)} ${value}`);
}

function unknown(value) {
  return value === null || value === undefined ? '(unknown)' : value;
}

function names(players) {
  return (players ?? []).map((p) => `${p.name} (${p.position} ${p.value?.toFixed?.(1) ?? '?'})`).join(' + ');
}

async function main() {
  console.log(`\n=== smart bilateral trades @ ${URL_BASE} ===\n`);

  const setup = await get('/api/setup/status');
  if (setup.unreachable) {
    console.log(`  the deployment could not be reached: ${setup.body.error}`);
    console.log('  nothing below is known — this is a transport failure, not a report');
    process.exit(1);
  }
  if (setup.status !== 200) {
    console.log(`  /api/setup/status answered ${setup.status}: ${unknown(setup.body.error)}`);
    process.exit(1);
  }
  if (!setup.body?.league?.id) {
    console.log('  the deployment answered, and no league is selected on it; nothing to report');
    process.exit(0);
  }
  line('league', `${setup.body.league.name} (${setup.body.league.id})`);
  if (LEAGUE_ID) line('asked about', LEAGUE_ID);

  /*
   * The Sleeper request counter, read either side of a Trades page load.
   *
   * `coverage` publishes `requestsUsed` per checkpoint, which is the only
   * running total this app keeps. If a Trades request were to walk Sleeper, the
   * sum would move.
   *
   * It is a whole-deployment total, so a cron batch landing between the two
   * reads would show up here as a non-zero difference that Smart Trades did not
   * cause. That is the honest failure direction — it can produce a false alarm
   * and never a false all-clear — and the way to settle one is to read it twice.
   */
  const before = await get('/api/diagnostics/manager-intelligence');
  const sleeperBefore = sumRequests(before.body);

  const started = Date.now();
  const board = await get(scoped('/api/trades/smart'));
  const latency = Date.now() - started;

  if (board.unreachable || board.status !== 200) {
    console.log(`\n  /api/trades/smart answered ${board.status}: ${unknown(board.body?.error)}`);
    process.exit(1);
  }

  const after = await get('/api/diagnostics/manager-intelligence');
  const sleeperAfter = sumRequests(after.body);

  const b = board.body;

  console.log('\n--- the search ---');
  line('partners evaluated', unknown(b.search?.partners));
  line('candidates generated', unknown(b.search?.generated));
  line('candidates scored', unknown(b.search?.scored));
  line('pruning ratio', ratio(b.search?.generated, b.search?.scored));
  line('offers viable', unknown(b.search?.viable));
  line('offers surfaced', unknown(b.search?.surfaced));
  line('bounds', JSON.stringify(b.search?.bounds ?? {}));
  line('request latency', `${latency}ms`);
  line('added Sleeper requests', sleeperBefore == null || sleeperAfter == null ? '(unknown)' : sleeperAfter - sleeperBefore);

  console.log('\n--- league trade capability ---');
  line('can this league trade', b.capability?.tradeable === false ? `no — ${b.capability.basis}` : 'yes');
  if (b.capability?.reason) line('reason', b.capability.reason);

  console.log('\n--- manager history available ---');
  /*
   * Whether the ledger was read at all, before anything read out of it.
   *
   * This line exists because its absence produced a false report: the board
   * used to return a hardcoded `profiles: 0` from five paths that exit before
   * opening the ledger, and this probe printed it for a production league
   * holding eight profiles. An unmeasured value printed as a measurement is the
   * one thing this probe must never do, so the flag is printed first and the
   * counts are suppressed when it is false.
   */
  if (b.history?.measured === false) {
    line('ledger read', 'no — nothing below was measured');
  } else {
    line('ledger read', 'yes');
    line('trade profiles stored', unknown(b.history?.profiles));
    line('seasons fully read', (b.history?.seasonsComplete ?? []).join(', ') || '(none)');
    line('history complete', String(b.history?.complete));
    line("league's own trade rate", unknown(b.history?.leagueRate));
  }

  console.log('\n--- the offers ---');
  if ((b.offers ?? []).length === 0) {
    console.log('  none surfaced');
    for (const note of b.notes ?? []) console.log(`    · ${note}`);
  }
  for (const [i, offer] of (b.offers ?? []).entries()) {
    console.log(`\n  ${i + 1}. with ${offer.partner?.displayName}`);
    line('give', names(offer.give));
    line('get', names(offer.get));
    line('objective fairness', `${offer.fairness?.label} (gap ${Math.round((offer.fairness?.gap ?? 0) * 100)}%)`);
    line('user utility', `${sign(offer.user?.starterGain)} pts starters, ${sign(offer.user?.depthChange)} bench`);
    line(
      'counterparty utility',
      `${sign(offer.counterparty?.starterGain)} pts starters, logic: ${(offer.counterparty?.rationales ?? []).join(', ') || '(none)'}`,
    );
    line(
      'manager fit',
      `${offer.managerFit?.activity} ${sign(offer.managerFit?.contribution, 3)} (cap ±${MANAGER_FIT_CAP})`,
    );
    line(
      'evidence',
      `${offer.managerFit?.evidence?.sample ?? 0} trade(s), ${offer.managerFit?.evidence?.seasonsObserved ?? 0} season(s) read, ` +
        `confidence ${offer.managerFit?.evidence?.confidence ?? 0}${offer.managerFit?.evidence?.historyComplete ? '' : ', history incomplete'}`,
    );
    line('composite', JSON.stringify(offer.breakdown ?? {}));
    for (const reason of offer.reasons ?? []) console.log(`      + ${reason}`);
    for (const caveat of offer.caveats ?? []) console.log(`      - ${caveat}`);
  }

  console.log('\n--- did history change the order? ---');
  const effect = orderingEffect(b.offers ?? []);
  line('offers whose rank moved', effect.moved);
  if (effect.moved > 0) {
    line('with manager fit', effect.withFit.join(' > '));
    line('without manager fit', effect.withoutFit.join(' > '));
  }

  console.log('\n--- sanity review (§24) ---');
  const findings = reviewFindings(b);
  if (findings.length === 0) {
    console.log('  no findings against: lopsided value, opponent-harming offers, bench-for-bench noise,');
    console.log('  repeated players, history exceeding its cap, unmeasured managers called inactive,');
    console.log('  illegal packages.');
  }
  for (const finding of findings) console.log(`  ! ${finding}`);

  if (SHOW_REJECTIONS) {
    const detail = await get(scoped('/api/diagnostics/smart-trades'));
    console.log('\n--- why candidates died ---');
    if (detail.status !== 200) {
      console.log(`  diagnostics answered ${detail.status}: ${unknown(detail.body?.error)}`);
    } else {
      const byReason = new Map();
      for (const r of detail.body?.rejections ?? []) {
        byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
      }
      for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) line(reason, count);
      for (const r of (detail.body?.rejections ?? []).slice(0, 12)) {
        console.log(`    · ${r.reason}: ${r.detail}`);
      }
    }
  }

  console.log('');
  process.exit(findings.length === 0 ? 0 : 1);
}

/** Every Sleeper request this deployment has recorded, across all checkpoints. */
function sumRequests(coverage) {
  const checkpoints = coverage?.checkpoints;
  if (!Array.isArray(checkpoints)) return null;
  return checkpoints.reduce((sum, c) => sum + (Number(c.requestsUsed) || 0), 0);
}

function ratio(generated, scored) {
  if (!generated || scored == null) return '(unknown)';
  return `${Math.round((1 - scored / generated) * 100)}% pruned before scoring`;
}

function sign(value, places = 1) {
  if (value === null || value === undefined) return '(unknown)';
  const n = Number(value);
  return `${n > 0 ? '+' : ''}${n.toFixed(places)}`;
}

await main();
