/**
 * The production read-back for Projection v2: is the new pipeline healthy, and
 * did the live app move?
 *
 *   node scripts/probe-projection-v2-readback.mjs [url]
 *
 * Run it through `.github/workflows/probe.yml`, which is where a runner with a
 * network path to the deployment lives. Read-only: every request is a `GET`
 * anyone can make, and it holds no passphrase.
 *
 * ## The two questions, which are not the same question
 *
 * **Is the ingest healthy.** `/api/diagnostics/nflverse` says what the three
 * feeds hold and how fresh it is, and `/api/diagnostics/projection-v2` says
 * whether the side-by-side can actually be computed against the live database.
 * Both are new, so on a deployment that predates this work they 404 — which is
 * the correct answer for a *before* run and the reason this script prints
 * rather than asserts.
 *
 * **Did the live app move.** This is the one that matters and the one that is
 * easy to do badly. Every live decision surface is fetched and reduced to a
 * **fingerprint of the decision-bearing fields only** — which players are
 * recommended, in which slots, at what projections, in what order. Run before a
 * deploy and again after it, the two fingerprints answer whether anything a
 * user would act on changed.
 *
 * ## Why the fingerprint is not a hash of the response
 *
 * Because the response legitimately differs between any two calls. It carries
 * `fetchedAt` stamps, freshness ages in minutes, live scores, and the
 * five-minute injury cron's own timestamps. A hash of the whole body would
 * differ every time and prove nothing, so a green run would mean nothing either.
 *
 * And because a *real* difference has to be readable. The fingerprint is
 * printed as its components rather than as a digest, so a change can be looked
 * at instead of merely alarmed about — and the input freshness stamps are
 * printed beside it, because the honest question when a projection moves is
 * "did an input move under it", and the crons this app runs (injuries every
 * five minutes, usage and markets daily at 09:00) can legitimately move one
 * between two runs minutes apart.
 *
 * A difference here is therefore a prompt to read, not a verdict. The verdict
 * that Projection v2 cannot reach a recommendation is
 * `tests/projectionV2.boundary.test.ts`, which proves it from the dependency
 * graph; this checks the deployed article behaves the way that proof says.
 */

const URL_BASE = (process.argv[2] ?? process.env.PRODUCTION_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev').replace(/\/$/, '');

const line = (s = '') => process.stdout.write(`${s}\n`);
const rule = (n = 78) => line('-'.repeat(n));

async function get(path) {
  const started = Date.now();
  try {
    const res = await fetch(`${URL_BASE}${path}`, { headers: { accept: 'application/json' } });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body, bytes: text.length, ms: Date.now() - started };
  } catch (err) {
    return { status: 0, body: null, bytes: 0, ms: Date.now() - started, error: String(err) };
  }
}

const fixed = (v, p = 2) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(p));

line();
line(`Projection v2 production read-back — ${URL_BASE}`);
line('='.repeat(78));
line(`run at ${new Date().toISOString()}`);
line();

// --------------------------------------------------------------- liveness ---

const health = await get('/api/health');
line('is it up');
rule();
line(`  /api/health  ${health.status}  ${JSON.stringify(health.body ?? health.error ?? null)}`);
line();

// ------------------------------------------------- the new pipeline itself ---

line('the new pipeline: is it healthy');
rule();

