/**
 * Jordan Love against Kirk Cousins on season value (4 November 2026, Alex's
 * check after round 6). ONE production read: the Waivers support snapshot
 * (`/api/leagues/:id/support-snapshot?context=waiver-plan`), which carries
 * every input the tiers used. Sleeper is never called.
 *
 * For each player: games played and season average in league scoring (the
 * production half), this week's number and Sleeper's weeks 10 to 12 (the
 * projection half), and the blended season value, computed with the same
 * shared function the app uses (`core/value/restOfSeason.ts`). Then the gap.
 *
 * The Probe workflow runs the D1 budget guard first. Times in Eastern.
 */

import { spawnSync } from 'node:child_process';
import { playedWeeksOf, productionGames, restOfSeasonBlend } from '../src/core/value/restOfSeason.ts';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const NAMES = (process.env.NAMES ?? 'Jordan Love,Kirk Cousins').split(',').map((s) => s.trim());
const eastern = () => new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });
const fmt = (v) => (v == null ? '-' : Number(v).toFixed(2));

function rowsToday() {
  if (!process.env.CLOUDFLARE_API_TOKEN) return null;
  const run = spawnSync(process.execPath, ['scripts/d1-budget-guard.mjs', '--ceiling', '100', '--what', 'love cousins probe'], { encoding: 'utf8', env: process.env });
  const match = /([\d,]+) of 5,000,000 rows read today/.exec(`${run.stdout}${run.stderr}`);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

console.log(`Started ${eastern()} ET`);
const before = rowsToday();
console.log(`D1 rows read today before: ${before ?? 'unknown'}`);
const setup = await fetch(`${APP}/api/setup/status`).then((r) => r.json()).catch(() => null);
const leagueId = process.env.LEAGUE_ID || setup?.league?.id;
const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}; league: ${leagueId ? 'found' : '?'}`);
if (!leagueId) process.exit(0);

const started = Date.now();
const res = await fetch(`${APP}/api/leagues/${encodeURIComponent(leagueId)}/support-snapshot?context=waiver-plan`);
const text = await res.text();
console.log(`snapshot: HTTP ${res.status}, ${Date.now() - started} ms, ${text.length} bytes`);
let snap = null;
try {
  snap = JSON.parse(text);
} catch {
  console.log('not JSON');
  process.exit(0);
}
const inputs = snap?.decision?.inputs ?? {};
const output = snap?.decision?.output ?? {};
const all = [...(inputs.roster?.inputs ?? []), ...(inputs.candidates?.inputs ?? [])];
const season = inputs.round2?.seasonPoints ?? {};
const through = inputs.round2?.seasonPointsThrough ?? 0;
const horizon = inputs.seasonHorizon?.weeks ?? [];
const week = inputs.week;
const ahead = new Map((inputs.ahead?.sleeper ?? []).map(([w, m]) => [Number(w), m]));
const figures = output?.tiers?.weekFigures ?? {};
console.log(`week ${week}; season points through week ${through}; horizon ${horizon.join(', ')}; ahead weeks ${[...ahead.keys()].join(', ')}`);

const results = [];
for (const name of NAMES) {
  const input = all.find((i) => i.player?.fullName === name);
  if (!input) {
    console.log(`\n${name}: not in the snapshot (not rostered by Alex and not scanned)`);
    continue;
  }
  const id = input.player.id;
  const points = season[id] ?? null;
  const games = productionGames({ leaguePoints: points, through, playedWeeks: playedWeeksOf(input.usageWeeks) });
  const avg = games.length > 0 ? games.reduce((a, b) => a + b, 0) / games.length : null;
  const aheadFor = new Map([...ahead].map(([w, m]) => [w, m?.[id]]).filter(([, v]) => typeof v === 'number'));
  const fig = figures[id]?.weeks ?? [];
  const thisWeek = fig.find((w) => w.week === week) ?? null;
  const bye = fig.find((w) => w.bye)?.week ?? null;
  const fromThisWeek = thisWeek != null && !thisWeek.bye && thisWeek.source === 'this_week' && thisWeek.fromWeek == null && thisWeek.points != null;
  const read = restOfSeasonBlend({
    thisWeek: { rate: thisWeek?.points ?? null, fromThisWeek },
    ahead: aheadFor,
    production: games,
    weeks: horizon,
    byeWeek: bye,
    floor: 1,
  });
  results.push({ name, rate: read.blend.rate });
  console.log(`\n${name} (${input.player.position} ${input.player.team}), id ${id}`);
  console.log(`  league points by week 1-${through}: ${JSON.stringify(points)}`);
  console.log(`  games counted: ${games.length}; season average ${fmt(avg)} per game played`);
  console.log(`  this week (${week}): ${fmt(thisWeek?.points)} [${thisWeek?.source ?? 'none'}${thisWeek?.fromWeek ? `, from week ${thisWeek.fromWeek}` : ''}]; bye in window: ${bye ?? 'none seen'}`);
  console.log(`  Sleeper ahead: ${[...ahead.keys()].map((w) => `w${w} ${fmt(aheadFor.get(w))}`).join(', ')}`);
  console.log(`  blend: projection ${fmt(read.blend.projection)} over ${read.blend.projectionWeeks} weeks; production ${fmt(read.blend.production)} over ${read.blend.games} games; production share ${read.blend.productionShare}; season value ${fmt(read.blend.rate)}`);
}
if (results.length === 2) console.log(`\ngap: ${results[1].name} minus ${results[0].name} = ${fmt(results[1].rate - results[0].rate)} a week (the tiers' week 12 to 17 gap was 1.71)`);
const audit = (output?.tiers?.audit ?? []).filter((a) => NAMES.includes(a.name));
for (const a of audit) console.log(`audit: ${a.name} gain ${fmt(a.gain)} by week ${JSON.stringify(a.byWeek)}; "${a.reason}"; drop ${a.drop ?? 'none'}`);

const after = rowsToday();
console.log(`\nD1 rows read today after: ${after ?? 'unknown'}${before != null && after != null ? ` (+${after - before}; can lag)` : ''}`);
console.log(`Finished ${eastern()} ET`);
