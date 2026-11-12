/**
 * Round 20: every bid on Alex's Waivers list, from one Waivers support
 * snapshot, as this checkout's engine draws it. Run by `probe-round20.mjs`
 * twice, on the code before the round and on this code, against the same file:
 *
 *   node --experimental-transform-types --no-warnings scripts/round20-report.ts snapshot.json
 *
 * Uses only exports both versions have. Reads no database and calls nobody.
 */

import { readFileSync } from 'node:fs';
import { waiverRequestFromSnapshot } from '../src/core/support/waiverSnapshot.ts';
import { assembleWaiverPlan } from '../src/core/waivers/assemble.ts';

const [file] = process.argv.slice(2);
if (!file) {
  console.error('usage: round20-report.ts snapshot.json');
  process.exit(1);
}
const raw = JSON.parse(readFileSync(file, 'utf8'));
const { request } = waiverRequestFromSnapshot(raw);
const plan = await assembleWaiverPlan(request);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const t = plan.tiers as unknown as Record<string, any> | null;
if (!t) {
  console.log('no tiers');
  process.exit(0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bidText = (b: any): string => {
  if (!b) return 'no bid';
  if (b.kind === 'free') return 'free agent, no bid';
  if (b.kind === 'none') return 'league does not bid';
  if (b.recommended == null && b.low == null) return 'no claim now';
  const band = b.low != null && b.high != null && b.low !== b.high ? ` (shown $${b.low}-${b.high})` : '';
  return `$${b.recommended ?? b.low}${band}`;
};

const doThese = t.doThese ?? (t.doThis ? [t.doThis] : []);
for (const [label, rows] of [['Do this', doThese], ['Worth considering', t.consider ?? []], ['Watch', t.watch ?? []]] as const) {
  for (const r of rows) {
    console.log(`${label}: ${r.name} (${r.position}) +${Number(r.gain).toFixed(1)} | bid ${bidText(r.bid)} | ${r.bid?.reason ?? ''}`);
  }
}
if (t.upsideStash) console.log(`Stash: ${t.upsideStash.name} (${t.upsideStash.position}) | bid ${bidText({ ...t.upsideStash.bid, recommended: t.upsideStash.bid?.high })}`);
if (t.block) console.log(`Block: ${t.block.name} (${t.block.position}) | bid ${bidText({ ...t.block.bid, recommended: t.block.bid?.high })}`);
const claims = plan.claimPlan?.claims ?? [];
for (const c of claims) console.log(`Claim card: ${c.headline}`);
const mine = request.budgets?.rosters?.find((r) => r.isMine);
console.log(`FAAB left: ${mine?.remaining ?? '?'}; week ${request.week}`);
