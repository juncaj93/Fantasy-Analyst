/**
 * What the number on a Team row should be, for a player who may not play.
 *
 * Reported 30 September 2026 from the bench: Nico Collins tagged `OUT` beside a
 * plain 9.9, and RJ Harvey tagged `Q` beside a plain 9.5. Each figure was
 * true (a market or Rotowire's forecast of a week he plays) and each looked
 * exactly like a healthy player's, with the only warning a two-letter tag.
 *
 * The rule, the same one the Compare sheet and the trade engine already follow:
 * a number that does not apply may not quietly look like one that does.
 *
 *  - **Ruled out** shows no forecast at all. The row says `Out`, and the figure
 *    he would have had lives only in the tooltip and the spoken label. Doubtful
 *    is ruled out too since 5 November 2026 (`weekAvailability.ts`).
 *  - **An injury charge** (none is left today: Questionable costs nothing)
 *    shows the forecast with the *same* injury
 *    charge the start/sit score applies (the evaluation's `status` component),
 *    drawn in the caution colour, with the undiscounted figure struck through
 *    under it. A reader sees both what the app ranks him at and why.
 *  - Everybody else is the plain projection, unchanged.
 *
 * The charge is read from the evaluation rather than recomputed here, so the
 * row and the score cannot disagree about what a designation costs.
 */

export interface RowFigureEvaluation {
  ruledOut?: boolean;
  statusFlag?: string | null;
  components?: readonly { key: string; value: number; unknown: boolean }[];
  /** In an IR slot. */
  onReserve?: boolean;
  /** No game this week, from the fixture list only (never from a missing number). */
  onBye?: boolean;
  /** What his number was built on: `published` is Sleeper's week, with no complete Vegas line. */
  decision?: { basis: string } | null;
  /** His game's clock. */
  lock?: { locked: boolean; kickoff: string | null };
}

/** The phrase for a number with no Vegas line behind it yet (Round 18). */
export const NO_LINE_YET = 'No line yet';

/**
 * Whether his game has no Vegas line yet, before kickoff (Round 18).
 *
 * His number is Sleeper's week (`published`: no complete market), and his game
 * has not started. The odds clock keeps asking until half an hour before
 * kickoff, so before then a line can still come.
 */
export function noLineYet(evaluation: RowFigureEvaluation | null | undefined, now: number = Date.now()): boolean {
  if (!evaluation || evaluation.ruledOut || evaluation.onBye) return false;
  if (evaluation.decision?.basis !== 'published') return false;
  if (evaluation.lock?.locked) return false;
  const kickoff = evaluation.lock?.kickoff ? Date.parse(evaluation.lock.kickoff) : Number.NaN;
  return !Number.isFinite(kickoff) || kickoff > now;
}

/**
 * The short reason beside a row's figure, or null (Round 18).
 *
 * A dash never stands alone: `Bye` (the fixture list says no game), `On IR`
 * (his slot), or `No projection` (nothing priced him and Sleeper has no week).
 * A Sleeper-only number before kickoff says `No line yet`.
 */
export function rowNote(figure: RowFigure, evaluation: RowFigureEvaluation | null | undefined, now: number = Date.now()): string | null {
  if (figure.kind === 'none') {
    if (evaluation?.onReserve) return 'On IR';
    if (evaluation?.onBye) return 'Bye';
    return 'No projection';
  }
  if (figure.kind === 'plain' && noLineYet(evaluation, now)) return NO_LINE_YET;
  return null;
}

export type RowFigure =
  | { kind: 'none' }
  | { kind: 'plain'; points: number }
  | { kind: 'out'; was: number | null; label: string }
  | { kind: 'risk'; points: number; was: number; charge: number; label: string };

/** `Questionable · practised fully` → `Questionable`. */
function designation(statusFlag: string | null | undefined, fallback: string): string {
  const first = (statusFlag ?? '').split('·')[0]?.trim();
  return first ? first : fallback;
}

export function rowFigure(projection: number | null | undefined, evaluation: RowFigureEvaluation | null | undefined): RowFigure {
  if (evaluation?.ruledOut) {
    return { kind: 'out', was: projection ?? null, label: designation(evaluation.statusFlag, 'Out') };
  }
  if (projection == null) return { kind: 'none' };
  const status = evaluation?.components?.find((c) => c.key === 'status' && !c.unknown);
  if (status && status.value < 0) {
    const charge = Math.round(status.value * 100) / 100;
    return {
      kind: 'risk',
      points: Math.max(0, Math.round((projection + charge) * 100) / 100),
      was: projection,
      charge,
      label: designation(evaluation?.statusFlag, 'Injury designation'),
    };
  }
  return { kind: 'plain', points: projection };
}

/** The row's accessible clause for the figure, in the same words as its tooltip. */
export function spokenRowFigure(figure: RowFigure, projectionClause: (points: number | null) => string): string {
  if (figure.kind === 'out') {
    return `, ${figure.label.toLowerCase()}, no projection shown` + (figure.was != null ? ` (${figure.was.toFixed(1)} if he played)` : '');
  }
  if (figure.kind === 'risk') {
    return (
      projectionClause(figure.points) +
      ` after the ${figure.label.toLowerCase()} discount, ${figure.was.toFixed(1)} if he plays`
    );
  }
  return projectionClause(figure.kind === 'plain' ? figure.points : null);
}
