/**
 * Two reports from 24 September 2026, asked of production rather than of a fixture.
 *
 *   1. The Team screen said `Start Carolina Panthers over Rhamondre Stevenson`
 *      under a FLEX row, beside an empty DEF row reading "Nobody eligible yet".
 *      A defence cannot play FLEX in this league. What did the optimiser
 *      actually return — the slots, the swaps, and which slot each swap names?
 *
 *   2. Drake Maye's market read 11.2 (pass yards 218.5, rush yards 24.5) and
 *      Stevenson and TreVeyon Henderson read 0.8 and 0.7 on sixteen touches a
 *      game. Which markets are those numbers built from, which are missing, and
 *      is the gap the provider's (nothing posted) or ours (posted, not read)?
 *
 * Part 1 reads the live app. Part 2 reads the odds provider's board for the
 * Patriots' game and a few others, prints every player-level market it carries
 * for the three players, and runs the same event through this revision's own
 * adapter so "posted" and "kept" can be read side by side.
 *
 * Reads only. The provider part is capped at MAX_ENTITIES (default 6) of the
 * month's allowance; the key is never echoed.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/*
 * The adapter's error class uses a TypeScript parameter property, which plain
 * type stripping refuses. The Probe workflow runs `node scripts/<name>.mjs` with
 * no flags, so this re-runs itself with the one flag it needs, and the imports
 * below are dynamic so nothing is parsed before that decision.
 */
if (!process.execArgv.includes('--experimental-transform-types')) {
  const run = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: process.env },
  );
  process.exit(run.status ?? 1);
}

const { buildLineupVerdicts } = await import('../src/core/startsit/sleeperLineup.ts');
const { SportsGameOddsProvider } = await import('../src/core/vegas/sportsGameOddsProvider.ts');
const { buildConsensus } = await import('../src/core/vegas/normalize.ts');
const { PlayerIndex } = await import('../src/core/identity/index.ts');
const { buildExpectation } = await import('../src/core/startsit/expectation.ts');
const { buildScoringProfile } = await import('../src/core/sleeper/scoring.ts');

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const KEY = process.env.SPORTSGAMEODDS_API_KEY ?? '';
const SGO = 'https://api.sportsgameodds.com/v2';
const MAX_ENTITIES = Number(process.env.MAX_ENTITIES ?? 6);
const WATCH = ['Drake Maye', 'Rhamondre Stevenson', 'TreVeyon Henderson'];

