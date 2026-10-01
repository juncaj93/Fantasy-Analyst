/**
 * Does the Players row's `7d` read differently from its `30d`?
 *
 * The compact Players row now prints `7d` ahead of `30d`, both from the same
 * `signal` object the list already carries. This walks the live list the
 * screen asks for and prints the players whose two windows disagree most: the
 * ones heating up this week, and the ones cooling off. Reads only, GET only.
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

const health = await get('/api/health');
console.log(`asking ${APP}  gitSha=${health.json?.gitSha ?? health.json?.release?.gitSha ?? '(none)'}`);

const leagues = await get('/api/leagues');
const league =
  (leagues.json?.leagues ?? []).find((l) => l.isSelected) ?? (leagues.json?.leagues ?? [])[0] ?? null;
const leagueParam = league ? `&leagueId=${encodeURIComponent(league.id)}` : '';
console.log(`league: ${league ? `${league.name} (${league.id})` : 'none'}\n`);

const players = [];
for (let offset = 0; offset < 600; offset += 100) {
  const res = await get(`/api/players?q=${leagueParam}&limit=100&offset=${offset}`);
  if (res.status !== 200) {
    console.log(`GET /api/players offset=${offset} -> ${res.status} ${res.text ?? ''}`);
    break;
  }
  players.push(...(res.json?.players ?? []));
  if (!res.json?.hasMore) break;
}

const sign = (n) => (n > 0 ? `+${n}` : String(n));
const rows = players
  .filter((p) => p.signal)
  .map((p) => ({ name: p.name, pos: p.position, d7: p.signal.last7.net, d30: p.signal.last30.net }));
const differ = rows.filter((r) => r.d7 !== r.d30);
console.log(`players: ${players.length}  with a tally: ${rows.length}  7d differs from 30d: ${differ.length}\n`);

// Heating up: this week carries more than its share of the month.
const heat = (r) => r.d7 - r.d30 / 4;
const line = (r) => `  ${r.name.padEnd(24)} ${String(r.pos ?? '').padEnd(4)} 7d ${sign(r.d7).padStart(4)} · 30d ${sign(r.d30).padStart(4)}`;
console.log('Trending up this week:');
for (const r of [...differ].sort((a, b) => heat(b) - heat(a)).slice(0, 5)) console.log(line(r));
console.log('\nTrending down this week:');
for (const r of [...differ].sort((a, b) => heat(a) - heat(b)).slice(0, 5)) console.log(line(r));
