/**
 * Which scoring a preseason projection snapshot was computed under.
 *
 * A projected season points total only means anything next to the rules that
 * produced it. Josh Allen is 386 under six-point passing touchdowns and 336
 * under four, and nothing in the number says which — so a snapshot taken for
 * one league and read by another is not approximately right, it is fifty points
 * wrong on every quarterback and right on everybody else, which is the hardest
 * kind of wrong to notice.
 *
 * So the profile is part of the snapshot's identity rather than a note attached
 * to it. Two leagues that score the same may share a capture; two that do not,
 * cannot, and the storage key makes that structural rather than a rule somebody
 * has to remember.
 *
 * The person declares it. The arithmetic below only ever *warns*: it can say a
 * declared profile looks inconsistent with the numbers, and it is never allowed
 * to overrule what it was told, because a projection model this app does not
 * own may legitimately differ from its own arithmetic by more than any
 * threshold worth setting.
 */

import type { ScoringProfile } from '../sleeper/scoring.ts';

/**
 * The fields that change what a season points total comes out as.
 *
 * Deliberately not the whole `ScoringProfile`: roster shape, superflex and the
 * tight-end premium do not move a per-player projection, and including them
 * would split two identical snapshots apart over a difference that changes no
 * number in them.
 */
export interface ProjectionScoring {
  ppr: number;
  passTd: number;
  pointsPerPassYard: number;
  pointsPerRushYard: number;
  pointsPerRecYard: number;
  rushTd: number;
  recTd: number;
  interception: number;
}

export function projectionScoringFrom(profile: ScoringProfile): ProjectionScoring {
  return {
    ppr: profile.ppr,
    passTd: profile.passTd,
    pointsPerPassYard: profile.pointsPerPassYard,
    pointsPerRushYard: profile.pointsPerRushYard,
    pointsPerRecYard: profile.pointsPerRecYard,
    rushTd: profile.rushTd,
    recTd: profile.recTd,
    interception: profile.interception,
  };
}

/**
 * A stable key for one scoring profile.
 *
 * Built from the values rather than from a league's label, because "Half PPR"
 * is a name two leagues can share while scoring passing touchdowns differently.
 * Sorted and rounded so the same rules always produce the same key.
 */
export function scoringKey(s: ProjectionScoring): string {
  const round = (n: number) => (Math.round(n * 1000) / 1000).toString();
  return [
    `ppr${round(s.ppr)}`,
    `passtd${round(s.passTd)}`,
    `passyd${round(s.pointsPerPassYard)}`,
    `rushyd${round(s.pointsPerRushYard)}`,
    `recyd${round(s.pointsPerRecYard)}`,
    `rushtd${round(s.rushTd)}`,
    `rectd${round(s.recTd)}`,
    `int${round(s.interception)}`,
  ].join('_');
}

/** "Half PPR · 6pt pass TD" — the profile as a person would say it. */
export function describeScoring(s: ProjectionScoring): string {
  const reception =
    s.ppr === 0 ? 'Standard' : s.ppr === 0.5 ? 'Half PPR' : s.ppr === 1 ? 'Full PPR' : `${s.ppr} per reception`;
  return `${reception} · ${s.passTd}pt pass TD`;
}

/** Do two snapshots' scoring rules agree closely enough to share a number? */
export function scoringMatches(a: ProjectionScoring, b: ProjectionScoring): boolean {
  return scoringKey(a) === scoringKey(b);
}

/**
 * A quarterback's points under four-point passing touchdowns rather than six,
 * used only to notice a declared profile that cannot be right.
 *
 * The check is deliberately crude and one-sided. It looks at the spread between
 * the top quarterbacks and the top non-quarterbacks, because that gap is the
 * one thing the passing-touchdown rule moves hard and predictably: under six
 * points a fantasy season's best quarterback outscores its best running back
 * comfortably, and under four he usually does not.
 *
 * Returns a sentence when something looks wrong and null when it does not. It
 * never blocks an import — see the module note.
 */
export function grossScoringMismatch(
  declared: ProjectionScoring,
  rows: { position: string | null; points: number }[],
): string | null {
  const best = (position: string) =>
    rows.filter((r) => (r.position ?? '').toUpperCase() === position).map((r) => r.points).sort((a, b) => b - a);

  const qb = best('QB');
  const skill = [...best('RB'), ...best('WR')].sort((a, b) => b - a);
  if (qb.length < 3 || skill.length < 3) return null;

  const topQb = qb[0]!;
  const topSkill = skill[0]!;
  const lead = topQb - topSkill;

  // Under six-point passing touchdowns the best quarterback leads the best
  // skill player by something like sixty to a hundred points. Under four he
  // leads by very little, or trails.
  if (declared.passTd >= 6 && lead < 20) {
    return (
      `The scoring was declared as ${declared.passTd}-point passing touchdowns, but the best quarterback ` +
      `in this snapshot (${topQb.toFixed(1)}) barely leads the best running back or receiver ` +
      `(${topSkill.toFixed(1)}). That gap usually means four-point passing touchdowns. ` +
      'Check the profile the snapshot was captured under.'
    );
  }
  if (declared.passTd <= 4 && lead > 55) {
    return (
      `The scoring was declared as ${declared.passTd}-point passing touchdowns, but the best quarterback ` +
      `in this snapshot (${topQb.toFixed(1)}) leads the best running back or receiver ` +
      `(${topSkill.toFixed(1)}) by ${lead.toFixed(0)} points. That gap usually means six-point passing ` +
      'touchdowns. Check the profile the snapshot was captured under.'
    );
  }
  return null;
}
