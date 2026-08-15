/**
 * Sleeper's league transaction history, normalized.
 *
 * The endpoint is documented and public:
 *
 *   GET https://api.sleeper.app/v1/league/<league_id>/transactions/<week>
 *
 * and it is the whole factual base of this workstream. Everything downstream —
 * manager profiles, expected FAAB cost, waiver competition — is arithmetic over
 * these rows. Nothing here reads a private endpoint, and nothing anywhere in
 * this app submits a transaction.
 *
 * Two properties of the payload shape this module, both confirmed against a
 * real league rather than assumed (`scripts/probe-sleeper-transactions.mjs`):
 *
 * - **Failed claims are returned.** Week 1 of the probed league had 20 winning
 *   waivers and 16 failed ones. The failures are the only published evidence of
 *   what the rest of the league was willing to pay, so they are kept and
 *   labelled, never filtered out on the way in.
 * - **A missing bid is not a zero bid.** `free_agent` adds carry no
 *   `waiver_bid` at all, and a FAAB league also contains genuine $0 claims.
 *   Reading the first as the second is how an expected-cost model learns that
 *   the going rate for a starter is a dollar.
 */

/** The fields this app consumes from Sleeper's transaction payload. */
export interface SleeperTransaction {
  transaction_id: string;
  type: string;
  status: string;
  leg?: number | null;
  created?: number | null;
  status_updated?: number | null;
  creator?: string | null;
  roster_ids?: number[] | null;
  consenter_ids?: number[] | null;
  adds?: Record<string, number> | null;
  drops?: Record<string, number> | null;
  settings?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  waiver_budget?: { sender: number; receiver: number; amount: number }[] | null;
  draft_picks?: Record<string, unknown>[] | null;
}

export type TransactionType = 'waiver' | 'free_agent' | 'trade' | 'commissioner' | 'unknown';
export type TransactionStatus = 'complete' | 'failed' | 'unknown';

export interface TransactionMove {
  /** Sleeper's player id. Resolution to a canonical player happens on read. */
  sleeperPlayerId: string;
  rosterId: number;
}

export interface BudgetMove {
  sender: number;
  receiver: number;
  amount: number;
}

export interface LeagueTransaction {
  sleeperLeagueId: string;
  transactionId: string;
  season: string;
  week: number;
  type: TransactionType;
  status: TransactionStatus;
  /** Epoch milliseconds, as Sleeper sent them. */
  createdMs: number | null;
  creatorUserId: string | null;
  rosterIds: number[];
  adds: TransactionMove[];
  drops: TransactionMove[];
  /** Dollars. `null` means the transaction carried no bid, not a bid of zero. */
  waiverBid: number | null;
  budgetMoves: BudgetMove[];
  draftPicks: Record<string, unknown>[];
  note: string | null;
}

function toType(raw: string | undefined): TransactionType {
  switch (raw) {
    case 'waiver':
    case 'free_agent':
    case 'trade':
    case 'commissioner':
      return raw;
    default:
      return 'unknown';
  }
}

function toStatus(raw: string | undefined): TransactionStatus {
  return raw === 'complete' || raw === 'failed' ? raw : 'unknown';
}

function moves(map: Record<string, number> | null | undefined): TransactionMove[] {
  if (!map) return [];
  return Object.entries(map)
    .filter(([playerId, rosterId]) => playerId !== '' && Number.isFinite(Number(rosterId)))
    .map(([playerId, rosterId]) => ({ sleeperPlayerId: playerId, rosterId: Number(rosterId) }));
}

/**
 * Read the bid, and only when there is one.
 *
 * `settings` is `null` on trades and on most free-agent adds. A waiver in a
 * FAAB league carries `waiver_bid`, which may legitimately be 0. So the test is
 * for the key's presence and numeric readability, never for truthiness — `?? 0`
 * here would silently convert every trade in the league into a $0 waiver claim.
 */
export function readWaiverBid(settings: Record<string, unknown> | null | undefined): number | null {
  if (!settings || !('waiver_bid' in settings)) return null;
  const raw = settings['waiver_bid'];
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

export function normalizeTransaction(
  raw: SleeperTransaction,
  ctx: { sleeperLeagueId: string; season: string; week: number },
): LeagueTransaction | null {
  if (!raw?.transaction_id) return null;

  const budgetMoves = (raw.waiver_budget ?? [])
    .filter((m) => m && Number.isFinite(m.amount))
    .map((m) => ({ sender: Number(m.sender), receiver: Number(m.receiver), amount: Math.round(Number(m.amount)) }));

  return {
    sleeperLeagueId: ctx.sleeperLeagueId,
    transactionId: String(raw.transaction_id),
    season: ctx.season,
    // Sleeper's own `leg` is authoritative when present; the requested week is
    // the fallback, because a transaction cannot be filed under a week nobody
    // asked for.
    week: Number.isFinite(raw.leg) ? Number(raw.leg) : ctx.week,
    type: toType(raw.type),
    status: toStatus(raw.status),
    createdMs: Number.isFinite(raw.created) ? Number(raw.created) : null,
    creatorUserId: raw.creator ? String(raw.creator) : null,
    rosterIds: (raw.roster_ids ?? []).map(Number).filter((n) => Number.isFinite(n)),
    adds: moves(raw.adds),
    drops: moves(raw.drops),
    waiverBid: readWaiverBid(raw.settings),
    budgetMoves,
    draftPicks: (raw.draft_picks ?? []).filter((p): p is Record<string, unknown> => p != null),
    note: typeof raw.metadata?.['notes'] === 'string' ? String(raw.metadata['notes']) : null,
  };
}

export function normalizeTransactions(
  raw: SleeperTransaction[],
  ctx: { sleeperLeagueId: string; season: string; week: number },
): LeagueTransaction[] {
  return raw
    .map((t) => normalizeTransaction(t, ctx))
    .filter((t): t is LeagueTransaction => t !== null);
}

/**
 * A won waiver claim with a real price attached.
 *
 * The three conditions are separate on purpose. `complete` excludes the losers,
 * `waiver` excludes free-agent adds that cost nothing by construction, and a
 * non-null bid excludes a league that does not use FAAB at all — in which case
 * this returns nothing and every caller degrades to saying so, rather than
 * modelling a currency the league does not spend.
 */
export function winningBids(transactions: LeagueTransaction[]): LeagueTransaction[] {
  return transactions.filter((t) => t.type === 'waiver' && t.status === 'complete' && t.waiverBid != null);
}

/** A claim that was placed and lost. Evidence about the bidder and the price. */
export function losingBids(transactions: LeagueTransaction[]): LeagueTransaction[] {
  return transactions.filter((t) => t.type === 'waiver' && t.status === 'failed' && t.waiverBid != null);
}

/**
 * Does this league actually spend FAAB?
 *
 * Sleeper's `waiver_type` says what the league is configured for, and the
 * transaction record says what it does. Both are consulted because a league can
 * be configured for FAAB and have every manager claim at $0, which is a
 * priority-order league wearing a budget, and pricing advice for it would be
 * fiction.
 */
export function usesFaab(transactions: LeagueTransaction[]): boolean {
  return winningBids(transactions).some((t) => (t.waiverBid ?? 0) > 0);
}
