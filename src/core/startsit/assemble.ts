/**
 * The whole Team screen decision, in one call.
 *
 * `recommendLineup` produces the lineup and `weeklyIntelligence` produces the
 * card behind each row, and until now the *layering* of the two — plus the
 * projection fallback and the three sentences that explain an empty column —
 * lived in `server/app.ts` and again in `core/demo/runtime/handlers.ts`. Two
 * copies of the same six steps, which is the arrangement `core/dst/assemble.ts`
 * was extracted to end for defences and `core/matchup/build.ts` never had.
 *
 * There are now three callers, and the third is the reason it had to move:
 * a support snapshot is replayed through *this* function, so the lineup an
 * agent reproduces from a file is the lineup the phone drew rather than a
 * plausible reconstruction of it. A pipeline spelled out at three call sites
 * would make the replay a fourth opinion.
 *
 * ## What it does not do
 *
 * It does not read anything. Every input arrives as a value — the assembled
 * `StartSitInput[]`, the league's shape and scoring, the current starters, the
 * mode, and the published fallback figures — so it is a pure function of its
 * arguments and reaches no database, no provider and no clock it was not given.
 * That is what makes it replayable, and it is the same property
 * `assembleDstPlan` has.
 *
 * It also does not wrap. The league name, the freshness block and the demo's
 * own scenario notes belong to the response envelope, and each caller adds its
 * own — the decision is what is here.
 */

import { fixtureOf, recommendLineup, type LineupRecommendation, type SlotFixture } from './lineup.ts';
import type { OpponentExposure } from './correlation.ts';
import { weeklyProjection, type ProjectableEvaluation, type ProjectionSource } from './projection.ts';
import { weeklyIntelligence, type WeeklyIntelligence } from '../contracts/integration.ts';
import type { StartSitEvaluation, StartSitInput } from './engine.ts';
import type { StartSitMode } from './mode.ts';
import type { RosterShape, ScoringProfile } from '../sleeper/scoring.ts';

/** An evaluation with the weekly card and the display projection attached. */
export type AssembledEvaluation<T extends { playerId: string } & ProjectableEvaluation> = T &
  Partial<WeeklyIntelligence> & {
    projection: number | null;
    projectionSource: ProjectionSource | null;
    /**
     * Who he plays, and what that defence gives up to his role.
     *
     * Attached here rather than to the lineup *slot*, for two reasons. Every
     * player passes through `enrich` — starters, bench and the undecidable —
     * so a bench row gets the same chip as a starting one from the same field.
     * And a slot on a `swap` is about two men at once, so a fixture hanging off
     * it would have to pick one and would pick the wrong one half the time.
     * Hanging it off the player means the row shows whoever the row is about.
     */
    fixture: SlotFixture | null;
  };

export interface LineupAssemblyRequest {
  /** The roster, assembled exactly as `startSitInputsFor` assembles it. */
  inputs: StartSitInput[];
  shape: RosterShape;
  profile: ScoringProfile;
  /** The lineup currently set in Sleeper, so a difference can be reported. */
  currentStarterIds: string[];
  mode: StartSitMode;
  /**
   * Rotowire's published weekly figures, for the players no market priced.
   *
   * Display only. `recommendLineup` reads it for `LineupSlot.projection` and
   * nothing that decides a lineup touches it — there is a test that holds that
   * claim, `sleeperProjectionFallback.test.ts` — so an empty map here changes
   * a column and never an answer.
   */
  published?: ReadonlyMap<string, number>;
  /**
   * Roster spots the player table could not resolve, for the note that says so.
   *
   * Passed rather than derived: only the caller knows how many player ids the
   * roster had before `startSitInputsFor` dropped the ones it could not find.
   */
  unknownPlayers?: number;
  /**
   * Why a position on this roster is refused the published fallback, if one is.
   *
   * A finished sentence, composed by the caller. It arrives as text rather than
   * as the profile it was derived from because composing it needs the published
   * feed's own assumptions, and this module is on the wrong side of the line
   * that keeps Rotowire's numbers out of a recommendation.
   */
  publishedRefusal?: string | null;
  /**
   * The games the opponent has stacked this week, for the Floor/Ceiling pass.
   *
   * A value like everything else here, so the replay stays a pure function of
   * the file it was handed. Absent is the ordinary state — Balanced weeks, a
   * roster on a bye, a week the Matchup screen has not been opened on — and it
   * changes nothing: see `recommendLineup`'s own note on the field.
   */
  opponentExposure?: ReadonlyMap<string, OpponentExposure>;
  now?: string | Date;
}

