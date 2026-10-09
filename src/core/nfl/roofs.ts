/**
 * Which stadiums are covered, for the weekly weather read.
 *
 * The fixture list (nflverse) carries a `roof` for most games and is always
 * preferred: it knows a neutral-site game in London from a home game, and it
 * knows whether a retractable roof was shut. This table is the fallback for a
 * fixture row whose roof is blank, keyed by the home club, because the
 * stadium is a fact about the club and changes once a decade.
 *
 * Three answers, the same three the weather model has:
 *   - `dome`: a fixed roof. Weather does not apply, and that is known.
 *   - `retractable`: could be either. Treated as no forecast yet, never as a
 *     dome, because an open roof in December is outdoors.
 *   - absent: an open-air stadium.
 */

export type RoofKind = 'dome' | 'retractable';

/** Home club (Sleeper's abbreviation) to its stadium's roof, 2026 season. */
export const STADIUM_ROOFS: Readonly<Record<string, RoofKind>> = {
  DET: 'dome', // Ford Field
  MIN: 'dome', // U.S. Bank Stadium
  NO: 'dome', // Caesars Superdome
  LV: 'dome', // Allegiant Stadium
  LAR: 'dome', // SoFi Stadium, fixed canopy
  LAC: 'dome', // SoFi Stadium, fixed canopy
  ARI: 'retractable', // State Farm Stadium
  ATL: 'retractable', // Mercedes-Benz Stadium
  DAL: 'retractable', // AT&T Stadium
  HOU: 'retractable', // NRG Stadium
  IND: 'retractable', // Lucas Oil Stadium
};

/**
 * The roof over a team's game this week, from the table, or null for open air
 * or unknown. `home` is whether `team` hosts; the stadium is the host's.
 */
export function tableRoofFor(team: string, opponent: string | null, home: boolean | null): RoofKind | null {
  if (home == null) return null;
  const host = (home ? team : opponent ?? '').toUpperCase();
  return STADIUM_ROOFS[host] ?? null;
}