async function get(path) {
  const res = await fetch(`${APP}${path}`, { headers: { accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) return { __error: `HTTP ${res.status} ${text.slice(0, 200)}` };
  try {
    return JSON.parse(text);
  } catch {
    return { __error: `not json: ${text.slice(0, 200)}` };
  }
}

const fmt = (v) => (v == null ? '—' : String(v));

const health = await get('/api/health');
console.log(`asking ${APP}`);
console.log(`deployed sha: ${health.release?.gitSha ?? health.gitSha ?? '(none reported)'}`);

const leagues = await get('/api/leagues');
const league = (leagues.leagues ?? []).find((l) => l.isSelected) ?? (leagues.leagues ?? [])[0] ?? null;
if (!league) {
  console.log('no league:', JSON.stringify(leagues).slice(0, 300));
  process.exit(0);
}
console.log(`league: ${league.name} (${league.id})`);
console.log(`roster_positions: ${JSON.stringify(league.rosterPositions ?? [])}`);

const vegas = await get('/api/vegas/status');
console.log(`vegas: provider=${vegas.provider} cached=${vegas.cachedProvider} fetchedAt=${vegas.fetchedAt} events=${JSON.stringify(vegas.events)?.slice(0, 200)}`);

/*
 * When each game was last bought, from the app's own spend ledger. Free: it is
 * a read of this app's database, not of the provider.
 */
const budget = await get('/api/vegas/budget');
if (budget.__error) console.log('budget:', budget.__error);
else {
  console.log('\nlast ten odds purchases (newest first):');
  for (const r of budget.recent ?? []) {
    console.log(`  ${r.at}  ${String(r.source).padEnd(9)} ${String(r.outcome).padEnd(8)} event=${r.eventId ?? '-'}  ${String(r.reason ?? '').slice(0, 90)}`);
  }
  console.log('next plan (what a refresh would buy now):');
  for (const e of budget.nextPlan?.events ?? []) {
    console.log(`  ${e.eventId}  kickoff=${e.kickoff}  ${e.priority}  ${String(e.reason).slice(0, 100)}`);
  }
  console.log(`  skipped players: ${budget.nextPlan?.skipped ?? '?'}`);
}

// --------------------------------------------------------------------- part 1
console.log('\n=== 1. the lineup the Team screen is drawn from ===');
const [roster, lineup] = await Promise.all([get(`/api/leagues/${league.id}/roster`), get(`/api/leagues/${league.id}/lineup`)]);
if (lineup.__error || roster.__error) {
  console.log('  ', lineup.__error ?? roster.__error);
} else {
  const nameOf = new Map();
  const positionOf = new Map();
  for (const group of ['starters', 'bench', 'players', 'reserve']) {
    for (const p of roster[group] ?? []) {
      nameOf.set(p.playerId, p.name ?? p.fullName ?? p.playerId);
      if (p.position) positionOf.set(p.playerId, p.position);
    }
  }
  const evals = [...(lineup.starters ?? []), ...(lineup.bench ?? []), ...(lineup.undecidable ?? [])];
  for (const e of evals) {
    nameOf.set(e.playerId, e.name);
    if (e.position) positionOf.set(e.playerId, e.position);
  }
  const who = (id) => (id == null ? '(empty)' : `${nameOf.get(id) ?? id} [${positionOf.get(id) ?? '?'}]`);

  const labels = (roster.rosterPositions ?? league.rosterPositions ?? [])
    .map((p) => String(p ?? '').toUpperCase())
    .filter((p) => p && !['BN', 'IR', 'TAXI'].includes(p));
  const slotIds = roster.starterSlotIds ?? [];
  console.log("  Sleeper's lineup:");
  labels.forEach((label, i) => console.log(`    ${label.padEnd(6)} ${who(slotIds[i] ?? null)}`));

  console.log("\n  the app's slots (slot | accepts | player | proj/source | alreadyStarting):");
  for (const s of lineup.slots ?? []) {
    console.log(
      `    ${String(s.slot).padEnd(6)} ${JSON.stringify(s.accepts).padEnd(22)} ${who(s.playerId).padEnd(34)} ` +
        `${fmt(s.projection)}/${s.projectionSource ?? '-'}  ${s.alreadyStarting ? 'starting' : 'NEW'}`,
    );
  }

  console.log('\n  swaps the optimiser returned (slot | in | out | gain) and whether the slot accepts the man it benches:');
  const acceptsOf = new Map((lineup.slots ?? []).map((s) => [String(s.slot), s.accepts ?? []]));
  let illegal = 0;
  for (const s of lineup.swaps ?? []) {
    const outPos = positionOf.get(s.outPlayerId) ?? '?';
    const inPos = positionOf.get(s.inPlayerId) ?? '?';
    const accepts = acceptsOf.get(String(s.slot)) ?? [];
    const legal = accepts.includes(outPos) && accepts.includes(inPos);
    if (!legal) illegal += 1;
    console.log(
      `    ${legal ? 'ok     ' : 'ILLEGAL'} ${String(s.slot).padEnd(6)} in ${who(s.inPlayerId).padEnd(30)} out ${who(s.outPlayerId).padEnd(34)} +${s.gain}` +
        (legal ? '' : `   (${s.slot} accepts ${JSON.stringify(accepts)}; ${inPos} in for ${outPos})`),
    );
  }
  if ((lineup.swaps ?? []).length === 0) console.log('    (none)');
  console.log(`  ${illegal} swap(s) pair two players who cannot share the slot named`);

  const rows = buildLineupVerdicts({
    rosterPositions: roster.rosterPositions ?? league.rosterPositions ?? [],
    starterIds: (roster.starters ?? []).map((p) => p.playerId),
    ...(roster.starterSlotIds ? { starterSlotIds: roster.starterSlotIds } : {}),
    slots: lineup.slots ?? [],
    suggestedSwaps: lineup.swaps ?? [],
    positionOf: (id) => positionOf.get(id) ?? null,
  });
  console.log('\n  what the rows say (this revision\'s buildLineupVerdicts over the live payload):');
  for (const row of rows) {
    const tail = row.verdict === 'swap' || row.verdict === 'fill' ? ` → ${who(row.recommendedPlayerId)} · ${fmt(row.projection)}` : '';
    console.log(`    ${row.slot.padEnd(6)} ${who(row.currentPlayerId).padEnd(34)} ${row.verdict.padEnd(8)}${tail}`);
  }

  console.log('\n  market breakdown for every evaluated player (points | coverage | markets used | missing):');
  for (const e of evals) {
    const x = e.expectation ?? {};
    const used = (x.contributions ?? []).map((c) => `${c.market}=${c.line ?? '-'}→${c.points}`).join(', ');
    console.log(
      `    ${String(e.name).padEnd(24)} ${String(e.position).padEnd(4)} exp=${fmt(x.points).padEnd(6)} cov=${x.coverage == null ? '—' : Math.round(x.coverage * 100) + '%'}`.padEnd(58) +
        ` used[${used}] missing${JSON.stringify(x.missingMarkets ?? [])} score=${fmt(e.score)}`,
    );
  }
}

console.log('\n=== 1b. the Matchup screen\'s cards for the three players ===');
const matchup = await get(`/api/leagues/${league.id}/matchup`);
if (matchup.__error) console.log('  ', matchup.__error);
else {
  console.log(`  week ${matchup.week}  found=${matchup.found}`);
  for (const card of Object.values(matchup.cards ?? {})) {
    if (!WATCH.includes(card.name)) continue;
    console.log(
      `  ${card.name.padEnd(22)} proj=${fmt(card.score)}/${card.projectionSource ?? '-'} ` +
        `lines=${JSON.stringify((card.lines ?? []).map((l) => `${l.label}:${l.value}`))} ` +
        `props=${JSON.stringify((card.props ?? []).map((p) => `${p.label}:${p.value}`))} pending=${JSON.stringify(card.pending)}`,
    );
  }
}

// --------------------------------------------------------------------- part 2
console.log('\n=== 2. what the odds provider actually posts ===');
if (!KEY) {
  console.log('  SPORTSGAMEODDS_API_KEY is not set for this run — part 2 skipped.');
  process.exit(0);
}

async function sgo(path) {
  const res = await fetch(`${SGO}${path}`, { headers: { 'X-Api-Key': KEY, accept: 'application/json' } });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null };
  }
}
async function used() {
  const r = await sgo('/account/usage');
  return r.json?.data?.rateLimits?.['per-month']?.['current-entities'] ?? null;
}

