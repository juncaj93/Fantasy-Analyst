/**
 * Everything the start/sit engine reads, assembled once per request.
 *
 * This lives in its own module because five endpoints and now a sixth need the
 * identical assembly, and the alternative is copies that drift: a player who is
 * Questionable on the Team screen and healthy on the Matchup screen is not a
 * display bug, it is two different answers to one lineup question. It moved out
 * of `app.ts` unchanged when Matchup arrived — the route file was the wrong
 * place for it the moment anything other than a route needed it.
 */

import { PropsRepo } from '../repos/props.ts';
import { PlayerRepo } from '../repos/players.ts';
import { EvidenceRepo } from '../repos/evidence.ts';
import { VegasEventsRepo } from '../repos/vegasEvents.ts';
import { InjuryService } from './injuryService.ts';
import { UsageService } from './usageService.ts';
import type { StartSitInput } from '../../core/startsit/engine.ts';
import type { StartSitMode } from '../../core/startsit/mode.ts';
import type { DefenseTendencyIndex } from '../../core/startsit/defense.ts';
import type { Database } from '../db.ts';

/**
 * Everything the start/sit engine knows about a set of players.
 *
 * One function, used by the lineup, the head-to-head comparison and the waiver
 * scan alike, because the alternative is three copies that drift: a player who
 * is Questionable on one screen and healthy on another is not a display bug, it
 * is two different answers to a lineup question.
 *
 * A player missing from the dictionary is skipped rather than fatal — a gap in
 * the player list is not a reason to fail the whole screen.
 */
export async function startSitInputsFor(
  db: Database,
  playerIds: string[],
  opts: { mode?: StartSitMode; context?: StartSitContext } = {},
): Promise<StartSitInput[]> {
  if (playerIds.length === 0) return [];
  const propsRepo = new PropsRepo(db);
  const [players, propsByPlayer, previousProps, kickoffs, signals] = await Promise.all([
    new PlayerRepo(db).listByIds(playerIds),
    propsRepo.latestForPlayers(playerIds),
    propsRepo.previousForPlayers(playerIds),
    propsRepo.kickoffsForPlayers(playerIds),
    new EvidenceRepo(db).getSignals(playerIds),
  ]);

  /*
   * Availability, resolved once for everybody.
   *
   * Sleeper's designation and the published injury report are combined here
   * rather than in the engine, so every screen reads the same state — and a
   * failure of the secondary source costs the practice detail and nothing else,
   * because the resolver falls back to Sleeper on its own.
   */
  const injuries = await new InjuryService(db)
    .statesFor([...players.values()].map((p) => ({ playerId: p.id, status: p.status })))
    .catch(() => new Map());

  /*
   * Per-game opportunity, for the role trend.
   *
   * Absent for a player with fewer than six games stored, which is the ordinary
   * state in September and is passed through as absent rather than padded:
   * `assessRole` answers `insufficient_data` for a short series, and that is the
   * honest answer rather than a trend invented from four games.
   */
  const usageService = new UsageService(db);
  const usage = await usageService
    .roleMetricsFor([...players.values()].map((p) => ({ playerId: p.id, position: p.position })))
    .catch(() => new Map());
  /*
   * The stored weeks themselves, for everything the trend series cannot answer.
   *
   * One extra indexed read for the same players, and it is what the opportunity
   * level, the role classification and the touchdown-dependency read are all
   * built from. A failure costs those three components and nothing else: they
   * report unknown, which is what they said before this pipeline existed.
   */
  const weeks = await usageService.weeksFor(playerIds).catch(() => new Map());

  /*
   * League-wide context, built once per request rather than once per player.
   *
   * The opponent table is a model over the whole season's games and the
   * schedule is one row per event — computing either inside the per-player loop
   * would turn one query into forty. `context` is passed in by callers that
   * have already built it for a different endpoint on the same request.
   */
  const context = opts.context ?? (await buildStartSitContext(db, usageService));

  const inputs: StartSitInput[] = [];
  for (const id of playerIds) {
    const player = players.get(id);
    if (!player) continue;
    const game = context.schedule.get((player.team ?? '').toUpperCase()) ?? null;
    inputs.push({
      player,
      props: propsByPlayer.get(id) ?? [],
      previousProps: previousProps.get(id) ?? [],
      // Absent means the schedule is unknown, which is never treated as a lock:
      // refusing a change the user can still make would be the app inventing a
      // restriction.
      kickoff: kickoffs.get(id) ?? null,
      signal: signals.get(id) ?? null,
      injuryStatus: player.status,
      injury: injuries.get(id) ?? null,
      usage: usage.get(id) ?? undefined,
      usageWeeks: weeks.get(id) ?? undefined,
      game: game ? { spread: game.spread, total: game.total, opponent: game.opponent } : null,
      opponent: game?.opponent ?? null,
      defenseTendencies: context.defense,
      mode: opts.mode ?? 'balanced',
      propsStale: false,
    });
  }
  return inputs;
}

/**
 * The things every player in a request shares: the slate, and the defences.
 *
 * Assembled once and handed to `startSitInputsFor`, because both halves are
 * league-wide models rather than per-player facts. Both degrade to empty
 * without failing the screen: no schedule means the game-script component says
 * "no game line", and no tendencies mean the matchup component says so too.
 */
export interface StartSitContext {
  /** Team abbreviation -> the game they are in, from the paid-for schedule. */
  schedule: Map<string, { opponent: string | null; spread: number | null; total: number | null; kickoff: string | null }>;
  defense: DefenseTendencyIndex;
}

export async function buildStartSitContext(
  db: Database,
  usageService = new UsageService(db),
  now = new Date(),
): Promise<StartSitContext> {
  const from = new Date(now.getTime() - 12 * 3_600_000).toISOString();
  const to = new Date(now.getTime() + 9 * 86_400_000).toISOString();

  const [events, defense] = await Promise.all([
    new VegasEventsRepo(db).between(from, to).catch(() => []),
    usageService.defenseTendencies().catch(() => new Map() as DefenseTendencyIndex),
  ]);

  const schedule: StartSitContext['schedule'] = new Map();
  for (const event of events) {
    const sides = [event.homeTeam, event.awayTeam].filter((t): t is string => !!t).map((t) => t.toUpperCase());
    if (sides.length === 0) continue;
    for (const team of sides) {
      if (schedule.has(team)) continue;
      const opponent = sides.find((t) => t !== team) ?? null;
      /*
       * The spread, resolved against the team it was stored for.
       *
       * Never against a column position: `home_team` in this table means "a
       * team we asked about", so reading the spread as "the home team's" would
       * be backwards for half the slate. A spread whose team is not one of the
       * two sides is dropped rather than guessed at.
       */
      const spreadTeam = (event.spreadTeam ?? '').toUpperCase();
      const spread =
        event.spread == null || !spreadTeam || !sides.includes(spreadTeam)
          ? null
          : spreadTeam === team
            ? event.spread
            : -event.spread;
      schedule.set(team, { opponent, spread, total: event.total ?? null, kickoff: event.kickoff });
    }
  }

  return { schedule, defense };
}

