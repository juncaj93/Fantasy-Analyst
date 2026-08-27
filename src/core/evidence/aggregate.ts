/**
 * Derive player signal from the evidence ledger.
 *
 * Rules:
 *  - user overrides win over classifier output, always
 *  - `pending`, `rejected` and `ignored` items never contribute to tallies
 *  - `mixed` and `neutral` items contribute exactly 0 but are still counted and
 *    displayed (they are real information, just not directional)
 *  - old evidence is never deleted; recency is expressed via windows
 */

import { isCarriedOverTally } from './provenance.ts';
import type {
  EffectiveEvidence,
  EvidenceItem,
  PlayerSignal,
  SignalWindow,
} from './types.ts';

/** Review states whose evidence counts toward tallies. */
const COUNTED_STATUSES = new Set(['auto_applied', 'accepted', 'corrected']);

/**
 * Rows that carry a period rather than a moment.
 *
 * Re-exported from `provenance.ts`, which is where the ledger's "where did this
 * row come from?" questions now live — the same answer decides whether a row's
 * stored summary is fit to show a reader, and two copies of it would drift.
 *
 * Known gap, stated rather than hidden: an identity repair re-files an existing
 * row under `user_identity_repair` and keeps its magnitude, so a repaired
 * *backfill* row loses this marker and looks like a moment again. Fixing that
 * means changing what the repair path records, which is a ledger rule and not
 * this module's to change.
 */
export { CARRIED_OVER_RULE_IDS } from './provenance.ts';

/**
 * Recent-evidence windows, in days.
 *
 * Seven days is momentum; thirty is the trend. Thirty rather than the previous
 * twenty-one because that is the window trade decisions are actually made on,
 * and one window shared by every mode beats two that nearly agree.
 */
export const RECENCY_WINDOWS = { last7: 7, last30: 30 } as const;

/** Apply the user override (if any) and decide whether the item counts. */
export function effectiveEvidence(item: EvidenceItem): EffectiveEvidence {
  const override = item.userOverride ?? null;
  const polarity = override?.polarity ?? item.polarity;
  const magnitude = override?.magnitude ?? item.magnitude;
  const counted = COUNTED_STATUSES.has(item.reviewStatus);
  const sign = polarity === 'positive' ? 1 : polarity === 'negative' ? -1 : 0;
  return {
    playerId: override?.playerId ?? item.playerId,
    polarity,
    magnitude,
    category: override?.category ?? (item.category as string | null) ?? null,
    sourceDate: item.sourceDate,
    delta: counted ? sign * magnitude : 0,
    counted,
    spansPriorIssues: isCarriedOverTally(item.ruleId),
  };
}

function emptyWindow(): SignalWindow {
  return { positive: 0, negative: 0, net: 0, items: 0 };
}

function add(window: SignalWindow, e: EffectiveEvidence): void {
  window.items++;
  if (e.delta > 0) window.positive += e.delta;
  else if (e.delta < 0) window.negative += Math.abs(e.delta);
  window.net = window.positive - window.negative;
}

export interface AggregateOptions {
  /** Reference time for recency windows. Defaults to now. */
  now?: string | Date;
  /** ISO date the current NFL season started; used for season-to-date. */
  seasonStart?: string | null;
}

/**
 * Compute the derived signal for one player from their evidence items.
 * Pure: the same ledger always produces the same signal.
 */
export function aggregatePlayerSignal(
  playerId: string,
  items: EvidenceItem[],
  opts: AggregateOptions = {},
): PlayerSignal {
  const nowMs = opts.now ? new Date(opts.now).getTime() : Date.now();
  const seasonStartMs = opts.seasonStart ? Date.parse(opts.seasonStart) : null;

  const raw = emptyWindow();
  const last7 = emptyWindow();
  const last30 = emptyWindow();
  const seasonToDate = emptyWindow();
  const categoryBreakdown: PlayerSignal['categoryBreakdown'] = {};

  let pendingCount = 0;
  let mixedCount = 0;
  let carriedOverItems = 0;
  let lastEvidenceAt: string | null = null;

  for (const item of items) {
    const e = effectiveEvidence(item);
    if (item.reviewStatus === 'pending') {
      pendingCount++;
      continue;
    }
    if (!e.counted) continue;
    if (e.polarity === 'mixed') mixedCount++;

    const ts = Date.parse(e.sourceDate);
    if (!lastEvidenceAt || (Number.isFinite(ts) && ts > Date.parse(lastEvidenceAt))) {
      lastEvidenceAt = e.sourceDate;
    }

    add(raw, e);

    if (e.spansPriorIssues) carriedOverItems++;

    const ageDays = Number.isFinite(ts) ? (nowMs - ts) / 86_400_000 : Number.POSITIVE_INFINITY;
    /*
     * The week believes only what happened in it.
     *
     * Seven days cannot contain several weekly issues, so a carried tally is
     * provably not 7-day evidence however recently it was imported — and the
     * import date is all its `sourceDate` records.
     *
     * Thirty days is left alone deliberately: "several earlier issues" *may*
     * fit inside a month, and excluding a row from a window it might genuinely
     * belong to asserts a fact the ledger does not have — the same error as
     * counting it in the week, pointing the other way.
     */
    if (ageDays <= RECENCY_WINDOWS.last7 && !e.spansPriorIssues) add(last7, e);
    if (ageDays <= RECENCY_WINDOWS.last30) add(last30, e);
    if (seasonStartMs == null || (Number.isFinite(ts) && ts >= seasonStartMs)) add(seasonToDate, e);

    const cat = e.category ?? 'other';
    const bucket = (categoryBreakdown[cat] ??= { positive: 0, negative: 0, items: 0 });
    bucket.items++;
    if (e.delta > 0) bucket.positive += e.delta;
    else if (e.delta < 0) bucket.negative += Math.abs(e.delta);
  }

  return {
    playerId,
    raw,
    last7,
    last30,
    seasonToDate,
    categoryBreakdown,
    pendingCount,
    mixedCount,
    carriedOverItems,
    lastEvidenceAt,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

/** Aggregate a mixed ledger into one signal per player. */
export function aggregateAll(
  items: EvidenceItem[],
  opts: AggregateOptions = {},
): Map<string, PlayerSignal> {
  const byPlayer = new Map<string, EvidenceItem[]>();
  for (const item of items) {
    const pid = item.userOverride?.playerId ?? item.playerId;
    const list = byPlayer.get(pid);
    if (list) list.push(item);
    else byPlayer.set(pid, [item]);
  }
  const out = new Map<string, PlayerSignal>();
  for (const [pid, list] of byPlayer) out.set(pid, aggregatePlayerSignal(pid, list, opts));
  return out;
}

/** An empty signal, used for players with no evidence at all. */
export function emptySignal(playerId: string, now = new Date().toISOString()): PlayerSignal {
  return {
    playerId,
    raw: emptyWindow(),
    last7: emptyWindow(),
    last30: emptyWindow(),
    seasonToDate: emptyWindow(),
    categoryBreakdown: {},
    pendingCount: 0,
    mixedCount: 0,
    carriedOverItems: 0,
    lastEvidenceAt: null,
    updatedAt: now,
  };
}
