/**
 * Which seasonal destinations the bar carries, while the answer is travelling.
 *
 * ## The failure this exists for
 *
 * The bar's seasonal slots (Draft, Waivers, Matchup) come from
 * `/api/overview`. Until that answer lands, `overview` is `null`, and the bar
 * used to read `null` the same way it reads an older deployment that says
 * nothing: Draft shown, Waivers and Matchup hidden. That is the pre-season bar.
 *
 * On 28 September 2026 the live site took 30-45 seconds to answer, and for
 * all of that time a reader in week 4 was shown Draft, Team, Trades, Players,
 * Setup: a slow answer drawn as though there were no season at all. "Still
 * waiting" and "the season has not started" are different facts, and the bar
 * was saying the second when it only knew the first.
 *
 * ## What it does instead
 *
 * The last answer the server actually gave is remembered, per world, on the
 * device. While a new answer is in flight, or when the read fails, the bar
 * keeps what it last knew. With nothing remembered (a first visit, cleared
 * storage, a private tab) the seasonal slots are left out rather than guessed,
 * and the bar says it is waiting (`pending`), until the server answers.
 *
 * Only a real answer from the server ever changes the remembered set, so a
 * stale memory is corrected on the very next load that completes.
 *
 * A remembered set is a fact about the bar, not a number: it never feeds a
 * recommendation, a score or a screen's contents. Demo scenarios have their
 * own lifecycle, so the memory is keyed by world and a demo never teaches the
 * live bar anything.
 */

export interface SeasonTabs {
  draftVisible: boolean;
  matchupVisible: boolean;
}

export type TabSource = 'server' | 'remembered' | 'failed' | 'pending';

export interface ResolvedTabs extends SeasonTabs {
  /**
   * Where the answer came from. `pending` means nothing is known yet;
   * `failed` means the read failed with nothing remembered, and the bar keeps
   * the board the way an older deployment's silence always has.
   */
  source: TabSource;
}

/** The fields of the overview this reads, all optional as on the wire. */
export interface OverviewSeasonFields {
  season?: { draftVisible?: boolean } | null;
  lifecycle?: { matchupVisible?: boolean } | null;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY_PREFIX = 'fa.seasonTabs.';

/**
 * The bar's seasonal slots from a server answer.
 *
 * Absent fields keep their long-standing meaning: no `draftVisible` keeps
 * Draft (an older deployment must never lose the board), no `matchupVisible`
 * means no Matchup (a tab to an endpoint that does not exist is worse).
 */
export function fromOverview(overview: OverviewSeasonFields): SeasonTabs {
  return {
    draftVisible: overview.season?.draftVisible ?? true,
    matchupVisible: overview.lifecycle?.matchupVisible ?? false,
  };
}

/**
 * The one decision: what the bar shows right now.
 *
 * A server answer always wins. Otherwise (waiting, or the read failed) the
 * last remembered answer stands in. With neither, a failed read keeps Draft,
 * as it always has (losing the board mid-draft because the overview errored
 * is the worst failure a seasonal tab can have, and the error banner is on
 * screen saying so), and a read still in flight is `pending`: no seasonal slot
 * at all, rather than a pre-season bar the server never described.
 */
export function resolveSeasonTabs(input: {
  overview: OverviewSeasonFields | null;
  failed: boolean;
  remembered: SeasonTabs | null;
}): ResolvedTabs {
  if (input.overview) return { ...fromOverview(input.overview), source: 'server' };
  if (input.remembered) return { ...input.remembered, source: 'remembered' };
  if (input.failed) return { ...fromOverview({}), source: 'failed' };
  return { draftVisible: false, matchupVisible: false, source: 'pending' };
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** What the server last said, for this world, or null. Never throws. */
export function recallSeasonTabs(world: string, storage: StorageLike | null = defaultStorage()): SeasonTabs | null {
  try {
    const raw = storage?.getItem(KEY_PREFIX + world);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SeasonTabs>;
    if (typeof parsed.draftVisible !== 'boolean' || typeof parsed.matchupVisible !== 'boolean') return null;
    return { draftVisible: parsed.draftVisible, matchupVisible: parsed.matchupVisible };
  } catch {
    return null;
  }
}

/** Remember a server answer. Never throws: a full or blocked store only loses the memory. */
export function rememberSeasonTabs(
  world: string,
  tabs: SeasonTabs,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.setItem(
      KEY_PREFIX + world,
      JSON.stringify({ draftVisible: tabs.draftVisible, matchupVisible: tabs.matchupVisible }),
    );
  } catch {
    /* ignore */
  }
}
