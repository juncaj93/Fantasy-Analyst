/**
 * How long do the app's own first reads take, sampled over a real window?
 *
 * The daily sweep has been failing on 30-45 second waits for `/api/overview`
 * and `/api/leagues/:id/lineup`, intermittently. One request fired by hand
 * says nothing about an intermittent wait, so this asks the same three
 * questions the app asks on open, every INTERVAL seconds for MINUTES minutes,
 * and prints one line per round with the wall-clock minute beside it. The
 * minute is the point: a wait that lines up with the five-minute cron looks
 * nothing like a cold start (first request after idle) or a query that is
 * always slow.
 *
 * Read-only: GETs against public read endpoints, nothing else.
 *
 * Env:
 *   BASE       site to probe (default production)
 *   MINUTES    how long to sample (default 10)
 *   INTERVAL   seconds between rounds (default 60)
 *   SLOW_MS    what counts as slow in the summary (default 5000)
 */

const BASE = process.env.BASE ?? 'https://fantasy-analyst.juncaj93.workers.dev';
// A round a minute for 10 minutes: every minute of the five-minute cron gets
// sampled twice. It was 75 until October 2026, when one run was measured at a
// few percent of the day's D1 reads before it was cancelled; the Probe
// workflow passes no MINUTES, so the default is what every run costs.
const MINUTES = Number(process.env.MINUTES ?? 10);
const INTERVAL = Number(process.env.INTERVAL ?? 60);
const SLOW_MS = Number(process.env.SLOW_MS ?? 5000);
const LIMIT_MS = 60_000;

async function timed(path) {
  const started = Date.now();
  try {
    const res = await fetch(BASE + path, { signal: AbortSignal.timeout(LIMIT_MS) });
    await res.arrayBuffer();
    return { ms: Date.now() - started, status: res.status, timing: res.headers.get('server-timing') };
  } catch (err) {
    return { ms: Date.now() - started, status: err?.name === 'TimeoutError' ? 'timeout' : 'error', timing: null };
  }
}

const leagues = await fetch(BASE + '/api/leagues').then((r) => r.json()).catch(() => null);
const leagueId = leagues?.leagues?.find((l) => l.isSelected)?.id ?? leagues?.leagues?.[0]?.id;
if (!leagueId) {
  console.error('No league found at /api/leagues; cannot time the lineup read.');
  process.exit(1);
}

const PATHS = {
  overview: '/api/overview',
  leagues: '/api/leagues',
  lineup: `/api/leagues/${leagueId}/lineup`,
};

const samples = Object.fromEntries(Object.keys(PATHS).map((k) => [k, []]));
const slowRounds = [];
const until = Date.now() + MINUTES * 60_000;

console.log(`probing ${BASE} every ${INTERVAL}s for ${MINUTES} min; league ${leagueId}`);
console.log('utc time   ' + Object.keys(PATHS).map((k) => k.padStart(10)).join(''));

while (Date.now() < until) {
  const at = new Date();
  // In parallel, the way the app asks on open.
  const results = await Promise.all(Object.values(PATHS).map((p) => timed(p)));
  const names = Object.keys(PATHS);
  results.forEach((r, i) => samples[names[i]].push(r.ms));
  const line =
    at.toISOString().slice(11, 19) +
    '   ' +
    results
      .map((r) => `${r.ms}${r.status === 200 ? '' : '!' + r.status}`.padStart(10))
      .join('');
  const slow = results.some((r) => r.ms >= SLOW_MS || r.status !== 200);
  console.log(line + (slow ? '   <-- slow' : ''));
  if (slow) {
    slowRounds.push({ at: at.toISOString(), line });
    for (const [i, r] of results.entries()) if (r.timing) console.log(`           ${names[i]} server-timing: ${r.timing}`);
  }
  const wait = INTERVAL * 1000 - (Date.now() - at.getTime());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
console.log('');
console.log('endpoint     n     p50     p90     p99     max   >=slow');
for (const [k, xs] of Object.entries(samples)) {
  console.log(
    k.padEnd(10) +
      String(xs.length).padStart(5) +
      [50, 90, 99].map((p) => String(pct(xs, p)).padStart(8)).join('') +
      String(Math.max(...xs)).padStart(8) +
      String(xs.filter((x) => x >= SLOW_MS).length).padStart(9),
  );
}
console.log('');
console.log(`${slowRounds.length} slow round(s) of ${samples.overview.length}`);
for (const s of slowRounds) console.log('  ' + s.line);
