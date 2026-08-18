/**
 * The queue is the user's order, and nothing else's.
 *
 * The ★ list is the one place in this app where the reader outranks the model.
 * Everywhere else a list is sorted by something the engine worked out; here it
 * is sorted by where somebody dragged a row, and the whole job of this module is
 * to make sure that survives contact with a live draft — refreshes, new picks,
 * players being taken, players being added from three screens away.
 *
 * **It never touches Draft Score.** A queue position is not an opinion about a
 * player: it says where to look, not how good he is. This module produces
 * orderings of ids and has no access to a score, a component or a weight, which
 * is a stronger guarantee than a comment asking future code not to.
 *
 * ## Sparse ranks, not array indices
 *
 * Order is stored per player as a number, and the numbers are deliberately
 * spread — 10, 20, 30 — rather than 0, 1, 2. Two reasons, both of which showed
 * up the moment this was tried the obvious way:
 *
 *  - **A move is one write.** Dropping a player between two others gives him
 *    the midpoint of their ranks, so a drag persists one row rather than
 *    renumbering the list. On a phone, mid-draft, that is the difference
 *    between an instant reorder and a stall.
 *  - **Concurrent additions cannot collide.** Queueing a player from the Players
 *    screen appends him after the last rank there is; it does not have to know
 *    what the draft board thinks the list currently looks like.
 *
 * Ranks are compacted back to a clean ladder only when they have to be — see
 * `needsCompaction`.
 */

/** The distance between adjacent ranks in a freshly laid-out queue. */
export const QUEUE_STEP = 1000;

/**
 * How close two ranks may get before the ladder is rebuilt.
 *
 * Repeated midpoint insertions between the same two players halve the gap each
 * time, and after ten or so there is no integer left between them. One is the
 * true floor; stopping at two leaves room for the insert that triggers the
 * compaction to complete before it happens.
 */
export const QUEUE_MIN_GAP = 2;

export interface QueueEntry {
  playerId: string;
  /** Sparse rank. Smaller is earlier. */
  order: number;
}

/**
 * The queue as an ordered list of ids.
 *
 * Ties break on the id so that two players who somehow share a rank — an old
 * row, a restored backup — still produce one stable order rather than a list
 * that shuffles between renders.
 */
export function queueSequence(entries: readonly QueueEntry[]): string[] {
  return [...entries]
    .sort((a, b) => a.order - b.order || a.playerId.localeCompare(b.playerId))
    .map((e) => e.playerId);
}

/**
 * Where a newly queued player goes: the end.
 *
 * Predictable is the whole requirement. A player starred in the eleventh round
 * goes after the ten players already starred, every time, whatever the board
 * thinks of him — a queue that re-sorted itself on insert would be the model
 * overruling the reader in the one list that is theirs.
 */
export function appendRank(entries: readonly QueueEntry[]): number {
  if (entries.length === 0) return QUEUE_STEP;
  const last = entries.reduce((max, e) => Math.max(max, e.order), Number.NEGATIVE_INFINITY);
  return last + QUEUE_STEP;
}

export interface ReorderResult {
  /** The full order after the move, best-first. */
  sequence: string[];
  /**
   * Only the entries whose rank actually changed.
   *
   * Usually exactly one. The caller persists these and nothing else, which is
   * what keeps a drag from writing the whole queue back on every drop.
   */
  writes: QueueEntry[];
  /** True when the ranks were rebuilt rather than nudged. */
  compacted: boolean;
}

/**
 * Move one player to a new position in the queue.
 *
 * `toIndex` is the index the player should occupy in the *resulting* list —
 * which is what a drag gesture naturally reports, and is why it is the argument
 * rather than "the player to insert before". Out-of-range indices are clamped
 * rather than rejected: a drop past the end of a list means the end of the list,
 * and a gesture that overshoots by two pixels is not an error condition.
 *
 * A player who is not in the queue is returned unchanged. Reordering something
 * that is not there is not a move, and inventing an entry for him would put a
 * player in the queue by dragging a different one.
 */
