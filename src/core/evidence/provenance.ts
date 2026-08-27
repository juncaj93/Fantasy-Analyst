/**
 * Where a ledger row came from, asked by `rule_id`.
 *
 * `rule_id` is already how the ledger records origin — the deterministic parser
 * writes the rule that matched, the ChatGPT import writes `ai-tally-import`,
 * the hand-maintained backfill writes `tally-backfill` — so provenance needs no
 * new column and no migration. What it did need was one place to ask, because
 * the answer is now load-bearing on two very different surfaces: how a row is
 * *counted*, and whether its stored summary is fit to show a reader.
 *
 * Deliberately tiny and free of imports, so the browser can ask the same
 * question the server does without pulling the aggregation model in behind it.
 */

/**
 * Rows that carry a *period* rather than a moment.
 *
 * Only the backfill importer qualifies. A weekly tally row is one issue's
 * reading of one player and its date is exactly when that news happened; the
 * parser's rows are single sentences from a dated newsletter. The backfill
 * importer is the one path that deliberately compresses "several earlier
 * issues" into a single item, and it says so on every row it writes.
 */
export const CARRIED_OVER_RULE_IDS: ReadonlySet<string> = new Set(['tally-backfill']);

export function isCarriedOverTally(ruleId: string | null | undefined): boolean {
  return ruleId != null && CARRIED_OVER_RULE_IDS.has(ruleId);
}

/**
 * Is this row's stored summary about *ingestion* rather than about football?
 *
 * The backfill importer composes its `context_summary` itself — "Carried over
 * from a running tally covering several earlier issues (net +11)" — because at
 * the time the useful thing to record was where a number that large had come
 * from. It is accurate, and it is bookkeeping: it explains how the row entered
 * the database and says nothing whatsoever about the player. On a card somebody
 * opened to find out what happened to a wide receiver, it spends the one line
 * that mattered on the app talking about itself.
 *
 * So on player-facing surfaces that summary is skipped and the row's excerpt —
 * the drivers the tally actually listed, "R1–R3 breakout/coverage numbers. R4:
 * #2 FPG excl. injury weeks…" — is shown instead. Nothing is invented and
 * nothing is deleted: the summary is still on the row, still in the evidence
 * timeline, and still on Review, which is where an explanation of how data got
 * in belongs.
 *
 * Asked by provenance rather than by matching the sentence, because a string
 * test would go stale the moment the wording changed and would quietly start
 * showing bookkeeping again — the failure being fixed here.
 */
export function summaryIsIngestionBookkeeping(ruleId: string | null | undefined): boolean {
  return isCarriedOverTally(ruleId);
}
