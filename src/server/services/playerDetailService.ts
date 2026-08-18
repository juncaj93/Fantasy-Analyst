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
 */

import { calendarSeason, priorSeason } from '../../core/season/context.ts';
import { SleeperClient } from '../../core/sleeper/client.ts';
import { fetchPlayerOutlook, type FetchLike } from '../../core/sleeper/outlook.ts';
import { summariseOutlook } from '../../core/sleeper/outlookSummary.ts';
import { majorInjuryHistory } from '../../core/draft/injury.ts';
import { DESIGNATION_LABEL, injuryLine, provenanceLine } from '../../core/injury/model.ts';
import { InjuryService } from './injuryService.ts';
import { InjuryHistoryRepo } from '../repos/injuryHistory.ts';
import { assessHistory, deriveEpisodes } from '../../core/injury/history.ts';
import {
  fullSeasonSlate,
  reconcileHistoricalAvailability,
  type HistoricalAvailability,
} from '../../core/injury/availability.ts';
import { buildSeasonStatLines, formatPositionRank, HALF_PPR } from '../../core/sleeper/seasonStats.ts';
import { PlayerDetailRepo } from '../repos/playerDetail.ts';
import { PlayerRepo } from '../repos/players.ts';
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

export interface PlayerDetailView {
  playerId: string;
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
}

export class PlayerDetailService {
  private readonly repo: PlayerDetailRepo;
  private readonly players: PlayerRepo;

  constructor(
    private readonly db: Database,
    private readonly deps: { sleeper?: SleeperClient; fetch?: FetchLike; now?: () => Date } = {},
  ) {
    this.repo = new PlayerDetailRepo(db);
    this.players = new PlayerRepo(db);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * Everything the expanded card adds, for one player.
   *
   * Statistics are read from the cache only — they are somebody else's nightly
   * job and this must not turn into a second one. The outlook may reach out,
   * once, and a failure to reach it is reported rather than thrown: an outlook
   * the network could not deliver must not take the rest of the card with it.
   */
  async forPlayer(playerId: string): Promise<PlayerDetailView> {
    const now = this.now();
    const statsSeason = lastCompletedSeason(now);
    const season = outlookSeason(now);

    /*
     * A row is the difference between "he did not play" and "we do not know".
     *
     * Those are two different sentences and the card is allowed to say either,
     * but never the wrong one. A stored row with no games means the season was
     * looked up and he did not appear in it — a dash. No row at all means the
     * statistics have not been ingested for him, and the section stays away
     * rather than implying an empty season.
     */
    const stored = await this.repo.getSeasonStats(playerId, statsSeason);
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
     * a sentence about his offensive line is whether it mentions him. Read from
     * the player dictionary the app already holds; absent is fine, and the
     * summariser falls back to pronouns.
     */
    const name = (await this.players.getById(playerId))?.fullName ?? null;
    const { outlook, note } = await this.outlookFor(playerId, season, now, name);
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
     * thing.
     */
    const measured = await this.availabilityFor(playerId, statsSeason, lastSeason, outlook?.fullText ?? null).catch(
      () => null,
    );

    /*
     * Current availability, from the shared layer.
     *
     * Read after the outlook and never blocking it: an injury store that
     * cannot answer costs this section and leaves the rest of the card intact,
     * which is the same rule every other feed on this screen follows.
     */
    const injury = await this.injuryFor(playerId, name).catch(() => null);

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

    return {
      playerId,
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
   */
  private async availabilityFor(
    playerId: string,
    season: string,
    lastSeason: SeasonStatsView | null,
    outlook: string | null,
  ): Promise<HistoricalAvailability | null> {
    const rows = (await new InjuryHistoryRepo(this.db).reportsFor([playerId], season)).get(playerId) ?? [];
    if (rows.length === 0) return null;

    const episodes = deriveEpisodes(rows);
    const availability = reconcileHistoricalAvailability({
      season,
      participation: {
        gamesPlayed: lastSeason?.gamesPlayed ?? null,
        gamesAvailable: fullSeasonSlate(await this.repo.gamesPlayedCounts(season)),
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
  private async injuryFor(playerId: string, name: string | null): Promise<PlayerDetailView['injury']> {
    void name;
    const player = await this.players.getById(playerId);
    const state = await new InjuryService(this.db).stateFor(playerId, player?.status ?? null);
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

  private async outlookFor(
    playerId: string,
    season: string,
    now: Date,
    name: string | null,
  ): Promise<{ outlook: OutlookView | null; note: string | null }> {
    const cached = await this.repo.getOutlook(playerId, season);
    const fresh = cached && now.getTime() - Date.parse(cached.fetchedAt) < OUTLOOK_TTL_MS;
    if (cached && fresh) return { outlook: toView(cached, season, cached.fetchedAt, name), note: null };

    const missAt = await this.repo.getOutlookMiss(playerId, season);
    if (missAt && now.getTime() - Date.parse(missAt) < OUTLOOK_MISS_TTL_MS) {
      return { outlook: null, note: `No ${season} outlook published for him.` };
    }

    try {
      const fetched = await fetchPlayerOutlook(playerId, season, { fetch: this.deps.fetch });
      const at = now.toISOString();
      if (!fetched) {
        await this.repo.recordOutlookMiss(playerId, season, at, 'provider has no outlook for this player');
        return { outlook: null, note: `No ${season} outlook published for him.` };
      }
      await this.repo.saveOutlook(fetched, at);
      return { outlook: toView(fetched, season, at, name), note: null };
    } catch (err) {
      // A stale outlook beats no outlook: the text is months old by design, so
      // an expired cache entry is still the right paragraph.
      if (cached) return { outlook: toView(cached, season, cached.fetchedAt, name), note: null };
      return {
        outlook: null,
        note: `Could not reach Sleeper for the ${season} outlook (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
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

    const known = new Map((await this.players.listAll()).map((p) => [p.id, p.position]));
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
