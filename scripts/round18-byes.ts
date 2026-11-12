/**
 * Round 18: this week's real byes against what each screen decides, for every
 * rostered player in the league.
 *
 *   LEAGUE_ID=<id> node --experimental-transform-types --no-warnings scripts/round18-byes.ts
 *
 * Read-only (production D1 through `scripts/lib/d1Http.ts`). The truth is the
 * NFL fixture list for the week Sleeper is in (`nfl_schedule`): a club with no
 * game is on bye. Then, for every player on every roster:
 *
 *  - Team, Matchup and Compare: the `onBye` flag `startSitInputsFor` builds,
 *    which all three read (Matchup prints BYE from it, Team now prints "Bye");
 *  - Waivers: the shared `byeReader` over the clubs Waivers asks about;
 *  - and who has no number at all, so a "No projection" row is not mistaken
 *    for a bye.
 *
 * Every disagreement is printed by name.
 */

import { d1Http } from './lib/d1Http.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { NflScheduleRepo } from '../src/server/repos/nflSchedule.ts';
import { SettingsRepo, SETTING_KEYS } from '../src/server/repos/settings.ts';
import { startSitInputsFor } from '../src/server/services/startSitInputs.ts';
import { byeReader, playingTeams, isOnBye } from '../src/core/nfl/schedule.ts';
import { normalizeTeam } from '../src/core/identity/normalize.ts';

const db = await d1Http();
const leagueId =
  process.env.LEAGUE_ID ||
  String((await db.prepare('SELECT id FROM leagues WHERE is_selected = 1 LIMIT 1').first<{ id: string }>())?.id ?? '');
/* The app's week (Round 18 follow-up): the week every screen shows. Older code has no such read and falls back to Sleeper's. */
const appState = await import('../src/server/services/appWeek.ts').then((m) => m.readAppNflState(db)).catch(() => null);
const state = appState ?? (await new SettingsRepo(db).get<{ season?: string; week?: number } | null>(SETTING_KEYS.nflState, null));
const season = String(state?.season ?? '');
const week = Number(state?.week ?? 0);
console.log(`season ${season}, app week ${week}, Sleeper week ${(appState as { sleeperWeek?: number } | null)?.sleeperWeek ?? week}`);

const fixtures = await new NflScheduleRepo(db).forWeek(season, week);
const playing = playingTeams(fixtures);
const clubs = [...new Set(fixtures.map((f) => normalizeTeam(f.team)))].sort();
console.log(`fixture rows this week: ${fixtures.length}; clubs with a game: ${playing ? playing.size : `unknown (fewer than 20 listed: ${clubs.length})`}`);
const ALL = ['ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC', 'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS'];
const realByes = playing ? ALL.filter((t) => !playing.has(t)) : [];
console.log(`real byes this week (from the fixture list): ${realByes.join(', ') || 'none'}`);

const rosters = await new LeagueRepo(db).listRosters(leagueId);
const ids = [...new Set(rosters.flatMap((r) => r.playerIds))].filter((id) => !/^[A-Z]{2,3}$/.test(id));
const inputs = await startSitInputsFor(db, ids);
/* Waivers asks about the clubs it needs, this week through three ahead: the same read. */
const teamFixtures = await new NflScheduleRepo(db).forTeams(season, [...new Set(inputs.map((i) => normalizeTeam(i.player.team)).filter(Boolean))], { from: week, to: week + 3 });
const waiverBye = byeReader(teamFixtures);

let disagree = 0;
let onByeCount = 0;
const owner = new Map<string, string>();
for (const r of rosters) for (const id of r.playerIds) owner.set(id, r.isMine ? 'Alex' : `roster ${r.rosterId}`);
for (const input of inputs) {
  const team = input.player.team ?? '';
  const truth = isOnBye(team, playing);
  const screen = input.onBye === true;
  const waivers = waiverBye(team, week) === true;
  if (screen) onByeCount++;
  if (truth !== screen || truth !== waivers) {
    disagree++;
    console.log(`  DISAGREE ${input.player.fullName} (${input.player.position} ${team}, ${owner.get(input.player.id)}): schedule ${truth ? 'bye' : 'plays'}, Team/Matchup/Compare ${screen ? 'bye' : 'plays'}, Waivers ${waivers ? 'bye' : 'plays'}`);
  }
}
console.log(`rostered players checked: ${inputs.length}; shown on bye: ${onByeCount}; disagreements: ${disagree}`);
const mine = rosters.find((r) => r.isMine);
for (const input of inputs.filter((i) => mine?.playerIds.includes(i.player.id) && i.onBye)) console.log(`  Alex on bye: ${input.player.fullName} (${input.player.team})`);
console.log(`bye check rows read: ${db.rowsRead()}`);