export interface LineupAssembly extends Omit<LineupRecommendation, 'starters' | 'bench' | 'undecidable' | 'notes'> {
  rosterShape: RosterShape;
  starters: AssembledEvaluation<LineupRecommendation['starters'][number]>[];
  bench: AssembledEvaluation<LineupRecommendation['bench'][number]>[];
  undecidable: AssembledEvaluation<LineupRecommendation['undecidable'][number]>[];
  /** The optimiser's own notes, plus the three this pass can add. */
  notes: string[];
}

export function assembleLineup(request: LineupAssemblyRequest): LineupAssembly {
  const published = request.published ?? new Map<string, number>();
  const recommendation = recommendLineup(request.inputs, request.shape, request.profile, {
    currentStarterIds: request.currentStarterIds,
    mode: request.mode,
    published,
    ...(request.opponentExposure === undefined ? {} : { opponentExposure: request.opponentExposure }),
    ...(request.now === undefined ? {} : { now: request.now }),
  });

  /*
   * The two slots the weekly card would otherwise carry empty.
   *
   * Expected points for everybody with stored usage, and — only for a slot
   * whose gap to the best legal alternative is genuinely close — the conditions
   * that would change the recommendation. Attached to the evaluations that
   * already travel in the response, so the card draws without a second request.
   */
  const intelligence = weeklyIntelligence({
    lineup: recommendation,
    inputs: request.inputs,
    profile: request.profile,
    mode: request.mode,
    ...(request.now === undefined ? {} : { now: request.now }),
  });

  /*
   * `score` stays exactly what it was — the comparable number the optimiser
   * ranked with. `projection` is the weekly forecast, which exists only when a
   * market does; the bench rows read it, and they read the same function the
   * starters' slots and the Matchup screen read. See `projection.ts` for why
   * printing the score instead was showing a quarterback at 3.15 points.
   */
  const enrich = <T extends { playerId: string } & ProjectableEvaluation>(
    evaluations: T[],
  ): AssembledEvaluation<T>[] =>
    evaluations.map((evaluation) => {
      const extra = intelligence.get(evaluation.playerId);
      const projected = weeklyProjection(evaluation, published.get(evaluation.playerId) ?? null);
      return {
        ...evaluation,
        ...(extra ?? {}),
        projection: projected.points,
        projectionSource: projected.source,
        fixture: fixtureOf(evaluation as unknown as StartSitEvaluation),
      };
    });

  const starters = enrich(recommendation.starters);
  const bench = enrich(recommendation.bench);
  const undecidable = enrich(recommendation.undecidable);

  return {
    ...recommendation,
    rosterShape: request.shape,
    starters,
    bench,
    undecidable,
    notes: notesFor(recommendation, request.unknownPlayers ?? 0, request.publishedRefusal ?? null),
  };
}


/**
 * The optimiser's notes, plus the three things only this layer can see.
 *
 * All three are about a column rather than about a player, which is why they
 * are said once here instead of on rows. A column of dashes that does not say
 * why it is a column of dashes reads as broken; with a sentence it reads as
 * honest, which is what it is.
 */
