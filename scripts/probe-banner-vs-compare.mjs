/**
 * Does the Team screen's suggestion rank on the same number the Compare sheet does?
 *
 * Reported 30 September 2026: the lineup card read `Start RJ Harvey over Mark
 * Andrews · +2.31 · FLEX` and the row under Andrews `→ Start RJ Harvey instead
 * · 9.5`, while the Compare sheet opened on the same two men said `start Mark
 * Andrews`, start/sit score 3.9 against −1.6.
 *
 * The suspicion from reading the code: `/api/startsit/compare` ranks on each
 * evaluation's `score`, and `buildSwaps` in `core/startsit/lineup.ts` ranks on
 * `rankingPoints`, which swaps a partially priced player's score for Rotowire's
 * published figure. If so, every contradicting pair has the signature: at
 * least one side with an incomplete market, a gain equal to the difference of
 * the two published figures, and a `score` ordering that points the other way.
 *
 * Fixed in #309: both surfaces now rank on `decisionPoints`, which the lineup
 * response carries on every evaluation as `decision`. The compare route is a
 * POST behind the passphrase, but it ranks on that same `decision.points`, so
 * this reads it from the public lineup GET. A worker older than #309 sends no
 * `decision`, and this falls back to `score`, the old sheet's number.
 * Reads only, GET only.
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

async function get(path) {
  try {
    const res = await fetch(`${APP}${path}`);
    const text = await res.text();
    try {
      return { status: res.status, json: JSON.parse(text) };
    } catch {
      return { status: res.status, json: null, text: text.slice(0, 400) };
    }
  } catch (err) {
    return { status: 0, json: null, text: String(err) };
  }
}

const leaguesRes = await get('/api/leagues');
const league =
  (leaguesRes.json?.leagues ?? []).find((l) => l.isSelected) ?? (leaguesRes.json?.leagues ?? [])[0] ?? null;
if (!league) {
  console.log(`no league: ${leaguesRes.status} ${leaguesRes.text ?? ''}`);
  process.exit(0);
}
console.log(`league: ${league.name} (${league.id})`);

const lineupRes = await get(`/api/leagues/${league.id}/lineup`);
const L = lineupRes.json ?? {};
console.log(`GET lineup -> ${lineupRes.status}; week=${L.week ?? '?'} mode=${L.mode ?? '?'}\n`);

const everyone = [...(L.starters ?? []), ...(L.bench ?? []), ...(L.undecidable ?? [])];
const byId = new Map(everyone.map((e) => [e.playerId, e]));

const fmt = (v) => (v == null ? '—' : typeof v === 'number' ? v.toFixed(2) : String(v));
const missing = (e) => e?.expectation?.missingMarkets ?? [];

function describe(e) {
  if (!e) return '  (not in the response)';
  const comps = (e.components ?? [])
    .filter((c) => !c.unknown && c.value !== 0)
    .map((c) => `${c.key}=${fmt(c.value)}`)
    .join(' ');
  return [
    `  ${e.name} (${e.position}, ${e.team}) status=${e.statusFlag ?? 'none'} ruledOut=${e.ruledOut ?? false}`,
    `    score=${fmt(e.score)}  decision=${fmt(e.decision?.points)} (${e.decision?.basis ?? 'none'})  marketPts=${fmt(e.expectation?.points)}  missingMarkets=[${missing(e).join(', ')}]`,
    `    projection=${fmt(e.projection)} source=${e.projectionSource ?? '—'} confidence=${e.confidence}`,
    `    components: ${comps || '(none)'}`,
  ].join('\n');
}

const swaps = [...(L.swaps ?? []).map((s) => ({ ...s, kind: 'swap' })), ...(L.fills ?? []).map((f) => ({ ...f, kind: 'fill' }))];
console.log(`=== ${swaps.length} suggestion(s) on the card ===`);
let contradictions = 0;
for (const s of swaps) {
  const inE = byId.get(s.inPlayerId);
  const outE = s.outPlayerId ? byId.get(s.outPlayerId) : null;
  console.log(`\n[${s.kind}] ${s.slot}: start ${s.inName}${s.outName ? ` over ${s.outName}` : ''} · +${s.gain}`);
  console.log(describe(inE));
  if (s.outPlayerId) console.log(describe(outE));
  if (inE && outE) {
    const sheetPoints = (e) => e.decision?.points ?? e.score ?? -Infinity;
    const scoreSays = sheetPoints(inE) > sheetPoints(outE) ? inE.name : outE.name;
    const projGap = inE.projection != null && outE.projection != null ? inE.projection - outE.projection : null;
    const scoreGap = sheetPoints(inE) - sheetPoints(outE);
    console.log(`    card gain=${s.gain}  projection gap=${fmt(projGap)}  sheet gap=${fmt(scoreGap)}`);
    console.log(`    compare (ranks on decision points) would say: start ${scoreSays}`);
    if (scoreSays !== inE.name || Math.abs(scoreGap - s.gain) > 0.01) {
      contradictions += 1;
      console.log('    >>> CONTRADICTION: the card and the Compare sheet disagree on this pair');
    }
  }
}

console.log('\n=== slot rows ===');
for (const slot of L.slots ?? []) {
  console.log(
    `  ${String(slot.slot).padEnd(6)} ${String(slot.name ?? '—').padEnd(24)} score=${fmt(slot.score).padEnd(7)} ` +
      `proj=${fmt(slot.projection).padEnd(6)} src=${slot.projectionSource ?? '—'} starting=${slot.alreadyStarting}`,
  );
}

console.log('\n=== bench ===');
for (const e of L.bench ?? []) {
  console.log(
    `  ${String(e.name).padEnd(24)} ${String(e.position).padEnd(4)} status=${String(e.statusFlag ?? '-').padEnd(12)} ` +
      `ruledOut=${String(e.ruledOut ?? false).padEnd(5)} score=${fmt(e.score).padEnd(7)} proj=${fmt(e.projection)} src=${e.projectionSource ?? '—'}`,
  );
}

console.log(`\ncontradicting pairs: ${contradictions} of ${swaps.filter((s) => s.outPlayerId).length} swaps`);
