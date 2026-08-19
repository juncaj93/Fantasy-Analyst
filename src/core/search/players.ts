/**
 * One player search, for every screen that has a search field.
 *
 * The brief asks for a shared normalizer and fuzzy matcher rather than six
 * screen-specific ones, and the honest starting position is that this app had
 * *one* — `web/search.ts` — which is better than six and still not enough. It
 * stripped punctuation and required every word to appear somewhere, which
 * handles `dj` for `D.J.` and `st brown` for `St. Brown` and nothing else:
 *
 *   - `Amon Ra` did not find `Amon-Ra St. Brown`, because dropping the hyphen
 *     leaves `amonra` on one side and `amon ra` on the other, and neither
 *     contains the other;
 *   - `JaMarr` did not find `Ja'Marr Chase` for the same reason in reverse;
 *   - `Bijan Robnson` found nothing at all, because a substring test has no
 *     concept of a typo;
 *   - and everything that *did* match came back in whatever order the board was
 *     already in, so typing `will` put Will Shipley above Will Levis or below
 *     him depending on ADP, which is not what the person typing meant.
 *
 * The core of the fix is that the same normalizer the identity resolver already
 * uses — `normalizeName`, which folds accents, drops apostrophes and turns every
 * other punctuation mark into a space — is now what search runs on too. That one
 * change fixes the first two cases outright and for the same reason: both sides
 * become `amon ra st brown` and `jamarr chase`, and the hyphen was never the
 * question.
 *
 * **Ranked, not filtered.** The second half is ordering. Exact beats prefix
 * beats word-prefix beats substring beats typo, and only then does the caller's
 * own order break ties — so `will` puts `Will` first among the Wills, and a
 * fuzzy hit can never outrank a literal one. A search that returns the right
 * player in position eleven has failed on a phone.
 *
 * **Typos are the last resort and are kept on a short leash.** Edit distance is
 * allowed only against whole name tokens, only when the typed token is at least
 * four characters, and only within a distance that scales with length — one for
 * a short word, two for a long one. Without those guards `joe` matches `Zoe`,
 * `moe`, `Jon` and `Job`, and a fuzzy search that returns the league at large
 * is worse than one that returns nothing.
 */

import { editDistance, normalizeName } from '../identity/normalize.ts';

/** How a candidate matched, best first. The ordinal *is* the ranking. */
export type MatchTier =
  /** The whole query equals the whole name. */
  | 'exact'
  /** The name starts with the query: `just` for `Justin Jefferson`. */
  | 'prefix'
  /** Every query word starts a name word: `ja ch` for `Ja'Marr Chase`. */
  | 'word_prefix'
  /** Every query word appears inside the name: `walski` for `Kowalski`. */
  | 'substring'
  /** At least one word only matched within an edit or two. */
  | 'fuzzy';

const TIER_RANK: Record<MatchTier, number> = {
  exact: 0,
  prefix: 1,
  word_prefix: 2,
  substring: 3,
  fuzzy: 4,
};

/**
 * Shortest token that may be matched with typos, and the distance allowed.
 *
 * Four is where it stops being dangerous. At three characters an edit of one
 * reaches roughly every three-letter token in the pool; at four it reaches a
 * handful; at eight, two edits is still a tighter net than one edit at three.
 */
const FUZZY_MIN_LENGTH = 4;

function fuzzyBudget(token: string): number {
  if (token.length < FUZZY_MIN_LENGTH) return 0;
  return token.length >= 8 ? 2 : 1;
}

export interface SearchMatch {
  tier: MatchTier;
  /** 0…1, higher is better. Used only to order within a tier. */
  score: number;
  /** Total edits spent across all query words. Zero for every literal tier. */
  distance: number;
}

/**
 * Normalized once, so a list of five hundred players is normalized five hundred
 * times per keystroke rather than five hundred times per query *word*.
 */
export interface SearchableName {
  /** `normalizeName(fullName)` — accents folded, apostrophes dropped. */
  normalized: string;
  /** The normalized name split into words. */
  tokens: string[];
}

export function prepareName(fullName: string): SearchableName {
  return prepareNormalized(normalizeName(fullName));
}

/**
 * The same thing, for a caller that already holds the canonical key.
 *
 * `players.normalized_name` is `normalizeName(full_name)`, written at sync time
 * and indexed. Re-deriving it per row costs a chain of regexes per player, and
 * measured over the 3,300-row dictionary that is the difference between
 * **9.5ms and 5.4ms** — on a platform that allows a Worker 10ms in total. The
 * server therefore ranks off the stored column, and this is the door onto the
 * matcher that does not pay for normalization twice.
 *
 * It is the caller's job to pass a genuinely canonical key. Passing a raw name
 * here is not a type error and will simply match badly, which is why the
 * parameter is named for what it must be.
 */