const start = await used();
console.log(`  month so far: ${start} entities`);
const from = new Date().toISOString().slice(0, 10);
const to = new Date(Date.now() + 8 * 86_400_000).toISOString().slice(0, 10);
/*
 * The first run of this probe (24 September, 02:16 UTC) read the Patriots,
 * Falcons, Bengals and Chiefs games and found every one carrying yardage,
 * receptions and touchdown markets. The Patriots alone is enough to re-check.
 */
const teams = (process.env.PROBE_TEAMS ?? 'NEW_ENGLAND_PATRIOTS_NFL').split(',').filter(Boolean);
const events = [];
for (const team of teams) {
  if (events.length >= MAX_ENTITIES) break;
  const r = await sgo(`/events?leagueID=NFL&type=match&teamID=${team}&startsAfter=${from}&startsBefore=${to}&oddsAvailable=true&limit=1`);
  for (const e of r.json?.data ?? []) if (!events.some((x) => x.eventID === e.eventID)) events.push(e);
}
const end = await used();
console.log(`  ${events.length} event(s) read, cost ${start != null && end != null ? end - start : '?'} entities`);

const nameOfPlayer = (players, id) => {
  const p = players?.[id];
  return p?.name ?? ([p?.firstName, p?.lastName].filter(Boolean).join(' ') || id);
};

