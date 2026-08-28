/**
 * What the expanded player card knows that the collapsed one does not.
 *
 * Two sources, two rhythms:
 *
 *   - **last season**, from Sleeper's public season-stats endpoint. One request
 *     covers every player, a finished season stops changing, and it runs on the
 *     nightly clock beside the player dictionary.
 *   - **this season's outlook**, from Sleeper's public GraphQL endpoint, one
 *     player at a time because that is the only shape it comes in. Fetched when
 *     a card is opened, then cached — hits and misses alike, because most
 *     players have no outlook and asking again every time somebody opens one of
 *     those cards is precisely the unbounded fetching this project refuses.
 *
 * Neither may ever block the draft board. The board does not read this at all;
 * the card asks for it separately, after it is open.
 *
 * ## Nor may either block the card
 *
 * "Fetched when a card is opened" used to mean *awaited* when a card is opened,
 * and that was the single largest thing between a tap and a card: a cold
 * outlook is a GraphQL round trip to somebody else's server, 150-400ms of it,
 * in front of a payload of eight hundred bytes the database already had. It is
 * now started and not waited for — see `scheduleOutlookRefresh` — so the first
 * open costs what the second one does and the text arrives on the next open.
 *
 * The database reads went the same way, for the same reason. They used to run
 * one after another because they were written one after another: seventeen
 * statements, seventeen serialized round trips, four of them asking for the
 * same player row. `forPlayer` now issues them in three waves — everything that
 * depends on nothing, then everything that depends on that, then the one read
 * that needs a snapshot id — and `tests/playerDetailWaves.test.ts` fails if a
 * fourth appears.
 */

import { calendarSeason, priorSeason } from '../../core/season/context.ts';
import { SleeperClient } from '../../core/sleeper/client.ts';
import { fetchPlayerOutlook, type FetchLike } from '../../core/sleeper/outlook.ts';
import { summariseOutlook } from '../../core/sleeper/outlookSummary.ts';
import { majorInjuryHistory } from '../../core/draft/injury.ts';
import { DESIGNATION_LABEL, injuryLine, provenanceLine } from '../../core/injury/model.ts';
import { InjuryService } from './injuryService.ts';
import { LeagueRepo } from '../repos/league.ts';
import { PreseasonProjectionsRepo } from '../repos/preseasonProjections.ts';
import { buildScoringProfile } from '../../core/sleeper/scoring.ts';
import { projectionScoringFrom, scoringKey } from '../../core/startWho/scoring.ts';
import { InjuryHistoryRepo } from '../repos/injuryHistory.ts';
import { assessHistory, deriveEpisodes } from '../../core/injury/history.ts';
import {
  fullSeasonSlate,
  reconcileHistoricalAvailability,
  type HistoricalAvailability,
} from '../../core/injury/availability.ts';
import { buildSeasonStatLines, formatPositionRank, HALF_PPR } from '../../core/sleeper/seasonStats.ts';
import { selectTakeaway } from '../../core/evidence/takeaway.ts';
import { profileContext } from '../../core/players/profileFlags.ts';
import { assessRole } from '../../core/startsit/decisions.ts';
import { UsageService } from './usageService.ts';
import { EvidenceRepo } from '../repos/evidence.ts';
import { PlayerDetailRepo } from '../repos/playerDetail.ts';
import { PlayerRepo } from '../repos/players.ts';
import type { CanonicalPlayer } from '../../core/identity/types.ts';
import type { Database } from '../db.ts';

/**
 * The season whose statistics a draft looks back on: the one before the one
 * being drafted. Derived rather than pinned, so this does not need editing
 * every August.
 */
export function lastCompletedSeason(now = new Date()): string {
  // Sleeper's league seasons roll over in the spring; a draft in August 2026 is
  // for the 2026 season and looks back at 2025. Expressed as "the season before
  // the current one" rather than as its own month arithmetic, so it cannot
  // drift from the current-season answer across the February boundary.
  return priorSeason(outlookSeason(now));
}

/** The season an outlook is written about: the one being drafted. */
export function outlookSeason(now = new Date()): string {
  return calendarSeason(now);
}

/**
 * How long a cached outlook stands.
 *
 * These are written once in the pre-season and edited rarely. A week is short
 * enough that a rewrite lands before a draft that matters and long enough that
 * a board opened repeatedly costs one request per player per week.
 */