const nflverse = await get('/api/diagnostics/nflverse');
if (nflverse.status === 404) {
  line('  /api/diagnostics/nflverse            404 — this deployment predates Projection v2');
} else if (nflverse.status !== 200 || !nflverse.body) {
  line(`  /api/diagnostics/nflverse            ${nflverse.status} — unexpected`);
} else {
  const h = nflverse.body;
  line(`  season                                ${h.season}`);
  line(`  identity crosswalk                    ${h.identity?.rows ?? 0} rows` +
    `, ${share(h.identity?.withSleeper, h.identity?.rows)} with a Sleeper id` +
    `, ${share(h.identity?.withPfr, h.identity?.rows)} with a PFR id`);
  line(`  crosswalk published                   ${h.identity?.asOf ?? '—'}`);
  line(`  snap counts                           ${h.snaps?.rows ?? 0} rows, ${h.snaps?.players ?? 0} players, through week ${h.snaps?.latestWeek ?? '—'}`);
  line(`  depth captures held                   ${h.depth?.captures?.length ?? 0}, latest ${h.depth?.latest ?? '—'}`);
  line(`  writes today                          ${h.writesToday ?? 0} of ${h.writeCeiling ?? '—'}`);
  line(`  in one sentence                       ${h.dataHealth ?? '—'}`);
  line();
  line('  last run per feed');
  for (const [source, run] of Object.entries(h.runs ?? {})) {
    if (!run) {
      line(`    ${source.padEnd(18)} has never run`);
      continue;
    }
    line(
      `    ${source.padEnd(18)} ${String(run.outcome).padEnd(14)} at ${run.fetchedAt}` +
        `  returned ${run.rowsReturned} · matched ${run.matched} · unmatched ${run.unmatched} · written ${run.rowsWritten}` +
        (run.note ? `  (${run.note})` : ''),
    );
  }
  /*
   * `not_published` is the right answer in August and must not read as a
   * failure — `snap_counts_YYYY.csv` does not exist until games have been
   * played. An alarm that cannot tell that from an outage is one nobody reads
   * in November.
   */
  const failing = Object.entries(h.runs ?? {}).filter(([, r]) => r && r.outcome === 'failed');
  line();
  line(`  feeds in a failed state               ${failing.length === 0 ? 'none' : failing.map(([s]) => s).join(', ')}`);
}
line();

const v2 = await get('/api/diagnostics/projection-v2');
if (v2.status === 404) {
  line('  /api/diagnostics/projection-v2       404 — this deployment predates Projection v2');
} else if (v2.status !== 200 || !v2.body) {
  line(`  /api/diagnostics/projection-v2       ${v2.status} ${JSON.stringify(v2.body ?? {}).slice(0, 200)}`);
} else {
  const r = v2.body;
  line(`  side-by-side computed for             ${r.rows?.length ?? 0} players`);
  line(`  declares itself authoritative         ${r.authoritative === false ? 'no (correct)' : `YES — WRONG (${r.authoritative})`}`);
  line(`  identity                              ${r.identity?.sleeperDirect ?? 0} direct · ${r.identity?.rosterBridge ?? 0} bridged · ${r.identity?.unresolved ?? 0} unresolved`);
  line(`  inputs available                      crosswalk ${r.inputs?.crosswalk} · snaps ${r.inputs?.snaps} · depth captures ${r.inputs?.depthCharts}`);
  const s = r.summary ?? {};
  line(`  where they land                       market ${s.byBasis?.market ?? 0} · +model ${s.byBasis?.market_plus_model ?? 0} · model ${s.byBasis?.model ?? 0} · none ${s.byBasis?.none ?? 0}`);
  line(`  confidence                            high ${s.byConfidence?.high ?? 0} · medium ${s.byConfidence?.medium ?? 0} · low ${s.byConfidence?.low ?? 0}`);
  line(`  mean |v2 - market|, strong market     ${fixed(s.meanAbsoluteDifferenceStrongMarket)}`);
  line(`  projections v2 has and the app has not ${s.newlyProjectable ?? 0}`);
  line(`  projections the app has and v2 has not ${s.lostProjections ?? 0}`);
  line(`  with a fresh-information adjustment   ${s.withFreshInformation ?? 0}`);
}
line();

// ---------------------------------------------------- the live decision set ---

line('the live app: the fingerprint that must not move');
rule();

const leagues = await get('/api/leagues');
const all = leagues.body?.leagues ?? [];
const league = all.find((l) => l.isSelected) ?? all[0] ?? null;

