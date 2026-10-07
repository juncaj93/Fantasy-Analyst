/**
 * Which touchdown line is the app reading as "anytime TD"?
 *
 * The provider quotes one full-game `touchdowns` over/under per player, and the
 * adapter files it as `anytime_td` whatever its line. Over 0.5 is "scores a
 * touchdown"; over 1.5 is "scores two". This reads the stored props the
 * lineup was built from (the public `lineup` support snapshot), prints every
 * player's touchdown quote with its line, price and implied chance, and what
 * that chance adds to his market number at six points a touchdown.
 *
 * Reads only: one GET of /api/leagues and one of the support snapshot. No odds
 * are bought and nothing is written.
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const leagues = await fetch(`${APP}/api/leagues`).then((r) => r.json());
const leagueId = process.env.LEAGUE_ID || leagues?.leagues?.find((l) => l.isSelected)?.id;
const res = await fetch(`${APP}/api/leagues/${leagueId}/support-snapshot?context=lineup`);
console.log(`GET support-snapshot (lineup) -> HTTP ${res.status}`);
const snap = await res.json();
const raw = snap?.decision?.inputs?.startSit;
const inputs = Array.isArray(raw) ? raw : (raw?.inputs ?? []);
console.log(`captured ${snap.capturedAt}  week ${snap?.decision?.context?.week}  players ${inputs.length}\n`);
const lines = new Map();
for (const input of inputs) {
  const name = input.player?.fullName ?? input.player?.id;
  const props = (input.props ?? []).filter((p) => p.market === 'anytime_td');
  if (props.length === 0) {
    console.log(`${String(name).padEnd(24)} no touchdown quote`);
    continue;
  }
  const before = (input.previousProps ?? []).filter((p) => p.market === 'anytime_td');
  if (before.length > 0) {
    console.log(`${''.padEnd(24)} previous snapshot: ${before.map((p) => `line ${p.line} over ${p.overPrice} under ${p.underPrice} implied ${p.impliedProbability == null ? '-' : (p.impliedProbability * 100).toFixed(0) + '%'}`).join(' | ')}`);
  }
  for (const p of props) {
    const key = String(p.line);
    lines.set(key, (lines.get(key) ?? 0) + 1);
    console.log(
      `${String(name).padEnd(24)} ${String(input.player?.position).padEnd(3)} line ${String(p.line).padEnd(4)} over ${String(p.overPrice).padEnd(6)} under ${String(p.underPrice).padEnd(6)} implied ${p.impliedProbability == null ? '-' : (p.impliedProbability * 100).toFixed(0) + '%'}  books ${p.bookCount ?? '-'}  fetched ${p.fetchedAt ?? p.capturedAt ?? '-'}`,
    );
  }
}
console.log(`\ntouchdown quotes by line: ${JSON.stringify(Object.fromEntries(lines))}`);
