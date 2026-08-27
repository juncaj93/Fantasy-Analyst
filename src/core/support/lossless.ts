/**
 * What a snapshot cannot carry, checked before it claims to.
 *
 * The Draft lane could hand-write its output section, field by field, and a
 * reviewer could see that every field was a number or a string. The in-season
 * lanes cannot: their outputs are domain objects — a lineup, a forecast, a claim
 * plan, an offer — and the honest capture is the object itself rather than a
 * flattened copy that a reader has to trust is complete.
 *
 * That buys completeness and introduces one failure mode, which this module
 * exists to close. `JSON.stringify` does not round-trip everything:
 *
 *   - **a `Map` becomes `{}`** — silently, with no error and no warning. This is
 *     not hypothetical. It is the third defect the Draft lane found by building
 *     itself: `ManagerTendencies.byPosition` is a `Map`, and a league with
 *     synced manager history could not replay at all. `DefenseTendencyIndex` is
 *     a `Map` too, and it is attached to every single `StartSitInput`;
 *   - **a `Set` becomes `{}`** for the same reason;
 *   - **a function disappears**, taking the key with it;
 *   - **a non-finite number becomes `null`** — `Infinity`, `-Infinity` and
 *     `NaN` alike. This one is not hypothetical either: a league's
 *     points-allowed table ends at `to: Infinity`, and through the wire every
 *     defence in that league scores a fraction of a point differently;
 *   - **`undefined` disappears**, taking the key with it — which is fine and is
 *     not reported here, because absent and `undefined` mean the same thing
 *     everywhere in this codebase and the rehydrated value is identical.
 *
 * A `Date` is not reported either: it becomes an ISO string, and both sides of a
 * replay comparison have been through JSON, so they agree.
 *
 * The rule this enforces is therefore narrow and absolute: **a snapshot may not
 * contain a value that JSON turns into a different value.** A capture carrying
 * one is refused rather than emitted, exactly as a capture carrying a secret is
 * refused — because a snapshot whose manager priors were all quietly neutralised
 * replays as a *different decision* that looks like the right one, which is the
 * worst thing a diagnostic file can be.
 *
 * Where a domain object genuinely needs a `Map`, the adapter hoists it into an
 * entry array and puts it back at replay. See `inseason.ts` for the two that do.
 */

/** One value that would not survive the wire, with enough path to find it. */
export interface LossyValue {
  /** `decision.output.cards.qb1.byPosition` */
  path: string;
  /** `Map`, `Set`, `function` — what it is, said in one word. */
  kind: string;
}

/**
 * Walk a value and report everything JSON would change.
 *
 * Every violation rather than the first, on the same reasoning as
 * `findRedactionViolations`: a caller fixing these is going to have to fix all
 * of them, and a list beats a game of whack-a-mole.
 *
 * Cycles are guarded rather than trusted. A snapshot is a tree of plain data by
 * the time this runs, but it is walking domain objects that were assembled by
 * six engines, and a stack overflow is a poor way to learn that one of them
 * memoises a back-reference.
 */
export function findLossyValues(value: unknown, path = ''): LossyValue[] {
  const found: LossyValue[] = [];
  const seen = new Set<object>();

  const walk = (node: unknown, at: string): void => {
    if (node == null) return;

    if (typeof node === 'function') {
      found.push({ path: at, kind: 'function' });
      return;
    }
    if (typeof node === 'number' && !Number.isFinite(node)) {
      /*
       * `Infinity`, `-Infinity` and `NaN` all serialise to `null`.
       *
       * The same silent corruption a `Map` suffers, in a shape nobody expects,
       * and this app produces one: a league's points-allowed table ends at
       * `to: Infinity`, because the top band is "and above". Through the wire it
       * becomes `null`, the band stops matching, and every defence in the league
       * replays a fraction of a point out — a snapshot that describes a decision
       * nobody made, differing by too little to notice and enough to chase.
       *
       * Reported by its own name rather than as a generic failure, because the
       * fix is never "encode it": it is to carry the value the engine derived it
       * from. See `inseason.ts`, which carries a league's published settings and
       * rebuilds the profile.
       */
      found.push({ path: at, kind: Number.isNaN(node) ? 'NaN' : 'Infinity' });
      return;
    }
    if (typeof node === 'bigint') {
      /*
       * A bigint does not become a different value: `JSON.stringify` throws on
       * it. Reported here anyway so the refusal names the field rather than
       * arriving as a `TypeError` from somewhere inside the serialiser.
       */
      found.push({ path: at, kind: 'bigint' });
      return;
    }
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (node instanceof Map) {
      found.push({ path: at, kind: 'Map' });
      return;
    }
    if (node instanceof Set) {
      found.push({ path: at, kind: 'Set' });
      return;
    }
    /*
     * A Date is fine and is deliberately not walked.
     *
     * It serialises to an ISO string and deserialises to that string, and both
     * sides of a replay comparison have been through JSON — so the two agree.
     * Walking its (absent) own properties would find nothing and cost a branch.
     */
    if (node instanceof Date) return;

    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${at}[${i}]`));
      return;
    }

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, at === '' ? key : `${at}.${key}`);
    }
  };

  walk(value, path);
  return found;
}

/** Raised when a capture would have emitted something the wire would change. */
export class SnapshotLossyError extends Error {
  /*
   * A plain field rather than a constructor parameter property, for the same
   * reason `SnapshotRedactionError` uses one: the replay CLI runs the shipped
   * modules through `--experimental-strip-types`, which refuses parameter
   * properties because they are a transform rather than an annotation.
   */
  readonly lossy: LossyValue[];

  constructor(lossy: LossyValue[]) {
    super(
      `refusing to emit a support snapshot: ${lossy.length} value${lossy.length === 1 ? '' : 's'} would not survive JSON — ` +
        lossy.map((v) => `${v.path} (${v.kind})`).join('; ') +
        '. Hoist it into an entry array in the adapter and put it back at replay; see core/support/lossless.ts.',
    );
    this.name = 'SnapshotLossyError';
    this.lossy = lossy;
  }
}
