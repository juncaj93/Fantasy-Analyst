/**
 * How much of last season a player was actually there for, and how much of the
 * missing part an injury explains.
 *
 * ## The bug this exists for
 *
 * A production card said both of these things about Joe Burrow's 2025, one line
 * under the other:
 *
 *     8 GP · QB29 half-PPR
 *     2025: missed 2 games with a toe injury
 *
 * Both numbers came from a source that was telling the truth. Sleeper says he
 * played 8 games, and the Bengals played 17, so he missed 9. The nflverse
 * injury report contains exactly four Burrow rows all season — Out in weeks 11
 * and 12 with a toe, then two practice-only weeks — because he spent weeks 3
 * to 10 on injured reserve and **a player on IR is not on the weekly injury
 * report at all**. Counting `Out` rows therefore counts the tail of a
 * nine-game absence and calls it the whole thing.
 *
 * So the two statements were not a contradiction between a right source and a
 * wrong one. They were a count of participation sitting beside a count of
 * paperwork, presented as if they measured the same quantity.
 *
 * ## The rule
 *
 * **Participation is Sleeper's to state.** Games played, and therefore games
 * missed, come from the season stats and from nothing else. The injury report
 * is never allowed to revise them downwards — its silence is the shape of its
 * coverage, not evidence that a player was available.
 *
 * **Attribution is nflverse's to state.** Which absences an injury explains
 * comes from the report, and where the report is silent the honest answer is
 * that part of the missed time is unexplained. Games played says a player was
 * absent; it never says why, and this module will not convert `8 GP` into
 * `missed 9 games with turf toe` on its own.
 *
 * The gap between the two is not a defect to be papered over. It is the thing
 * the wording has to be honest about, which is why `unresolvedMisses` is a
 * field here and not a rounding error.
 */

import { SIGNIFICANCE, type InjuryEpisode } from './history.ts';

// -------------------------------------------------------------- what goes in

export interface SeasonParticipation {
  /** Sleeper's games played. Authoritative; `null` when not ingested. */
  gamesPlayed: number | null;
  /**
   * Regular-season games the player's team actually played.
   *
   * Never a hardcoded 17. `fullSeasonSlate` derives it from what a full season
   * measurably was in the season being described, so a shortened season, a
   * season still in progress and a season with a different format each get
   * their own denominator rather than this one's.
   */
  gamesAvailable: number | null;
}

export interface AvailabilityEvidence {
  /** Folded injury-report rows. The only source of attribution. */
  episodes: InjuryEpisode[];
  /**
   * Supported prose that may state the season's missed-game total — a provider
   * outlook, in the provider's words.
   *
   * Corroboration only, in one direction: it can confirm a total participation
   * already derived, and it can never create one, override one, or add games
   * to one. Free text does not outrank a games-played column.
   */
  corroboration?: string | null;
}

// ------------------------------------------------------------- what comes out

/**
 * How much of the missed time the injury evidence accounts for.
 *
 *   - `complete` — every missed game is explained. Only this one may say
 *     "missed N games with X" as if that were the season's whole story.
 *   - `partial` — an injury explains some of it and something explains the
 *     rest. The wording must not present the part as the whole.
 *   - `unattributed` — games were missed and nothing ties them to an injury.
 *   - `unmeasured` — no trustworthy denominator, so no total to reconcile
 *     against. Counts become lower bounds and say so.
 */
export type AttributionConfidence = 'complete' | 'partial' | 'unattributed' | 'unmeasured';

/** Games missed to one body part, after weeks have been deduplicated. */
export interface AttributedPart {
  /** Normalized and lowercase, as `InjuryEpisode` holds it. */
  part: string;
  games: number;
  /** Separate absences of this part, each of which cost a game. */
  episodes: number;
}

