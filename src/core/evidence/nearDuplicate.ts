/**
 * Two lines that are the same fact reworded, and how to tell.
 *
 * The ledger keeps everything, deliberately and forever. What it cannot do is
 * decide that two of its rows are worth two lines on a card. Bijan Robinson's
 * expanded card showed both of these, from the same day, one under the other:
 *
 *   > Elite receiving efficiency/target rate paired with an NFL-leading 2,298
 *   > scrimmage yards
 *   > Elite receiving efficiency/target rate and led the NFL with 2,298
 *   > scrimmage yards
 *
 * Different wording, different sentence structure, one fact. The reader spent
 * two of the three lines the card has on learning something once.
 *
 * This module is the test for that, and everything about it is a constraint
 * against the obvious way it goes wrong — collapsing two *different* things:
 *
 *   - **nothing is deleted, merged or rewritten.** It answers a question about
 *     two strings and returns a boolean. What a caller does with the answer is
 *     display selection: the suppressed row is still in the ledger, still
 *     counted by the tally, and still printed in full on the player's own
 *     Evidence timeline, which exists to show everything;
 *   - **it never invents a combined sentence.** {@link distinctByFact} returns
 *     items that were already there, the most recent of each group, never a
 *     blend of two;
 *   - **different numbers mean different facts, always.** "14 carries in Week
 *     1" and "18 carries in Week 2" share almost every word and are two
 *     separate weeks of football. When both sides carry numbers and none of
 *     them match, no amount of shared vocabulary makes them a duplicate;
 *   - **it under-collapses on purpose.** Showing one thing twice costs a line.
 *     Hiding a genuinely distinct signal costs the reader a fact he will never
 *     know he did not see, so every threshold here is set where a false merge
 *     is the harder mistake to make. The owner's rule, verbatim: "if there's
 *     like two unique things from a certain day, that's fine to have both."
 *   - **it is deterministic and clock-free.** Same pair of strings, same
 *     answer, on any machine and on any day.
 */

/**
 * Words that carry no fact.
 *
 * Kept deliberately short. Every word removed here is a word two unrelated
 * sentences can no longer be told apart by, so this stops at grammar —
 * articles, prepositions, auxiliaries — and never touches football vocabulary.
 * "Led", "leading", "paired" and "elite" all survive: they are what the
 * sentences are made of.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from', 'had', 'has',
  'have', 'he', 'her', 'him', 'his', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that',
  'the', 'their', 'them', 'they', 'this', 'to', 'was', 'were', 'while', 'who', 'will', 'with',
]);

/**
 * How much of the two sentences has to be the same fact.
 *
 * Jaccard overlap — shared content tokens over the union of both sides — so a
 * long sentence and a short one only agree when the long one is saying nothing
 * else. The reported pair scores 0.75: nine shared tokens (`elite`,
 * `receiving`, `efficiency`, `target`, `rate`, `nfl`, `2298`, `scrimmage`,
 * `yards`) out of a union of twelve, with `paired`/`leading` against `led` the
 * only difference between them.
 *
 * 0.6 sits below that and well above the pairs that must survive: a role line
 * and an injury line from the same day share almost nothing, and two weeks of
 * the same statistic score in the low forties before the number rule below
 * even runs. It is a floor with a reason, not a tuned constant — moving it up
 * loses the reported bug, moving it far down starts merging football.
 */
export const NEAR_DUPLICATE_THRESHOLD = 0.6;

/**
 * How many tokens two sentences must actually share, whatever the ratio says.
 *
 * Jaccard is unstable on very short strings: "ruled out" against "ruled out
 * Sunday" scores 0.67 on two words in common. Three is the point at which
 * agreement stops being an accident of length.
 */
const MIN_SHARED_TOKENS = 3;

interface Facts {
  /** Content tokens, numbers included, with grammar and punctuation gone. */
  tokens: Set<string>;
  /** Just the numbers, which get a rule of their own. */
  numbers: Set<string>;
}

/**
 * The facts a sentence is made of.
 *
 * Numbers keep their value and lose their formatting, so `2,298` and `2298`
 * are the same fact written twice; `24.6` keeps its decimal, because 24.6 and
 * 246 are not the same fact at all. Everything else is lowercased, split on
 * punctuation — which is what makes `efficiency/target` two tokens and
 * `NFL-leading` two more — and stripped of grammar.
 */
