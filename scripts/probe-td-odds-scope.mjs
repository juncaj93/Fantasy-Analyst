/**
 * Is a touchdown line in the market total, for everyone or only for some?
 *
 * Asked on 24 September 2026 after Rashee Rice (KC) and Jaxon Smith-Njigba
 * (SEA) showed a Market figure with receiving yards and receptions beside it
 * and no touchdown anywhere on the card, the same symptom the Patriots had a
 * round earlier. For every player on both sides of this week's matchup:
 *
 *   A. what the app stored and summed (the lineup's evaluations carry every
 *      contribution; the opponent's side is read off the Matchup cards),
 *   B. what the card shows beside the number, and
 *   C. what the provider posts for his game right now, run through this
 *      revision's adapter and expectation so the three can be read side by side.
 *
 * Reads only. Part C is capped at MAX_ENTITIES (default 12) of the month's
 * allowance, one per game, and stops if the month is past 2,000. The key is
 * never echoed.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.execArgv.includes('--experimental-transform-types')) {
  const run = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: process.env },
  );
  process.exit(run.status ?? 1);
}

const { SportsGameOddsProvider, providerTeamId } = await import('../src/core/vegas/sportsGameOddsProvider.ts');
const { buildConsensus } = await import('../src/core/vegas/normalize.ts');
const { PlayerIndex } = await import('../src/core/identity/index.ts');
const { buildExpectation } = await import('../src/core/startsit/expectation.ts');
const { buildScoringProfile } = await import('../src/core/sleeper/scoring.ts');

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const KEY = process.env.SPORTSGAMEODDS_API_KEY ?? '';
const SGO = 'https://api.sportsgameodds.com/v2';
const MAX_ENTITIES = Number(process.env.MAX_ENTITIES ?? 12);
const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);

async function get(path) {
  const res = await fetch(`${APP}${path}`, { headers: { accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) return { __error: `HTTP ${res.status} ${text.slice(0, 200)}` };
  try {
    return JSON.parse(text);
  } catch {
    return { __error: `not json: ${text.slice(0, 200)}` };
  }
}
const fmt = (v) => (v == null ? '—' : String(v));

const health = await get('/api/health');
console.log(`asking ${APP}  deployed sha: ${health.release?.gitSha ?? '(none reported)'}`);
const leagues = await get('/api/leagues');
const league = (leagues.leagues ?? []).find((l) => l.isSelected) ?? (leagues.leagues ?? [])[0] ?? null;
if (!league) {
  console.log('no league');
  process.exit(0);
}
const profile = buildScoringProfile(league.scoringSettings ?? {}, league.rosterPositions ?? []);
console.log(`league ${league.name}  recTd=${profile.recTd} rushTd=${profile.rushTd} passTd=${profile.passTd} ppr=${profile.ppr}`);

const [lineup, matchup] = await Promise.all([get(`/api/leagues/${league.id}/lineup`), get(`/api/leagues/${league.id}/matchup`)]);

/** playerId → { name, position, team, side, stored contributions?, card } */
const sample = new Map();
for (const e of [...(lineup.starters ?? []), ...(lineup.bench ?? []), ...(lineup.undecidable ?? [])]) {
  sample.set(e.playerId, { name: e.name, position: e.position, team: e.team, side: 'mine', expectation: e.expectation ?? null });
}
for (const p of matchup.players ?? []) {
  const prior = sample.get(p.playerId);
  sample.set(p.playerId, {
    name: p.fullName ?? prior?.name ?? p.name,
    position: p.position ?? prior?.position,
    team: p.team ?? prior?.team,
    side: p.side ?? prior?.side,
    expectation: prior?.expectation ?? null,
  });
}
for (const [id, card] of Object.entries(matchup.cards ?? {})) {
  const row = sample.get(id) ?? { name: card.name, position: card.position, team: card.team, side: '?', expectation: null };
  row.card = card;
  row.name ??= card.name;
  row.position ??= card.position;
  row.team ??= card.team;
  sample.set(id, row);
}

console.log(`\n=== A+B. stored total and what the card shows (week ${matchup.week}) ===`);
console.log('name | pos | team | side | market | stored TD part | chips on card | card detail | pending');
const teams = new Set();
for (const [, r] of [...sample].sort((a, b) => String(a[1].team).localeCompare(String(b[1].team)))) {
  if (!SKILL.has(r.position)) continue;
  if (r.team) teams.add(String(r.team).toUpperCase());
  const x = r.expectation;
  const td = (x?.contributions ?? []).find((c) => c.market === 'anytime_td' || c.market === 'pass_tds');
  const market = r.card?.lines?.find((l) => l.key === 'market');
  const chips = (r.card?.props ?? []).map((p) => `${p.label} ${p.value}`).join(', ');
  console.log(
    `  ${String(r.name).padEnd(24)} ${String(r.position).padEnd(3)} ${String(r.team).padEnd(4)} ${String(r.side).padEnd(6)} ` +
      `${fmt(market?.value ?? x?.points).padEnd(9)} ` +
      `${x ? (td ? `${td.market}→${td.points} (${td.detail})` : `none; missing${JSON.stringify(x.missingMarkets)}`) : '(opponent: not served)'}` +
      ` | chips[${chips}] | ${market?.detail ?? '-'} | pending${JSON.stringify(r.card?.pending ?? [])}`,
  );
}