export function reorderQueue(
  entries: readonly QueueEntry[],
  playerId: string,
  toIndex: number,
): ReorderResult {
  const sorted = [...entries].sort((a, b) => a.order - b.order || a.playerId.localeCompare(b.playerId));
  const from = sorted.findIndex((e) => e.playerId === playerId);
  if (from < 0) {
    return { sequence: sorted.map((e) => e.playerId), writes: [], compacted: false };
  }

  const target = clamp(Math.trunc(toIndex), 0, sorted.length - 1);
  if (target === from) {
    return { sequence: sorted.map((e) => e.playerId), writes: [], compacted: false };
  }

  // The list as it will look, so the neighbours below are the ones he actually
  // lands between rather than the ones he passed on the way.
  const moved = sorted[from]!;
  const rest = sorted.filter((_, i) => i !== from);
  const before = target > 0 ? rest[target - 1] : undefined;
  const after = rest[target];

  const rank = rankBetween(before?.order, after?.order);
  const sequence = rest.map((e) => e.playerId);
  sequence.splice(target, 0, moved.playerId);

  /*
   * One write, unless the gaps have run out.
   *
   * `rankBetween` returns null when there is no room left between the two
   * neighbours, which is the only case that costs a full renumber — and after
   * it, there is room again for thousands more drags.
   */
  if (rank != null) {
    return { sequence, writes: [{ playerId, order: rank }], compacted: false };
  }

  const compacted = compact(sequence);
  return { sequence: compacted.map((e) => e.playerId), writes: compacted, compacted: true };
}

/**
 * A rank strictly between two neighbours, or null when there is no room.
 *
 * At the ends of the list there is always room — a step before the first, a
 * step after the last — so only an interior insertion can run out.
 */
export function rankBetween(before: number | undefined, after: number | undefined): number | null {
  if (before == null && after == null) return QUEUE_STEP;
  if (before == null) return after! - QUEUE_STEP;
  if (after == null) return before + QUEUE_STEP;
  if (after - before < QUEUE_MIN_GAP) return null;
  const mid = Math.round((before + after) / 2);
  return mid > before && mid < after ? mid : null;
}

/** Lay a sequence of ids out on a clean ladder. */
export function compact(sequence: readonly string[]): QueueEntry[] {
  return sequence.map((playerId, i) => ({ playerId, order: (i + 1) * QUEUE_STEP }));
}

/** True when two entries have got close enough that the next drag would fail. */
export function needsCompaction(entries: readonly QueueEntry[]): boolean {
  const sorted = [...entries].sort((a, b) => a.order - b.order);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.order - sorted[i - 1]!.order < QUEUE_MIN_GAP) return true;
  }
  return false;
}

/**
 * The queue after players have left it, by being drafted or by being unstarred.
 *
 * Removal is a filter and nothing more: the survivors keep the ranks they had,
 * so the ten players below a drafted one do not shuffle, and the reader's order
 * is exactly what it was minus one row. Renumbering here would be the classic
 * way to corrupt a stored order — it looks tidier and it silently rewrites
 * every rank on an event the user did not cause.
 */
export function removeFromQueue(entries: readonly QueueEntry[], removed: Iterable<string>): QueueEntry[] {
  const gone = new Set(removed);
  return [...entries]
    .filter((e) => !gone.has(e.playerId))
    .sort((a, b) => a.order - b.order || a.playerId.localeCompare(b.playerId));
}

/**
 * Reconcile a stored order with the players actually in the queue right now.
 *
 * Two ways they drift apart, and both are ordinary rather than exceptional: a
 * player was queued somewhere that did not assign a rank (an older client, a
 * direct API call), or a player left the queue while this client was not
 * looking. Anything with a rank keeps it and stays where it is; anything
 * without one is appended, in a stable order, after everything that has one.
 */
export function reconcileQueue(
  entries: readonly QueueEntry[],
  queuedNow: readonly string[],
): QueueEntry[] {
  const byId = new Map(entries.map((e) => [e.playerId, e]));
  const known = queuedNow
    .filter((id) => byId.has(id))
    .map((id) => byId.get(id)!)
    .sort((a, b) => a.order - b.order || a.playerId.localeCompare(b.playerId));

  const unranked = queuedNow.filter((id) => !byId.has(id)).sort();
  let next = known.length > 0 ? Math.max(...known.map((e) => e.order)) : 0;
  const appended = unranked.map((playerId) => {
    next += QUEUE_STEP;
    return { playerId, order: next };
  });

  return [...known, ...appended];
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}
