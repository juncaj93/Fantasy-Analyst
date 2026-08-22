/**
 * The 32 NFL clubs, their display names, and where their mark lives.
 *
 * This is the single place that answers "is this a real team?", "what is it
 * called?" and "which file draws it". Every screen that shows a team goes
 * through here, so a logo can never be right on the draft board and wrong on
 * the roster.
 *
 * The vocabulary is Sleeper's, because Sleeper is the source of truth for which
 * team a player is on (see docs/ARCHITECTURE.md). Anything arriving from ADP
 * imports, newsletters or old records is folded onto that vocabulary by
 * {@link normalizeTeam} — `JAC` becomes `JAX`, `OAK` becomes `LV`, `WSH`
 * becomes `WAS` — rather than by a second alias table living here. One table,
 * one truth.
 *
 * Nothing in this module ranks, scores or decides anything. It is presentation
 * metadata, and a missing entry degrades to the team abbreviation rather than
 * to a guess.
 */

import { normalizeTeam } from '../identity/normalize.ts';

export interface NflTeam {
  /** Canonical Sleeper abbreviation, e.g. `CHI`. */
  readonly code: string;
  /** Full club name for accessible text, e.g. `Chicago Bears`. */
  readonly name: string;
}

/**
 * Every current club, in alphabetical order by code.
 *
 * Deliberately a literal list rather than something derived at runtime: the
 * league has had the same 32 members since 2002, and a hard-coded roster is a
 * fact a test can hold the implementation to. When a club moves or rebrands,
 * this list and the matching asset change together in one commit.
 */
export const NFL_TEAMS: readonly NflTeam[] = [
  { code: 'ARI', name: 'Arizona Cardinals' },
  { code: 'ATL', name: 'Atlanta Falcons' },
  { code: 'BAL', name: 'Baltimore Ravens' },
  { code: 'BUF', name: 'Buffalo Bills' },
  { code: 'CAR', name: 'Carolina Panthers' },
  { code: 'CHI', name: 'Chicago Bears' },
  { code: 'CIN', name: 'Cincinnati Bengals' },
  { code: 'CLE', name: 'Cleveland Browns' },
  { code: 'DAL', name: 'Dallas Cowboys' },
  { code: 'DEN', name: 'Denver Broncos' },
  { code: 'DET', name: 'Detroit Lions' },
  { code: 'GB', name: 'Green Bay Packers' },
  { code: 'HOU', name: 'Houston Texans' },
  { code: 'IND', name: 'Indianapolis Colts' },
  { code: 'JAX', name: 'Jacksonville Jaguars' },
  { code: 'KC', name: 'Kansas City Chiefs' },
  { code: 'LAC', name: 'Los Angeles Chargers' },
  { code: 'LAR', name: 'Los Angeles Rams' },
  { code: 'LV', name: 'Las Vegas Raiders' },
  { code: 'MIA', name: 'Miami Dolphins' },
  { code: 'MIN', name: 'Minnesota Vikings' },
  { code: 'NE', name: 'New England Patriots' },
  { code: 'NO', name: 'New Orleans Saints' },
  { code: 'NYG', name: 'New York Giants' },
  { code: 'NYJ', name: 'New York Jets' },
  { code: 'PHI', name: 'Philadelphia Eagles' },
  { code: 'PIT', name: 'Pittsburgh Steelers' },
  { code: 'SEA', name: 'Seattle Seahawks' },
  { code: 'SF', name: 'San Francisco 49ers' },
  { code: 'TB', name: 'Tampa Bay Buccaneers' },
  { code: 'TEN', name: 'Tennessee Titans' },
  { code: 'WAS', name: 'Washington Commanders' },
];

const BY_CODE = new Map<string, NflTeam>(NFL_TEAMS.map((team) => [team.code, team]));

/**
 * The club a value refers to, or `null` if it names no current team.
 *
 * `null` covers three different real situations that all want the same
 * treatment on screen — a free agent (`''`/`FA`), a code from a provider we do
 * not recognise, and a genuinely missing value. None of them is an error, and
 * none of them is worth inventing a team for.
 */
export function nflTeam(input: string | null | undefined): NflTeam | null {
  const code = normalizeTeam(input);
  if (!code) return null;
  return BY_CODE.get(code) ?? null;
}

/** `Chicago Bears` for anything that resolves to CHI, else `null`. */
export function nflTeamName(input: string | null | undefined): string | null {
  return nflTeam(input)?.name ?? null;
}

const BY_NAME = new Map<string, string>();
for (const team of NFL_TEAMS) {
  BY_NAME.set(nameKey(team.name), team.code);
  // The nickname alone, which is how a table with a narrow column writes it.
  // "Football Team" and the like are historical and belong in the alias table
  // rather than here; this is only the last word of a current club's name.
  const nickname = team.name.split(' ').pop() ?? '';
  if (nickname) BY_NAME.set(nameKey(nickname), team.code);
}

function nameKey(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The Sleeper code for a team written any way a source might write it.
 *
 * `normalizeTeam` folds one abbreviation onto another and is deliberately not
 * changed here: it strips everything but letters, so "Detroit Lions" becomes
 * `DETROITLIONS` and resolves to nothing. Sources that write the club out in
 * full are common enough — a copied web table almost always does — that the
 * lookup is worth having, and it belongs where the club list already lives.
 *
 * Tries the abbreviation first so an existing caller's behaviour is unchanged,
 * then the full name, then the nickname. Returns '' rather than a guess.
 */
export function nflTeamCode(input: string | null | undefined): string {
  const raw = (input ?? '').trim();
  if (!raw) return '';
  const code = normalizeTeam(raw);
  if (BY_CODE.has(code)) return code;
  return BY_NAME.get(nameKey(raw)) ?? '';
}

/**
 * The team mark's URL, or `null` when there is nothing to draw.
 *
 * Served from this app's own origin, keyed by the canonical code, so the path
 * for a given team never changes and the browser can cache all 32 marks
 * permanently. See docs/ARCHITECTURE.md for where the files come from.
 */
export function nflTeamLogoUrl(input: string | null | undefined): string | null {
  const team = nflTeam(input);
  return team ? `/logos/nfl/${team.code.toLowerCase()}.webp` : null;
}
