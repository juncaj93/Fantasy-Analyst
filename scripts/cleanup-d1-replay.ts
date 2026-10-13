/**
 * Cleanup round replays on the real stored data (read-only).
 *
 *   node --experimental-transform-types --no-warnings scripts/cleanup-d1-replay.ts
 *
 * Needs CLOUDFLARE_API_TOKEN (and ACCOUNT_ID). Runs the app's own services
 * against production D1 through the REST API and prints D1's rows_read.
 *
 *   1. Vegas staleness read (item 6b): the odds job's planner, with the
 *      staleness read as it was and as it is now, over the same stored data.
 *      Requires identical plans and ages, in both the ordinary pass and the
 *      kickoff-clock pass.
 *   2. Depth chart captures: the old DISTINCT scan and the new seeks.
 *   3. Trades ideas (item T5): where the time goes, and the board with its
 *      season verdicts before and after, which must be identical.
 */

import { createHash } from 'node:crypto';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { MOCK_GAMES } from '../src/devserver/seed.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { applySeasonChecks } from '../src/core/trades/seasonCheck.ts';
import { DepthChartRepo } from '../src/server/repos/nflverse.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { TradeValueService } from '../src/server/services/tradeValueService.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { SmartTradeService } from '../src/server/services/smartTradeService.ts';
import { seasonChecksFor } from '../src/server/services/tradeIdeaCheck.ts';
import { VegasRefreshService } from '../src/server/services/vegasRefresh.ts';
import { openRestD1, topStatements } from './lib/restD1.ts';

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.error('CLOUDFLARE_API_TOKEN is not set.');
  process.exit(1);
}
const n = (v: number) => Math.round(v).toLocaleString('en-GB');
const hash = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12);

type Internals = {
  props: PropsRepo;
  rosterPlayers(now: number, byEvent?: boolean): Promise<unknown[]>;
  snapshotAges: unknown;
};

/** The staleness read as it was before this round. */
async function legacySnapshotAges(
  this: Internals,
  eventOf: ReadonlyMap<string, { eventId: string } | null>,
  now: number,
  byEvent: boolean,
): Promise<Map<string, number>> {
  const playerIds = [...eventOf.keys()];
  const eventIds = [...eventOf.values()].map((e) => e?.eventId).filter((id): id is string => id != null);
  const [props, fetched] = await Promise.all([this.props.latestForPlayers(playerIds), this.props.newestFetchByEvent(eventIds)]);
  const out = new Map<string, number>();
  for (const id of playerIds) {
    if (!byEvent && (props.get(id)?.length ?? 0) === 0) continue;
    const eventId = eventOf.get(id)?.eventId;
    const at = eventId ? Date.parse(fetched.get(eventId) ?? '') : NaN;
    if (Number.isFinite(at)) out.set(id, (now - at) / 60_000);
  }
  return out;
}

