/**
 * Do the rows on the Compare sheet add up to the number, for players ranked on
 * a Rotowire week? Asked of production's own answer, not of a checkout.
 *
 * Reads the live lineup support snapshot (built by the deployed worker), and for
 * every player ranked on a published week checks:
 *
 *     published week + sum of his printed rows  ==  his decision number
 *
 * where a printed row is `shownValue ?? value`, and the rows are everything but
 * the market's own pieces (vegas, uncertainty) and the lineup-only cover charge.
 * Also prints how many of those rows carry a `shownValue`, which is how a deploy
 * that predates the fix is told apart from one that has it.
 *
 * Reads only: one GET of the public support snapshot.
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? JSON.stringify(health)?.slice(0, 200)}`);

const leagues = await fetch(`${APP}/api/leagues`).then((r) => r.json());
const leagueId = process.env.LEAGUE_ID || leagues?.leagues?.find((l) => l.isSelected)?.id;
if (!leagueId) {
  console.error('no selected league');
  process.exit(1);
}
const res = await fetch(`${APP}/api/leagues/${leagueId}/support-snapshot?context=lineup`);
console.log(`GET support-snapshot (lineup) -> HTTP ${res.status}`);
if (!res.ok) {
  console.error((await res.text()).slice(0, 300));
  process.exit(1);
}
const snapshot = await res.json();
const output = snapshot.decision.output;
console.log(`engine ${snapshot.release.engineVersion} · week ${snapshot.decision.context.week}\n`);

const OUT = new Set(['vegas', 'uncertainty', 'replacement_risk']);
const players = [...(output.starters ?? []), ...(output.bench ?? []), ...(output.undecidable ?? [])];
const published = players.filter((e) => e.decision?.basis === 'published');

let bad = 0;
let withShown = 0;
console.log('player | week | rows as printed | decision number | week + rows | raw rows (engine) | result');
for (const e of published) {
  const rows = (e.components ?? []).filter((c) => !c.unknown && !OUT.has(c.key));
  const printed = rows.reduce((a, c) => a + (c.shownValue ?? c.value), 0);
  const raw = rows.reduce((a, c) => a + c.value, 0);
  withShown += rows.filter((c) => c.shownValue !== undefined).length;
  const total = e.decision.base + printed;
  const ok = Math.abs(total - e.decision.points) <= 0.05;
  if (!ok) bad++;
  console.log(
    [
      `${e.name} (${e.position})`,
      e.decision.base.toFixed(2),
      printed.toFixed(2),
      e.decision.points.toFixed(2),
      total.toFixed(2),
      raw.toFixed(2),
      ok ? 'ADDS UP' : 'DOES NOT ADD UP',
    ].join(' | '),
  );
}
console.log(`\npublished-week players: ${published.length} · rows carrying a shownValue: ${withShown}`);
console.log(`ROWS THAT DO NOT ADD UP: ${bad}`);
if (bad > 0 || published.length === 0) process.exitCode = 1;
