/**
 * Did the Worker's own scheduled runs end the way they should?
 *
 *   CLOUDFLARE_API_TOKEN=... node scripts/cron-health-watch.mjs
 *
 * Asks Cloudflare, not the app. Every other alarm here reads something the app
 * writes about itself -- a run record, a `checked_at`, a freshness row -- and an
 * invocation the runtime kills for CPU writes nothing after the point it died.
 * From 27 September 2026 09:15 UTC to 28 September 05:40 UTC the five-minute
 * tick was killed `exceededCpu` on 246 consecutive runs. The injury check at
 * the top of each run had already recorded its 304, so every freshness signal
 * stayed green, the 09:00 watch was not looking at that cron, and the
 * "Scheduled job failures" issue only ever hears about GitHub's jobs. Nobody
 * was told; it was found by accident two days later.
 *
 * Cloudflare keeps one row per scheduled invocation with its cron and how it
 * ended (`workersInvocationsScheduled`). That is the record a killed run cannot
 * fail to leave, so that is what this reads. One verdict per cron, printed as
 * JSON for the workflow to hand to `alert-on-failure.yml`, which lists each
 * failing cron as its own row on the issue, comments on the first failure, and
 * takes the row away again on the first healthy check.
 *
 * Read-only: a metrics API. Depends on nothing, like the alert beside it.
 */

import { pathToFileURL } from 'node:url';

/**
 * The Worker's crons, by the name each gets on the issue.
 *
 * `expectEveryMinutes` is how long a cron may go without any invocation before
 * its silence is itself the failure, with slack for GitHub starting this late
 * and for Cloudflare's analytics landing a few minutes behind.
 */
export const CRONS = [
  { cron: '*/5 * * * *', name: 'Worker: five-minute injury check', expectEveryMinutes: 45 },
  { cron: '0 9 * * *', name: 'Worker: 09:00 daily refresh', expectEveryMinutes: 26 * 60 },
  { cron: '0 23 * * SAT', name: 'Worker: Saturday evening Vegas refresh', expectEveryMinutes: 8 * 24 * 60 },
  { cron: '0 15 * * SUN', name: 'Worker: Sunday pregame Vegas refresh', expectEveryMinutes: 8 * 24 * 60 },
];

/**
 * When the five-minute tick counts as failing.
 *
 * One killed run is not an outage: the 27 September log has a lone kill at
 * 09:00:33 beside the daily tick, and the next run was fine. Three in a row is
 * fifteen minutes of nothing running, and six in two hours is a tick that is
 * dying more often than not even if the odd run gets through -- the shape the
 * outage had in its last hour, when three of twelve squeezed past.
 */
export const FIVE_MINUTE_RULES = { consecutive: 3, windowMinutes: 120, maxInWindow: 6 };

/**
 * How far back to ask.
 *
 * Just under a week, because that is the widest range the analytics API will
 * answer on this plan ("cannot request a time range wider than 1w", measured
 * on the first dry run). Enough to see the last run of a weekly cron except in
 * the few minutes before its next one, which `judgeCron` allows for.
 */
export const LOOKBACK_HOURS = 7 * 24 - 1;

const ok = (status) => status === 'success';

/**
 * The verdict on one cron, from its invocations. Pure: rows and a clock in,
 * a verdict out, so the whole decision is tested without Cloudflare.
 *
 * `runs` are `{ datetime, status }`, any order.
 */
