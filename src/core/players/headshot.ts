/**
 * Where a player's portrait lives, and when there is not one to ask for.
 *
 * The single place that answers "does this player have a face, and what is its
 * URL". Screens reach it through the `PlayerFace` primitive in
 * `src/web/components/common.tsx`, exactly as they reach `nflTeamLogoUrl`
 * through `TeamLogo` — so no component anywhere builds this string itself and
 * changing where portraits come from is one edit.
 *
 * Nothing here ranks, scores or decides anything. A portrait is identity
 * polish: every path degrades to initials, and the app is fully usable with
 * every image on it missing.
 *
 * ## The URL is a convention, not a contract
 *
 * Sleeper's player dictionary carries no image field. The path below was
 * established empirically — 91 players probed, 80 resolved, 78 of them distinct
 * portraits, no redirects, `public, max-age=2678400` off Cloudflare — and it is
 * the same convention Sleeper's own clients use. But nothing published promises
 * it will keep working, which is precisely why this returns a `string | null`
 * that the caller is expected to treat as optional and why the component that
 * consumes it treats a failed load as an ordinary outcome rather than an error.
 * See docs/ARCHITECTURE.md.
 *
 * ## Only a Sleeper player id, and only a numeric one
 *
 * The id is the identity key and the only input that can produce a URL. There
 * is deliberately no fuzzy matching and no name-derived path: a portrait keyed
 * on a name would silently draw the wrong person the first time two players
 * shared one, and a wrong face is worse than no face.
 *
 * ## A defence is never a person, said twice
 *
 * Live Sleeper keys team defences by the club abbreviation — `CHI` is a real
 * `player_id` — so the numeric rule already excludes every defence in
 * production data. That is the incidental version of the rule, and it is not
 * enough on its own: this repository's own demo seed keys its three defences
 * numerically (`1030` is Jacksonville), so the id shape is a convention of the
 * *source* rather than a fact about defences.
 *
 * The position is therefore checked as well, when the caller has it. Belt and
 * braces on purpose: `DEF` is the one position for which a portrait cannot
 * exist, whatever the id looks like, and a rule that holds only because one
 * provider happens to format its keys a certain way is a rule waiting to be
 * broken by a fixture.
 */

/** Sleeper's portrait host. Requested by the browser directly; never proxied. */
const HOST = 'https://sleepercdn.com/content/nfl/players';

/** The positions no portrait can exist for. A club is not a person. */
const TEAM_ENTITY_POSITIONS = new Set(['DEF', 'DST', 'D/ST']);

/**
 * The portrait URL for a Sleeper player id, or `null` when there is none to ask
 * for.
 *
 * `null` covers four different real situations that all want the same treatment
 * on screen — a team defence, a missing id, an id from some other vocabulary,
 * and a player Sleeper has no photograph of — and none of them is an error. The
 * caller draws initials.
 *
 * Numeric means *entirely* digits: `4046` is a player, `CHI` is a club, and
 * `4046x` is neither, so it is refused rather than trimmed into something that
 * looks like it worked.
 *
 * `position` is optional because not every caller has one to hand, and it is
 * worth passing wherever it is known: it is the rule that holds a defence out
 * even when its id is numeric. See the note above.
 */
export function playerHeadshotUrl(
  playerId: string | null | undefined,
  position?: string | null | undefined,
): string | null {
  if (position != null && TEAM_ENTITY_POSITIONS.has(position.trim().toUpperCase())) return null;
  const id = (playerId ?? '').trim();
  if (!id || !/^\d+$/.test(id)) return null;
  return `${HOST}/${id}.jpg`;
}

/**
 * One or two letters standing in for a face that is not there.
 *
 * Deterministic, so the same player falls back to the same mark on every screen
 * and between sessions — a fallback that changed shape would read as a second
 * kind of missing. First and last initial where there are two words, the first
 * two letters where there is only one, and nothing at all where there is no
 * name to read: an empty box is honest, a `?` is a state the reader has to
 * interpret.
 *
 * Suffixes are dropped, because `Jr.` is not a surname and `MW` for Marcus
 * Wilson Jr. is the right answer. Non-letters are ignored for the same reason
 * `O'Neal` should give `O` rather than an apostrophe.
 */
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

export function playerInitials(name: string | null | undefined): string {
  const words = (name ?? '')
    .split(/[\s]+/)
    .map((w) => w.replace(/[^\p{L}]/gu, ''))
    .filter((w) => w.length > 0 && !SUFFIXES.has(w.toLowerCase()));

  if (words.length === 0) return '';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
}