if (!league) {
  line(`  no league is connected, so there is no live decision surface to fingerprint.`);
  line(`  /api/leagues answered ${leagues.status} with ${all.length} leagues.`);
} else {
  line(`  league  ${league.name} (${league.id})  ${league.scoringLabel ?? ''}  season ${league.season}`);
  line();

  // ---- Team: the recommended lineup, which is the app's headline output ----
  const lineup = await get(`/api/leagues/${league.id}/lineup`);
  line(`  GET /api/leagues/:id/lineup            ${lineup.status}  ${lineup.bytes}B  ${lineup.ms}ms`);
  if (lineup.status === 200 && lineup.body?.found !== false) {
    const b = lineup.body;
    line(`    recommendedPoints ${fixed(b.recommendedPoints)}   currentPoints ${fixed(b.currentPoints)}   confidence ${b.confidence ?? '—'}`);
    line();
    line('    slot         player                          projection  source   score   locked');
    for (const slot of b.slots ?? []) {
      line(
        `    ${String(slot.slot ?? '—').padEnd(12)} ${String(slot.name ?? '(empty)').padEnd(31)} ` +
          `${fixed(slot.projection).padStart(10)}  ${String(slot.projectionSource ?? '—').padEnd(7)} ` +
          `${fixed(slot.score).padStart(6)}  ${slot.locked ? 'yes' : 'no'}`,
      );
    }
    line();
    line(`    swaps recommended: ${(b.swaps ?? []).length}`);
    for (const swap of b.swaps ?? []) {
      line(`      ${swap.slot}: ${swap.outName} -> ${swap.inName}   +${fixed(swap.gain)} pts`);
    }
    /*
     * The field that would betray a rollout before any screen did.
     *
     * `projectionSource` is a two-value type today — `market` or `sleeper` —
     * and `core/startsit/projection.ts` is the only module that can set it.
     * Anything else appearing here would mean a third tier had been wired into
     * the number the Team screen prints under the word "projected".
     */
    const sources = [...new Set((b.slots ?? []).map((s) => s.projectionSource).filter(Boolean))];
    line();
    line(`    projection sources in use: ${sources.join(', ') || '(none — nothing is priced)'}`);
    const unexpected = sources.filter((s) => s !== 'market' && s !== 'sleeper');
    line(`    unexpected sources: ${unexpected.length === 0 ? 'none (correct)' : `${unexpected.join(', ')} — WRONG`}`);
  } else if (lineup.body?.found === false) {
    line(`    ${lineup.body.error}`);
  }
  line();

  // ---- Matchup: the simulation ----
  const matchup = await get(`/api/leagues/${league.id}/matchup`);
  line(`  GET /api/leagues/:id/matchup           ${matchup.status}  ${matchup.bytes}B  ${matchup.ms}ms`);
  if (matchup.status === 200 && matchup.body?.found) {
    const f = matchup.body.forecast;
    if (!f) {
      line('    no forecast (degraded state)');
    } else {
      line(`    model ${f.modelVersion}   draws ${f.draws}   phase ${f.phase}   cached ${matchup.body.cached}`);
      /*
       * The single most useful line in this whole read-back.
       *
       * `fingerprint` is the simulation's own hash of the state it was computed
       * from — it seeds the draws and keys the cache. Identical before and
       * after a deploy means the simulation saw identical inputs, which is a
       * stronger statement than two win probabilities happening to match.
       */
      line(`    state fingerprint  ${f.fingerprint}`);
      line(`    mine    ${f.teams?.mine?.name ?? '—'}  actual ${fixed(f.teams?.mine?.actual)}  projected ${fixed(f.teams?.mine?.projectedFinal)}  win ${fixed(f.teams?.mine?.winProbability, 4)}`);
      line(`    theirs  ${f.teams?.theirs?.name ?? '—'}  actual ${fixed(f.teams?.theirs?.actual)}  projected ${fixed(f.teams?.theirs?.projectedFinal)}  win ${fixed(f.teams?.theirs?.winProbability, 4)}`);
      line(`    slots ${(f.slots ?? []).length}   insights ${(f.insights ?? []).length}   leverage ${(f.leverage ?? []).length}`);
    }
  } else if (matchup.status === 200) {
    line(`    not found: ${matchup.body?.reason ?? '—'}`);
  }
  line();

  // ---- Draft: the surface that actually produces decisions in preseason ----
  /*
   * The lineup and the matchup are the app's headline outputs in season and
   * are close to empty out of it — no roster assigned, no fixture published.
   * The Draft Room is where a preseason deployment does real work, so it is
   * the surface a preseason read-back has to fingerprint or it is comparing
   * two blanks and calling them equal.
   *
   * `DRAFT_ID` is exported by `.github/workflows/probe.yml`, which reads it
   * from the live app rather than hardcoding one.
   */
  const draftId = process.env.DRAFT_ID || league.draftId || null;
  if (!draftId) {
    line('  draft         no draft id available, so the draft board was not fingerprinted');
  } else {
    const board = await get(`/api/drafts/${encodeURIComponent(draftId)}/board?limit=40`);
    line(`  GET /api/drafts/:id/board              ${board.status}  ${board.bytes}B  ${board.ms}ms`);
    if (board.status === 200 && board.body) {
      const b = board.body;
      line(`    status ${b.status}   round ${b.round}   pick ${b.currentPick}   picksMade ${b.picksMade}   mySlot ${b.mySlot ?? '—'}`);
      line(`    adp snapshot  ${b.adpSnapshot ? `${b.adpSnapshot.label} captured ${b.adpSnapshot.capturedAt}, ${b.adpSnapshot.matched} matched` : 'none'}`);
      const ph = b.poolHealth ?? {};
      line(`    pool  eligible ${ph.activeEligible ?? '—'} · scored ${ph.scored ?? '—'} · returned ${ph.returned ?? '—'} · withAdp ${ph.withAdp ?? '—'}`);
      const recs = b.recommendations ?? [];
      line(`    recommendations: ${recs.length}`);
      line('    #   player                        pos  team   score     adp');
      recs.slice(0, 15).forEach((r, i) => {
        line(
          `    ${String(i + 1).padStart(2)}  ${String(r.name ?? r.playerId).padEnd(28)}  ${String(r.position ?? '—').padEnd(3)}  ` +
            `${String(r.team ?? '—').padEnd(4)}  ${fixed(r.score).padStart(7)}  ${fixed(r.adp, 1).padStart(6)}`,
        );
      });
      line(`    warnings: ${(b.warnings ?? []).join(' | ') || 'none'}`);
    }
  }
  line();

  // ---- The rankings, as orderings ----
  for (const [label, path, pick] of [
    ['waivers', `/api/leagues/${league.id}/waivers`, (b) => b?.candidates ?? b?.waivers ?? b?.rows ?? []],
    ['trade ladder', `/api/leagues/${league.id}/trades/ladder`, (b) => b?.ladder ?? b?.rows ?? []],
    ['players', '/api/players?limit=25', (b) => b?.players ?? []],
  ]) {
    const res = await get(path);
    const rows = pick(res.body);
    const order = Array.isArray(rows)
      ? rows.slice(0, 12).map((r) => r.playerId ?? r.id ?? r.name ?? '?').join(' ')
      : '(not a list)';
    line(`  ${label.padEnd(14)} ${String(res.status).padStart(3)}  ${Array.isArray(rows) ? rows.length : 0} rows`);
    line(`                     first 12: ${order}`);
  }
}
line();

