/**
 * The "worse status wins" round, replayed on live injury observations (24 October 2026).
 *
 *   node --experimental-transform-types --no-warnings scripts/injury-severity-report.ts <file.json>
 *
 * Reads `[{ playerId, name, screen, observations }]` (what `probe-injury-severity.mjs`
 * collected from the live endpoints) and prints, for every player, the status
 * under the rule before this round (Sleeper first, always) and under the rule
 * the code it runs on has (`resolveInjury`). Rows that differ are marked.
 */

import { readFileSync } from 'node:fs';
import { resolveInjury, type InjuryObservation } from '../src/core/injury/model.ts';
import { weekAvailability } from '../src/core/injury/weekAvailability.ts';

interface Row {
  playerId: string;
  name: string;
  screen: string;
  observations: InjuryObservation[];
}

const file = process.argv[2];
if (!file) throw new Error('usage: injury-severity-report.ts <file.json>');
const rows = JSON.parse(readFileSync(file, 'utf8')) as Row[];
const now = new Date();

/** The rule before this round: the first source in priority order with a designation. */
function before(observations: InjuryObservation[]): string {
  const order = ['sleeper', 'nflverse'];
  const rank = (s: string) => (order.indexOf(s) === -1 ? order.length : order.indexOf(s));
  const designated = observations
    .filter((o) => o.designation !== 'unknown')
    .sort((a, b) => rank(a.source) - rank(b.source) || (Date.parse(b.observedAt ?? '') || 0) - (Date.parse(a.observedAt ?? '') || 0));
  return designated[0]?.designation ?? 'unknown';
}

const fmtSources = (obs: InjuryObservation[]) =>
  obs.map((o) => `${o.source}=${o.raw ?? o.designation}@${o.asOf ?? o.observedAt ?? 'undated'}`).join(' | ');

let changed = 0;
for (const row of rows) {
  const old = before(row.observations);
  const next = resolveInjury(row.observations, now).designation;
  const differs = old !== next;
  if (differs) changed += 1;
  const benched = weekAvailability(next as never).out && !weekAvailability(old as never).out ? ' (now benched)' : '';
  console.log(
    `${differs ? 'CHANGED' : '       '} ${row.screen.padEnd(8)} ${row.name.padEnd(24)} old=${old.padEnd(12)} new=${next}${benched}   ${fmtSources(row.observations)}`,
  );
}
console.log(`\n${changed} of ${rows.length} player reads change status under the new rule.`);
