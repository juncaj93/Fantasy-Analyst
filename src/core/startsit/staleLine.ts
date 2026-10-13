/**
 * A player prop taken before the game line last moved.
 *
 * The game total and the spread are the fastest-moving numbers on a game: a
 * quarterback ruled out on Friday moves them within minutes, and a book's
 * player props can sit for hours behind. When the props were read before the
 * line we hold now, the team's implied total at the time of the props is
 * compared with the implied total now, and the whole market number is scaled
 * by that ratio.
 *
 *     implied team total = total / 2 - spread / 2      (spread: negative = favoured)
 *
 * Capped at {@link STALE_LINE.maxShift} either way and always labelled, so a
 * reader can see it happened. Nothing at all happens when either side of the
 * comparison is missing or when the props are not older than the line.
 */

export const STALE_LINE = {
  /** The most the scale may move a player's market number, as a fraction. */
  maxShift: 0.08,
  /** Moves smaller than this are noise in the line, not news. */
  minShift: 0.01,
} as const;

/** The game's lines at one moment, from the player's team's side. */
export interface TeamLines {
  total: number | null;
  /** The player's team's handicap. Negative when favoured. */
  spread: number | null;
  /** When these were read. */
  at: string | null;
}

export interface StaleScale {
  factor: number;
  detail: string;
}

export function impliedTeamTotal(lines: Pick<TeamLines, 'total' | 'spread'>): number | null {
  if (lines.total == null || lines.spread == null) return null;
  if (!Number.isFinite(lines.total) || !Number.isFinite(lines.spread)) return null;
  const implied = lines.total / 2 - lines.spread / 2;
  return implied > 0 ? implied : null;
}

/**
 * The factor to apply to a stale prop, or null when none applies.
 *
 * `atProps` is the game line stored with the snapshot the props came from;
 * `now` is the latest line. The props count as stale only when they were read
 * strictly before the latest line.
 */
export function staleScale(atProps: TeamLines | null | undefined, now: TeamLines | null | undefined): StaleScale | null {
  if (!atProps || !now) return null;
  if (!atProps.at || !now.at) return null;
  const propsAt = Date.parse(atProps.at);
  const lineAt = Date.parse(now.at);
  if (!Number.isFinite(propsAt) || !Number.isFinite(lineAt) || propsAt >= lineAt) return null;
  const then = impliedTeamTotal(atProps);
  const current = impliedTeamTotal(now);
  if (then == null || current == null) return null;
  const raw = current / then;
  if (Math.abs(raw - 1) < STALE_LINE.minShift) return null;
  const factor = Math.round(Math.min(1 + STALE_LINE.maxShift, Math.max(1 - STALE_LINE.maxShift, raw)) * 1000) / 1000;
  const capped = factor !== Math.round(raw * 1000) / 1000 ? ', capped' : '';
  return {
    factor,
    detail:
      `Props older than the game line: team total ${then.toFixed(1)} then, ${current.toFixed(1)} now, ` +
      `so x${factor.toFixed(2)}${capped}`,
  };
}