export function judgeCron(spec, runs, now) {
  const sorted = [...runs].sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
  const last = sorted.at(-1);
  const verdict = (healthy, message) => ({ name: spec.name, cron: spec.cron, result: healthy ? 'success' : 'failure', message });

  if (!last) {
    // A weekly cron's last run can sit just outside the week this can see, so
    // an empty window only counts as silence for a cron due more often than that.
    if (spec.expectEveryMinutes >= LOOKBACK_HOURS * 60) {
      return verdict(true, `${spec.cron} has not run within the ${LOOKBACK_HOURS} hours this can see; nothing to judge.`);
    }
    return verdict(false, `${spec.cron} has no invocation on record in the last ${LOOKBACK_HOURS} hours.`);
  }
  const silentMinutes = (now.getTime() - Date.parse(last.datetime)) / 60_000;
  if (silentMinutes > spec.expectEveryMinutes) {
    return verdict(
      false,
      `${spec.cron} last ran ${Math.round(silentMinutes)} minutes ago (${last.datetime}); ` +
        `it is expected at least every ${spec.expectEveryMinutes}. Cloudflare may have stopped scheduling it.`,
    );
  }

  if (spec.cron === '*/5 * * * *') {
    const { consecutive, windowMinutes, maxInWindow } = FIVE_MINUTE_RULES;
    const tail = sorted.slice(-consecutive);
    const since = now.getTime() - windowMinutes * 60_000;
    const recentFailures = sorted.filter((r) => Date.parse(r.datetime) >= since && !ok(r.status));
    if (tail.length === consecutive && tail.every((r) => !ok(r.status))) {
      return verdict(
        false,
        `The five-minute tick's last ${consecutive} runs all ended ${describe(tail)}, the latest at ${last.datetime}. ` +
          `${recentFailures.length} of its runs in the last ${windowMinutes / 60} hours did not finish. ` +
          `Run the Probe workflow with probe-cron-outcomes.mjs to see which step it dies in.`,
      );
    }
    if (recentFailures.length >= maxInWindow) {
      return verdict(
        false,
        `${recentFailures.length} five-minute runs in the last ${windowMinutes / 60} hours ended ${describe(recentFailures)} ` +
          `(limit ${maxInWindow - 1}). Run the Probe workflow with probe-cron-outcomes.mjs to see which step.`,
      );
    }
    return verdict(true, `The five-minute tick is running: latest ${last.datetime} ${last.status}, ${recentFailures.length} failed in the last ${windowMinutes / 60}h.`);
  }

  if (!ok(last.status)) {
    return verdict(false, `${spec.cron} last ran at ${last.datetime} and ended ${last.status}.`);
  }
  return verdict(true, `${spec.cron} last ran at ${last.datetime}: ${last.status}.`);
}

function describe(runs) {
  const statuses = [...new Set(runs.map((r) => r.status))];
  return statuses.join('/');
}

/** Every cron's verdict, from every invocation in the window. */
export function judgeAll(rows, now, crons = CRONS) {
  return crons.map((spec) => judgeCron(spec, rows.filter((r) => r.cron === spec.cron), now));
}

/* ------------------------------------------------------------ the network */

const GQL = 'https://api.cloudflare.com/client/v4/graphql';

async function resolveAccount(token, fetchImpl) {
  const res = await fetchImpl('https://api.cloudflare.com/client/v4/accounts', {
    headers: { authorization: `Bearer ${token}` },
  });
  const id = (await res.json().catch(() => null))?.result?.[0]?.id;
  if (!id) throw new Error(`could not resolve the Cloudflare account (HTTP ${res.status})`);
  return id;
}

/** Every scheduled invocation of the Worker since `from`, oldest first. */
export async function fetchInvocations({ token, account, script = 'fantasy-analyst', from, to, fetchImpl = fetch }) {
  const acct = account || (await resolveAccount(token, fetchImpl));
  const rows = [];
  let cursor = from.toISOString();
  for (let page = 0; page < 10; page += 1) {
    const res = await fetchImpl(GQL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query Q($a: String!, $from: Time!, $to: Time!, $s: String!) {
          viewer { accounts(filter: { accountTag: $a }) {
            workersInvocationsScheduled(limit: 10000, orderBy: [datetime_ASC],
              filter: { datetime_geq: $from, datetime_leq: $to, scriptName: $s }) { cron status datetime }
          } }
        }`,
        variables: { a: acct, from: cursor, to: to.toISOString(), s: script },
      }),
    });
    const body = await res.json().catch(() => null);
    if (!body || body.errors?.length) {
      throw new Error(`Cloudflare analytics: HTTP ${res.status} ${JSON.stringify(body?.errors ?? body).slice(0, 400)}`);
    }
    const got = body.data?.viewer?.accounts?.[0]?.workersInvocationsScheduled;
    if (!Array.isArray(got)) throw new Error('Cloudflare analytics returned no invocation list');
    rows.push(...got);
    if (got.length < 10000) break;
    cursor = got[got.length - 1].datetime;
  }
  return rows;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    console.log('::error::CLOUDFLARE_API_TOKEN is not set.');
    process.exit(1);
  }
  const now = new Date();
  let rows;
  try {
    rows = await fetchInvocations({
      token,
      account: process.env.CLOUDFLARE_ACCOUNT_ID,
      from: new Date(now.getTime() - LOOKBACK_HOURS * 3_600_000),
      to: now,
    });
  } catch (err) {
    // The watch not being able to see is its own failure, reported as that
    // rather than as a verdict on any cron.
    console.log(`::error::${err.message}`);
    process.exit(1);
  }
  const verdicts = judgeAll(rows, now);
  for (const v of verdicts) console.log(`${v.result === 'success' ? 'ok  ' : 'FAIL'}  ${v.name}: ${v.message}`);
  // The machine-readable line the workflow picks up.
  console.log(`VERDICTS=${JSON.stringify(verdicts.map(({ name, result }) => ({ name, result })))}`);
}
