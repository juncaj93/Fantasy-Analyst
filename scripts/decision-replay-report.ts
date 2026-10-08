/**
 * The decisions a set of live support snapshots produce, in names.
 *
 *   node --experimental-transform-types --no-warnings scripts/decision-replay-report.ts lineup.json [waiver-plan.json] [matchup.json]
 *
 * For a change that moves a score or a recommendation: run it on the code
 * before the change and on the code after, against the same files, and diff
 * the two outputs. It uses only exports both versions have.
 *
 *  - lineup: every rostered player's Vegas number, decision number and basis,
 *    the recommended starters, and the suggested changes, rebuilt through the
 *    real `assembleLineup`;
 *  - every file: the replay's outcome against what production captured, and
 *    each decision-level difference (starters, swaps, claims, the defense
 *    pick, Best move, win probability), with player ids turned into names.
 *
 * On the code production runs, the replay should say `reproduced`.
 */

import { readFileSync } from 'node:fs';
import { assembleLineup } from '../src/core/startsit/assemble.ts';
import { rehydrateLeagueRules, rehydrateStartSitInputs } from '../src/core/support/inseason.ts';
import { readSnapshot, replaySnapshot } from '../src/core/support/dispatch.ts';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: decision-replay-report.ts snapshot.json [...]');
  process.exit(1);
}

const names = new Map<string, string>();
function learnNames(value: unknown): void {
  if (Array.isArray(value)) {
    for (const v of value) learnNames(v);
    return;
  }
  if (value == null || typeof value !== 'object') return;
  const o = value as Record<string, unknown>;
  const id = o['id'] ?? o['playerId'];
  const name = o['fullName'] ?? o['name'];
  if (typeof id === 'string' && typeof name === 'string' && name.length > 0) names.set(id, name);
  for (const v of Object.values(o)) learnNames(v);
}
const named = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (s ?? 'null').replace(/[A-Za-z0-9_]+/g, (tok) => names.get(tok) ?? tok);
};
const r1 = (v: number | null | undefined) => (v == null ? '-' : (Math.round(v * 10) / 10).toFixed(1));

const DECISION_TERMS = [
  /^lineup$/,
  /^recommendedPoints$/,
  /^output\.swaps/,
  /^output\.fills/,
  /^claimPlan\./,
  /^dst\.decision$/,
  /^decision\./,
  /^winProbability$/,
  /^output\.upgrades\[\d+\]\.(playerId|kind|verdict|claim)$/,
];

for (const file of files) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  learnNames(raw);
  const kind = raw?.decision?.kind;
  console.log(`\n==== ${kind} · captured ${raw.capturedAt} · week ${raw?.decision?.context?.week ?? raw?.decision?.request?.week ?? '?'} ====`);

  if (kind === 'lineup') {
    const inputs = raw.decision.inputs;
    const { shape, profile } = rehydrateLeagueRules(inputs.rules);
    const lineup = assembleLineup({
      inputs: rehydrateStartSitInputs(inputs.startSit),
      shape,
      profile,
      currentStarterIds: inputs.currentStarterIds,
      mode: inputs.mode,
      published: new Map(Object.entries(inputs.published as Record<string, number>)),
      unknownPlayers: inputs.unknownPlayers,
      now: raw.capturedAt,
    });
    const everyone = [...lineup.starters, ...lineup.bench, ...lineup.undecidable].sort((a, b) => a.name.localeCompare(b.name));
    console.log('player | Vegas number | decision number | basis');
    for (const e of everyone) {
      console.log(`  ${e.name} (${e.position}) | ${r1(e.expectation?.points)} | ${r1(e.decision?.points)} | ${e.decision?.basis ?? 'none'}`);
    }
    /*
     * The Vegas-first rule (#330): everything but the market and availability
     * is held to a tenth of the base. Checked here so a change that moves the
     * base proves the cap still holds on the real roster.
     */
    const over = everyone.filter((e) => {
      const d = e.decision;
      if (!d || d.basis === 'unpriced' || !(d.base > 0)) return false;
      const status = (e.components as { key: string; value: number; unknown: boolean }[])
        .filter((c) => !c.unknown && c.key === 'status')
        .reduce((a, c) => a + c.value, 0);
      return Math.abs(d.adjustments - status) > d.base * 0.1 + 0.011;
    });
    console.log(`Vegas-first 90/10 rule: ${over.length === 0 ? 'holds for every priced player' : `BROKEN for ${over.map((e) => e.name).join(', ')}`}`);
    console.log('recommended starters:');
    for (const s of lineup.slots) console.log(`  ${s.slot}: ${s.name ?? '(empty)'}`);
    console.log(`suggested changes (${lineup.swaps.length + lineup.fills.length}):`);
    for (const s of lineup.swaps) console.log(`  ${s.slot}: start ${s.inName} over ${s.outName} +${r1(s.gain)} (${s.reason})`);
    for (const f of lineup.fills) console.log(`  ${f.slot}: fill with ${f.inName} +${r1(f.gain)}`);
  }

  const report = await replaySnapshot(readSnapshot(raw));
  console.log(`replay against production's capture: ${report.outcome}; engine ${report.engine.captured}${report.engine.matches ? '' : ` -> ${report.engine.current}`}; ${report.differences.length} difference(s) in all`);
  const decisions = report.differences.filter((d) => DECISION_TERMS.some((re) => re.test(d.term)));
  if (decisions.length === 0) console.log('  no decision-level difference');
  for (const d of decisions.slice(0, 40)) {
    console.log(`  ${d.term}: production ${named(d.captured)}  ->  this code ${named(d.replayed)}`);
  }
}