function notesFor(
  recommendation: LineupRecommendation,
  unknownPlayers: number,
  publishedRefusal?: string | null,
): string[] {
  const notes = [...recommendation.notes];
  const filledSlots = recommendation.slots.filter((slot) => slot.playerId);
  const projectable = filledSlots.filter((slot) => slot.projection != null);

  /*
   * Said only when *nothing* is projectable, because a note beside a mostly
   * full column would be noise.
   */
  if (filledSlots.length > 0 && projectable.length === 0) {
    notes.push(
      'No betting market has been read for these players yet, so there is no projection to show — the lineup below is still ranked on everything else that is known.',
    );
  }

  /*
   * And when the column *is* full of somebody else's numbers, it says whose.
   *
   * A screen quoting Rotowire under a heading this app owns is the failure the
   * whole provenance chain exists to prevent, and the row-level marks are
   * deliberately subtle. This is the one place the claim is made in a sentence.
   *
   * It used to end "They are not used to rank the lineup", which was true when
   * it was written and stopped being true the day a borrowed figure started
   * ranking players — docked by `BORROWED_RANKING_DISCOUNT`, but ranking them.
   * A sentence that outlives the behaviour it describes is worse than no
   * sentence: the reader has no way to tell which of the two is stale.
   *
   * How a borrowed figure is ranked is now said once, by `recommendLineup`,
   * which is the code that does it — so this says only whose number it is and
   * stops there, rather than making a second claim about a rule it does not own.
   */
  const borrowed = filledSlots.filter((slot) => slot.projectionSource === 'sleeper').length;
  if (borrowed > 0) {
    notes.push(
      `${borrowed} projection(s) below are Rotowire's published weekly figures, by way of Sleeper, shown because no betting market has priced those players.`,
    );
  }

  /*
   * And why one position's cell is blank when its neighbours are not.
   *
   * Written by the caller rather than here, and that boundary is the point: the
   * sentence is composed in `services/decisionInputs.ts`, which is sanctioned to
   * read the published feed, and arrives at this module as text. Nothing here
   * can reach a Rotowire number to build it, which is the rule
   * `tests/sleeperProjectionFallback.test.ts` keeps.
   *
   * Only said when the fallback is otherwise working — `borrowed > 0`. With no
   * published number anywhere the note above has already explained the whole
   * column, and adding "and especially not for your quarterback" to it would be
   * answering a question nobody looking at that screen has.
   */
  if (publishedRefusal && borrowed > 0) notes.push(publishedRefusal);

  if (unknownPlayers > 0) {
    notes.push(`${unknownPlayers} roster spot(s) are not in the player list yet — update it in Setup.`);
  }
  return notes;
}

/* ==================================================================== compare */

/**
 * What a head-to-head comparison shows, beside what it decided.
 *
 * ## Why this exists at all
 *
 * Because the Compare sheet was the one screen in the app with no projection
 * fallback of any kind, and on 22 September 2026 the owner photographed the
 * result: a FLEX comparison reporting Trey McBride as `unknown` Vegas, 0%
 * coverage and "no Vegas data for Trey McBride — compared on news and
 * availability only", while this league's own imported snapshot held 183.7
 * preseason points for him under exactly its own scoring key. Eleven and a half
 * points a week, in the database, on a screen that said it knew nothing.
 *
 * It was not McBride and it was not tight ends. A probe of production the same
 * morning found eight of the owner's ten starters carrying no market
 * expectation at all — a quarterback, four running backs, three receivers, a
 * tight end — because in week 2 the book had priced two players on the roster.
 * The Matchup screen showed every one of them a number, the Team screen showed
 * seven of them a number, and Compare showed none of them a number, for the
 * same players in the same session. Three ladders, one of them empty.
 *
 * ## What it does and does not touch
 *
 * It attaches a **display** projection and its provenance to each evaluation,
 * from the one ladder in `projection.ts`. It does not re-rank anything:
 * `compareStartSit` has already chosen, on `score`, which is built on the
 * market expectation and this app's own bounded nudges and reaches neither
 * borrowed tier. A comparison whose verdict moved because somebody else's
 * model was consulted would be a different feature, and not one anybody asked
 * for — the screen's job here is to stop showing a reader nothing when it holds
 * something.
 *
 * Pure, like `assembleLineup` above it: every figure arrives as a value, so the
 * same function serves the route, Demo Mode and a replayed support snapshot.
 */