console.log('\n=== C. what the provider posts now, and what this revision makes of it ===');
if (!KEY) {
  console.log('  SPORTSGAMEODDS_API_KEY is not set — part C skipped.');
  process.exit(0);
}
async function sgo(path) {
  const res = await fetch(`${SGO}${path}`, { headers: { 'X-Api-Key': KEY, accept: 'application/json' } });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null };
  }
}
async function used() {
  const r = await sgo('/account/usage');
  return r.json?.data?.rateLimits?.['per-month']?.['current-entities'] ?? null;
}
const start = await used();
console.log(`  month so far: ${start} entities`);
if (start != null && start > 2000) {
  console.log('  past 2,000 this month — part C skipped to protect the allowance.');
  process.exit(0);
}
const from = new Date().toISOString().slice(0, 10);
const to = new Date(Date.now() + 8 * 86_400_000).toISOString().slice(0, 10);
const events = [];
for (const team of teams) {
  if (events.length >= MAX_ENTITIES) break;
  if (events.some((e) => Object.values(e.teams ?? {}).some((t) => t.teamID === providerTeamId(team)))) continue;
  const id = providerTeamId(team);
  if (!id) continue;
  const r = await sgo(`/events?leagueID=NFL&type=match&teamID=${id}&startsAfter=${from}&startsBefore=${to}&limit=1`);
  for (const e of r.json?.data ?? []) if (!events.some((x) => x.eventID === e.eventID)) events.push(e);
}
const end = await used();
console.log(`  ${events.length} game(s) read, cost ${start != null && end != null ? end - start : '?'} entities`);

const candidates = [...sample].filter(([, r]) => SKILL.has(r.position));
const index = new PlayerIndex(
  candidates.map(([id, r]) => ({
    id,
    sleeperPlayerId: id,
    fullName: r.name,
    firstName: String(r.name).split(' ')[0],
    lastName: String(r.name).split(' ').slice(1).join(' '),
    team: r.team,
    position: r.position,
    status: null,
    active: true,
    normalizedName: '',
    aliases: [],
  })),
);
const quotes = [];
for (const event of events) {
  const provider = new SportsGameOddsProvider({
    apiKey: 'probe',
    fetch: async () => new Response(JSON.stringify({ data: [event] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const set = await provider.getPlayerProps(event.eventID);
  quotes.push(...set.quotes);
  /* The raw board's touchdown census, before the adapter touches it. */
  const tdPlayers = new Set();
  for (const odd of Object.values(event.odds ?? {})) {
    if (odd.periodID === 'game' && odd.statID === 'touchdowns' && odd.playerID) tdPlayers.add(odd.playerID);
  }
  const sides = Object.values(event.teams ?? {}).map((t) => t.teamID).join(' v ');
  console.log(`  ${sides}: ${tdPlayers.size} players carry a full-game touchdowns quote`);
}
const consensus = buildConsensus(quotes, index);
console.log('\n  name | pos | posted markets | fresh total | TD part | app shows');
let withTd = 0;
let skill = 0;
for (const [id, r] of candidates) {
  const props = consensus.filter((p) => p.playerId === id);
  if (props.length === 0) {
    console.log(`  ${String(r.name).padEnd(24)} ${r.position.padEnd(3)} (no quotes on the board read)`);
    continue;
  }
  skill += 1;
  const x = buildExpectation(r.position, props, profile);
  const td = x.contributions.find((c) => c.market === 'anytime_td' || c.market === 'pass_tds');
  if (td) withTd += 1;
  const shown = r.card?.lines?.find((l) => l.key === 'market')?.value ?? '—';
  console.log(
    `  ${String(r.name).padEnd(24)} ${r.position.padEnd(3)} ${props.map((p) => p.market).sort().join(',').padEnd(52)} ` +
      `${fmt(x.points).padEnd(6)} ${td ? `${td.points} (${td.detail})` : 'NONE'}  | app ${shown}  missing${JSON.stringify(x.missingMarkets)}`,
  );
}
console.log(`\n  ${withTd} of ${skill} priced skill players have a touchdown component on the fresh board`);
