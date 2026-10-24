/**
 * Backtest: Questionable at full value against Questionable discounted.
 *
 *   node --experimental-transform-types --no-warnings scripts/numbers-agree-backtest.ts <dir>
 *
 * Reads `<dir>/backtest-inputs.json` (from `startsit-round2-build.ts`: every
 * fully priced player-week of the completed weeks, as the engine saw it before
 * kickoff, with league-scored actual points) and, through the read-only D1
 * adapter, the stored weekly injury reports (`player_injury_reports`). For
 * every player-week the report listed Questionable it prints the average miss
 * (|number − actual points|) three ways:
 *
 *  - full value: the decision number, which is what every screen now shows;
 *  - discounted flat: that number times 0.616, Matchup's old "uncertain" mix;
 *  - discounted by practice: Matchup's old mix by the week's practice status
 *    (full 1.0, limited 0.864, did not practice 0.264, unknown 0.616).
 *
 * The status is taken from the stored report for that week, never from today's
 * player row, so the evaluation is made with no designation and the rule is
 * applied on top. Information only: Alex has decided the rule.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { d1Http } from './lib/d1Http.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { evaluatePlayer } from '../src/core/startsit/engine.ts';
import { decisionPoints } from '../src/core/startsit/decisionPoints.ts';
import { rehydrateStartSitInputs } from '../src/core/support/inseason.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: numbers-agree-backtest.ts <dir>');
const bt = JSON.parse(readFileSync(join(dir, 'backtest-inputs.json'), 'utf8'));
const profile = buildScoringProfile(bt.scoring, bt.rosterPositions);

type Report = { player_id: string; week: number; report_status: string | null; practice_status: string | null };
/* LOCAL_SEED=1: a dry run over the harness's seeded inputs, every item read as Questionable and limited. */
const reports: Report[] = process.env.LOCAL_SEED
  ? (bt.items as { week: number; playerId: string }[]).map((i) => ({ player_id: i.playerId, week: i.week, report_status: 'Questionable', practice_status: 'limited' }))
  : await (async () => {
      const db = await d1Http();
      const rows = await db
        .prepare('SELECT player_id, week, report_status, practice_status FROM player_injury_reports WHERE season = ?')
        .bind(String(bt.season))
        .all<Report>();
      console.log(`D1 rows read for the injury reports: ${db.rowsRead()}`);
      return rows.results;
    })();
const status = new Map(reports.map((r) => [`${r.week}:${r.player_id}`, r]));
console.log(`injury reports stored for ${bt.season}: ${reports.length} player-weeks`);

const PRACTICE_MIX: Record<string, number> = { full: 1, limited: 0.864, dnp: 0.264, unknown: 0.616 };
const misses = { full: [] as number[], flat: [] as number[], practice: [] as number[] };
const weeks = new Set<number>();
const players = new Set<string>();
const inputs = new Map<number, ReturnType<typeof rehydrateStartSitInputs>>();
for (const [w, bundle] of Object.entries(bt.bundles)) inputs.set(Number(w), rehydrateStartSitInputs(bundle as never));

for (const item of bt.items as { week: number; idx: number; playerId: string; actual: number }[]) {
  const report = status.get(`${item.week}:${item.playerId}`);
  if (!/^questionable$/i.test(report?.report_status ?? '')) continue;
  const input = inputs.get(item.week)?.[item.idx];
  if (!input) continue;
  const e = evaluatePlayer({ ...input, injuryStatus: null, injury: null, player: { ...input.player, status: null } } as never, profile);
  const number = decisionPoints(e)?.points;
  if (number == null) continue;
  const full = Math.max(0, number);
  misses.full.push(Math.abs(full - item.actual));
  misses.flat.push(Math.abs(full * 0.616 - item.actual));
  misses.practice.push(Math.abs(full * (PRACTICE_MIX[report?.practice_status ?? 'unknown'] ?? 0.616) - item.actual));
  weeks.add(item.week);
  players.add(item.playerId);
}

const mean = (xs: number[]) => (xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000);
console.log(`Questionable player-weeks priced and played out: ${misses.full.length}, ${players.size} players, weeks ${[...weeks].sort((a, b) => a - b).join(', ') || 'none'}`);
console.log(`average miss, full value:            ${mean(misses.full) ?? '-'}`);
console.log(`average miss, discounted flat 0.616: ${mean(misses.flat) ?? '-'}`);
console.log(`average miss, discounted by practice: ${mean(misses.practice) ?? '-'}`);