const OUTLOOK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A miss is re-checked less often than a hit is refreshed. Nobody writes a
 * season outlook for a third-string guard, and asking every week for four
 * months is four questions with the same answer.
 */
const OUTLOOK_MISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How many of a player's evidence rows the takeaway selection reads.
 *
 * The selection halves a candidate's score every three weeks, so an item older
 * than a season cannot beat anything current; reading a thousand of them to
 * discard nine hundred is work with a known answer. Newest first, so the bound
 * cuts the tail rather than the head.
 */
const TAKEAWAY_EVIDENCE_LIMIT = 40;

/**
 * The stored weekly injury rows, named off the function that consumes them.
 *
 * Taken from `deriveEpisodes` rather than imported from the repository so the
 * two cannot drift: whatever shape the derivation reads is the shape this
 * service is obliged to hand it.
 */
type HistoryRows = Parameters<typeof deriveEpisodes>[0];

export interface SeasonStatsView {
  season: string;
  gamesPlayed: number | null;
  /** `WR7`. Null when he did not score, which is not the same as finishing last. */
  positionRank: string | null;
  /** What "half-PPR" means here, for the card's own tooltip. */
  scoring: string;
}

export interface OutlookView {
  season: string;
  /** The provider's heading, e.g. `2026 Season Outlook`. */
  title: string;
  /**
   * What the card shows: a short selection of it, or all of it.
   *
   * It was once cut to the first two or three sentences, which was a bad trade
   * — these paragraphs open with last season and work forwards, so a clip from
   * the top routinely dropped the depth-chart and workload sentences, the
   * fantasy-relevant half. It then showed the whole thing, which is honest and
   * is twelve hundred characters on a phone mid-draft.
   *
   * Neither, now. `outlookSummary.ts` picks the two or three sentences that
   * bear on the decision and prints them **in the provider's own words, in the
   * order they were written**. No paraphrase, no splicing, nothing composed —
   * attributing invented prose to a named provider is the failure mode this
   * whole design is built to avoid. When nothing in an outlook scores as
   * decision-relevant, or the selection would not have been much shorter, the
   * summariser declines and this is the whole text again.
   */
  text: string;
  /**
   * True when `text` is a selection rather than the whole thing, so the card
   * can say so and offer the rest. A shortened quotation that does not admit it
   * is a misquotation.
   */
  summarised: boolean;
  /** The whole thing, always — the card expands into it on request. */
  fullText: string;
  /** Who wrote it. Shown, not merely stored. */
  source: string | null;
  fetchedAt: string;
}

/** What a market-derived model expected of him before the season began. */
export interface PreseasonProjectionView {
  points: number;
  /** `StartWho · Aug 22`. */
  label: string;
  /** `Half PPR · 6pt pass TD` — the rules the number was computed under. */
  scoringLabel: string;
  capturedAt: string;
}

