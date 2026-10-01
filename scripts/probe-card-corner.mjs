/**
 * What does the corner of a player's card say on the live league?
 *
 * Before the draft it holds the heart; once Sleeper calls the draft finished it
 * holds the owner pill. This prints the two facts that decide it, the draft's
 * own status and the season's `draftVisible`, and then the label the pill
 * would draw for a spread of real players: one per manager, plus free agents.
 * The label rule mirrors `ownerPillLabel` in `src/web/playerFilters.ts`.
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

const health = await get('/api/health');
console.log(`asking ${APP}  gitSha=${health.json?.gitSha ?? health.json?.release?.gitSha ?? '(none)'}`);

const overview = await get('/api/overview');
const season = overview.json?.season ?? {};
const lifecycle = overview.json?.lifecycle;
console.log(`lifecycle: ${typeof lifecycle === 'string' ? lifecycle : JSON.stringify(lifecycle ?? null)}`);
console.log(`season: phase=${season.phase} draftVisible=${season.draftVisible} reason="${season.reason ?? ''}"`);
console.log(`card corner: ${season.draftVisible === false ? 'OWNER PILL' : 'HEART'}\n`);

const leagues = await get('/api/leagues');
const league =
  (leagues.json?.leagues ?? []).find((l) => l.isSelected) ?? (leagues.json?.leagues ?? [])[0] ?? null;
if (!league) {
  console.log(`no league: ${leagues.status}`);
  process.exit(0);
}
console.log(`league: ${league.name} (${league.id})  draftId=${league.draftId ?? '(none)'}`);
// Sleeper's own word on the draft, read from Sleeper rather than from this app.
if (league.draftId) {
  try {
    const res = await fetch(`https://api.sleeper.app/v1/draft/${league.draftId}`);
    const draft = await res.json();
    console.log(`Sleeper draft status: ${draft?.status ?? '(none)'}  rounds=${draft?.settings?.rounds ?? '?'}`);
  } catch (err) {
    console.log(`Sleeper draft read failed: ${String(err)}`);
  }
}
console.log('');

const res = await get(`/api/players?q=&leagueId=${encodeURIComponent(league.id)}&limit=200&offset=0`);
const players = res.json?.players ?? [];
const teams = res.json?.teams ?? [];
console.log(`players: ${players.length}  teams: ${teams.length}\n`);

function label(ownerRosterId) {
  if (teams.length === 0) return null;
  if (ownerRosterId == null) return 'Available';
  const team = teams.find((t) => t.rosterId === ownerRosterId);
  if (!team) return `Team ${ownerRosterId}`;
  return team.isMine ? 'You' : (team.ownerName ?? '').trim() || `Team ${team.rosterId}`;
}

// One player per manager, then the first two free agents.
const owners = new Set();
let freeAgents = 0;
for (const p of players) {
  if (p.ownerRosterId == null) {
    if (freeAgents >= 2) continue;
    freeAgents++;
  } else {
    if (owners.has(p.ownerRosterId)) continue;
    owners.add(p.ownerRosterId);
  }
  console.log(`  ${String(p.name).padEnd(24)} ${String(p.position ?? '').padEnd(4)} pill: ${label(p.ownerRosterId)}`);
}