async function vegasReplay(): Promise<void> {
  console.log('\n=== 6b. Vegas staleness read, planner replayed on the real stored data ===');
  const now = Date.now();
  const provider = new MockVegasProvider(MOCK_GAMES);
  let allSame = true;
  for (const byEvent of [false, true]) {
    const before = await openRestD1(token!, process.env.ACCOUNT_ID);
    const legacy = new VegasRefreshService(before.db, provider) as unknown as Internals;
    legacy.snapshotAges = legacySnapshotAges.bind(legacy);
    const a = await legacy.rosterPlayers(now, byEvent);

    const after = await openRestD1(token!, process.env.ACCOUNT_ID);
    const current = new VegasRefreshService(after.db, provider) as unknown as Internals;
    const b = await current.rosterPlayers(now, byEvent);

    const same = JSON.stringify(a) === JSON.stringify(b);
    allSame &&= same;
    const ageRead = (log: typeof before.log) =>
      log.filter((l) => /FROM player_props pp|MAX\(fetched_at\) AS fetched_at FROM prop_snapshots/.test(l.sql));
    const rb = ageRead(before.log).reduce((s, l) => s + l.rowsRead, 0);
    const ra = ageRead(after.log).reduce((s, l) => s + l.rowsRead, 0);
    const callsB = ageRead(before.log).length;
    const callsA = ageRead(after.log).length;
    for (const l of after.log.filter((l) => /EXISTS \(SELECT 1 FROM player_props/.test(l.sql))) {
      console.log(`    players with no line in the slate checked for any quote: ${l.rowsReturned} of them have one on file (${n(l.rowsRead)} rows read)`);
    }
    console.log(
      `  ${byEvent ? 'kickoff-clock pass' : 'ordinary pass     '}: ${a.length} planned players, plans ${same ? 'IDENTICAL' : 'DIFFERENT'} ` +
        `(sha ${hash(a)} / ${hash(b)}); staleness read ${n(rb)} rows in ${callsB} statements before, ${n(ra)} in ${callsA} after`,
    );
    if (!same) {
      const x = a as any[];
      const y = b as any[];
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if (JSON.stringify(x[i]) !== JSON.stringify(y[i])) {
          console.log(`    first difference at ${i}:\n      before ${JSON.stringify(x[i])}\n      after  ${JSON.stringify(y[i])}`);
          break;
        }
      }
    }
  }
  console.log(`  RESULT: ${allSame ? 'identical decisions' : 'DECISIONS DIFFER, DO NOT SHIP'}`);
}

async function depthReplay(): Promise<void> {
  console.log('\n=== Depth chart captures: DISTINCT scan vs seeks ===');
  const rest = await openRestD1(token!, process.env.ACCOUNT_ID);
  const season = String(new Date().getUTCFullYear());
  const m0 = rest.mark();
  const old = await rest.db
    .prepare('SELECT DISTINCT captured_at FROM depth_chart_entries WHERE season = ? ORDER BY captured_at DESC')
    .bind(season)
    .all<{ captured_at: string }>();
  const oldCost = rest.since(m0);
  const m1 = rest.mark();
  const now = await new DepthChartRepo(rest.db).captures(season);
  const newCost = rest.since(m1);
  const same = JSON.stringify(old.results.map((r) => r.captured_at)) === JSON.stringify(now);
  console.log(`  season ${season}: ${now.length} captures, lists ${same ? 'IDENTICAL' : 'DIFFERENT'}; before ${n(oldCost.rowsRead)} rows, after ${n(newCost.rowsRead)} rows`);
}

