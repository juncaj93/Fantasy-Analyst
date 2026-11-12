/**
 * Round 22 (fast refresh): how long a refresh really takes, from production.
 *
 * Parts (STEPS, comma list; default all):
 *
 *   logs   Cloudflare's own request logs (telemetry API, zero D1 rows): every
 *          refresh request of the last 7 days (the old `/api/startsit/refresh`,
 *          the Waivers refresh, and the Round 22 `/api/refresh` start and
 *          status calls), how long each took, whether the phone stayed for the
 *          answer (`canceled` means it left), and the screen reloads that
 *          followed each tap, so "tap to fresh screen" can be added up.
 *   job    The Round 22 job record, one settings row through
 *          `/api/refresh/status`: when the last refresh ran, how long the
 *          server work took, each source's outcome, and the exact D1 rows it
 *          read and wrote (from D1's own per-statement meta).
 *
 * Read-only. Nothing here presses the button: the Probe workflow has no
 * passphrase, and a press could spend odds quota. Times printed in Eastern.
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.ACCOUNT_ID;
const SCRIPT = process.env.SCRIPT_NAME ?? 'fantasy-analyst';
const DAYS = Number(process.env.DAYS ?? 7);
const steps = new Set((process.env.STEPS || 'logs,job').split(',').map((s) => s.trim()).filter(Boolean));

const heading = (t) => console.log(`\n${'#'.repeat(70)}\n# ${t}\n${'#'.repeat(70)}`);
const eastern = (ms = Date.now()) =>
  new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });

console.log(`Round 22 probe, started ${eastern()} ET; steps: ${[...steps].join(', ')}`);

async function telemetry(body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text), text };
  } catch {
    return { status: res.status, json: null, text };
  }
}

/** Every event whose request URL contains `needle`, splitting the window when a page fills. */
async function eventsFor(needle, from, to) {
  const all = [];
  const ask = async (a, b, depth) => {
    const r = await telemetry({
      queryId: `round22-${needle}-${a}-${b}`,
      timeframe: { from: a, to: b },
      view: 'events',
      limit: 100,
      parameters: {
        datasets: ['cloudflare-workers'],
        filters: [
          { key: '$metadata.service', operation: 'eq', type: 'string', value: SCRIPT },
          { key: '$workers.event.request.url', operation: 'includes', type: 'string', value: needle },
        ],
        filterCombination: 'and',
      },
    });
    if (!r.json?.success) {
      console.log(`  ${needle}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
      return;
    }
    const list = r.json.result?.events?.events ?? [];
    if (list.length >= 100 && depth < 6) {
      const mid = Math.floor((a + b) / 2);
      await ask(a, mid, depth + 1);
      await ask(mid, b, depth + 1);
      return;
    }
    all.push(...list);
  };
  await ask(from, to, 0);
  return all;
}

/** One row per request: the invocation event carries method, outcome and timings. */
function requests(events) {
  const byId = new Map();
  for (const e of events) {
    const m = e.$metadata ?? {};
    const w = e.$workers ?? {};
    const id = m.requestId ?? w.requestId ?? `${e.timestamp}`;
    const row = byId.get(id) ?? { at: Number(e.timestamp ?? m.timestamp ?? 0), url: null, method: null, outcome: null, cpu: null, wall: null, status: null, messages: [] };
    row.at = Math.min(row.at, Number(e.timestamp ?? row.at));
    row.url ??= w.event?.request?.url ?? m.url ?? null;
    row.method ??= w.event?.request?.method ?? null;
    row.outcome ??= w.outcome ?? null;
    row.cpu ??= w.cpuTimeMs ?? null;
    row.wall ??= w.wallTimeMs ?? null;
    row.status ??= w.event?.response?.status ?? m.statusCode ?? null;
    if (m.message && !/^(GET|POST) /.test(String(m.message))) row.messages.push(String(m.message).slice(0, 240));
    byId.set(id, row);
  }
  return [...byId.values()].sort((a, b) => a.at - b.at);
}

const path = (url) => {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? u.search : '');
  } catch {
    return String(url ?? '?');
  }
};
const secs = (ms) => (ms == null ? '?' : `${(ms / 1000).toFixed(1)}s`);
const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

async function logsStep() {
  heading(`Refresh requests in the Worker logs, last ${DAYS} days`);
  if (!TOKEN || !ACCOUNT) {
    console.log('CLOUDFLARE_API_TOKEN and ACCOUNT_ID are needed for this part; skipped.');
    return;
  }
  const to = Date.now();
  const from = to - DAYS * 24 * 3_600_000;
  const taps = requests([
    ...(await eventsFor('/api/startsit/refresh', from, to)),
    ...(await eventsFor('/waivers/refresh', from, to)),
    ...(await eventsFor('/api/refresh', from, to)),
  ]).filter((r) => r.method !== 'GET' || /\/api\/refresh/.test(r.url ?? ''));
  if (taps.length === 0) {
    console.log('No refresh request in the logs (they may keep fewer days).');
    return;
  }
  /* The screen reloads that follow a tap: Team's three, Waivers' one. */
  const reads = requests([
    ...(await eventsFor('/lineup', from, to)),
    ...(await eventsFor('/roster', from, to)),
    ...(await eventsFor('/waivers', from, to)),
  ]).filter((r) => (r.method ?? 'GET') === 'GET' && !/refresh/.test(r.url ?? ''));

  const old = [];
  console.log('when (ET)                 request                               status outcome     wall    cpu   then screen reloads');
  for (const t of taps) {
    const end = t.at + (t.wall ?? 0);
    const after = reads.filter((r) => r.at >= end - 1_000 && r.at <= end + 15_000);
    const reloadEnd = after.length ? Math.max(...after.map((r) => r.at + (r.wall ?? 0))) : null;
    const total = reloadEnd != null ? reloadEnd - t.at : t.wall;
    const p = path(t.url).replace(/\/api\/leagues\/[^/]+/, '/api/leagues/:id');
    console.log(
      `${eastern(t.at).padEnd(25)} ${`${t.method ?? '?'} ${p}`.slice(0, 37).padEnd(37)} ${String(t.status ?? '?').padEnd(6)} ${String(t.outcome ?? '?').padEnd(11)} ${secs(t.wall).padEnd(7)} ${String(t.cpu ?? '?').padEnd(5)} ${after.length ? `${after.length} read(s), tap to fresh screen ${secs(total)}` : 'none'}`,
    );
    for (const msg of t.messages.slice(0, 2)) console.log(`      ${msg}`);
    if (/startsit\/refresh/.test(t.url ?? '')) old.push({ wall: t.wall, total, outcome: t.outcome });
  }
  if (old.length) {
    console.log(`\nOld Team refresh: ${old.length} tap(s); median request ${secs(median(old.map((o) => o.wall)))}, median tap to fresh screen ${secs(median(old.map((o) => o.total)))}, longest ${secs(Math.max(...old.map((o) => o.total ?? 0)))}; left before the answer (canceled): ${old.filter((o) => o.outcome === 'canceled').length}`);
  }
  const sample = taps[0];
  console.log(`(outcome values seen: ${[...new Set(taps.map((t) => t.outcome))].join(', ')})`);
  void sample;
}

async function jobStep() {
  heading('Round 22 refresh job record (one settings row)');
  const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
  console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);
  for (const kind of ['startsit', 'waivers']) {
    const res = await fetch(`${APP}/api/refresh/status?kind=${kind}`).catch(() => null);
    if (!res || !res.ok) {
      console.log(`${kind}: HTTP ${res?.status ?? '?'} (route not deployed yet?)`);
      continue;
    }
    const { job } = await res.json();
    if (!job) {
      console.log(`${kind}: no refresh has run on the new code yet`);
      continue;
    }
    console.log(`${kind}: ${job.state}, started ${eastern(Date.parse(job.startedAt))}, finished ${job.finishedAt ? eastern(Date.parse(job.finishedAt)) : '-'}, server work ${secs(job.ms)}`);
    if (job.cost) console.log(`  D1 rows read ${job.cost.rowsRead}, written ${job.cost.rowsWritten} (${job.cost.statements} statements)`);
    for (const s of job.sources ?? []) console.log(`  ${s.source.padEnd(9)} ${s.outcome.padEnd(11)} ${secs(s.ms).padEnd(6)} ${s.detail}`);
  }
}

if (steps.has('logs')) await logsStep();
if (steps.has('job')) await jobStep();
console.log(`\nfinished ${eastern()} ET`);
