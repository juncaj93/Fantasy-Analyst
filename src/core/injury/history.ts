/**
 * What last season did to a player, and what of it is worth saying.
 *
 * This is history, not status. Nothing in this file may ever answer the
 * question "can he play on Sunday" — that is `resolveInjury`'s job, from
 * Sleeper's live designation. A player who tore something in October 2025 and
 * is practising fully today is **healthy**, and the only thing this module is
 * allowed to add is a sentence of context beside that fact.
 *
 * The source is the published nflverse season file, which is a weekly report:
 * one row per player per week, and the same injury appears in as many rows as
 * it lasted. Read literally it is very noisy — a player with a bad ankle shows
 * up eleven times. So the rows are folded into **episodes** first, and only an
 * episode is ever described.
 *
 * What the source actually contains, measured on the real 2025 file rather than
 * assumed (6,068 rows, 22 weeks, 1,453 players):
 *
 *   - `report_status` is only ever `Out`, `Questionable`, `Doubtful` or blank.
 *     **There is no IR and no PUP in this file.** Those are Sleeper's roster
 *     statuses, and a significance rule written in terms of them would never
 *     fire. So games missed, not roster designation, is the spine here.
 *   - The injury vocabulary is 51 body parts. There is no "ACL", no "surgery",
 *     no "tear", no "fracture" — "Knee" is as specific as a torn ACL ever gets.
 *     This module therefore never says ACL. `Achilles` and `Concussion` are
 *     real values and are the two that carry their own severity.
 *   - Three descriptors are explicitly not injuries: resting, personal matter,
 *     other. Those are dropped rather than described.
 */

import { normalizeDesignation, normalizePractice, type PracticeStatus } from './model.ts';

// ----------------------------------------------------------------- the source

/** One week of one player, as the season file records it. */
export interface HistoryRow {
  week: number;
  reportStatus: string | null;
  primaryInjury: string | null;
  secondaryInjury: string | null;
  practiceStatus: string | null;
  practiceInjury?: string | null;
}

/**
 * The last week of the regular season. Weeks past it are playoff games, which
 * are still games a player missed, but only for the teams that played them.
 */
export const LAST_REGULAR_WEEK = 18;

/**
 * Descriptors that are not injuries.
 *
 * The file says so in words — "Not injury related - resting player" is a
 * healthy starter getting a Wednesday off, and counting it as an injury would
 * put a note on the best players in the league for being rested.
 */
function isNotAnInjury(raw: string): boolean {
  return /^not injury related/i.test(raw.trim());
}

/**
 * Group by what hurt.
 *
 * Case and spacing only — no stemming, no synonym table, no guessing that a
 * "Calf" and a "Hamstring" are the same soft-tissue story. Two descriptors are
 * the same injury when the source spelled them the same way.
 */
export function normalizeBodyPart(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || isNotAnInjury(trimmed)) return null;
  return trimmed.replace(/\s+/g, ' ').toLowerCase();
}

