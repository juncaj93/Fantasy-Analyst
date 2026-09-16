/**
 * Why do Matchup and Team recommend different players for the same FLEX slot?
 *
 * Reported 16 September 2026, one screen apart:
 *
 *     Matchup   Best move: Start K. Concepcion over J. Reed  +2.5 projected pts  75% -> 77%
 *     Team      Start RJ Harvey over Jayden Reed             +1.37 pts
 *
 * The hypothesis this is here to confirm or kill: the two screens are using
 * *different numbers for the same player*. `build.ts` feeds the simulator the
 * published Rotowire figure at full value, while `recommendLineup` ranks the
 * same figure docked by `BORROWED_RANKING_DISCOUNT`. If so the disagreement is
 * not the principled one `decision.ts` documents — a favourite trading points
 * for a narrower distribution — it is two screens disagreeing about arithmetic.
 *
 * Also dumps what the win probability was computed from, because a 17.8-point
 * edge reading 75% is a claim about variance and the variance should be
 * legible rather than taken on trust.
 *
 * Reads only.
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

async function get(path) {
  const res = await fetch(`${APP}${path}`);
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text: text.slice(0, 300) };
  }
}

const health = await get('/api/health');
console.log(`gitSha=${health.json?.gitSha ?? '(none)'}\n`);

const leagues = await get('/api/leagues');
const league =
  (leagues.json?.leagues ?? []).find((l) => l.isSelected) ?? (leagues.json?.leagues ?? [])[0];

const [matchup, lineup] = await Promise.all([
  get(`/api/leagues/${league.id}/matchup`),
  get(`/api/leagues/${league.id}/lineup`),
]);

const f = matchup.json?.forecast ?? matchup.json ?? {};

console.log('--- the two totals and the number on the bar ---');
for (const side of ['mine', 'theirs']) {
  const t = f.teams?.[side] ?? {};
  console.log(
    `  ${side.padEnd(7)} projected=${String(t.projectedTotal ?? t.projected ?? '—').padEnd(8)} win=${t.winProbability ?? '—'}`,
  );
}
console.log(`  draws=${f.draws ?? '—'}  phase=${f.phase ?? '—'}  model=${f.modelVersion ?? '—'}`);

console.log('\n--- what the matchup believes each of my starters is worth ---');
const mine = [];
for (const row of f.slots ?? []) {
  const p = row.mine ?? row.home ?? null;
  if (p) mine.push(p);
}
for (const p of [...mine, ...(f.bench?.mine ?? [])]) {
  const tier = p.projectionBorrowed ? 'published' : p.projectionEstimated ? 'preseason' : 'market';
  console.log(
    `  ${String(p.name).padEnd(24)} ${String(p.slot ?? 'BN').padEnd(5)} projectedFinal=${String(p.projectedFinal ?? '—').padEnd(8)} tier=${tier}`,
  );
}

console.log('\n--- what the lineup believes about the same men ---');
const byId = new Map();
for (const s of [...(lineup.json?.slots ?? []), ...(lineup.json?.bench ?? [])]) {
  if (s.playerId) byId.set(s.playerId, s);
}
for (const p of [...mine, ...(f.bench?.mine ?? [])]) {
  const s = byId.get(p.playerId);
  if (!s) continue;
  console.log(
    `  ${String(p.name).padEnd(24)} score=${String(s.score ?? '—').padEnd(8)} projection=${String(s.projection ?? '—').padEnd(8)} src=${s.projectionSource ?? '-'}`,
  );
}

console.log('\n--- the two recommendations, side by side ---');
/* `decision`, which is what the card is drawn from — not a guessed field name. */
const best = f.decision?.best ?? null;
console.log(
  best
    ? `  matchup best move: start ${best.inName} over ${best.outName} (${best.slot}), ${best.pointsDelta > 0 ? '+' : ''}${best.pointsDelta} pts, ${(best.winNow * 100).toFixed(0)}% -> ${(best.winAfter * 100).toFixed(0)}%`
    : `  matchup best move: (none) — ${f.decision?.note ?? 'no note'}`,
);
for (const o of f.decision?.options ?? []) {
  console.log(`    option: ${o.inName} over ${o.outName} (${o.slot}) gain=${(o.gain * 100).toFixed(1)}pp`);
}
/*
 * The echo, which the first version of this script could not see because it
 * was written before the field existed. A probe that predates the behaviour it
 * is asked about reports the old answer whatever is deployed - twice now.
 */
