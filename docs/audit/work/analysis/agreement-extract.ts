/**
 * Round 29 agreement: unpack the probe bundle into the files lineup-table.ts reads,
 * and replay Compare (a passphrase POST in production) from the lineup snapshot.
 *   node --experimental-transform-types --no-warnings agreement-extract.ts <bundle.json> <outDir> [preKickoffIso]
 * Writes <outDir>/now/ (as captured) and, with a pre-kickoff time, <outDir>/prekick/ (the same inputs, clock moved
 * back so nothing is locked), each with Team rebuilt and Compare replayed for every swap, toss-up and starter/bench pair.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const repo = '/home/user/Fantasy-Analyst/src';
const { rehydrateLeagueRules, rehydrateStartSitInputs } = await import(`${repo}/core/support/inseason.ts`);
const { assembleLineup } = await import(`${repo}/core/startsit/assemble.ts`);
const { compareStartSit } = await import(`${repo}/core/startsit/engine.ts`);
const { resolveComparisonSlot } = await import(`${repo}/core/sleeper/eligibility.ts`);

const B = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const out = process.argv[3]!;
const preKick = process.argv[4] ?? null;
const s = B.screens ?? {};
const body = (k: string) => s[k]?.body ?? null;
const write = (dir: string, name: string, v: unknown) => v != null && writeFileSync(join(dir, name), JSON.stringify(v));

const snap = B.snapshots?.lineup?.body;
const inputs = snap?.decision?.inputs;
if (!inputs) throw new Error('no lineup snapshot inputs in the bundle');
const { shape, profile } = rehydrateLeagueRules(inputs.rules);
const startSit = rehydrateStartSitInputs(inputs.startSit);
const published = new Map(Object.entries(inputs.published as Record<string, number>));
const mode = inputs.mode ?? 'balanced';

for (const [label, now] of [['now', snap.capturedAt], ...(preKick ? [['prekick', preKick]] : [])] as [string, string][]) {
  const dir = join(out, label);
  mkdirSync(dir, { recursive: true });
  /* The live answers, for both folders (they are what the phone read). */
  write(dir, 'roster.json', body('team.roster'));
  write(dir, 'waivers.json', body('waivers'));
  write(dir, 'matchup.json', body('matchup'));
  write(dir, 'pool-mine.json', body('compare.poolMine'));
  write(dir, 'pool-waivers.json', body('compare.poolWaivers'));
  write(dir, 'players-board.json', body('players.board'));
  for (const [id, r] of Object.entries<any>(s.cards ?? {})) write(dir, `players-card-${id}.json`, r.body);
  for (const c of s.checks ?? []) write(dir, `trades-check-${c.give}-${c.get}.json`, c.body);
  /* Team: live at "now"; rebuilt from the snapshot at "prekick". */
  const shifted = startSit.map((i: any) => (label === 'now' ? i : { ...i, now }));
  const lineup =
    label === 'now'
      ? body('team.lineup')
      : assembleLineup({
          inputs: shifted,
          shape,
          profile,
          currentStarterIds: inputs.currentStarterIds,
          ...(inputs.currentSlots ? { currentSlotOf: new Map(Object.entries(inputs.currentSlots)) } : {}),
          mode,
          published,
          unknownPlayers: inputs.unknownPlayers,
          now,
        } as never);
  write(dir, 'lineup.json', lineup);
  /* Compare as production computes it: no IR slot (app.ts:3593), Team's mode, the published week. */
  const byId = new Map(shifted.map((i: any) => [i.player.id, i]));
  const pairs = new Map<string, [string, string, string | null]>();
  for (const sw of [...(lineup?.swaps ?? []), ...(lineup?.tossUps ?? [])]) pairs.set(`${sw.inPlayerId}-${sw.outPlayerId}`, [sw.inPlayerId, sw.outPlayerId, sw.slot ?? null]);
  const starters: any[] = lineup?.starters ?? [];
  const bench: any[] = lineup?.bench ?? [];
  for (const st of starters) {
    const best = bench
      .filter((b) => resolveComparisonSlot([st.position, b.position], shape, st.position).comparable)
      .sort((a, b) => (b.decision?.points ?? -99) - (a.decision?.points ?? -99))[0];
    if (best) pairs.set(`${best.playerId}-${st.playerId}`, [best.playerId, st.playerId, null]);
  }
  let n = 0;
  for (const [key, [a, b, slot]] of pairs) {
    const ia = byId.get(a);
    const ib = byId.get(b);
    if (!ia || !ib) continue;
    const strip = (i: any) => ({ ...i, onReserve: undefined });
    const cmp: any = compareStartSit([strip(ia), strip(ib)], profile, { mode, published });
    const resolved = resolveComparisonSlot([ia.player.position, ib.player.position], shape, slot);
    write(dir, `compare-${key}.json`, { ...cmp, mode, slot: resolved });
    n += 1;
  }
  console.log(`${label}: ${n} Compare replays, lineup ${label === 'now' ? 'live' : 'rebuilt'} at ${now}`);
}