export interface HistoricalAvailability {
  season: string;
  gamesPlayed: number | null;
  /** `null` when no denominator could be trusted for *this* player. */
  gamesAvailable: number | null;
  /** `gamesAvailable - gamesPlayed`, or `null` when either is unknown. */
  gamesMissedTotal: number | null;
  /** Never greater than `gamesMissedTotal`. */
  injuryAttributedMisses: number;
  /** Missed games no injury evidence explains. `null` when the total is unknown. */
  unresolvedMisses: number | null;
  confidence: AttributionConfidence;
  /** Attributed games per body part, most costly first. */
  parts: AttributedPart[];
  /** Whether supported prose independently stated the same total. */
  corroborated: boolean;
  /** The one line a card may show, or `null` when there is nothing to say. */
  displaySummary: string | null;
}

// ------------------------------------------------------------ the denominator

/**
 * How many players must reach a games-played value before it counts as a full
 * season.
 *
 * The maximum on its own is the wrong statistic, and the 2025 payload shows why
 * in one line: 687 players played 17 games and **two** played 18. Eighteen is
 * not an error — a player who changes teams mid-season can dodge both byes and
 * appear in every week — but it is one player's schedule, not the league's, and
 * taking the max would hand every card a denominator one game too high.
 *
 * Sixteen is comfortably above the handful that can exceed a slate and far
 * below the hundreds who play one.
 */
export const SLATE_MIN_PLAYERS = 16;

/**
 * What a full regular season measurably was, from games played alone.
 *
 * Derived rather than assumed, which is the whole point: nothing here knows
 * that a modern NFL season is 17 games, so a season still in progress reports
 * the games played so far and a season of a different length reports its own.
 * That is also the guard against the `17 - GP` arithmetic that would quietly
 * turn a player who has appeared in all six games of a young season into
 * someone who has missed eleven.
 *
 * Returns `null` when no value clears the bar, which is a season nothing can
 * responsibly be measured against.
 */
export function fullSeasonSlate(counts: Iterable<{ games: number; players: number }>): number | null {
  let slate: number | null = null;
  for (const { games, players } of counts) {
    if (!Number.isFinite(games) || games <= 0) continue;
    if (players < SLATE_MIN_PLAYERS) continue;
    if (slate == null || games > slate) slate = games;
  }
  return slate;
}

// ------------------------------------------------------------ corroboration

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18,
};

/**
 * A missed-game count stated outright in supported prose.
 *
 * Rotowire writes sentences like "he missed nine games last year, Weeks 3-12,
 * with turf toe", and that number is the one piece of the IR gap the structured
 * feed cannot supply. It is read narrowly — an explicit "missed N games" and
 * nothing inferred from the shape of a sentence — and it is only ever used to
 * agree with a total participation already produced.
 *
 * Because agreement is the only use, a claim about the wrong season is
 * harmless: it either matches the number participation derived, in which case
 * the number is right whatever the sentence was about, or it does not match and
 * is discarded.
 */