// ------------------------------------------------------------- provenance ---

line('input freshness, so a moved number can be attributed');
rule();
for (const [label, path, pick] of [
  ['vegas', '/api/vegas/status', (b) => `${b?.provider ?? '—'} · fetched ${b?.fetchedAt ?? b?.freshness?.fetchedAt ?? '—'} · events ${b?.events ?? '—'}`],
  ['setup', '/api/setup/status', (b) =>
    `season ${b?.league?.season ?? b?.season ?? '—'}` +
    ` · week ${b?.nflState?.week ?? b?.state?.week ?? b?.week ?? '—'}` +
    ` · draft ${b?.league?.draftId ?? '—'}`],
  ['rollover', '/api/diagnostics/rollover', (b) => `ready ${b?.ready ?? '—'}`],
]) {
  const res = await get(path);
  line(`  ${label.padEnd(10)} ${String(res.status).padStart(3)}  ${res.status === 200 ? pick(res.body) : '—'}`);
}
line();

line('Compare this output against the run taken before the deploy. The pipeline');
line('block should go from 404 to populated; every line under "the live app"');
line('should read the same. Where one does not, the freshness block above says');
line('whether an input moved under it — the injury check runs every five minutes');
line('and the market and usage refreshes run daily at 09:00 UTC, so two runs an');
line('hour apart can legitimately differ without anything having been enabled.');
line();

function share(part, whole) {
  if (!whole) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}
