/**
 * Round 34, Part B: the Round 29 audit's heavy reads, repeated once, counted.
 *
 * The audit (docs/audit/ROUND29_FULL_AUDIT.md, finding 8; round29-probe.txt)
 * saw Cloudflare's "exceeded resource limits" (HTTP 503) on Data health, 10 of
 * 20 Players cards, 3 of 3 metered trade checks and 2 of 3 support snapshots.
 * This makes the same public GETs in the same order and prints, per group, how
 * many answered and how many were refused, so the before (audit) and after
 * (this run) compare call for call. Reads only; nothing is written. Cloudflare's
 * own request outcomes for the probe's window are printed too, when the token
 * is handed on (probe.yml).
 *
 * The league is the selected one from the public `/api/leagues`. Run through
 * the Probe workflow, which holds it back past 50 percent of today's D1 reads.
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? '';
let ACCOUNT = process.env.ACCOUNT_ID || null;

const et = (d) =>
  d.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

async function getApp(path) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${APP}${path}`, { signal: AbortSignal.timeout(90_000), headers: { 'cache-control': 'no-cache' } });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON: Cloudflare's own error page */
    }
    return { status: res.status, ms: Date.now() - t0, body };
  } catch (err) {
    return { status: 0, ms: Date.now() - t0, body: null, error: String(err?.message ?? err) };
  }
}

const groups = new Map();
/* The reads the phone retries once on a refusal, 400 ms later (Round 34 follow-up). */
const PHONE_RETRIES = new Set(['card', 'dataHealth', 'verdict']);
async function call(group, label, path) {
  let r = await getApp(path);
  const g = groups.get(group) ?? { ok: 0, refused: 0, other: 0, afterRetry: 0, ms: [] };
  if (r.status >= 200 && r.status < 300) g.ok += 1;
  else if (r.status === 503) g.refused += 1;
  else g.other += 1;
  g.ms.push(r.ms);
  let note = '';
  if (r.status === 503 && PHONE_RETRIES.has(group)) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const again = await getApp(path);
    if (again.status >= 200 && again.status < 300) g.afterRetry += 1;
    note = `  retry HTTP ${again.status}`;
    if (again.status >= 200 && again.status < 300) r = again;
  }
  groups.set(group, g);
  console.log(`  ${label.padEnd(26)} HTTP ${r.status === 200 && note ? 503 : r.status} ${String(g.ms.at(-1)).padStart(6)} ms${note}`);
  return r;
}

const startedAt = new Date();
console.log(`Round 34 CPU probe, started ${et(startedAt)} ET`);
const health = await getApp('/api/health');
console.log(`production revision: ${health.body?.release?.gitSha ?? '?'}`);
const leagues = await getApp('/api/leagues');
const leagueId = process.env.LEAGUE_ID || leagues.body?.leagues?.find((l) => l.isSelected)?.id;
if (!leagueId) {
  console.log('No selected league: nothing to do.');
  process.exit(0);
}
const L = encodeURIComponent(leagueId);

console.log('\n## The audit\'s screen reads, in its order');
await call('screens', 'overview', '/api/overview');
await call('screens', 'authStatus', '/api/auth/status');
await call('screens', 'team.roster', `/api/leagues/${L}/roster`);
const lineup = await call('screens', 'team.lineup', `/api/leagues/${L}/lineup`);
const waivers = await call('screens', 'waivers', `/api/leagues/${L}/waivers?cost=1`);
await call('screens', 'matchup', `/api/leagues/${L}/matchup`);
const mode = encodeURIComponent(lineup.body?.mode ?? 'balanced');
await call('screens', 'compare.poolMine', `/api/leagues/${L}/compare-pool?tab=mine&position=ALL&q=&mode=${mode}`);
const poolWaivers = await call('screens', 'compare.poolWaivers', `/api/leagues/${L}/compare-pool?tab=waivers&position=ALL&q=&mode=${mode}`);
const board = await call('board', 'players.board', `/api/players/season?leagueId=${L}&cost=1`);
const offers = await call('offers', 'trades.offers', '/api/trades/screens/offers');
const teams = await call('screens', 'trades.teams', '/api/trades/screens/teams');

console.log('\n## Each offer: the verdict Check shows, and the metered trade check');
const myRosterId =
  (teams.body?.teams ?? []).find((t) => t.isMine)?.rosterId ?? (board.body?.teams ?? []).find((t) => t.isMine)?.rosterId ?? null;