async function tradesReplay(): Promise<void> {
  console.log('\n=== T5. Trades ideas: where the time goes, and before vs after ===');
  const sleeper = new SleeperClient({
    fetch: async (url: string) => {
      throw new Error(`the trade check must not call Sleeper: ${url}`);
    },
  });

  // BEFORE: the board, then the check reading every player again.
  const a = await openRestD1(token!, process.env.ACCOUNT_ID);
  let t = Date.now();
  const boardA = await new SmartTradeService(a.db).build({ limit: 5 });
  const boardAMs = Date.now() - t;
  const mA = a.mark();
  t = Date.now();
  const checksA = await seasonChecksFor(a.db, sleeper, boardA.league?.id, boardA.offers);
  const checkAMs = Date.now() - t;
  const checkACost = a.since(mA);
  const finalA = applySeasonChecks(boardA, checksA).board;

  // AFTER: the board keeps its inputs; the check reads only the free agents.
  const b = await openRestD1(token!, process.env.ACCOUNT_ID);
  t = Date.now();
  const { board: boardB, inputs } = await new SmartTradeService(b.db).buildWithInputs({ limit: 5 });
  const boardBMs = Date.now() - t;
  const mB = b.mark();
  t = Date.now();
  const checksB = await seasonChecksFor(b.db, sleeper, boardB.league?.id, boardB.offers, inputs);
  const checkBMs = Date.now() - t;
  const checkBCost = b.since(mB);
  const finalB = applySeasonChecks(boardB, checksB).board;

  console.log(`  ideas on the board: ${boardA.offers.length} before the season check, ${finalA.offers.length} kept`);
  console.log(`  board build:   before ${boardAMs} ms, after ${boardBMs} ms (same code; REST round trips, not Worker time)`);
  console.log(`  season check:  before ${checkAMs} ms, ${checkACost.statements} statements, ${n(checkACost.rowsRead)} rows read`);
  console.log(`                 after  ${checkBMs} ms, ${checkBCost.statements} statements, ${n(checkBCost.rowsRead)} rows read`);
  const same = JSON.stringify(finalA) === JSON.stringify(finalB) && JSON.stringify([...checksA]) === JSON.stringify([...checksB]);
  console.log(`  ideas and verdicts: ${same ? 'IDENTICAL' : 'DIFFERENT'} (sha ${hash([finalA, [...checksA]])} / ${hash([finalB, [...checksB]])}), ${checksA.size} verdicts`);
  console.log('  where the board build spent its time (top statements by time):');
  for (const line of topStatements(a.log.slice(0, mA))) console.log('    ' + line);
  console.log('  where the check spent its time before (top statements by time):');
  for (const line of topStatements(a.log.slice(mA))) console.log('    ' + line);
  console.log('  and after:');
  for (const line of topStatements(b.log.slice(mB))) console.log('    ' + line);
  if (!same) console.log('  RESULT: OUTPUT DIFFERS, DO NOT SHIP');

  // The board is empty on some days (nothing passes the gates), so the check
  // has nothing to do. Replay it on deals built from the real rosters instead.
  const leagueId = boardA.league?.id;
  if (leagueId) {
    const rosters = await new LeagueRepo(a.db).listRosters(leagueId);
    const mine = rosters.find((r) => r.isMine);
    const ideas = mine
      ? rosters
          .filter((r) => !r.isMine && r.playerIds.length > 0)
          .flatMap((partner) =>
            mine.playerIds.slice(0, 3).flatMap((give, i) =>
              partner.playerIds.slice(0, 2).map((get, j) => ({
                id: `${partner.rosterId}-${i}-${j}`,
                partnerRosterId: partner.rosterId,
                give: [give],
                get: [get],
              })),
            ),
          )
          .slice(0, 12)
      : [];
    if (ideas.length > 0) {
      console.log(`\n  the check on ${ideas.length} deals built from the real rosters (the board had ${boardA.offers.length} ideas today):`);
      const c = await openRestD1(token!, process.env.ACCOUNT_ID);
      const { inputs: boardInputs } = await new SmartTradeService(c.db).buildWithInputs({ limit: 5 });
      const mC = c.mark();
      t = Date.now();
      const before = await new TradeValueService(c.db, sleeper).checkIdeas(leagueId, ideas);
      const beforeMs = Date.now() - t;
      const beforeCost = c.since(mC);
      const d = await openRestD1(token!, process.env.ACCOUNT_ID);
      const { inputs: boardInputs2 } = await new SmartTradeService(d.db).buildWithInputs({ limit: 5 });
      const mD = d.mark();
      t = Date.now();
      const after = await new TradeValueService(d.db, sleeper).checkIdeas(leagueId, ideas, boardInputs2);
      const afterMs = Date.now() - t;
      const afterCost = d.since(mD);
      const sameChecks = JSON.stringify([...before]) === JSON.stringify([...after]);
      console.log(`    before: ${beforeMs} ms, ${beforeCost.statements} statements, ${n(beforeCost.rowsRead)} rows read, ${before.size} verdicts`);
      console.log(`    after:  ${afterMs} ms, ${afterCost.statements} statements, ${n(afterCost.rowsRead)} rows read, ${after.size} verdicts`);
      console.log(`    verdicts: ${sameChecks ? 'IDENTICAL' : 'DIFFERENT, DO NOT SHIP'} (sha ${hash([...before])} / ${hash([...after])}); board inputs held ${boardInputs.length} players`);
      console.log('    before, top statements by time:');
      for (const line of topStatements(c.log.slice(mC))) console.log('      ' + line);
      console.log('    after:');
      for (const line of topStatements(d.log.slice(mD))) console.log('      ' + line);
    }
  }
}

const only = process.argv[2];
if (!only || only === 'vegas') await vegasReplay();
if (!only || only === 'depth') await depthReplay();
if (!only || only === 'trades') await tradesReplay();