export interface PlayerDetailView {
  playerId: string;
  /**
   * The preseason market-derived projection, when one covers him.
   *
   * Historical context and nothing more. It is shown with its date and the
   * scoring it was captured under so that after week one it cannot be read as a
   * current expectation — the weekly market owns that, and this is what
   * somebody thought in August.
   *
   * Null when no snapshot covers him, or when every snapshot was captured under
   * scoring this league does not use. The card shows nothing rather than a
   * number that would be wrong for the reader's rules.
   */
  preseasonProjection: PreseasonProjectionView | null;
  lastSeason: SeasonStatsView | null;
  outlook: OutlookView | null;
  /**
   * Why there is no outlook, when there is none. The card is allowed to say
   * "none published" and is not allowed to imply the app failed to look.
   */
  outlookNote: string | null;
  /**
   * `2025: missed 5 games with a hamstring injury` — one line, or nothing.
   *
   * Last season, never this one. Two sources can produce it and only one is
   * ever shown:
   *
   *   - participation reconciled against the published season report — how
   *     many games he missed, and how much of that an injury explains.
   *     Preferred, because it carries numbers that agree with the stat line
   *     directly above it on the card;
   *   - failing that, a diagnosis named in the season outlook, as a label
   *     (`Major injury history: ACL`). Kept for the injuries the report's
   *     vocabulary cannot express — it lists body parts, so a torn ACL appears
   *     there only as "Knee".
   *
   * Never both. Showing a counted line and a label about the same injury is the
   * app saying one thing twice in two voices.
   */
  injuryContext: string | null;
  /**
   * The reconciliation `injuryContext` was derived from, in numbers.
   *
   * The line above is one sentence and this is the working behind it: games
   * played, games available, total missed, how many of those an injury
   * explains, and how many it does not. Present so that a summary can be
   * audited against its own inputs — the defect this replaced was invisible
   * precisely because the card showed a sentence and never the arithmetic.
   *
   * `null` when there was nothing to reconcile.
   */
  availability: {
    season: string;
    gamesPlayed: number | null;
    gamesAvailable: number | null;
    gamesMissedTotal: number | null;
    injuryAttributedMisses: number;
    unresolvedMisses: number | null;
    confidence: string;
    /** Games tied to each body part, most costly first. */
    parts: { part: string; games: number; episodes: number }[];
    /** Whether supported prose independently stated the same total. */
    corroborated: boolean;
  } | null;
  /**
   * What is known about his availability right now, and where it came from.
   *
   * Separate from `injuryContext` above, which is history named in the season
   * outlook. This is the current designation, the body part, the practice week
   * and the provenance — three sources' worth of fact, resolved once.
   */
  injury: {
    designation: string;
    label: string;
    line: string | null;
    bodyPart: string | null;
    practice: string | null;
    provenance: string | null;
    freshness: string;
    confidence: string;
    conflict: string | null;
  } | null;
  /**
   * One sentence saying why the tally reads the way it does.
   *
   * Explanation, never arithmetic. The evidence behind it has already been
   * counted once by the tally; this is the same evidence said in words, and
   * `scoreDelta` is 0 on the way out to make that checkable rather than merely
   * asserted. Null is a normal answer — most players have nothing the ledger
   * supports saying out loud.
   *
   * It lives here, on the one shared detail payload, precisely so that Draft,
   * Team, Waivers, Trades and Players show the same sentence rather than six
   * screens each deciding what the evidence means.
   */
  newsletterTakeaway: {
    text: string;
    sourceName: string;
    sourceDate: string;
    /** How many independent issues said it. 1 is normal. */
    corroboration: number;
    derivation: 'extracted' | 'templated';
    /** The rows it came from, for the evidence view rather than the card. */
    evidenceItemIds: string[];
    scoreDelta: 0;
  } | null;
  /**
   * Physical and age context, on the rare occasion there is any.
   *
   * Usually empty, and that is the design. A flag fires only where a
   * measurement meets a role it is genuinely in tension with — a light frame
   * projected outside, an older back whose usage is falling — because a flag
   * that fires on a third of the league is a column rather than a flag.
   *
   * `showMeasurements` is false unless a physical flag fired, and height and
   * weight are nulled out here rather than left for the browser to remember to
   * hide: a number shown is a number the reader will weigh whether or not it
   * means anything. `scoreDelta` is 0 and no consumer may convert a flag into a
   * penalty.
   */
  profile: {
    flags: { key: string; text: string; kind: 'physical' | 'age'; weight: 'context' }[];
    showMeasurements: boolean;
    scoreDelta: 0;
    heightInches: number | null;
    weightPounds: number | null;
  };
}

export class PlayerDetailService {
  private readonly repo: PlayerDetailRepo;
  private readonly players: PlayerRepo;

