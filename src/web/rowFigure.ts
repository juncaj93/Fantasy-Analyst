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
 *    he would have had lives only in the tooltip and the spoken label.
 *  - **Questionable or doubtful** shows the forecast with the *same* injury
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
