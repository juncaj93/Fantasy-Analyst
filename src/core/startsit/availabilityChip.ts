/**
 * The availability chip on a Compare card, and the Best move warning line.
 *
 * Since 13 October 2026 only Out, Doubtful and a bye move the score. Every
 * other status the league host reports (Questionable above all) costs nothing
 * and is shown instead: a warning chip on the card, and one short line on Best
 * move when the player it tells you to start carries one. The reader decides.
 *
 * Out and Doubtful still get a chip, in the stronger tone, so the card says
 * why its number is gone or low.
 */

export type AvailabilityTone = 'warn' | 'out';

export interface AvailabilityChip {
  /** `Questionable`, `Doubtful`, `Out`, `On IR`. */
  label: string;
  tone: AvailabilityTone;
}

interface ChipSource {
  statusFlag: string | null | undefined;
  ruledOut?: boolean | null;
}

/** `Questionable · hamstring · limited → full` → `Questionable`. */
function designation(statusFlag: string): string {
  return statusFlag.split('·')[0]!.trim();
}

export function availabilityChip(evaluation: ChipSource | null | undefined): AvailabilityChip | null {
  const flag = evaluation?.statusFlag?.trim();
  if (!flag) return evaluation?.ruledOut ? { label: 'Out', tone: 'out' } : null;
  const label = designation(flag) || flag;
  const tone: AvailabilityTone = evaluation?.ruledOut || /^doubtful$/i.test(label) ? 'out' : 'warn';
  return { label, tone };
}

/** The surname, for a one-line warning: `McConkey` from `Ladd McConkey`. */
function surname(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  const last = parts[parts.length - 1]!;
  return /^(jr\.?|sr\.?|ii|iii|iv)$/i.test(last) && parts.length > 2 ? parts[parts.length - 2]! : last;
}

/**
 * The Best move line for a recommended starter who may not play, or null.
 * Only a warning chip earns it: Out and Doubtful are already in the score.
 */
export function availabilityWarning(name: string, evaluation: ChipSource | null | undefined): string | null {
  const chip = availabilityChip(evaluation);
  if (!chip || chip.tone !== 'warn') return null;
  return `${surname(name)} is ${chip.label.toLowerCase()} and may not play`;
}
