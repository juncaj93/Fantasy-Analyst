/** Round 29: matchup forecasts graded. node ... forecasts.ts <bundle.json> */
import { readFileSync } from 'node:fs';
const B = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const rows: any[] = B.forecasts ?? [];
const me = B.gather?.meta?.myRosterId ?? null;
const settled = rows.filter((r) => r.won != null || (r.final_score != null && r.opponent_final_score != null));
const f = (x: any, d = 1) => (x == null ? '-' : Number(x).toFixed(d));
const brier = (k: string) => {
  const xs = settled.filter((r) => r[k] != null && r.won != null);
  return { n: xs.length, b: xs.reduce((s, r) => s + (Number(r[k]) - Number(r.won)) ** 2, 0) / Math.max(1, xs.length) };
};
for (const k of ['first_win_probability', 'latest_win_probability']) {
  const { n, b } = brier(k);
  console.log(`${k}: ${n} settled, Brier ${b.toFixed(3)} (0.25 = coin flip)`);
}
const pregame = settled.filter((r) => r.first_phase === 'pregame' && r.won != null && r.first_win_probability != null);
const bands = [[0, 0.35], [0.35, 0.5], [0.5, 0.65], [0.65, 1.01]];
console.log(`pregame first forecasts: ${pregame.length}`);
for (const [lo, hi] of bands) {
  const xs = pregame.filter((r) => r.first_win_probability >= lo! && r.first_win_probability < hi!);
  if (!xs.length) continue;
  const avg = xs.reduce((s, r) => s + Number(r.first_win_probability), 0) / xs.length;
  const won = xs.filter((r) => Number(r.won) === 1).length;
  console.log(`  said ${Math.round(lo! * 100)} to ${Math.round(Math.min(1, hi!) * 100)}% (average ${Math.round(avg * 100)}%): won ${won} of ${xs.length} (${Math.round((100 * won) / xs.length)}%)`);
}
const proj = settled.filter((r) => r.first_projected_final != null && r.final_score != null);
const mae = proj.reduce((s, r) => s + Math.abs(Number(r.first_projected_final) - Number(r.final_score)), 0) / Math.max(1, proj.length);
const bias = proj.reduce((s, r) => s + (Number(r.first_projected_final) - Number(r.final_score)), 0) / Math.max(1, proj.length);
console.log(`first projected team total vs final: ${proj.length} rows, miss ${mae.toFixed(1)} points, bias ${bias >= 0 ? '+' : ''}${bias.toFixed(1)}`);
console.log(`\nAlex's weeks (roster ${me}):`);
for (const r of rows.filter((r) => String(r.roster_id) === String(me)).sort((a, b) => a.week - b.week)) {
  console.log(`  week ${r.week}: first ${f(r.first_win_probability * 100, 0)}% (${r.first_phase}, ${r.first_forecast_at}) projected ${f(r.first_projected_final)}; latest ${f(r.latest_win_probability * 100, 0)}% projected ${f(r.latest_projected_final)}; final ${f(r.final_score)} vs ${f(r.opponent_final_score)} ${r.won == null ? '(not settled)' : Number(r.won) === 1 ? 'WON' : 'LOST'}; model ${r.model_version}`);
}