for (const o of (offers.body?.offers ?? []).slice(0, 3)) {
  const give = (o.give ?? []).map((p) => p.playerId).join(',');
  const get = (o.get ?? []).map((p) => p.playerId).join(',');
  const partner = o.partner?.rosterId;
  if (partner == null || !give || !get) continue;
  await call('verdict', `verdict ${o.id ?? '?'}`, `/api/trades/screens/verdict?b=${partner}&give=${encodeURIComponent(give)}&get=${encodeURIComponent(get)}`);
  if (myRosterId != null)
    await call('check', `trade check ${o.id ?? '?'}`, `/api/leagues/${L}/trades/check?a=${myRosterId}&b=${partner}&give=${encodeURIComponent(give)}&get=${encodeURIComponent(get)}&cost=1`);
}

console.log('\n## Players cards: Alex\'s skill players, then the free agents the screens put forward (20, as the audit)');
const evals = [...(lineup.body?.starters ?? []), ...(lineup.body?.bench ?? []), ...(lineup.body?.undecidable ?? [])];
const mine = evals.filter((e) => ['QB', 'RB', 'WR', 'TE'].includes(e.position)).map((e) => e.playerId).filter(Boolean);
const w = waivers.body ?? {};
const t = w.tiers ?? {};
const fromWaivers = [
  w.pickupStart?.start?.playerId,
  ...(w.pickupStart?.consider ?? []).map((m) => m.playerId),
  ...[...(t.doThese ?? []), ...(t.doThis ? [t.doThis] : []), ...(t.consider ?? []), ...(t.watch ?? [])].map((m) => m.playerId),
  ...(poolWaivers.body?.rows ?? []).map((r) => r.id ?? r.playerId),
].filter(Boolean);
const free = [...new Set(fromWaivers)].filter((id) => !mine.includes(id));
const pick = [...new Set([...mine, ...free.slice(0, Math.max(6, 20 - mine.length))])];
for (const id of pick) await call('card', `card ${pick.indexOf(id) + 1}`, `/api/players/${encodeURIComponent(id)}/season?leagueId=${L}&cost=1`);

console.log('\n## Data health and the support snapshots');
await call('screens', 'refresh.status', '/api/refresh/status?kind=startsit');
await call('dataHealth', 'dataHealth', '/api/data-health');
for (const context of ['lineup', 'matchup', 'waiver-plan']) await call('snapshot', `snapshot ${context}`, `/api/leagues/${L}/support-snapshot?context=${context}`);
const finishedAt = new Date();

console.log('\n## Summary: answered / refused by Cloudflare (503) / other, per group');
const audit = { dataHealth: '0 of 1', card: '10 of 20', check: '0 of 3', snapshot: '1 of 3' };
for (const [group, g] of groups) {
  const total = g.ok + g.refused + g.other;
  const sorted = [...g.ms].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(
    `  ${group.padEnd(11)} answered ${g.ok} of ${total}, refused ${g.refused}, other ${g.other}${PHONE_RETRIES.has(group) ? `, with the phone's one retry ${g.ok + g.afterRetry} of ${total}` : ''}, median ${median} ms${audit[group] ? `   (Round 29 audit: answered ${audit[group]})` : ''}`,
  );
}

if (TOKEN) {
  console.log("\n## Cloudflare's own request outcomes during this probe (free; reads no database rows)");
  try {
    const cf = async (path, init = {}) => {
      const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        ...init,
        signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      });
      return res.json();
    };
    ACCOUNT ??= (await cf('/accounts')).result?.[0]?.id ?? null;
    const from = new Date(startedAt.getTime() - 60_000).toISOString();
    const to = new Date(finishedAt.getTime() + 60_000).toISOString();
    const body = await cf('/graphql', {
      method: 'POST',
      body: JSON.stringify({
        query: `query Q($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
          workersInvocationsAdaptive(limit: 100, filter: { datetime_geq: $from, datetime_leq: $to, scriptName: "fantasy-analyst" }) {
            dimensions { status } sum { requests errors } quantiles { cpuTimeP50 cpuTimeP99 } } } } }`,
        variables: { a: ACCOUNT, from, to },
      }),
    });
    if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join(' | '));
    for (const g of body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [])
      console.log(
        `  ${String(g.dimensions.status).padEnd(22)} requests ${g.sum.requests}  errors ${g.sum.errors}  CPU p50 ${(g.quantiles.cpuTimeP50 / 1000).toFixed(1)} ms  p99 ${(g.quantiles.cpuTimeP99 / 1000).toFixed(1)} ms`,
      );
  } catch (err) {
    console.log(`  (could not read: ${String(err?.message ?? err).slice(0, 200)})`);
  }
}
console.log(`\nfinished ${et(finishedAt)} ET`);
