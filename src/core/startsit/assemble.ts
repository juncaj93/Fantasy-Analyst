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

import { recommendLineup, type LineupRecommendation } from './lineup.ts';
import { weeklyProjection, type ProjectableEvaluation, type ProjectionSource } from './projection.ts';
import { weeklyIntelligence, type WeeklyIntelligence } from '../contracts/integration.ts';
import type { StartSitInput } from './engine.ts';
import type { StartSitMode } from './mode.ts';
import type { RosterShape, ScoringProfile } from '../sleeper/scoring.ts';

/** An evaluation with the weekly card and the display projection attached. */
export type AssembledEvaluation<T extends { playerId: string } & ProjectableEvaluation> = T &
  Partial<WeeklyIntelligence> & {
    projection: number | null;
    projectionSource: ProjectionSource | null;
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
    notes: notesFor(recommendation, request.unknownPlayers ?? 0),
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
function notesFor(recommendation: LineupRecommendation, unknownPlayers: number): string[] {
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
   */
  const borrowed = filledSlots.filter((slot) => slot.projectionSource === 'sleeper').length;
  if (borrowed > 0) {
    notes.push(
      `${borrowed} projection(s) below are Rotowire's published weekly figures, by way of Sleeper, shown because no betting market has priced those players. They are not used to rank the lineup.`,
    );
  }

  if (unknownPlayers > 0) {
    notes.push(`${unknownPlayers} roster spot(s) are not in the player list yet — update it in Setup.`);
  }
  return notes;
}
