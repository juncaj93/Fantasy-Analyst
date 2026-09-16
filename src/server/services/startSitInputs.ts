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
import { NflScheduleRepo } from '../repos/nflSchedule.ts';
import { slateWindow } from '../../core/nfl/slateWindow.ts';
import { SettingsRepo, SETTING_KEYS } from '../repos/settings.ts';
import { homeByTeam, indoorByTeam } from '../../core/nfl/schedule.ts';
import { seasonStartIso } from '../../core/dst/assemble.ts';
import { InjuryService } from './injuryService.ts';
import { UsageService, roleMetricsFrom } from './usageService.ts';
import type { StoredUsageWeek } from '../repos/usage.ts';
import type { StartSitInput } from '../../core/startsit/engine.ts';
import type { StartSitMode } from '../../core/startsit/mode.ts';
import type { DefenseTendencyIndex } from '../../core/startsit/defense.ts';
import type { NflState } from '../../core/sleeper/phase.ts';
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
  opts: {
    mode?: StartSitMode;
    context?: StartSitContext;
    /**
     * Reference time, so the slate window is testable.
     *
     * `buildStartSitContext` has taken one since it was written and this did
     * not, which meant the two halves of one window could only ever be pinned
     * on one side. A test that wants to stand at a fixed Tuesday and ask what
     * counts as this week had to hardcode a wall-clock instant and then read
     * the real one — which works for about fifteen hours and then starts
     * failing for reasons that have nothing to do with the code.
     *
     * Defaults to now, so nothing in production changes.
     */
    now?: Date;
  } = {},
): Promise<StartSitInput[]> {
  if (playerIds.length === 0) return [];
  const propsRepo = new PropsRepo(db);
  /*
   * This week's games, and only this week's.
   *
   * The same window `buildStartSitContext` passes to `VegasEventsRepo.between`,
   * from the same function, because the two reads are two halves of one fact
   * and they had drifted: the events half was windowed from the day it was
   * written and the props half never was. See `core/nfl/slateWindow.ts` for
   * what that cost in production on 15 September 2026.
   *
   * The same window also bounds the kickoff read below, which is the secondary
   * source behind the fixture list. It used to be the only one, and unbounded:
   * the newest `game_start` that had ever mentioned the player, whatever week
   * it belonged to.
   */
  const slate = slateWindow(opts.now ?? new Date());
  const [players, propsByPlayer, previousProps, pricedKickoffs, signals] = await Promise.all([
    new PlayerRepo(db).listByIds(playerIds),
    propsRepo.latestForPlayers(playerIds, slate),
    propsRepo.previousForPlayers(playerIds, slate),
    propsRepo.kickoffsForPlayers(playerIds, slate),
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
   * The stored weeks, read once and used for both things that need them.
   *
   * Two consumers: the role *trend*, which is `assessRole`'s two disagreeing
   * series, and the raw rows, which the opportunity level, the role
   * classification and the touchdown-dependency read each ask a different
   * question of. Both used to fetch their own copy — `roleMetricsFor` is a
   * `weeksFor` read plus a pure derivation, so every assembly ran the identical
   * query twice and paid for the same rows twice. Measured on a 30-player
   * matchup at week 10: 600 rows where 300 were wanted, on a screen that
   * re-assembles every thirty seconds while games are live.
   *
   * A failure still costs those components and nothing else — an empty map is
   * `insufficient_data` and `unknown`, which is what they said before this
   * pipeline existed. Absent for a player with fewer than six games stored,
   * which is the ordinary state in September and is passed through as absent
   * rather than padded.
   */
  const usageService = new UsageService(db);
  const weeks = await usageService.weeksFor(playerIds).catch(() => new Map<string, StoredUsageWeek[]>());
  const usage = roleMetricsFrom(
    [...players.values()].map((p) => ({ playerId: p.id, position: p.position })),
    weeks,
  );

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
      /*
       * From the league's fixture list, not from whatever a book last quoted.
       *
       * It used to come from `PropsRepo.kickoffsForPlayers`, which read the
       * `game_start` of the newest snapshot that mentioned the player — with
       * no bound on which week that snapshot was for. On the Tuesday of week 2
       * that was the previous Sunday's kickoff for nine of ten starters, every
       * one of them therefore `locked`, and a locked starter cannot be moved
       * by the optimiser or traded for: the trade board's own diagnostics
       * showed 107 candidates scored and every one rejected at "your lineup
       * would gain 0.0 pts".
       *
       * The fixture list first, then the `game_start` of a game a book has
       * quoted *in this week's window*. The second is a genuine fallback
       * rather than a duplicate: `nfl_schedule` is an ingested table that can
       * be empty, and a deployment that has not read it yet must not lose
       * every kickoff it holds. What it may never do again is answer from a
       * week that is over.
       *
       * Absent means the schedule is unknown, which is never treated as a lock:
       * refusing a change the user can still make would be the app inventing a
       * restriction.
       */
      kickoff: game?.kickoff ?? pricedKickoffs.get(id) ?? null,
      signal: signals.get(id) ?? null,
      injuryStatus: player.status,
      injury: injuries.get(id) ?? null,
      usage: usage.get(id) ?? undefined,
      usageWeeks: weeks.get(id) ?? undefined,
      game: game ? { spread: game.spread, total: game.total, opponent: game.opponent } : null,
      opponent: game?.opponent ?? null,
      /*
       * At home or on the road, for the one model that reads it.
       *
       * Set from the shared context so every screen agrees: a defence worth
       * 8.4 on Team and 8.1 on Waivers is not a rounding difference, it is two
       * answers to one question. Absent when the fixture list has not been
       * ingested, which removes the term rather than putting anybody on the
       * road by default.
       */
      ...(context.home.has((player.team ?? '').toUpperCase())
        ? { home: context.home.get((player.team ?? '').toUpperCase())! }
        : {}),
      /*
       * Indoors, when the fixture list says so, and nothing when it does not.
       *
       * The weather model has always had an indoor branch — a dome is the
       * absence of the question rather than a mild day — and never had anything
       * to trigger it, because nothing set `weather` at all. This does not
       * invent a forecast: an outdoor game passes no object, so the component
       * stays `unknown`, exactly as it was.
       */
      ...(context.indoor.get((player.team ?? '').toUpperCase())
        ? { weather: { indoor: true, source: 'fixture list' } }
        : {}),
      /*
       * The opposing offence's market form, for the defence lane's fallback.
       *
       * Set for everybody rather than only for defences because the engine's
       * skill-position path does not read it — see the field's own note — and a
       * per-position branch here would put the same fact in two shapes.
       */
      ...(game?.opponent && context.opponentForm.has(game.opponent.toUpperCase())
        ? { opponentForm: context.opponentForm.get(game.opponent.toUpperCase())! }
        : {}),
      defenseTendencies: context.defense,
      /*
       * Only when the caller has one. An input with no mode is not an input
       * with Balanced on it: `assembleLineup` reads `i.mode ?? mode`, so a
       * hardcoded default here silently outranked the mode the assembly was
       * asked for — which is exactly what the lineup route now needs, because
       * it resolves the week's posture *after* gathering these.
       */
      ...(opts.mode ? { mode: opts.mode } : {}),
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
  /**
   * Which teams are at home this week, from the stored fixture list.
   *
   * A third league-wide fact, built once beside the other two. Empty until a
   * schedule has been ingested, which is the state every deployment was in
   * before migration 0032 and which the defence model already handles by
   * dropping the term.
   */
  home: Map<string, boolean>;
  /**
   * Which teams are playing indoors, off the same fixture rows as `home`.
   *
   * Built from `roof`, which this app already stores and had never read. It
   * costs no additional query — the rows are the ones `home` is derived from —
   * and it is the only environmental fact available here, since there is no
   * weather feed. Absent for every team playing outdoors or under a roof whose
   * state is unpublished, which leaves the weather component unknown rather
   * than claiming a forecast nobody has.
   */
  indoor: Map<string, boolean>;
  /**
   * What the market has paid each offence, over the games it actually priced.
   *
   * The fallback anchor a defence may use when its *own* fixture is unpriced —
   * see `dstProjection.ts`'s `fromOpponentForm` for why a defence gets that
   * second look and a receiver does not.
   *
   * **Empty unless it could be needed.** The read below is skipped entirely
   * when every fixture in this week's window already carries a line, because
   * then no defence can reach the fallback and the query would buy nothing.
   * That condition is free to evaluate — the events are already in hand — and
   * it matters on a database this app has run to the edge of its quota twice
   * this week.
   */
  opponentForm: Map<string, { impliedTotal: number; games: number }>;
}

export async function buildStartSitContext(
  db: Database,
  usageService = new UsageService(db),
  now = new Date(),
): Promise<StartSitContext> {
  const { from, to } = slateWindow(now);

  const [events, defense, state] = await Promise.all([
    new VegasEventsRepo(db).between(from, to).catch(() => []),
    usageService.defenseTendencies().catch(() => new Map() as DefenseTendencyIndex),
    new SettingsRepo(db).get<NflState | null>(SETTING_KEYS.nflState, null).catch(() => null),
  ]);

  /*
   * The fixture list for the week in play — thirty-two rows, or none.
   *
   * Read here rather than by each route because the alternative was one route
   * knowing which side of a game a defence is on and the next one not. A season
   * or a week Sleeper has not published yet skips the read entirely.
   */
  /*
   * One read, two facts. `home` and `indoor` are both derived from the same
   * fixture rows, so the second one is free — which matters on a database this
   * app has repeatedly run to the edge of its quota.
   */
  const fixtures =
    state?.season && state.week != null && state.week > 0
      ? await new NflScheduleRepo(db).forWeek(String(state.season), state.week).catch(() => [])
      : [];
  const home = homeByTeam(fixtures);
  const indoor = indoorByTeam(fixtures);

  /*
   * The slate, seeded from the fixture list and priced from the book.
   *
   * The order is the point, and it is a division of ownership rather than a
   * preference. `nfl_schedule` is the NFL's own fixture list: it has all
   * thirty-two teams, it knows a bye from an unpriced game, and it carries a
   * kickoff for a fixture no book has quoted. `vegas_events` has only the
   * games somebody is taking bets on, and what it uniquely holds is the price.
   *
   * So every team this week gets an entry with its opponent and its kickoff,
   * and the loop below adds a spread and a total to the ones that have been
   * priced. Before this, the map was built from the events alone — which meant
   * that "who does he play and when" was only answerable for a player whose
   * game a book had quoted, and on the Tuesday of a new week, when the odds
   * cron has not run since the previous Sunday, that was nobody.
   */
  const schedule: StartSitContext['schedule'] = new Map();
  for (const fixture of fixtures) {
    const team = fixture.team.toUpperCase();
    if (!team) continue;
    schedule.set(team, {
      opponent: fixture.opponent ? fixture.opponent.toUpperCase() : null,
      spread: null,
      total: null,
      kickoff: fixture.kickoff,
    });
  }

  for (const event of events) {
    const sides = [event.homeTeam, event.awayTeam].filter((t): t is string => !!t).map((t) => t.toUpperCase());
    if (sides.length === 0) continue;
    for (const team of sides) {
      const fixture = schedule.get(team);
      /*
       * Priced twice in one window is possible — a Thursday game and the
       * following Thursday can both be inside nine days — and the fixture list
       * says which of them is this week's. A team already carrying a price
       * keeps it; a team the schedule does not list at all is still admitted,
       * because a missing fixture row must not be able to hide a game.
       */
      if (fixture && (fixture.spread != null || fixture.total != null)) continue;
      const opponent = fixture?.opponent ?? sides.find((t) => t !== team) ?? null;
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
      schedule.set(team, {
        opponent,
        spread,
        total: event.total ?? null,
        // The fixture list's kickoff wins where there is one: it is published
        // by the league rather than by a book, and it exists for games nobody
        // has priced.
        kickoff: fixture?.kickoff ?? event.kickoff,
      });
    }
  }

  /*
   * One aggregate, and only when a defence could actually need it.
   *
   * `schedule` above is this week's events; if all of them carry a total and a
   * spread then every defence is priced the ordinary way and the fallback is
   * unreachable. Asking anyway would be a season-wide scan bought for nothing,
   * on a path Team, Matchup and Waivers all run.
   */
  const anyUnpriced = [...schedule.values()].some((g) => g.total == null || g.spread == null);
  const opponentForm =
    anyUnpriced && state?.season
      ? await new VegasEventsRepo(db)
          .impliedTotalsByTeam(seasonStartIso(String(state.season)), now.toISOString())
          .catch(() => new Map<string, { impliedTotal: number; games: number }>())
      : new Map<string, { impliedTotal: number; games: number }>();

  return { schedule, defense, home, indoor, opponentForm };
}