export interface ComparisonAssemblyRequest<T extends { playerId: string } & ProjectableEvaluation> {
  evaluations: T[];
  /** Rotowire's published weekly figures, by player id. Tier 2. */
  published?: ReadonlyMap<string, number>;
  /** This league's imported preseason **season totals**, by player id. Tier 3. */
  preseason?: ReadonlyMap<string, number>;
  /** Why a position here is refused a published total, composed by the caller. */
  publishedRefusal?: string | null;
}

/** An evaluation with the display projection, its provenance and the fixture attached. */
export type ProjectedEvaluation<T extends { playerId: string } & ProjectableEvaluation> = T & {
  projection: number | null;
  projectionSource: ProjectionSource | null;
  /**
   * Who he plays, already written as `vs BAL` / `@ BAL` / `BAL`.
   *
   * From the same `fixtureOf` the lineup rows use, rather than re-derived in the
   * grid from `opponent` and `home`. The second derivation is where `vs` and `@`
   * get swapped: `vegas_events.home_team` means "a team we asked about" and not
   * "the home side", which is the vocabulary trap that had every spread
   * backwards once already. One function writes the label; screens print it.
   */
  fixture: SlotFixture | null;
};

export interface ComparisonAssembly<T extends { playerId: string } & ProjectableEvaluation> {
  evaluations: ProjectedEvaluation<T>[];
  /**
   * The sentences that are about the *column* rather than about a player.
   *
   * Same argument as `notesFor`: a cell that is empty, or that holds somebody
   * else's number, has to say so once rather than eleven times down a grid.
   */
  projectionNotes: string[];
}

export function assembleComparison<T extends { playerId: string } & ProjectableEvaluation>(
  request: ComparisonAssemblyRequest<T>,
): ComparisonAssembly<T> {
  const published = request.published ?? new Map<string, number>();
  const preseason = request.preseason ?? new Map<string, number>();

  const evaluations = request.evaluations.map((evaluation) => {
    const projected = weeklyProjection(
      evaluation,
      published.get(evaluation.playerId) ?? null,
      preseason.get(evaluation.playerId) ?? null,
    );
    return {
      ...evaluation,
      projection: projected.points,
      projectionSource: projected.source,
      fixture: fixtureOf(evaluation as unknown as StartSitEvaluation),
    };
  });

  const projectionNotes: string[] = [];
  const borrowed = evaluations.filter((e) => e.projectionSource === 'sleeper').length;
  const estimated = evaluations.filter((e) => e.projectionSource === 'preseason').length;
  const none = evaluations.filter((e) => e.projection == null).length;

  if (borrowed > 0) {
    projectionNotes.push(
      `${borrowed} projection(s) here are Rotowire's published weekly figures, by way of Sleeper, ` +
        `shown because no betting market has priced those players.`,
    );
  }
  /*
   * The third tier names itself in full, every time, because it is the weakest
   * claim the app makes and the tilde in front of the figure is not enough on
   * its own. "Preseason" without "divided by a season of games" invites a
   * reader to take 183.7 for a Sunday.
   */
  if (estimated > 0) {
    projectionNotes.push(
      `${estimated} projection(s) here are marked ~ : this league's imported preseason total for the ` +
        `whole season, divided by a full season of games. No betting market and no weekly projection ` +
        `has priced those players, so the figure takes no account of who they face.`,
    );
  }
  if (none > 0 && none === evaluations.length) {
    projectionNotes.push(
      'Nobody here has a projection from any source, so the ranking below is built on news, usage and ' +
        'availability alone.',
    );
  }
  /*
   * Only said when the fallback is otherwise working, for the reason `notesFor`
   * gives: with nothing borrowed anywhere the sentence above has explained the
   * whole column already.
   */
  if (request.publishedRefusal && borrowed > 0) projectionNotes.push(request.publishedRefusal);

  return { evaluations, projectionNotes };
}
