/**
 * What the Waivers page says on the live board, and that its decision did not move.
 *
 *   node --experimental-transform-types --no-warnings scripts/waiver-no-move-report.ts snapshot.json
 *
 * Replays a `waiver-plan` support snapshot through the real `assembleWaiverPlan`
 * and prints the decision (plan state, claims, how many rows of each kind) and,
 * where this checkout has `core/waivers/noMove.ts`, the empty-state wording the
 * screen now draws from it. Run on the code before and after: the decision
 * lines must be identical, and only the wording lines may appear.
 */

import { readFileSync } from 'node:fs';
import { assembleWaiverPlan } from '../src/core/waivers/assemble.ts';
import { buildWaiverBoard } from '../src/core/waivers/board.ts';
import { snapshotDstSources } from '../src/core/support/dstSnapshot.ts';
import { rehydrateLeagueRules, rehydrateStartSitInputs } from '../src/core/support/inseason.ts';
import { rehydratePlayer } from '../src/core/support/players.ts';

const file = process.argv[2]!;
const snapshot = JSON.parse(readFileSync(file, 'utf8'));
const inputs = snapshot.decision.inputs;
const { shape, profile } = rehydrateLeagueRules(inputs.rules);

const decision = await assembleWaiverPlan({
  shape,
  profile,
  rosterInputs: rehydrateStartSitInputs(inputs.roster),
  candidateInputs: rehydrateStartSitInputs(inputs.candidates),
  rosteredIds: new Set(inputs.rosteredIds as string[]),
  currentStarterIds: inputs.currentStarterIds,
  reserveIds: inputs.reserveIds,
  ...(inputs.preseasonPoints === undefined ? {} : { preseasonPoints: new Map(Object.entries(inputs.preseasonPoints)) }),
  ...(inputs.draftRankOf === undefined ? {} : { draftRankOf: new Map(Object.entries(inputs.draftRankOf)) }),
  ...(inputs.published === undefined ? {} : { published: new Map(Object.entries(inputs.published)) }),
  /* Not on a file captured before this round: read from the league's own scoring instead, as the gatherer does. */
  refusedPositions: inputs.refusedPositions ?? (profile.passTd !== 4 || profile.interception !== -1 ? ['QB'] : []),
  ...(inputs.depth === undefined ? {} : { depth: new Map(Object.entries(inputs.depth)) }),
  ...(inputs.trendingDrops === undefined ? {} : { trendingDrops: new Map(inputs.trendingDrops) }),
  ...(inputs.recentlyDropped === undefined ? {} : { recentlyDropped: new Map(Object.entries(inputs.recentlyDropped)) }),
  ...(inputs.waiverWindow == null
    ? {}
    : { waiverWindow: { rules: inputs.waiverWindow.rules, drops: new Map(Object.entries(inputs.waiverWindow.drops)) } }),
  rosters: inputs.rosters,
  players: inputs.players.map(rehydratePlayer),
  week: inputs.week,
  season: inputs.season,
  strategy: inputs.strategy == null ? null : { ...inputs.strategy, trending: new Map(inputs.strategy.trending) },
  trending: inputs.strategy == null ? undefined : new Map(inputs.strategy.trending),
  ...(inputs.seasonMarkets == null ? {} : { seasonMarkets: new Map(inputs.seasonMarkets) }),
  budgets: inputs.budgets,
  prices: inputs.prices,
  observations: inputs.observations,
  ...(inputs.history == null
    ? {}
    : { history: { profiles: new Map(inputs.history.profiles), baseline: inputs.history.baseline, week: inputs.history.week, finalWeek: inputs.history.finalWeek } }),
  dstSources: inputs.dst == null ? null : snapshotDstSources(inputs.dst),
  bestBall: inputs.bestBall,
  draftComplete: inputs.draftComplete,
  playoff: inputs.playoff,
  now: new Date(Date.parse(snapshot.capturedAt)),
  generatedAt: inputs.generatedAt,
} as never);

const board = buildWaiverBoard({ ...decision, faab: { bids: decision.bids }, pickup: decision.pickup } as never);
const level = (l: string) => board.rows.filter((r) => r.strength.level === l).length;
console.log(`week ${inputs.week}  captured ${snapshot.capturedAt}`);
console.log('DECISION');
console.log(`  plan state ${decision.claimPlan?.state}  surfaced ${decision.claimPlan?.surface}  claims ${decision.claimPlan?.claims.length ?? 0}`);
for (const c of decision.claimPlan?.claims ?? []) console.log(`  claim ${c.rank}. ${c.headline}  drop ${c.dropName ?? '-'}`);
console.log(`  upgrades ${decision.upgrades.length}  value adds ${decision.valueAdds.length}  unscored ${decision.unknowns.length}`);
console.log(`  board rows: strong ${level('strong')} solid ${level('solid')} speculative ${level('speculative')} value ${level('value')} unscored ${level('unknown')}`);
for (const r of board.rows) console.log(`  row ${r.name} (${r.position}) ${r.strength.label} · Proj. ${r.shortTerm.label}`);

console.log('WHAT THE SCREEN SAYS');
try {
  const noMove = await import('../src/core/waivers/noMove.ts');
  const claimed = new Set((decision.claimPlan?.claims ?? []).map((c) => c.addPlayerId));
  const recommended = board.rows.filter((r) => claimed.has(r.playerId) || r.dst != null);
  if (!decision.claimPlan?.surface && recommended.length === 0) {
    const summary = noMove.noMoveSummary(decision as never);
    console.log(`  ${summary.headline}`);
    if (summary.detail) console.log(`  ${summary.detail}`);
    if (summary.nearest) console.log(`  ${summary.nearest}`);
  } else {
    console.log('  (a plan is drawn; the empty-state card is not shown)');
  }
  for (const note of noMove.unscoredNotes(board.rows.filter((r) => r.strength.level === 'unknown') as never)) console.log(`  unscored: ${note}`);
} catch {
  console.log('  (this checkout has no empty-state wording: the page drew "Recommended move" over nothing)');
}