const echo = f.decision?.onProjection ?? null;
console.log(
  echo
    ? `  matchup onProjection: start ${echo.inName} over ${echo.outName} (${echo.slot}), ${echo.pointsDelta > 0 ? '+' : ''}${echo.pointsDelta} pts`
    : '  matchup onProjection: (none)',
);
for (const s of lineup.json?.swaps ?? []) {
  console.log(`  lineup swap:       in=${s.inPlayerId} out=${s.outPlayerId} gain=${s.gain}`);
}

/* The property the report was about: do the two screens name the same man? */
const lineupIn = (lineup.json?.swaps ?? [])[0]?.inPlayerId ?? null;
const matchupIn = best?.inPlayerId ?? echo?.inPlayerId ?? null;
console.log('\n--- the property, checked ---');
if (lineupIn && matchupIn) {
  console.log(
    lineupIn === matchupIn
      ? `  OK   both tabs name the same man (${(best ?? echo).inName})`
      : `  FAIL Team names ${lineupIn}, Matchup names ${matchupIn}`,
  );
} else {
  console.log(`  only one tab is proposing a change: lineup=${lineupIn ?? 'none'} matchup=${matchupIn ?? 'none'}`);
}

/*
 * What the win probability implies about the spread, worked backwards.
 *
 * A normal approximation is not what the simulator does, but it is a fair
 * reading of the answer it produced: if a 17.8-point edge is 75%, the standard
 * deviation of the *difference* is about 26 points, which is about 19 a side.
 * Printed so the assumption can be argued with rather than guessed at.
 */
const a = f.teams?.mine?.projectedTotal ?? f.teams?.mine?.projected ?? null;
const b = f.teams?.theirs?.projectedTotal ?? f.teams?.theirs?.projected ?? null;
const p = f.teams?.mine?.winProbability ?? null;
if (a != null && b != null && p != null && p > 0 && p < 1) {
  /* Inverse normal CDF, Acklam's approximation — good to ~1e-9. */
  const invNorm = (q) => {
    const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
    const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
    const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425;
    if (q < pl) { const u = Math.sqrt(-2 * Math.log(q)); return (((((C[0]*u+C[1])*u+C[2])*u+C[3])*u+C[4])*u+C[5]) / ((((D[0]*u+D[1])*u+D[2])*u+D[3])*u+1); }
    if (q > 1 - pl) { const u = Math.sqrt(-2 * Math.log(1 - q)); return -(((((C[0]*u+C[1])*u+C[2])*u+C[3])*u+C[4])*u+C[5]) / ((((D[0]*u+D[1])*u+D[2])*u+D[3])*u+1); }
    const u = q - 0.5; const r = u * u;
    return (((((A[0]*r+A[1])*r+A[2])*r+A[3])*r+A[4])*r+A[5])*u / (((((B[0]*r+B[1])*r+B[2])*r+B[3])*r+B[4])*r+1);
  };
  const edge = a - b;
  const z = invNorm(p > 1 ? p / 100 : p);
  console.log('\n--- what that win probability implies about the spread ---');
  console.log(`  edge=${edge.toFixed(1)} pts, win=${p}`);
  console.log(`  implied SD of the difference: ${(edge / z).toFixed(1)} pts  (about ${(edge / z / Math.SQRT2).toFixed(1)} a side)`);
}
