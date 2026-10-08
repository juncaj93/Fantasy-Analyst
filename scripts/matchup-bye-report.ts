/**
 * The live Matchup forecast, replayed with and without bye weeks.
 *
 *   node --experimental-transform-types --no-warnings scripts/matchup-bye-report.ts snapshot.json live.json
 *
 * `snapshot.json` is the public `matchup` support snapshot; `live.json` is the
 * live `/api/leagues/:id/matchup` response captured beside it. The snapshot
 * records every read the forecast made except the preseason tier, so that one
 * is rebuilt from the live response: a player drawn as an estimate carries his
 * preseason season total over sixteen games, so the total is his figure × 16.
 *
 * Who is on a bye is read the way the new code reads it, from the fixture list
 * the inputs were built on: when most players in the request have an opponent
 * the list was loaded, and a player with a club and no opponent is resting.
 * The flag is set on the inputs; code that predates it ignores it, so the same
 * file replays the old behaviour on an old checkout and the new one here.
 */

import { readFileSync } from 'node:fs';
import { buildMatchupResponse } from '../src/core/matchup/build.ts';
import { snapshotMatchupSources } from '../src/core/support/matchupSnapshot.ts';
import { EXPECTED_GAMES } from '../src/core/nfl/expectedGames.ts';

const [snapshotPath, livePath] = process.argv.slice(2);
if (!snapshotPath || !livePath) {
  console.error('usage: matchup-bye-report.ts snapshot.json live.json');
  process.exit(1);
}
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
const live = JSON.parse(readFileSync(livePath, 'utf8'));

const sources = snapshotMatchupSources(snapshot);

const livePlayers = [
  ...(live.forecast?.slots ?? []).flatMap((s: { mine: unknown; theirs: unknown }) => [s.mine, s.theirs]),
  ...(live.forecast?.bench?.mine ?? []),
  ...(live.forecast?.bench?.theirs ?? []),
].filter((p: unknown): p is { playerId: string; projectedFinal: number | null; projectionEstimated?: boolean } => p != null);
const preseason = new Map<string, number>();
for (const p of livePlayers) {
  if (p.projectionEstimated && p.projectedFinal != null) preseason.set(p.playerId, p.projectedFinal * EXPECTED_GAMES);
}
sources.preseasonProjections = async ({ playerIds }) =>
  new Map([...preseason].filter(([id]) => playerIds.includes(id)));

const original = sources.startSitInputs;
let resting: string[] = [];
sources.startSitInputs = async (ids) => {
  const inputs = await original(ids);
  const withOpponent = inputs.filter((i) => i.opponent != null).length;
  const loaded = inputs.length > 0 && withOpponent / inputs.length >= 0.75;
  resting = loaded ? inputs.filter((i) => (i.player.team ?? '') !== '' && i.opponent == null).map((i) => i.player.fullName) : [];
  return inputs.map((i) => (loaded && (i.player.team ?? '') !== '' && i.opponent == null ? { ...i, onBye: true } : i));
};

const leagueId = snapshot.decision.inputs.league.id;
const response = await buildMatchupResponse(sources, leagueId, { week: snapshot.decision.inputs.week ?? null });
const f = response.forecast;
console.log(`captured ${snapshot.capturedAt}  week ${response.week}`);
console.log(`players with no game this week (read from the fixture list): ${resting.join(', ') || 'none'}`);
if (!f) {
  console.log(`no forecast: ${response.reason}`);
  process.exit(0);
}
const pct = (v: number | null | undefined) => (v == null ? '-' : `${Math.round(v * 100)}%`);
console.log(`projected final: mine ${f.teams.mine.projectedFinal?.toFixed(1)} · theirs ${f.teams.theirs.projectedFinal?.toFixed(1)}`);
console.log(`win probability: mine ${pct(f.teams.mine.winProbability)}`);
const best = f.decision?.best;
console.log(
  best
    ? `best move: start ${best.inName} over ${best.outName} (${best.slot}) · ${best.pointsDelta >= 0 ? '+' : ''}${best.pointsDelta.toFixed(1)} pts · ${pct(best.winNow)} -> ${pct(best.winAfter)}`
    : `best move: hold (${f.decision?.note ?? 'no change clears the bar'})`,
);
for (const o of f.decision?.options ?? []) {
  console.log(`  option: start ${o.inName} over ${o.outName} (${o.slot}) · ${o.pointsDelta.toFixed(1)} pts · ${pct(o.winAfter)}`);
}
console.log('\nstarters (slot, mine, theirs)');
for (const s of f.slots) {
  const cell = (p: typeof s.mine) =>
    p == null ? '(empty)' : `${p.name} ${p.onBye ? 'BYE' : p.projectedFinal == null ? '-' : p.projectedFinal.toFixed(1)}${p.projectionEstimated ? ' (est)' : ''}`;
  console.log(`  ${s.slot.padEnd(5)} ${cell(s.mine).padEnd(28)} ${cell(s.theirs)}`);
}
