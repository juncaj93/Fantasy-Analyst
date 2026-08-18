/**
 * Matching what somebody typed against a player's name.
 *
 * Presentation only. This decides which of the rows already on screen are
 * drawn — never which players exist, what they are worth, or what order the
 * board puts them in when nobody is searching.
 *
 * The matching itself moved to `core/search/players.ts`, which every screen
 * shares with the identity resolver's normalizer. This file is the web-side
 * door onto it, kept because the screens import it and because a search that
 * *ranks* needs a second entry point that the old boolean one could not express.
 *
 * What the shared matcher adds over what used to be here:
 *
 *  - accents, apostrophes and hyphens are folded the same way on both sides, so
 *    `Amon Ra` finds `Amon-Ra St. Brown` and `JaMarr` finds `Ja'Marr Chase` —
 *    neither of which the old substring test could do, in either direction;
 *  - a small typo is forgiven on words long enough for it to mean something,
 *    so `Robnson` still finds Robinson;
 *  - results come back ranked, exact and prefix first, so typing `will` puts
 *    the Wills at the top instead of wherever ADP had left them.
 *
 * Unchanged: every word must find a home, order does not matter, and an empty
 * query matches everybody — which is what makes clearing the field restore the
 * board rather than emptying the screen.
 */

export { matchesQuery, rankByQuery } from '../core/search/players.ts';
