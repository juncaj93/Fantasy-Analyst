/**
 * Matching what somebody typed against a player's name.
 *
 * Presentation only. This decides which of the rows already on screen are
 * drawn — never which players exist, what they are worth, or what order they
 * come in. Both screens that search use it, so "why did he not come up" has one
 * answer rather than two.
 *
 * The rules are the ones a thumb needs on a phone:
 *
 *  - every word has to appear, in any order, so `bren kai` finds Kai Brennan
 *    and typing the surname first is not a mistake;
 *  - case and punctuation are ignored on both sides, so `dj` finds `D.J.` and
 *    `tj hock` finds `T.J. Hockenson`;
 *  - an empty query matches everybody, which is what makes the filter vanish
 *    the moment the field is cleared rather than emptying the screen.
 */

/** Lower-cased, stripped of everything that is not a letter, digit or space. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, '');
}

export function matchesQuery(name: string, query: string): boolean {
  const needles = normalise(query).split(/\s+/).filter(Boolean);
  if (needles.length === 0) return true;
  const haystack = normalise(name);
  return needles.every((needle) => haystack.includes(needle));
}