/** Title case for display, from the normalized key. */
export function bodyPartLabel(part: string): string {
  return part.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * The body part a week is about.
 *
 * The report injury is what the team filed for the game; the practice injury is
 * what it filed midweek. They almost always agree, and when only one is present
 * that is the one that matters. The secondary injury is deliberately ignored
 * for grouping — a player listed "Knee, Ankle" is having a knee episode with an
 * ankle mentioned, and treating it as two episodes would double-count it.
 */
function partOf(row: HistoryRow): string | null {
  return normalizeBodyPart(row.primaryInjury) ?? normalizeBodyPart(row.practiceInjury);
}

// ---------------------------------------------------------------- the episode

export interface InjuryEpisode {
  /** Normalized, lowercase. Use `bodyPartLabel` to show it. */
  bodyPart: string;
  firstWeek: number;
  lastWeek: number;
  /**
   * Weeks the player was ruled Out. This is a count of games missed, not an
   * estimate: the file states `Out` per week, and a week he was Out is a game
   * he did not play.
   */
  gamesMissed: number;
  /** Weeks in the regular season only, for phrasing that says "games". */
  regularSeasonGamesMissed: number;
  /** The worst the report ever got during the episode. */
  peak: 'out' | 'doubtful' | 'questionable' | 'none';
  /** Every week the episode covers, kept so a note can be audited. */
  weeks: number[];
  /** How many of those weeks he did not practise at all. */
  dnpWeeks: number;
}

/**
 * A gap this long ends an episode.
 *
 * One clear week is a bye or a week the team did not have to file, so it does
 * not separate anything. Two clear weeks means he came back and something
 * happened again, which is a second episode and possibly a recurrence.
 */
export const EPISODE_GAP_WEEKS = 3;

/**
 * Fold one player's weekly rows into episodes.
 *
 * Rows may arrive in any order. Weeks are deduplicated: a file that lists a
 * player twice in a week must not count the game twice.
 */
export function deriveEpisodes(rows: HistoryRow[]): InjuryEpisode[] {
  const byPart = new Map<string, Map<number, HistoryRow>>();

  for (const row of rows) {
    const part = partOf(row);
    if (!part) continue;
    if (!Number.isFinite(row.week)) continue;
    let weeks = byPart.get(part);
    if (!weeks) byPart.set(part, (weeks = new Map()));
    /*
     * Keep the worst row for a week. A player listed Questionable on Friday and
     * Out on Saturday is Out — taking whichever row happened to come last in
     * the file would make the outcome depend on row order.
     */
    const existing = weeks.get(row.week);
    if (!existing || severityOf(row) > severityOf(existing)) weeks.set(row.week, row);
  }

  const episodes: InjuryEpisode[] = [];
  for (const [part, weekRows] of byPart) {
    const weeks = [...weekRows.keys()].sort((a, b) => a - b);
    let run: number[] = [];
    const flush = () => {
      if (run.length) episodes.push(buildEpisode(part, run, weekRows));
      run = [];
    };
    for (const week of weeks) {
      if (run.length && week - run[run.length - 1]! >= EPISODE_GAP_WEEKS) flush();
      run.push(week);
    }
    flush();
  }

  return episodes.sort((a, b) => a.firstWeek - b.firstWeek || a.bodyPart.localeCompare(b.bodyPart));
}

function severityOf(row: HistoryRow): number {
  const d = normalizeDesignation(row.reportStatus).designation;
  return d === 'out' ? 3 : d === 'doubtful' ? 2 : d === 'questionable' ? 1 : 0;
}

function buildEpisode(part: string, weeks: number[], rows: Map<number, HistoryRow>): InjuryEpisode {
  let gamesMissed = 0;
  let regularSeasonGamesMissed = 0;
  let peakScore = 0;
  let dnpWeeks = 0;

  for (const week of weeks) {
    const row = rows.get(week)!;
    const score = severityOf(row);
    if (score > peakScore) peakScore = score;
    if (score === 3) {
      gamesMissed++;
      if (week <= LAST_REGULAR_WEEK) regularSeasonGamesMissed++;
    }
    const practice: PracticeStatus = normalizePractice(row.practiceStatus);
    if (practice === 'dnp') dnpWeeks++;
  }

  return {
    bodyPart: part,
    firstWeek: weeks[0]!,
    lastWeek: weeks[weeks.length - 1]!,
    gamesMissed,
    regularSeasonGamesMissed,
    peak: peakScore === 3 ? 'out' : peakScore === 2 ? 'doubtful' : peakScore === 1 ? 'questionable' : 'none',
    weeks,
    dnpWeeks,
  };
}

// ------------------------------------------------------------- what counts

export type Significance = 'strong' | 'moderate' | 'none';

/**
 * The thresholds, in one place and stated as numbers.
 *
 * Deliberately conservative, because the cost of the two mistakes is not
 * symmetric. A missing note costs a user nothing they did not already lack. A
 * note on a player who tweaked an ankle in October makes the app look like it
 * is guessing, and worse, invites a reader to bench a healthy starter.
 *
 * Games missed is the spine. A player who missed no games did not have a
 * season worth a line about, however many Wednesdays he sat out — that is the
 * "isolated Questionable" and "one limited practice" case the brief rules out,
 * and it is most of the file.
 */
export const SIGNIFICANCE = {
  /** Missing this many games is a strong signal on its own. */
  strongGamesMissed: 4,
  /** As is missing any time at all with one of the parts that ends seasons. */
  strongParts: new Set(['achilles']),
  /** Two or more games missed, or a recurrence, is worth a line. */
  moderateGamesMissed: 2,
  /** A concussion that cost a game is worth a line whatever the count says. */
  moderateParts: new Set(['concussion']),
  /** Separate absences of the same part, each of which cost a game. */
  recurrenceEpisodes: 2,
} as const;

export interface HistoryAssessment {
  significance: Significance;
  /** The episode the note is about — the costliest one. */
  leading: InjuryEpisode | null;
  /** Separate absences of the leading body part that each cost a game. */
  recurrences: number;
  /** Games missed across every episode. */
  totalGamesMissed: number;
  /** Games missed to the leading body part alone, across all of its episodes. */
  partGamesMissed: number;
}

/**
 * Judge a player's season.
 *
 * An episode that cost no games is never the basis of a note, so the leading
 * episode is chosen among those that did.
 */
export function assessHistory(episodes: InjuryEpisode[]): HistoryAssessment {
  const costly = episodes.filter((e) => e.gamesMissed > 0);
  const totalGamesMissed = costly.reduce((sum, e) => sum + e.gamesMissed, 0);

  if (costly.length === 0) {
    return { significance: 'none', leading: null, recurrences: 0, totalGamesMissed: 0, partGamesMissed: 0 };
  }

  const leading = costly.reduce((worst, e) =>
    e.gamesMissed > worst.gamesMissed || (e.gamesMissed === worst.gamesMissed && e.firstWeek < worst.firstWeek)
      ? e
      : worst,
  );
  const recurrences = costly.filter((e) => e.bodyPart === leading.bodyPart).length;

  /*
   * Recurrence counts the parts, not the total: two separate two-game hamstring
   * absences say something a single four-game one does not.
   */
  const partGamesMissed = costly
    .filter((e) => e.bodyPart === leading.bodyPart)
    .reduce((sum, e) => sum + e.gamesMissed, 0);

  let significance: Significance = 'none';
  if (partGamesMissed >= SIGNIFICANCE.strongGamesMissed) significance = 'strong';
  else if (SIGNIFICANCE.strongParts.has(leading.bodyPart)) significance = 'strong';
  else if (recurrences >= SIGNIFICANCE.recurrenceEpisodes) significance = 'moderate';
  else if (partGamesMissed >= SIGNIFICANCE.moderateGamesMissed) significance = 'moderate';
  else if (SIGNIFICANCE.moderateParts.has(leading.bodyPart)) significance = 'moderate';

  return { significance, leading, recurrences, totalGamesMissed, partGamesMissed };
}

// ------------------------------------------------------------------- the line

const COUNT_WORDS = ['', '', 'two', 'three', 'four', 'five', 'six'] as const;

/**
 * One short line, or nothing.
 *
 * Never a paragraph, never a diagnosis, and never a word the source did not
 * support. "Missed 5 games with a hamstring injury" is a count of `Out` weeks
 * and a body part the file named; "ACL recovery" would be neither, so it is
 * not a sentence this can produce.
 */
export function historyNote(season: string, assessment: HistoryAssessment): string | null {
  const { significance, leading, recurrences } = assessment;
  if (significance === 'none' || !leading) return null;

  const part = leading.bodyPart;
  const repeated = recurrences >= SIGNIFICANCE.recurrenceEpisodes;
  /*
   * Recurrence is about one body part, so the count that belongs beside it is
   * that part's total rather than the leading episode's — "two separate
   * hamstring absences" describes both of them, and a number that counted only
   * the longer one would contradict the sentence it sits in.
   */
  const games = repeated ? assessment.partGamesMissed : leading.gamesMissed;

  if (repeated) {
    const word = COUNT_WORDS[Math.min(recurrences, COUNT_WORDS.length - 1)] ?? String(recurrences);
    /*
     * When the absences were also long, the count is the more useful half and
     * dropping it to say "two separate knee absences" about six missed games
     * throws away the part a reader actually wants.
     */
    return games >= SIGNIFICANCE.strongGamesMissed
      ? `${season}: missed ${games} games across ${word} separate ${part} absences`
      : `${season}: ${word} separate ${part} absences`;
  }

  if (games >= 1) return `${season}: ${missedGames(games)} ${withPart(part)}`;

  /*
   * Reachable only for a body part that carries its own weight without a
   * counted absence. Says the shape of it rather than inventing a number.
   */
  return `${season}: multi-week ${part} absence`;
}

function missedGames(games: number): string {
  return `missed ${games} ${games === 1 ? 'game' : 'games'}`;
}

/**
 * How the absence is attributed.
 *
 * "A concussion injury" and "an illness injury" are both wrong: those are the
 * condition, not the part of the body that has one. The file's vocabulary is
 * otherwise all body parts, which do take "injury".
 */
function withPart(part: string): string {
  if (part === 'illness') return 'through illness';
  if (part === 'concussion') return 'with a concussion';
  return `with ${article(part)} ${display(part)} injury`;
}

/**
 * Body parts read as ordinary nouns in lower case. Achilles is a name, and
 * "an achilles injury" looks like a typo in the middle of a card.
 */
function display(part: string): string {
  return part === 'achilles' ? 'Achilles' : part;
}

function article(word: string): string {
  return /^[aeiou]/.test(word) ? 'an' : 'a';
}

// ------------------------------------------------------------------ the whole

export interface PlayerHistory {
  season: string;
  episodes: InjuryEpisode[];
  significance: Significance;
  gamesMissed: number;
  note: string | null;
}

/** The one call the rest of the app makes. Pure, and total. */
export function summarizeSeason(season: string, rows: HistoryRow[]): PlayerHistory {
  const episodes = deriveEpisodes(rows);
  const assessment = assessHistory(episodes);
  return {
    season,
    episodes,
    significance: assessment.significance,
    gamesMissed: assessment.totalGamesMissed,
    note: historyNote(season, assessment),
  };
}

/**
 * Does a note repeat what the season outlook already said?
 *
 * The outlook is prose a provider wrote, and it usually mentions a major injury
 * by name. Showing both is the app saying the same thing twice in two voices.
 * The test is deliberately narrow — the body part, as a whole word — because a
 * false match here silently hides real information.
 */
export function outlookAlreadySaysIt(note: string | null, outlook: string | null | undefined): boolean {
  if (!note || !outlook) return false;
  const part = /with an? ([a-z ]+) injury|separate ([a-z ]+) absences|multi-week ([a-z ]+) absence/.exec(note);
  const body = (part?.[1] ?? part?.[2] ?? part?.[3] ?? '').trim();
  if (!body) return false;
  return new RegExp(`\\b${body.replace(/\s+/g, '\\s+')}\\b`, 'i').test(outlook);
}