function factsOf(text: string): Facts {
  const flat = text
    .toLowerCase()
    // Thousands separators inside a number only: `2,298` is one number, and
    // `receiving, target` is still two words.
    .replace(/(\d),(?=\d)/g, '$1');
  const tokens = new Set<string>();
  const numbers = new Set<string>();
  for (const raw of flat.split(/[^a-z0-9.]+/)) {
    // A trailing full stop is the end of a sentence, not part of the word.
    const token = raw.replace(/^\.+|\.+$/g, '');
    if (token.length < 2) continue;
    if (/^\d+(?:\.\d+)?$/.test(token)) {
      numbers.add(token);
      tokens.add(token);
      continue;
    }
    if (STOPWORDS.has(token)) continue;
    tokens.add(token);
  }
  return { tokens, numbers };
}

/** Punctuation- and case-insensitive equality, for the identical-reprint case. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * How much two sentences overlap, from 0 (nothing in common) to 1 (the same
 * facts in some order). Exported because a threshold nobody can measure
 * against is a threshold nobody can argue with.
 */
export function factSimilarity(a: string, b: string): number {
  const left = factsOf(a);
  const right = factsOf(b);
  if (left.tokens.size === 0 || right.tokens.size === 0) return 0;
  let shared = 0;
  for (const token of left.tokens) if (right.tokens.has(token)) shared += 1;
  const union = left.tokens.size + right.tokens.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Are these two lines the same underlying claim, reworded?
 *
 * Three gates, in the order that makes the cheap "no" cheap:
 *
 *   1. identical once punctuation and case are set aside — the same newsletter
 *      line reaching the ledger twice, which is the easy half of this problem;
 *   2. **different numbers, different facts.** If both sentences carry numbers
 *      and share none of them, they are distinct however alike they read. This
 *      is the rule that keeps two weeks of the same statistic — "14 carries in
 *      Week 1", "18 carries in Week 2" — as two lines;
 *   3. enough shared vocabulary, by both ratio and count.
 */
export function isNearDuplicate(a: string, b: string): boolean {
  if (normalise(a) === normalise(b)) return normalise(a).length > 0;
  const left = factsOf(a);
  const right = factsOf(b);
  if (left.numbers.size > 0 && right.numbers.size > 0) {
    let sharedNumber = false;
    for (const n of left.numbers) if (right.numbers.has(n)) sharedNumber = true;
    if (!sharedNumber) return false;
  }
  let shared = 0;
  for (const token of left.tokens) if (right.tokens.has(token)) shared += 1;
  if (shared < MIN_SHARED_TOKENS) return false;
  const union = left.tokens.size + right.tokens.size - shared;
  return union > 0 && shared / union >= NEAR_DUPLICATE_THRESHOLD;
}

/**
 * The same list, with each fact said once — by its most recent telling.
 *
 * Order is the caller's, kept: whatever survives a group appears where that
 * item already was, so a list that arrived newest-first stays newest-first.
 * When a group's newest item is not its first, the newest one takes the
 * earliest position the group held, which is the only arrangement in which
 * "most recent of each fact" and "newest first" are both true.
 *
 * Grouping is against the items already kept rather than pairwise across
 * everything, so a chain of three loose rewordings cannot drag two genuinely
 * different sentences into one group through a middleman.
 */
export function distinctByFact<T>(items: readonly T[], read: (item: T) => { text: string; sourceDate: string }): T[] {
  const kept: { item: T; text: string; sourceDate: string }[] = [];
  for (const item of items) {
    const { text, sourceDate } = read(item);
    const twin = kept.findIndex((k) => isNearDuplicate(k.text, text));
    if (twin < 0) {
      kept.push({ item, text, sourceDate });
      continue;
    }
    // Ties keep the incumbent: the list arrives newest-first, so the first of
    // two items sharing a date is already the one the ledger considers newer.
    if (sourceDate > kept[twin]!.sourceDate) kept[twin] = { item, text, sourceDate };
  }
  return kept.map((k) => k.item);
}