  constructor(
    private readonly db: Database,
    private readonly deps: {
      sleeper?: SleeperClient;
      fetch?: FetchLike;
      now?: () => Date;
      /**
       * Where work that must outlive the response goes.
       *
       * `ExecutionContext.waitUntil`, in the deployed Worker: the platform keeps
       * the invocation alive until the promise settles, which is what makes
       * "populate the cache without making the reader wait for it" a real thing
       * rather than a race against the response being sent.
       *
       * Left unset anywhere there is no such context — a test, the dev server —
       * and the task then simply runs detached. The one thing it must never do
       * is become an `await` again.
       */
      background?: (task: Promise<unknown>) => void;
    } = {},
  ) {
    this.repo = new PlayerDetailRepo(db);
    this.players = new PlayerRepo(db);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * Start something, and do not wait for it.
   *
   * Errors are swallowed here rather than reported, deliberately: nobody is
   * listening. A background refresh that fails leaves the cache exactly as it
   * was, the card says the same thing it said, and the next open tries again.
   */
  private detach(task: () => Promise<unknown>): void {
    const running = task().catch(() => undefined);
    if (this.deps.background) this.deps.background(running);
  }

  /**
   * What a market-derived model expected of him, out of one snapshot.
   *
   * The scoping decision lives with the caller now, where the league is read:
   * the snapshot handed here has already been chosen by this league's scoring
   * profile, because a projection computed under other rules is not a rough
   * answer for this reader, it is the wrong number with a plausible size. A
   * league with no snapshot arrives as `null` and gets nothing, which is also
   * the answer when no league is selected — a player card is not the place to
   * discover a configuration problem.
   */
  private async pointsFromSnapshot(
    playerId: string,
    snapshot: { id: number; label: string; scoringLabel: string; capturedAt: string } | null,
  ): Promise<PreseasonProjectionView | null> {
    if (!snapshot) return null;
    const points = await new PreseasonProjectionsRepo(this.db).pointsForSnapshot(snapshot.id, [playerId]);
    const value = points.get(playerId);
    if (value == null) return null;
    return {
      points: value,
      label: snapshot.label,
      scoringLabel: snapshot.scoringLabel,
      capturedAt: snapshot.capturedAt,
    };
  }

  /**
   * Everything the expanded card adds, in three waves rather than seventeen.
   *
   * The waves are the whole design, so they are written as three explicit
   * `Promise.all`s rather than left to emerge from the order the lines happen
   * to be in:
   *
   *   1. **what depends on nothing** — the season stat row, the player row, the
   *      two outlook cache reads, last season's injury reports, the evidence
   *      ledger, the selected league. Six answers, one round trip's latency.
   *   2. **what depends on those** — current injury state and the usage trend
   *      (both need the player row), the newest projection snapshot (needs the
   *      league's scoring), the season's games-played distribution (needed only
   *      when there are injury reports to reconcile against it, so it is asked
   *      for here rather than in wave 1 where it would cost a query on every
   *      card open for the majority of players who have none).
   *   3. **the one read that needs an id from wave 2** — this player's points
   *      inside that snapshot.
   *
   * `player` is accepted from the caller because the route has already read the
   * row to decide whether to answer 404 at all, and asking for it again is a
   * round trip spent re-establishing something the caller is holding.
   */
  async forPlayer(playerId: string, opts: { player?: CanonicalPlayer | null } = {}): Promise<PlayerDetailView> {
    const now = this.now();
    const statsSeason = lastCompletedSeason(now);
    const season = outlookSeason(now);

    // ---------------------------------------------------------------- wave 1
    const [stored, player, cachedOutlook, outlookMissAt, historyRows, evidence, league] = await Promise.all([
      /*
       * A row is the difference between "he did not play" and "we do not know".
       *
       * Those are two different sentences and the card is allowed to say
       * either, but never the wrong one. A stored row with no games means the
       * season was looked up and he did not appear in it — a dash. No row at
       * all means the statistics have not been ingested for him, and the
       * section stays away rather than implying an empty season.
       */
      this.repo.getSeasonStats(playerId, statsSeason),
      /*
       * His row, once.
       *
       * It was read four times: for the summariser's name, for the injury
       * status, for the measurements, and again by the route. One read, passed
       * to everything that needs it.
       */
      opts.player !== undefined ? Promise.resolve(opts.player) : this.players.getById(playerId),
      /*
       * Both halves of the outlook cache, together.
       *
       * They used to be read one after the other because the second is only
       * consulted when the first misses — which is true, and cost a whole round
       * trip to find out. Two point lookups on indexed keys are cheaper in one
       * wave than one of them is in two.
       */
      this.repo.getOutlook(playerId, season),
      this.repo.getOutlookMiss(playerId, season),
      new InjuryHistoryRepo(this.db)
        .reportsFor([playerId], statsSeason)
        .then((rows) => rows.get(playerId) ?? [])
        .catch(() => []),
      /*
       * The newsletter ledger, bounded to the most recent items rather than the
       * whole history: the selection weights recency heavily enough that a
       * two-year-old sentence cannot win, so reading two years of them to
       * discard them is work with a known answer.
       */
      new EvidenceRepo(this.db).listForPlayer(playerId, TAKEAWAY_EVIDENCE_LIMIT).catch(() => []),
      new LeagueRepo(this.db).getSelectedLeague().catch(() => null),
    ]);

    const lastSeason: SeasonStatsView | null = stored
      ? {
          season: statsSeason,
          gamesPlayed: stored.gamesPlayed,
          positionRank: formatPositionRank(stored.position ?? '', stored.positionRankHalfPpr),
          scoring: HALF_PPR.description,
        }
      : null;

    /*
     * His name, for the summariser.
     *
     * The one thing that reliably tells a sentence about the player apart from
     * a sentence about his offensive line is whether it mentions him. Absent is
     * fine, and the summariser falls back to pronouns.
     */
    const name = player?.fullName ?? null;
    const { outlook, note } = this.outlookFrom(cachedOutlook, outlookMissAt, playerId, season, now, name);

    // ---------------------------------------------------------------- wave 2
    const [injury, usageTrend, snapshot, slate] = await Promise.all([
      /*
       * Current availability, from the shared layer. An injury store that
       * cannot answer costs this section and leaves the rest of the card
       * intact, which is the same rule every other feed on this screen follows.
       */
      this.injuryFor(playerId, player?.status ?? null).catch(() => null),
      /*
       * The usage trend comes from the injury/role layer rather than from a
       * source of its own: the age flag requires *declining usage* as well as
       * age, and asking a different source for that would let the card disagree
       * with the role line printed a few pixels away.
       */
      player
        ? this.usageTrendFor(player.id, player.position).catch(() => 'unknown' as const)
        : Promise.resolve('unknown' as const),
      /*
       * The newest projection snapshot, scoped by this league's scoring before
       * anything else: a projection computed under other rules is not a rough
       * answer for this reader, it is the wrong number with a plausible size.
       */
      league
        ? new PreseasonProjectionsRepo(this.db)
            .latest(
              season,
              scoringKey(
                projectionScoringFrom(buildScoringProfile(league.scoringSettings, league.rosterPositions)),
              ),
            )
            .catch(() => null)
        : Promise.resolve(null),
      // Only when there is something to reconcile it against. See above.
      historyRows.length > 0 ? this.repo.gamesPlayedCounts(statsSeason).catch(() => []) : Promise.resolve([]),
    ]);

    /*
     * Read out of the outlook, and only out of the outlook.
     *
     * The other candidate sources were considered and rejected: the status
     * field says what is wrong today and nothing about last year, and the
     * newsletter ledger records that somebody was written about, not what
     * happened to them. A named diagnosis in supported prose is the one signal
     * here that cannot be produced by guessing.
     */
    // Read from the whole outlook, never from the shortened one: a diagnosis
    // named in a sentence the summary did not choose is still in the source.
    const history = majorInjuryHistory(outlook?.fullText ?? null);

    /*
     * And what last season's participation and published report, together, say.
     *
     * Together is the operative word. The report counts the games an injury was
     * filed for; Sleeper counts the games he played. Reconciling them is what
     * stops the card printing `8 GP` above `missed 2 games` — see
     * `availability.ts` for why those two numbers were never measuring the same
     * thing. Arithmetic over rows already in hand, so it costs no trip.
     */
    const measured = this.availabilityFrom(historyRows, slate, statsSeason, lastSeason, outlook?.fullText ?? null);

    /*
     * One line, never two.
     *
     * The measured note wins when there is one, because "missed 5 games with a
     * hamstring injury" is everything "Major injury history: Hamstring" says
     * plus the number that makes it useful. Showing both would be the app
     * saying the same thing twice in two voices, which is the duplication this
     * card was already trying to avoid.
     */
    const injuryContext = measured?.displaySummary ?? history?.line ?? null;

    const takeaway = this.takeawayFrom(evidence, playerId, now);

    const profile = player
      ? profileContext(
          {
            playerId,
            position: player.position,
            heightInches: player.heightInches ?? null,
            weightPounds: player.weightPounds ?? null,
            age: player.age ?? null,
            yearsExp: player.yearsExp ?? null,
          },
          { usageTrend },
        )
      : { flags: [], showMeasurements: false, scoreDelta: 0 as const };

    return {
      playerId,
      // ------------------------------------------------------------- wave 3
      preseasonProjection: await this.pointsFromSnapshot(playerId, snapshot).catch(() => null),
      lastSeason,
      outlook,
      outlookNote: note,
      injuryContext,
      availability: measured
        ? {
            season: measured.season,
            gamesPlayed: measured.gamesPlayed,
            gamesAvailable: measured.gamesAvailable,
            gamesMissedTotal: measured.gamesMissedTotal,
            injuryAttributedMisses: measured.injuryAttributedMisses,
            unresolvedMisses: measured.unresolvedMisses,
            confidence: measured.confidence,
            parts: measured.parts,
            corroborated: measured.corroborated,
          }
        : null,
      injury,
      newsletterTakeaway: takeaway,
      profile: {
        flags: profile.flags,
        showMeasurements: profile.showMeasurements,
        scoreDelta: 0,
        // Withheld unless a flag fired — the rule, applied at the boundary
        // rather than left to the browser to remember.
        heightInches: profile.showMeasurements ? (player?.heightInches ?? null) : null,
        weightPounds: profile.showMeasurements ? (player?.weightPounds ?? null) : null,
      },
    };
  }

  /**
   * Whether his opportunity is going up, down or nowhere.
   *
   * Read through the same `assessRole` every other screen uses rather than
   * measured again here, so the "usage trending down" half of an age flag can
   * never contradict the role line printed a few pixels above it. Below the
   * six-game minimum the detector says `insufficient_data`, which maps to
   * `unknown` — and `unknown` is what stops the age flag firing, which is the
   * whole point: age alone is a birthday.
   */
  private async usageTrendFor(
    playerId: string,
    position: string,
  ): Promise<'rising' | 'flat' | 'falling' | 'unknown'> {
    const metrics = await new UsageService(this.db).roleMetricsFor([{ playerId, position }]);
    const forPlayer = metrics.get(playerId);
    if (!forPlayer || forPlayer.length === 0) return 'unknown';
    const trend = assessRole(forPlayer).trend;
    if (trend === 'rising_high' || trend === 'rising_moderate') return 'rising';
    if (trend === 'falling_high' || trend === 'falling_moderate') return 'falling';
    if (trend === 'stable') return 'flat';
    return 'unknown';
  }

  /**
   * Select the takeaway, and keep its provenance.
   *
   * The whole judgement is in `core/evidence/takeaway.ts`, which has no
   * database and is tested without one. This is the read and nothing more —
   * deliberately, because "which sentence best explains this tally" is exactly
   * the kind of decision that becomes untestable the moment it is written
   * beside a SQL query.
   */
  private takeawayFrom(
    items: Parameters<typeof selectTakeaway>[0],
    playerId: string,
    now: Date,
  ): PlayerDetailView['newsletterTakeaway'] {
    const takeaway = selectTakeaway(items, { now, playerId });
    if (!takeaway) return null;
    return {
      text: takeaway.text,
      sourceName: takeaway.sourceName,
      sourceDate: takeaway.sourceDate,
      corroboration: takeaway.corroboration,
      derivation: takeaway.derivation,
      evidenceItemIds: takeaway.evidenceItemIds,
      scoreDelta: 0,
    };
  }

  /**
   * Last season's availability, reconciled.
   *
   * Three inputs meet here and nowhere else: Sleeper's games played, the
   * season's actual length, and the injury report's episodes. The episodes are
   * re-derived from the stored weekly rows rather than read from the summary
   * table — the summary was written by a backfill that never saw a games-played
   * column, and evidence is the thing worth storing anyway.
   *
   * `null` when there is nothing worth a line, which is most players.
   *
   * Both reads happen in `forPlayer`'s waves and arrive here as values, so this
   * is arithmetic and nothing else — which is also why it no longer needs a
   * `catch` around it at the call site.
   */
  private availabilityFrom(
    rows: HistoryRows,
    slate: Parameters<typeof fullSeasonSlate>[0],
    season: string,
    lastSeason: SeasonStatsView | null,
    outlook: string | null,
  ): HistoricalAvailability | null {
    if (rows.length === 0) return null;

    const episodes = deriveEpisodes(rows);
    const availability = reconcileHistoricalAvailability({
      season,
      participation: {
        gamesPlayed: lastSeason?.gamesPlayed ?? null,
        gamesAvailable: fullSeasonSlate(slate),
      },
      evidence: { episodes, corroboration: outlook },
    });

    /*
     * The bar for saying anything at all is unchanged, and deliberately.
     *
     * Reconciliation corrects a note's numbers and qualifies its wording; it
     * does not decide that a season was worth mentioning. Letting games missed
     * alone open that door would put an injury line on every player who sat out
     * for a reason this app cannot see — a suspension, a holdout, a healthy
     * scratch — which is the causality-from-participation mistake the whole
     * design refuses.
     *
     * The single exception earns itself: when supported prose independently
     * states the same missed-game total, the count and the cause both have a
     * source, and the IR weeks nflverse filed no row for are no longer a guess.
     */
    const significant = assessHistory(episodes).significance !== 'none';
    return significant || availability.corroborated ? availability : null;
  }

  /**
   * The current injury state, flattened for the wire.
   *
   * `null` when nobody has said anything, so the card renders no section at all
   * rather than a heading over the word "unknown".
   */
  private async injuryFor(playerId: string, status: string | null): Promise<PlayerDetailView['injury']> {
    const state = await new InjuryService(this.db).stateFor(playerId, status);
    if (state.designation === 'unknown') return null;
    if (state.designation === 'healthy' && !state.bodyPart && !state.practice.label) return null;
    return {
      designation: state.designation,
      label: DESIGNATION_LABEL[state.designation],
      line: injuryLine(state),
      bodyPart: state.bodyPart,
      practice: state.practice.label,
      provenance: provenanceLine(state),
      freshness: state.freshness,
      confidence: state.confidence,
      conflict: state.conflictNote,
    };
  }

  /**
   * What the card says about the outlook, decided from cache alone.
   *
   * **Nothing here reaches the network, and that is the point.** This was the
   * biggest single thing between a tap and a card: a cold outlook is a GraphQL
   * request to a third party, and the request that was waiting on it had
   * already read everything else it needed. "First open is slow, second open is
   * instant" was that fetch, described from the outside.
   *
   * The four cases, in the order they are decided:
   *
   *   - **fresh in cache** — shown, and nothing is started;
   *   - **stale in cache** — shown anyway, and a refresh is started behind the
   *     response. A stale outlook beats no outlook: the text is months old by
   *     design, so an expired entry is still the right paragraph, and the
   *     reader gets this week's copy on the next open;
   *   - **a recorded miss, still standing** — "none published", which is a fact
   *     that was checked, not an assumption;
   *   - **nothing at all** — a fetch is started, and the note says so. The card
   *     is allowed to say it has not got the text yet; it is not allowed to
   *     imply nobody wrote one, which is a different claim and would be cached
   *     as if it had been checked.
   */
  private outlookFrom(
    cached: (Parameters<typeof toView>[0] & { fetchedAt: string }) | null,
    missAt: string | null,
    playerId: string,
    season: string,
    now: Date,
    name: string | null,
  ): { outlook: OutlookView | null; note: string | null } {
    const fresh = cached && now.getTime() - Date.parse(cached.fetchedAt) < OUTLOOK_TTL_MS;
    if (cached && fresh) return { outlook: toView(cached, season, cached.fetchedAt, name), note: null };

    if (missAt && now.getTime() - Date.parse(missAt) < OUTLOOK_MISS_TTL_MS) {
      return { outlook: null, note: `No ${season} outlook published for him.` };
    }

    this.scheduleOutlookRefresh(playerId, season);

    if (cached) return { outlook: toView(cached, season, cached.fetchedAt, name), note: null };
    return { outlook: null, note: `Fetching his ${season} outlook — it will be here next time you open this.` };
  }

  /**
   * Go and get the outlook, after the reader has their card.
   *
   * Misses are written down as well as hits, because most players have no
   * outlook and asking Sleeper again every time one of those cards is opened is
   * precisely the unbounded fetching this project refuses.
   */
  private scheduleOutlookRefresh(playerId: string, season: string): void {
    this.detach(async () => {
      const fetched = await fetchPlayerOutlook(playerId, season, { fetch: this.deps.fetch });
      const at = this.now().toISOString();
      if (!fetched) {
        await this.repo.recordOutlookMiss(playerId, season, at, 'provider has no outlook for this player');
        return;
      }
      await this.repo.saveOutlook(fetched, at);
    });
  }

  /**
   * Refresh last season's statistics for everyone.
   *
   * Runs on the nightly cron. Returns what happened rather than logging it,
   * because "how much of this landed" is a question Setup asks out loud.
   */
  async refreshSeasonStats(season = lastCompletedSeason(this.now())): Promise<{
    season: string;
    returned: number;
    matched: number;
    unmatched: number;
    rankDisagreements: number;
  }> {
    const client = this.deps.sleeper ?? new SleeperClient();
    const payload = await client.getSeasonStats(season);

    // Everybody, including the players `listAll` now filters out: see
    // `positionsById` for why last season's file is the one read that wants
    // them.
    const known = await this.players.positionsById();
    const { lines, diagnostics } = buildSeasonStatLines(payload, (id) => known.get(id) ?? null);

    const at = this.now().toISOString();
    await this.repo.saveSeasonStats(season, lines, at);
    await this.repo.recordStatsRun({
      season,
      fetchedAt: at,
      source: 'sleeper:stats/nfl/regular',
      rowsReturned: diagnostics.returned,
      rowsMatched: diagnostics.matched,
      rowsUnmatched: diagnostics.unmatched,
      rankDisagreements: diagnostics.rankDisagreements,
      note: null,
    });
    return { season, ...diagnostics };
  }

  /**
   * What Setup says about all of this.
   *
   * Every number here exists because a partially-loaded pipeline looks exactly
   * like a working one from the outside, right up until a card is blank.
   */
  async diagnostics(): Promise<{
    stats: {
      season: string;
      source: string;
      players: number;
      lastRunAt: string | null;
      returned: number | null;
      unmatched: number | null;
      rankDisagreements: number | null;
      scoring: string;
    };
    outlook: {
      season: string;
      source: string;
      stored: number;
      noneAvailable: number;
      newestAt: string | null;
    };
    rosterPercent: { available: false; note: string };
  }> {
    const now = this.now();
    const statsSeason = lastCompletedSeason(now);
    const season = outlookSeason(now);
    const run = await this.repo.latestStatsRun();
    const coverage = await this.repo.outlookCoverage(season);
    return {
      stats: {
        season: statsSeason,
        source: 'Sleeper — /stats/nfl/regular',
        players: await this.repo.countSeasonStats(statsSeason),
        lastRunAt: run?.fetchedAt ?? null,
        returned: run?.rowsReturned ?? null,
        unmatched: run?.rowsUnmatched ?? null,
        rankDisagreements: run?.rankDisagreements ?? null,
        scoring: HALF_PPR.description,
      },
      outlook: {
        season,
        source: 'Sleeper — get_player_outlook (written by Rotowire)',
        stored: coverage.stored,
        noneAvailable: coverage.misses,
        newestAt: coverage.newestAt,
      },
      /*
       * The honest answer to a question the user asked directly.
       *
       * Sleeper shows a roster percentage inside its own app. Nothing serves
       * it: it is absent from the player dictionary, and the GraphQL schema has
       * no field for it under introspection — the two places it could be. The
       * only way to get the number is to take it out of Sleeper's client, and
       * that is not something this project does.
       */
      rosterPercent: {
        available: false,
        note:
          'Sleeper publishes no roster percentage. It is not in the player dictionary and there is no field for ' +
          'it in the GraphQL schema, so the app shows none rather than a number it would have to invent.',
      },
    };
  }
}

function toView(
  outlook: { title: string | null; body: string; source: string | null },
  season: string,
  fetchedAt: string,
  name?: string | null,
): OutlookView {
  // Whole, and only whitespace-normalised — the stored body arrives as one
  // paragraph but nothing guarantees it stays that way.
  const full = outlook.body.replace(/\s+/g, ' ').trim();
  // The name is passed in because it is the cheapest evidence that a sentence
  // is about the player rather than about his offensive line.
  const summary = summariseOutlook(full, { name: name ?? undefined });
  return {
    season,
    title: outlook.title ?? `${season} Season Outlook`,
    text: summary?.text ?? full,
    summarised: summary != null,
    fullText: full,
    source: outlook.source,
    fetchedAt,
  };
}
