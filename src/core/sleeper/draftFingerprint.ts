/**
 * What "the draft changed" actually means.
 *
 * The Draft board is expensive to rebuild — a Monte Carlo survival run per
 * candidate, tier boundaries over the remaining pool, opportunity cost against
 * the wait horizon. During a live draft the app asks Sleeper for the pick
 * stream every few seconds, and most of those answers are the *same answer*:
 * nobody has picked since last time. Rebuilding on those is pure waste, and it
 * is the kind of waste a phone notices.
 *
 * So every sync is reduced to one short string, and the board is only rebuilt
 * when that string moves. The whole correctness of that trade lives here.
 *
 * **Semantic, not literal.** Hashing the raw Sleeper response would be easier
 * and wrong: the payload carries transport timestamps, per-pick `metadata`
 * blobs that get rewritten with no pick behind them, and object key ordering
 * that is not promised to be stable. Any of those would report "changed" on a
 * draft where nothing happened, which is exactly the recomputation this exists
 * to avoid — and a fingerprint that always changes is indistinguishable from
 * not having one.
 *
 * What is in it is what a draft *means*: which draft, what state it is in, and
 * who has been taken by whom, in order. Pick ownership is included rather than
 * inferred from the slot, because a traded pick makes the two different and the
 * app's notion of whose turn it is follows ownership (see nextpick/ownership).
 */

/** The only fields of a pick that can change what the board should say. */
export interface FingerprintPick {
  pickNo: number;
  /** Null while a slot exists but nobody has been taken in it. */
  playerId: string | null;
  /** The roster the pick belongs to — the traded-pick-aware owner. */
  rosterId: number | null;
  /** Sleeper's user id for whoever made it, where it is known. */
  pickedBy?: string | null;
}

export interface FingerprintInput {
  draftId: string;
  /** `pre_draft` | `drafting` | `paused` | `complete`. */
  status: string;
  picks: FingerprintPick[];
}

/**
 * FNV-1a, 32-bit.
 *
 * A hash rather than the joined string because the joined string is ~40 bytes
 * per pick and this value is held in component state, compared on every poll
 * and printed in a diagnostic. Collisions cost a *missed* redraw, so the count
 * of picks is carried alongside the hash rather than folded into it: the
 * overwhelmingly common change — one more pick — moves a field that cannot
 * collide at all.
 */
function hash32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // The FNV prime, as shifts, so this stays in 32-bit integer arithmetic.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * One stable string for "the state of this draft".
 *
 * Equal strings mean nothing the board depends on has moved. Different strings
 * mean something has, and the board is rebuilt.
 *
 * Picks are sorted by pick number before hashing, so a response that lists them
 * in a different order than the last one is not mistaken for a draft that
 * changed. Sorting is the whole reason this is not just a join.
 */
export function draftStateFingerprint(input: FingerprintInput): string {
  const picks = [...input.picks].sort((a, b) => a.pickNo - b.pickNo);
  const body = picks
    .map((p) => `${p.pickNo}|${p.playerId ?? ''}|${p.rosterId ?? ''}|${p.pickedBy ?? ''}`)
    .join(';');
  return `${input.draftId}:${input.status}:${picks.length}:${hash32(body)}`;
}