for (const event of events) {
  const sides = Object.values(event.teams ?? {}).map((t) => t.teamID).join(' v ');
  console.log(`\n  --- ${sides}  starts ${event.status?.startsAt}  eventID=${event.eventID}`);

  /* Census: for each statID on a player, how many players carry it, by bet type and side. */
  const census = new Map();
  for (const odd of Object.values(event.odds ?? {})) {
    const entity = odd.playerID ?? odd.statEntityID ?? '';
    if (!entity || ['all', 'side1', 'side2', 'home', 'away'].includes(entity)) continue;
    if (odd.periodID !== 'game') continue;
    const k = `${odd.statID} ${odd.betTypeID}/${odd.sideID}`;
    const set = census.get(k) ?? new Set();
    set.add(entity);
    census.set(k, set);
  }
  const interesting = /^(passing_yards|passing_touchdowns|rushing_yards|receiving_yards|receiving_receptions|receptions|touchdowns|rushing_touchdowns|receiving_touchdowns|fantasyScore) /;
  console.log('    players carrying each full-game market (statID bet/side: count):');
  for (const [k, set] of [...census].filter(([k]) => interesting.test(k)).sort()) {
    console.log(`      ${k.padEnd(40)} ${set.size}`);
  }

  /* The three players, every full-game market they carry. */
  for (const want of WATCH) {
    const rows = [];
    for (const odd of Object.values(event.odds ?? {})) {
      const entity = odd.playerID ?? odd.statEntityID ?? '';
      if (!entity || nameOfPlayer(event.players, entity) !== want) continue;
      if (odd.periodID !== 'game') continue;
      rows.push(
        `${odd.statID} ${odd.betTypeID}/${odd.sideID} line=${odd.bookOverUnder ?? odd.fairOverUnder ?? '-'} odds=${odd.bookOdds ?? odd.fairOdds ?? '-'}` +
          ` books=${Object.keys(odd.byBookmaker ?? {}).length}${odd.cancelled ? ' CANCELLED' : ''}`,
      );
    }
    if (rows.length === 0) continue;
    console.log(`    ${want}: ${rows.length} full-game quote(s)`);
    for (const r of rows.sort()) console.log(`      ${r}`);
  }

  /* The same event through this revision's adapter: what the app keeps. */
  const provider = new SportsGameOddsProvider({
    apiKey: 'probe',
    fetch: async () => new Response(JSON.stringify({ data: [event] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const set = await provider.getPlayerProps(event.eventID);
  for (const want of WATCH) {
    const kept = set.quotes.filter((q) => q.playerName === want);
    if (kept.length === 0 && !Object.values(event.players ?? {}).some((p) => nameOfPlayer({ x: p }, 'x') === want)) continue;
    console.log(`    adapter keeps for ${want}: ${kept.map((q) => `${q.market}=${q.line ?? '-'}@${q.overPrice ?? '-'}`).join(', ') || '(nothing)'}`);
  }

  /*
   * The rest of the pipeline over the same board: consensus, then the
   * expectation under this league's scoring. This is what the app would print
   * if it bought this game now.
   */
  const positions = { 'Drake Maye': 'QB', 'Rhamondre Stevenson': 'RB', 'TreVeyon Henderson': 'RB' };
  const index = new PlayerIndex(
    WATCH.map((name, i) => ({
      id: `p${i}`,
      sleeperPlayerId: null,
      fullName: name,
      firstName: name.split(' ')[0],
      lastName: name.split(' ').slice(1).join(' '),
      team: 'NE',
      position: positions[name],
      status: null,
      active: true,
      normalizedName: '',
      aliases: [],
    })),
  );
  const consensus = buildConsensus(set.quotes, index);
  const settings = league.scoringSettings ?? null;
  const profile = settings
    ? buildScoringProfile(settings, league.rosterPositions ?? [])
    : buildScoringProfile({ rec: 0.5, pass_td: 6 }, []);
  console.log(`    scoring: ${settings ? 'the league\'s own settings' : 'fallback half-PPR, 6-pt pass TD'} (passTd=${profile.passTd} ppr=${profile.ppr})`);
  WATCH.forEach((name, i) => {
    const props = consensus.filter((p) => p.playerId === `p${i}`);
    const x = buildExpectation(positions[name], props, profile);
    console.log(
      `    fresh-board expectation ${name.padEnd(20)} ${fmt(x.points).padEnd(6)} cov=${Math.round(x.coverage * 100)}% ` +
        `[${x.contributions.map((c) => `${c.market}→${c.points}`).join(', ')}] missing${JSON.stringify(x.missingMarkets)}`,
    );
  });
}