export function prepareNormalized(normalized: string): SearchableName {
  return { normalized, tokens: normalized.split(' ').filter(Boolean) };
}

/**
 * The whole-name form with its spaces squeezed out.
 *
 * `amonrastbrown`. Exported because a datastore that wants to *recall*
 * candidates for this matcher has to be able to index the same string the
 * matcher compares against — see `recallTerms`.
 */
export function squashName(normalized: string): string {
  return normalized.replace(/ /g, '');
}

/**
 * What a datastore must look for to recall every candidate this matcher could
 * accept.
 *
 * The problem this solves is not matching, it is **recall**. A database cannot
 * run `scoreName`, so it has to hand the matcher a candidate set — and if that
 * set is built by a different rule from the one the matcher applies, the two
 * disagree and a player who *would* have matched is never offered. That is the
 * subtlest way to end up with two matchers while believing you have one.
 *
 * So the recall rule lives here, beside the scoring it must not drift from.
 * Each element is the alternatives for one query word: a store should OR within
 * an element and AND across them, which mirrors `scoreName`'s "every word must
 * find a home" exactly.
 *
 * Two alternatives per word:
 *
 *   - **the word itself**, which recalls the exact, prefix, word-prefix and
 *     substring tiers;
 *   - **its first three characters**, but only for a word long enough to have
 *     earned a typo budget. This is what recalls the fuzzy tier: `robnson`
 *     cannot be found by substring, but `rob` finds Robinson and the matcher
 *     then decides whether the edit distance is acceptable.
 *
 * The prefix is deliberately not shorter. At two characters it recalls a
 * meaningful fraction of the dictionary for no gain, and the matcher would
 * throw all of it away.
 *
 * The one thing this cannot recall is a typo in a word's **first three
 * characters** — `Macua` for `Nacua`. Widening the net to catch that means
 * scanning the whole table, which is the cost this design exists to avoid, and
 * a slip on the opening letters is much rarer than one in the middle.
 */
export function recallTerms(query: string): string[][] {
  return prepareQuery(query).map((word) => {
    const terms = [word];
    if (fuzzyBudget(word) > 0) terms.push(word.slice(0, RECALL_PREFIX));
    return terms;
  });
}

/** How much of a word is enough to recall it despite a typo later on. */
const RECALL_PREFIX = 3;

/** The query, normalized and split. An empty query has no words. */
export function prepareQuery(query: string): string[] {
  return normalizeName(query).split(' ').filter(Boolean);
}

/**
 * Score one name against an already-prepared query.
 *
 * Returns null when the name does not match at all. An empty query matches
 * everything at `exact` — which is what makes clearing the field restore the
 * full list in its original order rather than emptying the screen.
 */
export function scoreName(name: SearchableName, queryWords: readonly string[]): SearchMatch | null {
  if (queryWords.length === 0) return { tier: 'exact', score: 1, distance: 0 };
  if (!name.normalized) return null;

  const joined = queryWords.join(' ');
  if (name.normalized === joined) return { tier: 'exact', score: 1, distance: 0 };
  if (name.normalized.startsWith(joined)) {
    // A prefix of a short name is a better match than a prefix of a long one:
    // `will` is more nearly all of `Will Levis` than of `William Robinson`.
    return { tier: 'prefix', score: joined.length / name.normalized.length, distance: 0 };
  }

  /*
   * Word by word, best tier per word, worst tier overall.
   *
   * Each query word has to find *some* home in the name, and the match as a
   * whole is only as good as its weakest word — one fuzzy word makes the whole
   * match fuzzy. That is what stops `bijan robnson` from being ranked as a
   * substring match on the strength of `bijan` alone.
   */
  let worst = TIER_RANK.exact;
  let totalDistance = 0;
  let totalScore = 0;

  for (const word of queryWords) {
    const best = matchWord(word, name);
    if (!best) return null;
    worst = Math.max(worst, TIER_RANK[best.tier]);
    totalDistance += best.distance;
    totalScore += best.score;
  }

  const tier = (Object.keys(TIER_RANK) as MatchTier[]).find((t) => TIER_RANK[t] === worst)!;
  return { tier, score: totalScore / queryWords.length, distance: totalDistance };
}

