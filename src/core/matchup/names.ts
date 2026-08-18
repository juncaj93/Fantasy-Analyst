/**
 * `J. Hurts`, and what to do when two of them are on the screen.
 *
 * A matchup row is about seventy pixels of horizontal space on a 360px phone,
 * shared with a club mark, a score, a projection and a status dot. A full name
 * does not fit, and truncating one with an ellipsis produces `Amon-Ra St. B…`,
 * which is worse than either the short form or the full one.
 *
 * So names are shortened deliberately rather than clipped, and the shortening
 * is done for the **whole matchup at once** — which is the only way to notice
 * that both `J. Jefferson` and `J. Jennings` are on the screen. Disambiguation
 * is minimal and deterministic: the shortest form that is unique inside this
 * matchup, chosen by a fixed ladder rather than by whoever was processed first.
 *
 * Compound surnames survive: `St. Brown`, `Van Jefferson` and `Smith-Njigba`
 * are surnames and are kept whole. That is the difference between reading a row
 * and decoding it.
 */

/** The particles that belong to the surname rather than standing before it. */
const SURNAME_PARTICLES = new Set(['st.', 'st', 'van', 'von', 'de', 'del', 'della', 'di', 'da', 'la', 'le', 'mc', 'mac', 'o']);

/** The suffixes that are not part of the name a row should print. */
const SUFFIXES = new Set(['jr.', 'jr', 'sr.', 'sr', 'ii', 'iii', 'iv', 'v']);

export interface NameParts {
  first: string;
  last: string;
  /** The suffix, kept so it can be restored for disambiguation. */
  suffix: string | null;
}

/**
 * Split a full name into the parts a row needs.
 *
 * Everything after the first token is the surname, minus a trailing suffix, and
 * a particle immediately before the last token pulls back into it. A single
 * token — a defence, a name Sleeper published without a space — is treated as
 * the surname, because printing `D. ` for it would be worse than printing it.
 */
export function splitName(fullName: string): NameParts {
  const tokens = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { first: '', last: '', suffix: null };
  if (tokens.length === 1) return { first: '', last: tokens[0]!, suffix: null };

  let suffix: string | null = null;
  const last = tokens[tokens.length - 1]!;
  if (SUFFIXES.has(last.toLowerCase()) && tokens.length > 2) {
    suffix = last;
    tokens.pop();
  }

  const first = tokens[0]!;
  let surname = tokens.slice(1).join(' ');

  // `Amon-Ra St. Brown` -> first `Amon-Ra`, surname `St. Brown`, which the join
  // above already produces. The particle check is what keeps a *three*-token
  // name like `Equanimeous St. Brown` from losing its particle if the caller
  // ever passes the middle name separately.
  const rest = tokens.slice(1);
  if (rest.length > 2 && SURNAME_PARTICLES.has(rest[rest.length - 2]!.toLowerCase())) {
    surname = rest.slice(-2).join(' ');
  }

  return { first, last: surname, suffix };
}

/** `Jalen Hurts` -> `J. Hurts`. A one-token name is returned unchanged. */
export function shortName(fullName: string): string {
  const { first, last } = splitName(fullName);
  if (!first) return last;
  return `${first[0]!.toUpperCase()}. ${last}`;
}

/**
 * The short name for every player on one screen, with collisions resolved.
 *
 * The ladder, shortest first:
 *
 *  1. `J. Hurts`
 *  2. `Ja. Hurts` — two letters of the given name, which separates Jalen from
 *     Justin without spending a whole word;
 *  3. `Jalen Hurts` — the full name, which is always unique enough to be worth
 *     printing when the alternative is two identical rows;
 *  4. `Jalen Hurts Jr.` — the suffix, restored only when it is the only thing
 *     telling two people apart.
 *
 * Deterministic in the input order, and the input is sorted by id before it
 * reaches here, so the same matchup produces the same names on every render.
 */
export function shortNamesFor(players: { playerId: string; name: string }[]): Map<string, string> {
  const parts = new Map<string, NameParts>();
  for (const player of players) parts.set(player.playerId, splitName(player.name));

  const ladder = [
    (p: NameParts) => (p.first ? `${p.first[0]!.toUpperCase()}. ${p.last}` : p.last),
    (p: NameParts) => (p.first.length > 1 ? `${p.first.slice(0, 2)}. ${p.last}` : `${p.first}. ${p.last}`),
    (p: NameParts) => (p.first ? `${p.first} ${p.last}` : p.last),
    (p: NameParts) => [p.first, p.last, p.suffix].filter(Boolean).join(' '),
  ];

  const out = new Map<string, string>();
  const remaining = [...players].sort((a, b) => a.playerId.localeCompare(b.playerId));

  let pool = remaining;
  for (let rung = 0; rung < ladder.length && pool.length > 0; rung++) {
    const rendered = new Map<string, { playerId: string; name: string }[]>();
    for (const player of pool) {
      const label = ladder[rung]!(parts.get(player.playerId)!);
      const bucket = rendered.get(label);
      if (bucket) bucket.push(player);
      else rendered.set(label, [player]);
    }
    const next: { playerId: string; name: string }[] = [];
    for (const [label, bucket] of rendered) {
      if (bucket.length === 1 || rung === ladder.length - 1) {
        for (const player of bucket) out.set(player.playerId, label);
      } else {
        next.push(...bucket);
      }
    }
    pool = next;
  }

  return out;
}
