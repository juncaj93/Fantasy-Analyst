/**
 * Alex's waiver list from one Waivers support snapshot, as this checkout's
 * engine draws it. Run by `probe-waivers-round8.mjs` twice, on the code before
 * round 8 and on this code, against the same file:
 *
 *   node --experimental-transform-types --no-warnings scripts/waiver-round8-report.ts snapshot.json [--before]
 *
 * `--before` leaves out the free agents only round 8's scan adds (the
 * snapshot's `context.pool.lastWeekIds` and `stashIds`), so the old code sees
 * the wire it would have scanned. Uses only exports both versions have.
 */

import { readFileSync } from 'node:fs';
import { waiverRequestFromSnapshot } from '../src/core/support/waiverSnapshot.ts';
import { assembleWaiverPlan } from '../src/core/waivers/assemble.ts';

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error('usage: waiver-round8-report.ts snapshot.json [--before]');
  process.exit(1);
}
const raw = JSON.parse(readFileSync(file, 'utf8'));
const pool = raw?.decision?.context?.pool ?? {};
const added = new Set<string>([...(pool.lastWeekIds ?? []), ...(pool.stashIds ?? [])]);
const { request } = waiverRequestFromSnapshot(raw);
const before = flag === '--before';
const req = before ? { ...request, candidateInputs: request.candidateInputs.filter((i) => !added.has(i.player.id)) } : request;
const plan = await assembleWaiverPlan(req);
const t = plan.tiers as unknown as Record<string, any> | null;
const f = (v: number | null | undefined) => (v == null ? '-' : Number(v).toFixed(2));

console.log(`wire: ${req.candidateInputs.length} free agents scanned${before ? ` (round 8's ${added.size} left out)` : ''}`);
if (!t) {
  console.log('no tiers');
  process.exit(0);
}
const bid = (r: any) =>
  r.bid?.kind === 'free' ? 'free agent' : r.bid?.kind === 'claim' ? (r.bid.recommended == null ? 'no bid' : `bid $${r.bid.recommended} ($${r.bid.low}-${r.bid.high})`) : (r.bid?.kind ?? '-');
const drop = (r: any) => (r.needsSpot ? 'needs a drop' : r.drop ? `${r.drop.viaReserve ? 'IR' : 'drop'} ${r.drop.name}` : 'open spot');
const row = (r: any) => `${r.name} (${r.position}) "${r.reason}"; gain ${f(r.gain)}; ${drop(r)}; ${bid(r)}`;
for (const r of t.doThese ?? []) console.log(`DO THIS: ${row(r)}`);
for (const r of t.consider ?? []) console.log(`CONSIDER: ${row(r)}`);
for (const r of (t.watch ?? []).slice(0, 8)) console.log(`WATCH: ${row(r)}`);
const room = (x: any) => (x?.kind === 'reserve' ? 'open IR slot' : x?.kind === 'open' ? 'open bench spot' : x?.kind === 'drop' ? `drop ${x.name}` : '-');
const lineBid = (b: any) => (b?.kind === 'free' ? 'free agent' : b?.kind === 'claim' ? `bid $${b.low} to $${b.high}` : '-');
console.log(
  t.upsideStash
    ? `STASH: ${t.upsideStash.name} (${t.upsideStash.position}) "${t.upsideStash.reason}"; season value ${f(t.upsideStash.value)}; ${room(t.upsideStash.room)}; ${lineBid(t.upsideStash.bid)}`
    : `STASH: ${before ? 'not in the code before round 8' : 'none this week'}`,
);
console.log(
  t.block
    ? `BLOCK: ${t.block.name} (${t.block.position}) "${t.block.reason}" (${t.block.detail}); +${f(t.block.gain)} to his lineup; ${room(t.block.room)}; ${lineBid(t.block.bid)}`
    : `BLOCK: ${before ? 'not in the code before round 8' : 'none this week'}`,
);
console.log(`drop-ready: ${(t.dropReady ?? []).map((d: any) => d.name).join(', ') || 'none'}`);
const excluded = (t.excluded ?? []).map((x: any) => `${x.name} (${x.reason})`);
console.log(`never offered: ${excluded.join('; ') || 'none'}`);