/** The best any single name-token can do against one query word. */
function matchWord(word: string, name: SearchableName): SearchMatch | null {
  let best: SearchMatch | null = null;

  const take = (candidate: SearchMatch) => {
    if (!best || TIER_RANK[candidate.tier] < TIER_RANK[best.tier] || (candidate.tier === best.tier && candidate.score > best.score)) {
      best = candidate;
    }
  };

  for (const token of name.tokens) {
    if (token === word) take({ tier: 'exact', score: 1, distance: 0 });
    else if (token.startsWith(word)) take({ tier: 'word_prefix', score: word.length / token.length, distance: 0 });
  }
  // A word-prefix or better is already as good as it gets; nothing below can
  // beat it, and skipping the rest keeps the common keystroke cheap.
  if (best && TIER_RANK[(best as SearchMatch).tier] <= TIER_RANK.word_prefix) return best;

  /*
   * Substring across the whole name, not per token.
   *
   * `stbrown` should find `st brown`, and no single token contains it. Spaces
   * are squeezed out of both sides for this one test — which is also what makes
   * `amonra` find `amon ra`, the case the old matcher got wrong in both
   * directions.
   */
  const squashedName = name.normalized.replace(/ /g, '');
  const squashedWord = word.replace(/ /g, '');
  if (squashedName.includes(squashedWord)) {
    take({ tier: 'substring', score: squashedWord.length / squashedName.length, distance: 0 });
  }
  if (best) return best;

  const budget = fuzzyBudget(word);
  if (budget === 0) return null;

  for (const token of name.tokens) {
    /*
     * Length-guarded before the distance is even computed.
     *
     * `editDistance` bails on a length gap of its own, but the gap that matters
     * here is different: a four-letter query against a ten-letter surname is
     * not a typo however few edits separate their prefixes, and allowing it is
     * how `chas` would come back with `Chase`, `Charbonnet` and `Chandler` all
     * ranked as misspellings of each other.
     */
    if (Math.abs(token.length - word.length) > budget) continue;
    const dist = editDistance(word, token, budget);
    if (dist <= budget) {
      take({ tier: 'fuzzy', score: 1 - dist / (budget + 1), distance: dist });
    }
  }

  return best;
}

/**
 * Filter and rank a list by a query, preserving the caller's order within ties.
 *
 * The caller's order is the board's order — ADP, Draft Score, whatever the
 * screen is sorted by — and it is the correct tie-break: among two players who
 * match the query equally well, the one the board already ranked higher is the
 * one the user meant. So this is a *stable* sort over the tier, never a
 * re-ranking of the board by string similarity.
 *
 * `score` deliberately takes no part in the ordering, only in diagnostics. It
 * measures how much of the name the query covers, and sorting by it hands short
 * names a permanent advantage that has nothing to do with football: on `will`,
 * a coverage sort puts Will Levis above William Robinson for no better reason
 * than that his name is shorter, and on a single letter it would order the
 * entire board by name length. Tier says how literally the query matched;
 * beyond that the board already knows who is worth more.
 */
export function rankByQuery<T>(items: readonly T[], query: string, nameOf: (item: T) => string): T[] {
  return rankBy(items, query, (item) => prepareName(nameOf(item)));
}

/**
 * The same ranking, for a caller whose items already carry the canonical key.
 *
 * The server's is the call site this exists for: it ranks rows out of the
 * player table, every one of which has `normalized_name` written at sync time.
 * Going through `rankByQuery` would re-derive that key per row, which is the
 * cost `prepareNormalized` documents and the reason this door is separate.
 *
 * Same matcher, same ordering, same tie-break. Only the way in differs.
 */
export function rankByNormalized<T>(
  items: readonly T[],
  query: string,
  normalizedOf: (item: T) => string,
): T[] {
  return rankBy(items, query, (item) => prepareNormalized(normalizedOf(item)));
}

function rankBy<T>(items: readonly T[], query: string, prepare: (item: T) => SearchableName): T[] {
  const words = prepareQuery(query);
  if (words.length === 0) return [...items];

  const scored: { item: T; match: SearchMatch; index: number }[] = [];
  for (const [index, item] of items.entries()) {
    const match = scoreName(prepare(item), words);
    if (match) scored.push({ item, match, index });
  }

  scored.sort((a, b) => {
    const tier = TIER_RANK[a.match.tier] - TIER_RANK[b.match.tier];
    if (tier !== 0) return tier;
    // Fewer edits is a more literal match, and that much *is* about the query.
    if (a.match.distance !== b.match.distance) return a.match.distance - b.match.distance;
    return a.index - b.index;
  });

  return scored.map((s) => s.item);
}

/**
 * Whether a name matches at all, for callers that only filter.
 *
 * The old `matchesQuery` signature, kept so nothing that only needs a boolean
 * has to build a prepared name to get one — and so the shared matcher is the
 * cheap option at every call site, which is what keeps a seventh
 * implementation from being written.
 */
export function matchesQuery(name: string, query: string): boolean {
  const words = prepareQuery(query);
  if (words.length === 0) return true;
  return scoreName(prepareName(name), words) != null;
}
