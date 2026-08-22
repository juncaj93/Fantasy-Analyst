/**
 * What the number beside a player on Team actually is.
 *
 * Production showed roughly a point and a half where a weekly fantasy projection
 * would be in the teens. This prints the whole chain for every starter — what
 * the screen renders, the ranking score beside it, the market expectation
 * underneath both, and every component that was summed — next to the same
 * player's published weekly projection, so "the base is missing and the
 * adjustments are being shown as a total" is something to read rather than to
 * argue about.
 *
 * `proj` and `score` are printed as two columns on purpose. They are two
 * different questions — what he is expected to score, and how he ranks against
 * the rest of the roster — and the defect this probe found was one of them
 * being printed under the other's heading. Where there is no market they should
 * now read `— 3.15`: no projection, still rankable.
 *
 * It also prints what the Matchup screen says for the same players, because the
 * two screens must mean the same thing by "projected".
 *
 * **Read-only.** Every request is a GET the public site already answers, plus
 * public Sleeper reads. Nothing logs in, nothing writes, nothing touches D1.
 *
 * The Sleeper projection column is printed for comparison only. This app does
 * not read it and must not: a number labelled "Fantasy Analyst projected" that
 * is actually somebody else's is the one thing core/matchup/build.ts §33 forbids.
 *
 *   node scripts/probe-team-projection-semantics.mjs
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const SLEEPER = 'https://api.sleeper.app';

async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 200) };
    return { ok: true, body: JSON.parse(text) };
  } catch (err) {
    return { ok: false, status: 0, error: String(err).slice(0, 200) };
  }
}

const head = (t) => console.log(`\n=== ${t} ===`);
const show = (l, v) => console.log(`  ${String(l).padEnd(30)} ${v}`);

const main = async () => {
  console.log(`probe started ${new Date().toISOString()}`);

  const setup = await getJson(`${APP}/api/setup/status`);
  if (!setup.ok) return console.log(`setup unreachable: ${setup.error}`);
  const leagueId = setup.body.league?.id;
  const scoringLabel = setup.body.league?.scoringLabel;
  if (!leagueId) return console.log('no league selected');

  head('THE DEPLOYMENT');
  show('league', `${setup.body.league?.name} (${leagueId})`);
  show('scoring', scoringLabel);
  show('vegas provider', setup.body.vegas?.provider);
  show('vegas live', setup.body.vegas?.live);
  show('vegas events', setup.body.vegas?.events);
  show('vegas lastRefreshedAt', setup.body.vegas?.lastRefreshedAt ?? '(never)');

  // --------------------------------------------------- what Team renders
  head(`APP /api/leagues/${leagueId}/lineup  (the source of Team's "Projected points")`);
  const lineup = await getJson(`${APP}/api/leagues/${leagueId}/lineup`);
  if (!lineup.ok) return console.log(`  failed: ${lineup.error}`);
  const lu = lineup.body;
  show('found', lu.found);
  show('mode', lu.mode ?? '(default)');
  show('slots', (lu.slots ?? []).length);
  show('projectedTotal', lu.projectedTotal);
  for (const note of lu.notes ?? []) console.log(`    note: ${note}`);

  const evaluations = [...(lu.starters ?? []), ...(lu.bench ?? []), ...(lu.undecidable ?? [])];
  const byId = new Map(evaluations.map((e) => [e.playerId, e]));

  head('EVERY RECOMMENDED STARTER, DECOMPOSED');
  console.log('  slot       player                    proj    score   market   sum-of-known-components');
  const rows = [];
  for (const slot of lu.slots ?? []) {
    const e = slot.playerId ? byId.get(slot.playerId) : null;
    if (!e) {
      console.log(`  ${String(slot.slot).padEnd(10)} (nobody eligible)`);
      continue;
    }
    const known = (e.components ?? []).filter((c) => !c.unknown);
    const sum = known.reduce((a, c) => a + (c.value ?? 0), 0);
    rows.push({ playerId: e.playerId, name: e.name, score: slot.score, projection: slot.projection ?? null });
    console.log(
      `  ${String(slot.slot).padEnd(10)} ${String(e.name).padEnd(24)} ` +
        `${String(slot.projection ?? '—').padStart(6)}  ${String(slot.score ?? '—').padStart(6)}  ` +
        `${String(e.expectation?.points ?? 'null').padStart(6)}   ${sum.toFixed(2)}`,
    );
    console.log(
      `             components kept: ` +
        (known.map((c) => `${c.key}=${(c.value ?? 0).toFixed(2)}`).join(' ') || '(none)'),
    );
    const missing = (e.components ?? []).filter((c) => c.unknown).map((c) => c.key);
    console.log(`             components dropped as unknown: ${missing.join(' ') || '(none)'}`);
    console.log(
      `             expectation: coverage=${e.expectation?.coverage} missingMarkets=${(e.expectation?.missingMarkets ?? []).join(',') || '(none)'}` +
        ` | confidence=${e.confidence}`,
    );
  }

  // ------------------------------------------- what Matchup says for the same
  head(`APP /api/leagues/${leagueId}/matchup  (the other screen that says "projected")`);
  const matchup = await getJson(`${APP}/api/leagues/${leagueId}/matchup`);
  const mineProj = new Map();
  if (matchup.ok) {
    show('week', matchup.body.week);
    show('found', matchup.body.found);
    show('mine projectedFinal', matchup.body.forecast?.teams?.mine?.projectedFinal ?? 'null');
    for (const s of matchup.body.forecast?.slots ?? []) {
      if (s.mine?.playerId) mineProj.set(s.mine.playerId, s.mine.projection);
    }
    show('slots with a projection', `${[...mineProj.values()].filter((v) => v != null).length} of ${mineProj.size}`);
  } else {
    console.log(`  failed: ${matchup.error}`);
  }

  // ----------------------------------------------- the published comparison
  head('SLEEPER published weekly projections (comparison only — never read by the app)');
  const week = matchup.ok ? matchup.body.week : 1;
  const season = setup.body.league?.season;
  const pub = await getJson(
    `${SLEEPER}/projections/nfl/${season}/${week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&order_by=ppr`,
  );
  const publishedById = new Map();
  if (pub.ok && Array.isArray(pub.body)) {
    let withPoints = 0;
    for (const r of pub.body) {
      const s = r.stats ?? {};
      if (s.pts_half_ppr != null || s.pts_ppr != null) withPoints++;
      publishedById.set(String(r.player_id), s);
    }
    show('rows', pub.body.length);
    show('rows carrying fantasy points', withPoints);
    show('publisher', pub.body[0]?.company ?? '(unknown)');
  } else {
    console.log(`  unavailable: ${pub.error}`);
  }

  head('SIDE BY SIDE — the starters');
  console.log('  player                    Team proj   Team score   Matchup   Sleeper(half)  Sleeper(ppr)');
  for (const r of rows) {
    const s = publishedById.get(String(r.playerId)) ?? {};
    const mp = mineProj.has(r.playerId) ? mineProj.get(r.playerId) : '—';
    console.log(
      `  ${String(r.name).padEnd(24)} ${String(r.projection ?? '—').padStart(9)} ${String(r.score ?? '—').padStart(12)} ` +
        `${String(mp ?? 'null').padStart(9)} ${String(s.pts_half_ppr ?? '—').padStart(13)} ${String(s.pts_ppr ?? '—').padStart(13)}`,
    );
  }

  console.log(`\nprobe finished ${new Date().toISOString()}`);
};

await main();
