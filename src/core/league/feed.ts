/**
 * The decision feed — one place that says what changed, and nothing else.
 *
 * The rule this file exists to enforce is a negative one, and it is the whole
 * feature:
 *
 * > Surface an item only when something actually changes a decision, a
 * > recommendation, a confidence tier, a rank materially, an injury contingency
 * > or a transaction priority.
 *
 * Everything else — a refresh that found the same numbers, a prop that moved
 * half a yard, a rank that shuffled two places inside a tier — produces
 * nothing. A feed that reports every observation trains the reader to ignore
 * it, at which point the one item that mattered is ignored too.
 *
 * Deduplication is the second half of the same idea. Three sources describing
 * one injury are one event. They arrive as three candidates with the same
 * `dedupeKey`, and exactly one row survives: the most decision-relevant, with
 * the others recorded as corroboration rather than as separate news.
 */

export type FeedKind =
  | 'injury'
  | 'role'
  | 'market'
  | 'faab'
  | 'competition'
  | 'rank'
  | 'lineup'
  | 'matchup'
  | 'bye';

/** Below this, a change is not worth a line. 0–1, normalized by the emitter. */
export const MATERIALITY_THRESHOLD = 0.2;

export interface FeedCandidate {
  kind: FeedKind;
  /**
   * The identity of the *situation*, not of the observation.
   *
   * `injury:4034` is the right shape; `injury:4034:espn:2026-09-12T14:03Z` is
   * not, because it makes every retelling of one injury a separate event, which
   * is exactly the failure this feed is built to prevent.
   */
  dedupeKey: string;
  playerId?: string | null;
  headline: string;
  detail?: string | null;
  /** 0–1. How much of a decision this moved. */
  magnitude: number;
  occurredAt: string;
  /**
   * True only when a recommendation, a tier, a contingency or a claim priority
   * actually changed. A large magnitude with no decision change is still
   * suppressed — a player who moved from clearly-start to even-more-clearly
   * start has not given the reader anything to do.
   */
  changesDecision: boolean;
  /** Where it came from, for the corroboration line. */
  source?: string;
}

export interface FeedEvent extends FeedCandidate {
  /** Other sources that reported the same situation in this batch. */
  corroboration: string[];
}

/**
 * Is this worth a line at all?
 *
 * Both conditions, deliberately. Magnitude without a decision change is noise
 * dressed as news; a decision change with no magnitude behind it is a rounding
 * error crossing a threshold, and the app's own thresholds are not events.
 */
export function isMaterial(candidate: FeedCandidate, threshold = MATERIALITY_THRESHOLD): boolean {
  return candidate.changesDecision && candidate.magnitude >= threshold;
}

/**
 * Collapse a batch to one event per situation.
 *
 * The survivor is the largest magnitude, then the newest — a source that
 * upgrades "questionable" to "out" says more than one that repeats
 * "questionable", whichever arrived first. Losers are not discarded silently:
 * their sources are listed on the survivor, so the feed can say "reported by
 * three sources" instead of saying it three times.
 */
export function dedupe(candidates: FeedCandidate[]): FeedEvent[] {
  const groups = new Map<string, FeedCandidate[]>();
  for (const c of candidates) {
    const list = groups.get(c.dedupeKey) ?? [];
    list.push(c);
    groups.set(c.dedupeKey, list);
  }

  const out: FeedEvent[] = [];
  for (const [, group] of groups) {
    const sorted = [...group].sort(
      (a, b) => b.magnitude - a.magnitude || b.occurredAt.localeCompare(a.occurredAt),
    );
    const winner = sorted[0]!;
    const corroboration = sorted
      .slice(1)
      .map((c) => c.source)
      .filter((s): s is string => !!s && s !== winner.source);
    out.push({ ...winner, corroboration: [...new Set(corroboration)] });
  }

  return out.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.magnitude - a.magnitude);
}

/**
 * The whole pipeline: filter for materiality, then collapse.
 *
 * In that order. Deduplicating first would let three immaterial reports of the
 * same nothing merge into one item that then looks corroborated, which is how a
 * threshold gets defeated by repetition.
 */
export function buildFeed(candidates: FeedCandidate[], threshold = MATERIALITY_THRESHOLD): FeedEvent[] {
  return dedupe(candidates.filter((c) => isMaterial(c, threshold)));
}

/**
 * Reconcile a fresh batch against what the feed is already showing.
 *
 * An open event for the same situation is *superseded* rather than duplicated,
 * so a story that develops over three days is one line that keeps getting more
 * accurate. An identical restatement — same headline, same magnitude — changes
 * nothing at all, which is what makes reopening the app twice in a minute
 * produce a still feed.
 */
export function reconcile(
  open: { dedupeKey: string; headline: string; magnitude: number; id: number }[],
  fresh: FeedEvent[],
): { insert: FeedEvent[]; supersede: { id: number; by: FeedEvent }[]; unchanged: FeedEvent[] } {
  const openByKey = new Map(open.map((o) => [o.dedupeKey, o]));
  const insert: FeedEvent[] = [];
  const supersede: { id: number; by: FeedEvent }[] = [];
  const unchanged: FeedEvent[] = [];

  for (const event of fresh) {
    const existing = openByKey.get(event.dedupeKey);
    if (!existing) {
      insert.push(event);
      continue;
    }
    if (existing.headline === event.headline && Math.abs(existing.magnitude - event.magnitude) < 0.01) {
      unchanged.push(event);
      continue;
    }
    supersede.push({ id: existing.id, by: event });
  }

  return { insert, supersede, unchanged };
}