export function readMissedGamesClaim(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = /\bmissed\s+(\d{1,2}|[a-z]+)\s+(?:regular[- ]season\s+)?games?\b/i.exec(text);
  if (!match) return null;
  const raw = match[1]!.toLowerCase();
  const value = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** Does supported prose name this body part, as a whole word? */
function prosePartMatches(part: string, text: string): boolean {
  return new RegExp(`\\b${part.replace(/\s+/g, '\\s+')}\\b`, 'i').test(text);
}

// ------------------------------------------------------------ the reconciler

export interface AvailabilityInput {
  season: string;
  participation: SeasonParticipation;
  evidence: AvailabilityEvidence;
}

/**
 * Reconcile participation against injury evidence. Pure, total, deterministic.
 *
 * The single owner of historical missed-game arithmetic. Nothing else in the
 * app subtracts games played from games available — a second copy of that
 * subtraction is how a card ends up disagreeing with itself.
 */
export function reconcileHistoricalAvailability(input: AvailabilityInput): HistoricalAvailability {
  const { season, participation, evidence } = input;
  const gamesPlayed = finite(participation.gamesPlayed);

  /*
   * Absences first, deduplicated by week.
   *
   * A week belongs to one episode. The costliest episode claims its weeks
   * first so that a player carrying a long knee absence and an ankle mentioned
   * in one of the same weeks is described by the knee — and, more importantly,
   * so that two episodes sharing a Sunday cannot report two missed games.
   */
  const ordered = [...evidence.episodes]
    .filter((e) => e.regularSeasonGamesMissed > 0 || outWeeksOf(e).length > 0)
    .sort((a, b) => b.regularSeasonGamesMissed - a.regularSeasonGamesMissed || a.firstWeek - b.firstWeek);

  const claimed = new Map<number, string>();
  for (const episode of ordered) {
    for (const week of outWeeksOf(episode)) {
      if (!claimed.has(week)) claimed.set(week, episode.bodyPart);
    }
  }

  const perPart = new Map<string, AttributedPart>();
  for (const part of claimed.values()) {
    const entry = perPart.get(part) ?? { part, games: 0, episodes: 0 };
    entry.games++;
    perPart.set(part, entry);
  }
  for (const episode of ordered) {
    const entry = perPart.get(episode.bodyPart);
    if (entry && outWeeksOf(episode).some((w) => claimed.get(w) === episode.bodyPart)) entry.episodes++;
  }
  const parts = [...perPart.values()].sort((a, b) => b.games - a.games || a.part.localeCompare(b.part));
  const attributedFromReport = claimed.size;

  /*
   * The denominator, and when to refuse it.
   *
   * A player whose proven absences outnumber the games the slate says he could
   * have missed is telling us the slate is not his: he signed in October, he
   * changed teams into an extra game, or his opportunity differed from the
   * league's in some way this app cannot see. The subtraction is wrong for him
   * specifically, so it is dropped rather than clamped — a total that has to be
   * forced into range was never a measurement.
   */
  let gamesAvailable = finite(participation.gamesAvailable);
  let gamesMissedTotal = gamesAvailable != null && gamesPlayed != null ? gamesAvailable - gamesPlayed : null;
  if (gamesMissedTotal != null && (gamesMissedTotal < 0 || gamesMissedTotal < attributedFromReport)) {
    gamesAvailable = null;
    gamesMissedTotal = null;
  }

  /*
   * Corroboration, which can only ever close a gap that participation opened.
   *
   * When prose independently states the same number of missed games that
   * subtraction produced, and names the body part the report already recorded,
   * two sources that cannot see each other agree — the count and the cause. The
   * IR weeks nflverse never filed a row for are then explained, and the summary
   * is allowed to say so. A claim that disagrees with participation is dropped
   * on the spot; free text does not get to move a games-played column.
   */
  let injuryAttributedMisses = attributedFromReport;
  let corroborated = false;
  const prose = evidence.corroboration ?? null;
  if (gamesMissedTotal != null && gamesMissedTotal > attributedFromReport && prose) {
    const claim = readMissedGamesClaim(prose);
    const leading = parts[0];
    if (claim != null && claim === gamesMissedTotal && leading && prosePartMatches(leading.part, prose)) {
      injuryAttributedMisses = gamesMissedTotal;
      leading.games = gamesMissedTotal;
      corroborated = true;
    }
  }

  const unresolvedMisses = gamesMissedTotal == null ? null : gamesMissedTotal - injuryAttributedMisses;

  const confidence: AttributionConfidence =
    gamesMissedTotal == null
      ? 'unmeasured'
      : injuryAttributedMisses === 0
        ? 'unattributed'
        : injuryAttributedMisses >= gamesMissedTotal
          ? 'complete'
          : 'partial';

  const availability: HistoricalAvailability = {
    season,
    gamesPlayed,
    gamesAvailable,
    gamesMissedTotal,
    injuryAttributedMisses,
    unresolvedMisses,
    confidence,
    parts,
    corroborated,
    displaySummary: null,
  };
  availability.displaySummary = describeAvailability(availability);
  return availability;
}

function outWeeksOf(episode: InjuryEpisode): number[] {
  return episode.outWeeks ?? [];
}

function finite(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

// ------------------------------------------------------------------- the line

/**
 * One short line whose claim never exceeds its evidence.
 *
 * Each branch below is a different state of knowledge, and the wording differs
 * because the knowledge does. The rule they all obey: a number presented as a
 * season total must *be* a season total. Where an injury explains only part of
 * the missed time the sentence has to carry that, and where there is no
 * trustworthy total the counts are stated as the lower bounds they are.
 */
export function describeAvailability(a: HistoricalAvailability): string | null {
  const leading = a.parts[0];
  const { season } = a;

  if (a.confidence === 'unattributed') {
    // Games were missed and nothing ties them to an injury. Say the
    // participation and stop — the reason is not ours to supply.
    return a.gamesMissedTotal && a.gamesMissedTotal > 0 ? `${season}: ${playedOf(a)}` : null;
  }

  if (!leading) return null;

  if (a.confidence === 'unmeasured') {
    /*
     * No denominator, so `missed 2 games` cannot be claimed as the season's
     * total the way it was for Burrow. What the report proves is a floor, and
     * the sentence says floor.
     */
    if (leading.games >= 1) return `${season}: at least ${games(leading.games)} missed ${withPart(leading.part)}`;
    return `${season}: multi-week ${leading.part} absence`;
  }

  if (a.confidence === 'complete') {
    /*
     * Every missed game is accounted for, so this is the one case allowed to
     * read as the whole story.
     */
    if (a.parts.length >= 2) {
      const [first, second] = a.parts;
      return `${season}: missed ${games(first!.games)} ${withPart(first!.part)} and ${second!.games} ${withPart(second!.part)}`;
    }
    /*
     * Recurrence is its own signal: two separate three-game hamstring absences
     * say something one six-game absence does not, and the count belongs beside
     * it rather than instead of it.
     */
    if (leading.episodes >= SIGNIFICANCE.recurrenceEpisodes && !a.corroborated) {
      return `${season}: missed ${games(leading.games)} across ${countWord(leading.episodes)} separate ${leading.part} absences`;
    }
    return `${season}: missed ${games(leading.games)} ${withPart(leading.part)}`;
  }

  /*
   * Partial. The half that is proven is stated as a floor, and participation
   * carries the total — so the line can be read beside `8 GP` without the two
   * of them describing different seasons.
   */
  if (a.parts.length >= 2) {
    return `${season}: ${playedOf(a)}; missed time included ${a.parts.slice(0, 2).map((p) => p.part).join(' and ')} injuries`;
  }
  return `${season}: ${playedOf(a)}; at least ${absences(leading.games)} tied to ${attributedTo(leading.part)}`;
}

/** `played 8 of 17 games` — the participation half, in Sleeper's numbers. */
function playedOf(a: HistoricalAvailability): string {
  return `played ${a.gamesPlayed} of ${a.gamesAvailable} games`;
}

function games(n: number): string {
  return `${n} ${n === 1 ? 'game' : 'games'}`;
}

function absences(n: number): string {
  return `${n} ${n === 1 ? 'absence' : 'absences'}`;
}

const COUNT_WORDS = ['', '', 'two', 'three', 'four', 'five', 'six'] as const;

function countWord(n: number): string {
  return COUNT_WORDS[Math.min(n, COUNT_WORDS.length - 1)] ?? String(n);
}

/**
 * How the absence is attributed.
 *
 * "A concussion injury" and "an illness injury" are both wrong: those are the
 * condition, not the part of the body that has one. The report's vocabulary is
 * otherwise all body parts, which do take "injury".
 */
function withPart(part: string): string {
  if (part === 'illness') return 'through illness';
  if (part === 'concussion') return 'with a concussion';
  return `with ${article(part)} ${display(part)} injury`;
}

/** The same attribution as a bare noun phrase, for "tied to ...". */
function attributedTo(part: string): string {
  if (part === 'illness') return 'illness';
  if (part === 'concussion') return 'a concussion';
  return `${article(part)} ${display(part)} injury`;
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
