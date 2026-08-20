/**
 * Draft Room.
 *
 * Above the fold: draft state, picks until your turn, top recommendations.
 * Tap a player to reveal the case for him — the conclusion, the numbers, the
 * two or three reasons, and the strongest argument against. The model's own
 * arithmetic is still there in full, one disclosure further in.
 *
 * There is deliberately no "draft this player" control — the tool recommends
 * only, and never touches Sleeper.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  InjuryDetail,
  LastSeasonLine,
  NewsletterTakeaway,
  ProfileFlags,
  SeasonOutlook,
  usePlayerDetail,
} from '../components/playerDetail.tsx';
import {
  api,
  type DraftBoard,
  type DraftRecommendation,
  type LeagueSummary,
  type SlotProgress,
} from '../api.ts';
import {
  CompactTally,
  DetailLabel,
  Disclose,
  Empty,
  InjuryTag,
  Notice,
  PositionBadge,
  Unknown,
  formatShortAge,
  positionCardClass,
} from '../components/common.tsx';
import { NavBar, SearchFilterRow, SegmentedControl, SkeletonRows } from '../components/native.tsx';
/* One shared answer to "which players does this filter mean". */
import { FLX_FILTER } from '../../core/sleeper/eligibility.ts';
/* Which rows the typed query leaves on screen. Presentation only — see search.ts. */
import { rankByQuery } from '../search.ts';
/*
 * The board survives a reload in a dead zone.
 *
 * Read-only and last-resort: it is consulted only when the server could not be
 * reached and there is nothing already on screen, and what it returns is always
 * rendered as a capture with its age. See offlineCache.ts for why it never
 * invents a pick.
 */
import { describeAge, recallBoard, rememberBoardSoon } from '../offlineCache.ts';
/*
 * The chance he is still there at your next pick — as a number, in colour.
 *
 * This is the whole urgency interface. Red is "he will not last", amber is "it
 * is a coin flip", green is "there is time"; the percentage is always printed,
 * so the colour is an accelerator and never the thing carrying the meaning.
 * The bands come from the model itself, so the colour and the number can never
 * be computed from two different rules.
 */
import { survivalBand } from '../../core/draft/survival.ts';
/*
 * The two tier decisions the board draws: where a line goes, and who is worth
 * marking. Both are pure arithmetic over what `tiers.ts` already computed, and
 * both live in core so they can be checked without a browser.
 */
import { annotateTiers, tierCliffWarning, type TierBreak } from '../../core/draft/tierBoard.ts';
/* One vocabulary for market names, shared with the baseline's own note. */
import { seasonMarketLabel } from '../../core/vegas/season.ts';
import { marketDelta, marketDeltaTitle } from '../marketDelta.ts';
/*
 * Three ways to read the same board, and one pure function that reorders it.
 *
 * The ordering lives in core rather than here for the reason every other
 * decision on this screen does: it is arithmetic, it has a right answer, and it
 * can be checked without a browser. What this file supplies is the control and
 * which mode is selected — see boardSort.ts for the guarantee that switching
 * modes cannot touch a number on a card.
 */
/*
 * The arithmetic behind the queue's long-press drag, kept out of the DOM.
 *
 * Whether a press has become a drag, which index the finger is over, and how
 * far each row should slide — all three can be wrong and none of them needs a
 * browser to check. See dragReorder.ts.
 */
import { LONG_PRESS_MS, moveItem, pressVerdict, rowOffset, targetIndex } from '../../core/draft/dragReorder.ts';
import {
  DEFAULT_SORT_MODE,
  SORT_DESCRIPTIONS,
  SORT_LABELS,
  SORT_MODES,
  hasDogCoverage,
  orderBoardRows,
  type SortMode,
} from '../../core/draft/boardSort.ts';
import { QueueControl } from '../components/decisions.tsx';
/*
 * The room, as a board.
 *
 * A companion to this screen and never a competitor to it: it draws the picks
 * that already arrived in `board`, so it costs no request, no polling loop and
 * no recomputation of anything the ranking depends on. It is opened from a
 * glyph beside the league name and closed again without this screen losing so
 * much as its scroll position.
 */
import { DraftBoardOverlay } from '../components/draftBoard.tsx';
import { GridIcon } from '../components/icons.tsx';
import { unwindOne } from '../tabReset.ts';
/*
 * Staying level with Sleeper without being asked.
 *
 * The lifecycle, the cadence, the deduping and the "did anything actually
 * change" decision all live in draftRefresh.ts, deliberately away from this
 * screen: it is the one piece of this app that has to be driven by a clock, and
 * a scheduler buried in a thousand-line component is a scheduler nobody can
 * test. This file supplies it with the two things only a screen knows — how to
 * sync, and what to rebuild when the answer is new.
 */
import {
  createDraftRefreshController,
  installDraftRefreshProbe,
  type DraftRefreshController,
  type DraftRefreshState,
  type DraftSyncResult,
} from '../draftRefresh.ts';

/**
 * The filter row.
 *
 * `★` is not a position — it is the user's own queue, and it sits first
 * because during a draft "who did I want again" is asked more often than any
 * single position.
 *
 * The positions come from the league rather than from a list here. A chip that
 * can only ever return nothing is worse than no chip: the board already hides
 * positions the league does not start, so a DEF chip in a league with no
 * defence slot looked exactly like a bug in the board.
 */
const QUEUE_FILTER = '★';
const ALL_FILTER = 'ALL';

/**
 * How many ranked rows the board asks for.
 *
 * All of them, now. This used to be forty, widening to 250 only while a search
 * was open, on the theory that nobody reads past the fortieth player. That was
 * wrong in the way that matters: by the middle of a draft the fortieth
 * *available* player is around ADP 78, so the board stopped there — and it
 * stopped silently, looking exactly like the end of the player universe rather
 * than the end of a page. A draft assistant that cannot show you the eleventh
 * round is no use in the eleventh round.
 *
 * The server ranks every available player either way; this number only ever
 * decided how many of the scored rows came back. So it now asks for the whole
 * scored set and lets the one cap that exists for a reason — `MAX_CANDIDATES`
 * on the server, which bounds how many players are scored at all — be the only
 * cap. It is deliberately a little above that, so the client is never the thing
 * doing the truncating.
 */
const BOARD_ROWS = 400;

export function DraftScreen({
  leagues,
  unlocked,
  resetNonce,
}: {
  leagues: LeagueSummary[];
  unlocked: boolean;
  /** Bumped when the Draft tab is tapped while already on Draft. */
  resetNonce: number;
}) {
  const selected = leagues.find((l) => l.isSelected) ?? null;
  const draftId = selected?.draftId ?? null;

  const [board, setBoard] = useState<DraftBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [position, setPosition] = useState(ALL_FILTER);
  /**
   * Which ordering is on screen.
   *
   * Presentation only, and it never reaches the server: the whole scored board
   * is already here, so a sort is a reorder of what the reader has rather than
   * a new request. That is what makes switching instant mid-draft, and it is
   * also what makes it safe — a mode that cannot ask for anything cannot come
   * back with different numbers.
   */
  const [sort, setSort] = useState<SortMode>(DEFAULT_SORT_MODE);
  /**
   * The queue's order while a drag is settling, or null when the server's is
   * current.
   *
   * A drag redraws the list immediately and confirms afterwards, because a
   * reorder that waited for a round trip before moving would feel broken on a
   * phone mid-draft. The server's answer replaces this the moment it lands —
   * and it is the server's ordering that survives a refresh, so an optimistic
   * list that turned out to be wrong is corrected rather than kept.
   */
  const [queueOrder, setQueueOrder] = useState<string[] | null>(null);
  /**
   * Finding one player on a board of hundreds.
   *
   * Presentation only, and deliberately so: the board arrives ranked and the
   * query filters what is drawn without touching the order, the scores or which
   * players are available. A row keeps the rank it has on the whole board, so
   * searching tells you where he actually sits rather than renumbering him to 1.
   */
  const [query, setQuery] = useState('');
  /**
   * Whether the search field is unfolded.
   *
   * Presentation, and nothing more: the board does not know or care. It starts
   * folded so the controls cost one row rather than two, which is worth an
   * extra player on every phone this app is used on.
   */
  const [searchOpen, setSearchOpen] = useState(false);
  const searching = query.trim().length > 0;
  /*
   * Which of the two tier treatments this view gets.
   *
   * Filtered to one position the board is a ladder, so the breaks in it can be
   * drawn where they fall. `ALL`, the queue and `FLX` are mixed-position lists
   * where consecutive rows are usually different positions, and a line across
   * them would be claiming a boundary that does not exist — so those get the
   * proximity tag on the players it is actually about instead.
   */
  const isSinglePosition = position !== ALL_FILTER && position !== QUEUE_FILTER && position !== FLX_FILTER;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [flagging, setFlagging] = useState<string | null>(null);
  /**
   * Whether the draft board is over the screen.
   *
   * One boolean, and deliberately nothing else. Everything this screen holds —
   * the filter, the query, the fold, the expanded card, the queue, the scroll —
   * is untouched while the board is open, which is what makes closing it return
   * the reader exactly where they were rather than to a rebuilt Draft page.
   */
  const [boardOpen, setBoardOpen] = useState(false);

  /** Manual refresh state: in-flight spinner, last success, last complaint. */
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  /** What the automatic loop is doing. Rendered as one compact cue, no more. */
  const [refreshState, setRefreshState] = useState<DraftRefreshState | null>(null);
  /** Re-renders the freshness cue without touching anything else. */
  const [now, setNow] = useState(() => Date.now());
  /**
   * When the board on screen was captured, if it came from the cache.
   *
   * Null for every board the server sent, which is almost all of them. Non-null
   * is the one state the header has to shout about: what is being read is a
   * photograph of the draft, not the draft.
   */
  const [cachedAt, setCachedAt] = useState<number | null>(null);

  /**
   * The current board and filter, readable from outside React's render cycle.
   *
   * The refresh controller lives for as long as the screen does and is *not*
   * rebuilt when the filter changes — restarting it on every chip tap would
   * throw away the fingerprint it had, and the next poll would then rebuild a
   * board that had not changed. So it reads these two facts through refs rather
   * than capturing them, which is also how "is it my pick" stays current between
   * one poll and the next without a second render.
   */
  const boardRef = useRef<DraftBoard | null>(null);
  const positionRef = useRef(position);
  positionRef.current = position;
  const controllerRef = useRef<DraftRefreshController | null>(null);

  const load = useCallback(
    async (pos: string, options: { quiet?: boolean } = {}) => {
      if (!draftId) return;
      /*
       * A poll is not a page load.
       *
       * `loading` is what puts the skeleton on screen, and an automatic refresh
       * that raised it every five seconds would flash the whole board at a
       * reader who is trying to read it. Only a filter change — a thing the user
       * did, and expects to wait for — is allowed to.
       */
      if (!options.quiet) setLoading(true);
      try {
        const filter = pos === QUEUE_FILTER ? '&queued=1' : pos === ALL_FILTER ? '' : `&position=${pos}`;
        const next = await api.get<DraftBoard>(`/api/drafts/${draftId}/board?limit=${BOARD_ROWS}${filter}`);
        boardRef.current = next;
        setBoard(next);
        /*
         * The server's order is now the current one.
         *
         * Cleared on every load, including a quiet poll: a board rebuilt after
         * a pick landed carries the stored queue order, so keeping a local
         * override would pin the list to a sequence from before the drag was
         * confirmed — and would keep a failed drag on screen indefinitely.
         */
        setQueueOrder(null);
        /*
         * A player who has just been drafted cannot stay expanded.
         *
         * Everything else the reader has set up — the filter, the search, the
         * scroll, the queue — survives untouched, because none of it is derived
         * from the board. This one is: it names a row, and the row is gone.
         */
        setExpanded((current) =>
          current && !next.recommendations.some((rec) => rec.playerId === current) ? null : current,
        );
        setUpdatedAt(Date.now());
        setError(null);
        setCachedAt(null);
        /*
         * Keep the last good board where a reload can find it.
         *
         * Only the unfiltered board is worth remembering, and only that one is
         * remembered: a cache keyed by chip would store six copies of largely
         * the same rows, and the value of this is "the board exists at all in a
         * dead zone", not "your RB filter survived".
         */
        if (pos === ALL_FILTER) rememberBoardSoon(draftId, next);
      } catch (err) {
        /*
         * A quiet load reports upwards instead of painting a banner.
         *
         * Two things follow from that, and both matter. The refresh controller
         * is the one holding the fingerprint it was about to record as applied —
         * swallowing this would tell it the board had been rebuilt from a
         * response that never arrived, and the board would then sit stale until
         * the *next* pick, with nothing on screen admitting it. And a background
         * failure has not earned a red notice across a board the reader is
         * using: the controller already knows how to retry, back off, and say
         * "sync delayed" once it has failed enough times to mean it.
         */
        if (options.quiet) throw err;

        /*
         * The tunnel case: nothing on screen, and the server unreachable.
         *
         * Falling back to the cached board is only correct when there is
         * nothing better already showing. A board that is on screen is one the
         * server actually sent, and replacing it with an older copy of itself
         * because a later request failed would be a downgrade — the refresh
         * controller is already marking that situation stale and retrying.
         *
         * This is the reload-in-a-dead-zone path, and the only one.
         */
        const cached = boardRef.current ? null : recallBoard<DraftBoard>(draftId);
        if (cached) {
          boardRef.current = cached.value;
          setBoard(cached.value);
          setCachedAt(cached.capturedAt);
          // Never silently. The banner says the board is a capture and how old
          // it is, because a stale board rendered as a live one is how somebody
          // drafts a player who went three picks ago.
          setError(null);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!options.quiet) setLoading(false);
      }
    },
    [draftId],
  );

  /** The latest `load`, reachable from the controller without restarting it. */
  const loadRef = useRef(load);
  loadRef.current = load;

  /*
   * Refetched when the filter changes, and only then.
   *
   * Typing no longer touches the server at all. It used to, because the board
   * was fetched forty rows deep and a search had to go back for more; now the
   * whole scored board is already here and the query filters what is drawn.
   */
  useEffect(() => {
    void load(position);
  }, [load, position]);

  /*
   * Tapping Draft while already on Draft — one rung per tap.
   *
   * Innermost first, which is the order a reader would undo it themselves: the
   * open player folds shut, then the search closes and empties, then the
   * position filter goes back to the whole board, and a fourth tap takes the
   * board to the top. The expansion comes before the filter deliberately —
   * resetting the filter first would redraw the list underneath an open card
   * and the card would vanish as a side effect, so the tap that was meant to
   * close it would appear to have done two things.
   *
   * The queue, the hearts and every tally are untouched. Those are the reader's
   * own marks and a tab tap has no business near them.
   */
  useEffect(() => {
    if (resetNonce === 0) return;
    unwindOne([
      { when: expanded != null, undo: () => setExpanded(null) },
      {
        when: searchOpen || query !== '',
        undo: () => {
          setQuery('');
          setSearchOpen(false);
        },
      },
      { when: position !== ALL_FILTER, undo: () => setPosition(ALL_FILTER) },
    ]);
  }, [resetNonce]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  /**
   * Queue a player, and leave the board exactly where it is.
   *
   * The star is a bookmark. It does not change the ranking, so re-fetching the
   * board would be forty rows of work to redraw the same forty rows — and on a
   * phone mid-draft it would also throw away the user's scroll position for a
   * tap that meant "remind me later". Only the one star flips.
   *
   * The ★ filter is the exception: there the queue *is* the query, so removing
   * a player has to remove his row, and that needs the server.
   */
  const setQueued = useCallback(
    async (playerId: string, queued: boolean) => {
      setFlagging(playerId);
      try {
        await api.post<{ queued: boolean }>(`/api/players/${playerId}/queue`, { queued });
        if (position === QUEUE_FILTER) await load(position);
        else
          setBoard((current) =>
            current
              ? {
                  ...current,
                  recommendations: current.recommendations.map((rec) =>
                    rec.playerId === playerId ? { ...rec, queued } : rec,
                  ),
                }
              : current,
          );
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setFlagging(null);
      }
    },
    [load, position, searching],
  );

  /**
   * Persist a drag, and keep the list where the reader dropped it meanwhile.
   *
   * The optimistic sequence goes on screen first and the server's answer
   * replaces it — which is nearly always the same sequence, and is the
   * authority when it is not. A failure clears the override rather than
   * retrying: the reader can see the row snap back, which is honest, and one
   * more drag is cheaper than a queue that silently disagrees with the stored
   * one.
   */
  const commitQueueOrder = useCallback(
    async (playerId: string, toIndex: number, optimistic: string[]) => {
      setQueueOrder(optimistic);
      try {
        const res = await api.post<{ order: string[] }>('/api/queue/reorder', { playerId, toIndex });
        setQueueOrder(res.order);
        setError(null);
      } catch (err) {
        setQueueOrder(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  /**
   * The automatic loop, alive for exactly as long as this screen is.
   *
   * Mounting *is* the trigger, and that is the whole fix. Draft is rendered only
   * while it is the current tab, so every way into it — the app opening here, a
   * tap on the destination, coming back from Team, a PWA resuming into it —
   * arrives through this effect and gets one immediate sync. Every way out
   * unmounts it, which stops the polling; nothing keeps asking Sleeper from the
   * Players tab. The lifecycle listeners are registered here rather than in the
   * controller so they are torn down by the same cleanup, with no chance of a
   * listener outliving the thing it wakes.
   *
   * Pulling new picks is a write, and writes need the passphrase — so a
   * view-only reader gets no loop at all. That is not a lesser version of this
   * feature: without a session the sync would 401 on every tick and the board
   * could not learn anything new from it anyway.
   */
  useEffect(() => {
    if (!draftId || !unlocked) {
      setRefreshState(null);
      return;
    }

    const controller = createDraftRefreshController({
      sync: () => api.post<DraftSyncResult>(`/api/drafts/${draftId}/sync`),
      /*
       * The expensive half, reached only when the fingerprint moved.
       *
       * Rebuilding the board is what recomputes availability, the live rosters,
       * the tier bands, the Next% survival runs and the opportunity cost — none
       * of which is duplicated or retuned here. The refresh layer's whole
       * contribution is deciding that it is worth doing.
       */
      applyChange: () => loadRef.current(positionRef.current, { quiet: true }),
      isOnClock: () => boardRef.current?.onTheClock ?? false,
      isVisible: () => document.visibilityState !== 'hidden',
      isOnline: () => navigator.onLine !== false,
      onState: setRefreshState,
      onError: (err, reason) => {
        // Only a tap gets an answer. A failed background poll is the
        // controller's problem — it backs off, keeps the last good board, and
        // says "delayed" once it has failed enough times to mean it.
        if (reason === 'manual') setRefreshNote(err instanceof Error ? err.message : String(err));
      },
      now: () => Date.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (handle) => window.clearTimeout(handle),
    });
    controllerRef.current = controller;
    controller.start();

    /*
     * Coming back, in all the ways iOS says it.
     *
     * Safari suspends a backgrounded tab and does not run its timers, so the
     * only honest way to be current after a resume is to ask again the moment
     * the page is visible. It fires several of these signals for one resume, in
     * no promised order — the controller coalesces them into one request.
     */
    const onVisibility = () => controller.visibilityChanged();
    const onResume = () => controller.resume('resume');
    const onOnline = () => controller.resume('online');
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onResume);
    window.addEventListener('focus', onResume);
    window.addEventListener('online', onOnline);

    const removeProbe = installDraftRefreshProbe(() => ({
      ...controller.getState(),
      draftId,
      routeActive: true,
      visible: document.visibilityState !== 'hidden',
      online: navigator.onLine !== false,
      onClock: boardRef.current?.onTheClock ?? false,
    }));

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onResume);
      window.removeEventListener('focus', onResume);
      window.removeEventListener('online', onOnline);
      removeProbe();
      controller.stop();
      controllerRef.current = null;
    };
  }, [draftId, unlocked]);

  /**
   * Force-sync now.
   *
   * The glyph does not own a request any more — it asks the same controller the
   * clock asks, which is what makes a tap during an automatic poll join that
   * poll instead of racing it. Without a session it still does the one useful
   * thing it can: rebuild the board from the state already stored.
   */
  const refreshNow = useCallback(async () => {
    if (!draftId || refreshing) return;
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const controller = controllerRef.current;
      if (controller) await controller.refreshNow('manual');
      else await load(positionRef.current);
      setNow(Date.now());
    } finally {
      setRefreshing(false);
    }
  }, [draftId, load, refreshing]);

  /*
   * Inside the queue, the reader's order. Everywhere else, the model's.
   *
   * Computed here, above the early returns, because the drag hook below is a
   * hook and hooks cannot be called conditionally. `board` is null on the first
   * frame and while a filter change is loading, which is what the empty list
   * covers — the ordering is a pure function of it either way.
   *
   * The server already returns the ★ filter in the stored order, so the local
   * override only applies while a drag is settling. It has to apply, or the row
   * would snap back to where it was for the length of a round trip.
   *
   * ## Inside the queue, the sort control does not order anything
   *
   * It used to, whenever the selected mode was not Score, and that quietly
   * destroyed the feature: a reader who had been looking at the board by DOG
   * and then opened their shortlist could drag a row anywhere they liked and
   * watch `sortBoard` put it straight back on the next render. The drag was not
   * broken — the precedence was, and the drag was the only visible symptom.
   *
   * A queue position is a thing the reader said out loud. There is no reading of
   * "sort by ADP" that outranks it, because the queue is not a view of the board
   * that happens to be filtered; it is a list they wrote. So manual order wins
   * here unconditionally, and `sort` is left exactly as they set it so that
   * leaving the queue returns them to the board they were reading — they should
   * not have to reselect a mode because they glanced at their shortlist.
   */
  const isQueue = position === QUEUE_FILTER;
  const recommendations = board?.recommendations ?? [];
  const ordered = orderBoardRows(recommendations, { isQueue, sort, pendingQueueOrder: queueOrder });

  /*
   * Drag to reorder, inside the queue and nowhere else.
   *
   * Disabled while a search is open, because the visible rows are then a subset
   * and an index into them is not an index into the queue — dropping a player
   * "third" in a filtered list would move him to the third place of a list the
   * reader cannot see.
   */
  const canReorder = isQueue && !searching && unlocked;
  const { drag, onPointerDown } = useQueueDrag({
    enabled: canReorder,
    ids: ordered.map((rec) => rec.playerId),
    onCommit: commitQueueOrder,
  });

  if (!selected) {
    return (
      <Empty>
        No league selected. Open <strong>Team</strong> to connect Sleeper and pick a league.
      </Empty>
    );
  }
  if (!draftId) {
    return <Empty>This league has no draft attached in Sleeper yet.</Empty>;
  }
  if (!board && loading) {
    return (
      <>
        <NavBar title="Draft" subtitle="Loading the board…" />
        <SkeletonRows rows={7} testId="draft-skeleton" />
      </>
    );
  }
  if (error && !board) return <Notice tone="error">{error}</Notice>;
  if (!board) return <Empty>No draft data.</Empty>;

  /*
   * What is drawn, and what each row is called.
   *
   * The rank is fixed before the filter runs, so a searched player carries the
   * number he has on the whole board rather than his position in the result.
   * Tier lines are drawn only on an unfiltered single-position ladder: a line
   * between two rows that are not adjacent on the board would be claiming a
   * boundary that is not there.
   */
  /*
   * Everything the server sent, in order. No slice.
   *
   * There used to be a second cap here, forty rows deep, which meant that even
   * a response carrying the whole board was cut back down before it was drawn.
   * Removing only the request limit would have left this one quietly doing the
   * same damage.
   */
  /*
   * Sort, then group into tiers, then search — in that order, and the order
   * matters.
   *
   * Tier dividers claim that everything above one is a tier, which is only true
   * of a contiguous run; drawing them over a board sorted by DOG would be
   * asserting boundaries in a sequence the tier model never saw. So a market
   * sort turns them off, exactly as a mixed-position board already does.
   *
   * The search runs last, over whatever order the reader chose. `rankByQuery`
   * drops what does not match and puts the literal hits first, so typing `will`
   * does not return the Wills in whatever order the board happened to leave
   * them in; within a tier of match the chosen ordering survives.
   *
   * The dividers are built before the search, not after, which is what keeps
   * the `rank` badge showing where a player sits on the *board* rather than
   * where he sits in the search results. A player who is the 41st best
   * available is the 41st best available whether or not you found him by
   * typing.
   */
  const rows = withTierDividers(ordered, isSinglePosition && !searching && sort === DEFAULT_SORT_MODE);
  const visible = searching ? rankByQuery(rows, query, (item) => item.rec.name) : rows;

  /*
   * When the board last moved, and when it was last checked.
   *
   * The controller knows both once it is running; before it has said anything —
   * a view-only reader, or the first frame — the board's own arrival time is the
   * only answer there is, and it is the right one.
   */
  const changedAt = refreshState?.lastChangedAt ?? updatedAt;
  const checkedAt = refreshState?.lastCheckedAt ?? updatedAt;

  return (
    <>
      {/*
        The board, over everything, reading the state this screen already has.

        Mounted from here rather than from the app shell so it dies with the
        Draft screen and can never outlive the refresh loop feeding it. It is
        handed `board` and nothing else: no fetcher, no controller, no way to
        ask Sleeper anything.
      */}
      {boardOpen ? <DraftBoardOverlay board={board} onClose={() => setBoardOpen(false)} /> : null}

      {/*
        The live state, in the bar that does not scroll away.

        The pick number, the round, the roster count and the draft status used
        to occupy a row of stat cards above everything else, which pushed the
        only thing the user is actually reading — the players — most of a screen
        down. Then they became one line, which scrolled off the moment the
        reader moved down the board. They are now the navigation bar's own
        subtitle: same numbers, same board state, no extra height, and on screen
        at pick 40 as well as at pick 3.
      */}
      <NavBar
        testId="draft-nav"
        title={
          /*
            The league, and the way into the board.

            The glyph sits *in* the title line rather than in the bar's actions,
            because it is about this league's draft rather than about this
            screen, and because the actions end is already the refresh control's.
            It costs no row and no height: the button is shorter than the line it
            sits on, so the bar is exactly as tall as it was before this existed.
          */
          <span className="nav-title-row">
            <span className="nav-title-name" data-testid="board-league-name">
              {board.league.name}
            </span>
            <button
              type="button"
              className="title-icon-btn"
              data-testid="draft-board-open"
              aria-label="Open draft board"
              aria-haspopup="dialog"
              aria-expanded={boardOpen}
              onClick={() => setBoardOpen(true)}
            >
              <GridIcon size={15} />
            </button>
          </span>
        }
        subtitle={
          <span className="draft-status" data-testid="draft-status">
            <span className="draft-pick">#{board.currentPick}</span>
            <span>R{board.round}</span>
            <span className={board.onTheClock ? 'draft-turn draft-turn-now' : 'draft-turn'}>
              {board.picksUntilMyTurn == null
                ? '—'
                : board.onTheClock
                  ? 'YOUR PICK'
                  : `${board.picksUntilMyTurn} to go`}
            </span>
            {/*
              Two different facts, one of which is worth a word.

              What the reader wants to know is how old the *board* is — when the
              draft last actually moved — and that is what is printed. When the
              app has just checked and found nothing new, this deliberately does
              not tick over to "just now": a draft where nobody has picked for
              two minutes is two minutes old, and saying otherwise would be the
              app congratulating itself for polling. The moment of the last check
              is carried as an attribute beside it, which is where the probe and
              the tests read it and where it costs the header no pixels.
            */}
            {changedAt != null ? (
              <span
                className="draft-updated"
                data-testid="draft-updated"
                data-checked-age={checkedAt == null ? '' : String(Math.max(0, Math.round((now - checkedAt) / 1000)))}
              >
                {formatShortAge(changedAt, now)}
              </span>
            ) : null}
          </span>
        }
        trailing={
          /*
            Two controls sharing the bar's trailing end, and no new row.

            The row a control costs on this screen is a player, so the sort sits
            beside the refresh glyph rather than above the list. Both are about
            the board as a whole, which is what the trailing end of the
            navigation bar is for; the filter chips below stay about which
            players, which is a different question and keeps its own row.
          */
          <span className="nav-trailing-group">
            <SortControl
              value={sort}
              onChange={setSort}
              /*
                Dimmed in the queue, where the rows are in the reader's order and
                this control is remembering a choice rather than applying one.
              */
              inactive={position === QUEUE_FILTER}
              /*
                The board's own answer, or the rows themselves.

                `dogState` is the better source — it can distinguish "Underdog
                has not priced these players" from "the file was stale and we
                dropped it" — but it is absent on an older deployment, and
                looking at whether any row actually carries a DOG value is the
                honest fallback rather than assuming either way.
              */
              dogAvailable={board.dogState?.available ?? hasDogCoverage(board.recommendations)}
            />
            <button
              type="button"
              className="icon-btn"
              data-testid="draft-refresh"
              aria-label={
                unlocked
                  ? 'Refresh draft from Sleeper'
                  : 'Refresh the board. Unlock in Setup to pull new picks from Sleeper.'
              }
              aria-busy={refreshing}
              disabled={refreshing}
              onClick={() => void refreshNow()}
            >
              <span className={refreshing ? 'icon-spin' : undefined} aria-hidden="true">
                ↻
              </span>
            </button>
          </span>
        }
      />

      {refreshNote ? (
        <div className="draft-refresh-note" data-testid="draft-refresh-note" role="status">
          {refreshNote} Showing the last draft state received.
        </div>
      ) : null}

      {/*
        Behind, and still trying.

        Shown only after the automatic loop has failed twice running, because one
        failed poll on a phone is a tunnel and not a fault, and a line that
        appears every time a lift door closes teaches the reader to ignore it.
        It never replaces the board: the last good state is the most useful thing
        on the screen precisely when the sync is struggling, and an error page
        where the players were would be the worst possible trade mid-draft.

        Suppressed while a manual complaint is up, so a failed tap gets one
        answer rather than two saying the same thing.
      */}
      {refreshState?.stale && !refreshNote && cachedAt == null ? (
        <div className="draft-refresh-note" data-testid="draft-sync-stale" role="status">
          Draft sync delayed · retrying
        </div>
      ) : null}

      {/*
        A board that came out of storage says so, permanently and in the loudest
        tone this screen has.

        Not the quiet "sync delayed" cue above, and not dismissible. That cue is
        about a board the server *did* send falling behind by seconds; this is a
        photograph of the draft taken before the tunnel, and every number under
        it — who is available, the survival percentages, the tier bands — is as
        old as the timestamp says. Somebody reading this without noticing would
        take a player who went three picks ago, which is the single most
        expensive mistake this app can help them make.

        `role="alert"` rather than `status` for the same reason: a screen reader
        should interrupt for this one.
      */}
      {cachedAt != null ? (
        <Notice tone="error" data-testid="draft-offline-capture" role="alert">
          Offline — showing the board as it was {describeAge(Math.max(0, now - cachedAt))}. Picks made since then are
          not in it.
        </Notice>
      ) : null}

      {/*
        Status, not advice.

        This replaces a card that said "3 starting slots still open" and then a
        sentence telling the user to take the best players available — which the
        ranked list underneath is already doing, at length. Slots the league
        does not have never appear, and it updates on the same live roster
        reconstruction as everything else.
      */}
      <RosterProgressLine progress={board.rosterProgress ?? []} />

      {error ? <Notice tone="error">{error}</Notice> : null}
      {board.warnings.map((w) => (
        <Notice key={w}>{w}</Notice>
      ))}

      {/*
        Only the star carries a label. A chip reading "QB" already says what it
        does, and naming it "Filter to QB" would replace a perfectly good
        accessible name with a worse one.
      */}
      {/*
        Search and the filters, on one row.

        During a draft the question is often "where is he" rather than "who is
        best", and the answer used to require scrolling forty rows or knowing to
        star him first. It filters; it does not re-rank, re-score or change who
        is available, and every row keeps its real board rank.

        It is folded into a glyph until it is asked for, because the field was
        costing a whole row of the one screen where a row is a player. Nothing
        about what it matches changed with the fold — see SearchFilterRow.
      */}
      <SearchFilterRow
        value={query}
        onChange={setQuery}
        expanded={searchOpen}
        onExpandedChange={setSearchOpen}
        placeholder="Search the board"
        label="Search the board"
        testId="draft-search"
      >
        <SegmentedControl
          label="Filter by position"
          value={position}
          onChange={setPosition}
          /*
            The queue, everybody, the positions the league starts, then FLX.

            FLX goes last rather than among the positions, because it is not one:
            it is a view spanning three of them, and a chip that reads like a
            position sitting in the middle of the real ones invites exactly the
            confusion this filter must not cause. At the end it reads as what it
            is — the combined view, after the parts. It appears only where it can
            return something; see `offersFlex`, decided from the league's slots.
          */
          segments={[
            QUEUE_FILTER,
            ALL_FILTER,
            ...(board.startablePositions ?? []),
            ...(board.offersFlex ? [FLX_FILTER] : []),
          ].map((p) => ({
            id: p,
            label: p,
            ...(p === QUEUE_FILTER
              ? { ariaLabel: 'Show only your queue', className: 'chip-queue', testId: 'queue-filter' }
              : {}),
            ...(p === FLX_FILTER
              ? { ariaLabel: 'Flex-eligible players: running backs, receivers and tight ends', testId: 'flx-filter' }
              : {}),
          }))}
        />
      </SearchFilterRow>

      {/*
        No heading over the list.

        "RECOMMENDED (40)" cost a line of a phone screen to say what the ranked
        list already says by being ranked. The list keeps its accessible name so
        a screen reader still hears one; sighted readers get the players sooner.
      */}
      {visible.length === 0 ? (
        <Empty>
          {searching
            ? `Nobody available matching “${query.trim()}”.`
            : position === QUEUE_FILTER
              ? 'Your queue is empty. Tap the ☆ beside a player to add them.'
              : 'No available players match this filter.'}
        </Empty>
      ) : (
        <div
          /*
            One grouped surface, and the rows are flush inside it.

            The list had a test id and no class, so it had never been styled as
            a container at all — which is exactly why every row was left being
            its own floating rounded card with its own shadow and a gap under
            it. See `.board-list` in the stylesheet.
          */
          className="board-list"
          role="list"
          aria-label={position === QUEUE_FILTER ? 'Your queue, best first' : 'Available players, best first'}
          data-testid="board-list"
          /*
            Five numbers rather than four, when this board has a fifth.

            The metrics line was fitted to exactly four labelled values, and DOG
            is a genuine fifth. The flag goes on the *list* rather than on the
            rows that happen to carry a DOG value, and that distinction is the
            whole of it: styling only the DOG rows gave the board two card
            heights, 57px and 58px, which the rhythm test correctly rejected.
            One board, one treatment, one height — a row Underdog has not priced
            simply has four numbers in the same slightly tighter line.
          */
          data-dog={board.dogState?.available ? 'yes' : 'no'}
        >
          {visible.map((item, i) => (
            /* The divider goes above the row that opens the tier, not instead of it. */
            <Fragment key={item.rec.playerId}>
              {/*
                The pick count only appears when a market gap is what opened the
                band. A Score break has no distance behind it, and printing one
                would be inventing a number.
              */}
              {item.divider ? (
                <TierDivider gap={item.breakReason === 'market' ? item.rec.tierCliff.tierGapBefore : null} />
              ) : null}
              <RecommendationRow
                rank={item.rank}
                rec={item.rec}
                showCliffProximity={!isSinglePosition}
                horizonPick={board.waitHorizonPick}
                currentPick={board.currentPick}
                marketSource={board.marketSource ?? null}
                scoringLabel={board.league?.scoringLabel ?? null}
                expanded={expanded === item.rec.playerId}
                onToggle={() => setExpanded(expanded === item.rec.playerId ? null : item.rec.playerId)}
                onQueue={setQueued}
                busy={flagging === item.rec.playerId}
                /*
                  The drag, and where this row currently sits because of it.

                  `reorderable` gates the handle; `offset` is how far this row
                  slides to open the gap. Both are absent everywhere but the
                  queue, so every other view renders exactly the row it did
                  before this feature existed.
                */
                reorderable={canReorder}
                onReorderStart={(event) => onPointerDown(event, item.rec.playerId, i)}
                dragging={drag?.playerId === item.rec.playerId}
                offset={
                  drag == null
                    ? 0
                    : drag.playerId === item.rec.playerId
                      ? drag.deltaY
                      : rowOffset({
                          index: i,
                          fromIndex: drag.fromIndex,
                          toIndex: drag.toIndex,
                          rowHeight: drag.rowHeight,
                        })
                }
              />
            </Fragment>
          ))}
        </div>
      )}
    </>
  );
}

/** What a drag is doing right now, or null when nothing is being dragged. */
interface DragState {
  playerId: string;
  fromIndex: number;
  toIndex: number;
  /** How far the finger has travelled, in pixels, signed downward. */
  deltaY: number;
  rowHeight: number;
}

/**
 * Long-press to pick a player up, drag to move him, release to keep it.
 *
 * Available inside the ★ filter and nowhere else, and that restriction is the
 * whole design rather than a limitation. The queue is an explicit preference —
 * a list the reader built — so an order imposed on it is theirs to change. Every
 * other view of this board is ranked by the model, and a drag there would be
 * asking the reader to rearrange a conclusion, which would then be silently
 * discarded on the next refresh.
 *
 * Three properties that took some care:
 *
 *  - **Scrolling still wins.** The press has to be held for half a second
 *    without moving before it becomes a drag. A finger that moves first is
 *    scrolling and the timer is abandoned — permanently, so a slow scroll
 *    cannot turn into a drag halfway down.
 *  - **The order is applied optimistically and confirmed after.** A drag that
 *    waited for a round trip before redrawing would feel broken on a phone
 *    mid-draft; a drag whose result the server rejected would be worse. So the
 *    list moves immediately and the server's answer replaces it, which is
 *    almost always the same list.
 *  - **It never touches a ranking.** The gesture produces an index. What that
 *    index means is decided by `reorderQueue` in core, which operates on ids
 *    and ranks and has no access to a Score at all.
 */
function useQueueDrag({
  enabled,
  ids,
  onCommit,
}: {
  enabled: boolean;
  ids: string[];
  onCommit: (playerId: string, toIndex: number, optimistic: string[]) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  /*
   * The same drag, readable synchronously.
   *
   * `end` needs to know where the row was dropped, and the obvious way to get
   * it — reading the state inside a `setDrag` updater and committing from
   * there — is wrong twice over. An updater must be pure, and under StrictMode
   * React deliberately calls it twice, so the commit would fire two reorder
   * requests for one drop every time in development. The ref is the honest
   * version: the updater only ever returns the next state, and the side effect
   * reads what it needs from outside it.
   */
  const dragRef = useRef<DragState | null>(null);
  /*
   * The live gesture, readable from event handlers that were registered once.
   *
   * Registering `pointermove` on every render would mean re-binding on every
   * frame of a drag, which drops moves; keeping the state in a ref means the
   * listeners are bound at the start of a gesture and torn down at the end.
   */
  const gesture = useRef<{
    playerId: string;
    fromIndex: number;
    startY: number;
    rowHeight: number;
    startedAt: number;
    timer: number | null;
    active: boolean;
    abandoned: boolean;
  } | null>(null);
  const idsRef = useRef(ids);
  idsRef.current = ids;

  /** Write the drag through both the ref and the state, so they cannot drift. */
  const applyDrag = useCallback((next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const end = useCallback(
    (commit: boolean) => {
      const current = gesture.current;
      const state = dragRef.current;
      gesture.current = null;
      if (current?.timer != null) window.clearTimeout(current.timer);
      applyDrag(null);
      if (commit && state && current?.active && state.toIndex !== state.fromIndex) {
        onCommit(state.playerId, state.toIndex, moveItem(idsRef.current, state.fromIndex, state.toIndex));
      }
    },
    [applyDrag, onCommit],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent, playerId: string, index: number) => {
      if (!enabled) return;
      // A secondary button, a pinch, or anything that is not a single primary
      // pointer is not a reorder.
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      const row = (event.currentTarget as HTMLElement).closest('[data-testid="recommendation-row"]');
      const rowHeight = row instanceof HTMLElement ? row.getBoundingClientRect().height : 0;
      if (rowHeight <= 0) return;

      const timer = window.setTimeout(() => {
        const current = gesture.current;
        if (!current || current.abandoned) return;
        current.active = true;
        applyDrag({ playerId, fromIndex: index, toIndex: index, deltaY: 0, rowHeight });
        // A short tick when the row is picked up, where the platform offers one.
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);

      gesture.current = {
        playerId,
        fromIndex: index,
        startY: event.clientY,
        rowHeight,
        startedAt: Date.now(),
        timer,
        active: false,
        abandoned: false,
      };
    },
    [applyDrag, enabled],
  );

  useEffect(() => {
    if (!enabled) return;

    const onMove = (event: PointerEvent) => {
      const current = gesture.current;
      if (!current) return;
      const deltaY = event.clientY - current.startY;

      if (!current.active) {
        // Still deciding. Movement before the hold elapses means a scroll, and
        // that verdict is final.
        const verdict = pressVerdict({
          heldMs: Date.now() - current.startedAt,
          movedPx: Math.abs(deltaY),
        });
        if (verdict === 'scroll') {
          current.abandoned = true;
          if (current.timer != null) window.clearTimeout(current.timer);
          gesture.current = null;
        }
        return;
      }

      /*
       * The drag owns the movement now, so the page must not also scroll with
       * it. `touch-action: none` on the row is what actually makes this
       * cancellable — without it the browser has already committed the gesture
       * to scrolling and this call does nothing but log a warning.
       */
      if (event.cancelable) event.preventDefault();
      const state = dragRef.current;
      if (state == null) return;
      applyDrag({
        ...state,
        deltaY,
        toIndex: targetIndex({
          fromIndex: state.fromIndex,
          deltaY,
          rowHeight: state.rowHeight,
          count: idsRef.current.length,
        }),
      });
    };

    const onUp = () => end(true);
    const onCancel = () => end(false);

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [applyDrag, enabled, end]);

  return { drag, onPointerDown };
}

/**
 * Score / ADP / DOG, in the space a control has beside the refresh glyph.
 *
 * Three words, because three words is what the three orderings need and any
 * fewer would be a puzzle: `S / A / D` saves nine characters and costs the
 * reader the meaning. It is a radio group rather than a cycle button — a cycle
 * would hide two of the three states and make "which order am I looking at"
 * a thing to remember rather than a thing to see.
 *
 * The DOG chip stays visible when Underdog has priced nobody, and says so in
 * its accessible name rather than vanishing. A control that disappears when a
 * data source is down teaches the reader that the feature is unreliable; one
 * that explains itself teaches them what is actually wrong.
 */
function SortControl({
  value,
  onChange,
  dogAvailable,
  inactive,
}: {
  value: SortMode;
  onChange: (mode: SortMode) => void;
  dogAvailable: boolean;
  /**
   * True in the ★ queue, where the reader's own order is what the list is in.
   *
   * Dimmed rather than removed, and still operable: the mode stays selectable
   * so that leaving the queue puts them on the board they meant to be reading.
   * What it must not do is *look* like it is ordering the rows underneath it,
   * because it is not — that is the whole of this regression, expressed in the
   * one place a reader could have noticed it.
   */
  inactive: boolean;
}) {
  return (
    <span
      className="sort-control"
      role="radiogroup"
      aria-label={inactive ? 'Sort the board — your queue keeps the order you set' : 'Sort the board'}
      data-testid="draft-sort"
      data-inactive={inactive ? 'yes' : 'no'}
    >
      {SORT_MODES.map((mode) => {
        const unavailable = mode === 'dog' && !dogAvailable;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            className="sort-chip"
            aria-checked={value === mode}
            data-testid={`sort-${mode}`}
            data-active={value === mode ? 'yes' : 'no'}
            aria-label={
              inactive
                ? `${SORT_DESCRIPTIONS[mode]}. Not applied in your queue, which stays in the order you set.`
                : unavailable
                  ? 'Sort by raw Underdog ADP. No Underdog ADP is currently available.'
                  : SORT_DESCRIPTIONS[mode]
            }
            onClick={() => onChange(mode)}
          >
            {SORT_LABELS[mode]}
          </button>
        );
      })}
    </span>
  );
}

/**
 * Slot names short enough to sit six-across on a 360px phone.
 *
 * Only the ones whose Sleeper spelling is too long to print. Anything not named
 * here — `QB`, `RB`, `WR`, `TE`, `DEF`, `BN` — is already as short as it gets
 * and passes through unchanged, so a league with an unusual slot still shows
 * its real name rather than a blank.
 */
const SLOT_LABELS: Record<string, string> = {
  FLEX: 'FLX',
  SUPER_FLEX: 'SFLX',
  WRRB_FLEX: 'W/R',
  REC_FLEX: 'W/T',
  WRRB_WRT: 'FLX',
  IDP_FLEX: 'IDP',
};

/**
 * One line: how much of a starting lineup you have, and how much of a bench.
 *
 * `0/1 QB · 1/2 RB · 3/3 WR · 0/1 TE · 0/2 FLX · 0/6 BN`, from the league's own
 * roster settings and the live pick stream. Deliberately status only — the
 * ranked list below is where "so take a receiver" belongs, and saying it twice
 * in different words is how a draft screen fills up with prose.
 *
 * The bench number is the one that needs saying out loud, because "how much
 * room is left" is a different question from "what is missing" and the line
 * only answered the second. Both come from one allocation in `liveRoster`, so
 * no player can be counted in both.
 */
function RosterProgressLine({ progress }: { progress: SlotProgress[] }) {
  if (progress.length === 0) return null;
  return (
    <div className="roster-progress" data-testid="roster-progress">
      {progress.map((slot) => {
        const label = SLOT_LABELS[slot.slot] ?? slot.slot;
        const classes = ['slot'];
        if (slot.filled >= slot.required) classes.push('slot-done');
        if (slot.bench) classes.push('slot-bench');
        return (
          <span
            key={slot.slot}
            className={classes.join(' ')}
            data-slot={slot.slot}
            title={
              slot.bench
                ? `${slot.filled} of ${slot.required} bench spot${slot.required === 1 ? '' : 's'} used`
                : `${slot.filled} of ${slot.required} ${slot.slot} starting slot${slot.required === 1 ? '' : 's'} filled`
            }
          >
            <strong>
              {slot.filled}/{slot.required}
            </strong>{' '}
            {label}
          </span>
        );
      })}
    </div>
  );
}

/** A row to draw, and whether a tier boundary falls immediately above it. */
interface BoardItem {
  rec: DraftRecommendation;
  rank: number;
  divider: boolean;
  breakReason: TierBreak | null;
}

/**
 * The rows in the order the board chose, each told whether a tier boundary
 * falls above it.
 *
 * **The order is never touched here.** Whichever sort the reader picked —
 * Score, ADP, DOG — decides who appears where, and a tier is an annotation on
 * that sequence. This function may insert a line between two adjacent rows; it
 * may not move a row.
 *
 * That is a correction. This used to reorder the board into tier bands, to make
 * a divider's claim literally true: everything above the line is one tier. The
 * claim was true and the board was wrong. On the reported tight-end board it
 * put Kenyon Sadiq (Score 68) above Juwan Johnson and Chig Okonkwo (both 83),
 * because the market clustered him higher — so the screen contradicted its own
 * ranking, in the one view whose entire job is to say who to draft. A reader
 * comparing two numbers on screen should never have to know which of them the
 * layout secretly outranked.
 *
 * So the divider now says something weaker and true: *the market's next tier
 * starts here*. The rows above it are the rows the sort put above it, which is
 * what the reader is looking at anyway.
 *
 * Off entirely on the mixed board, where there is no single position for a
 * boundary to be about.
 */
function withTierDividers(recs: DraftRecommendation[], enabled: boolean): BoardItem[] {
  if (!enabled) return recs.map((rec, i) => ({ rec, rank: i + 1, divider: false, breakReason: null }));
  return annotateTiers(
    recs,
    (rec) => rec.tierCliff.tierIndex,
    (rec) => rec.score,
  ).map(({ row, rank, divider, breakReason }) => ({ rec: row, rank, divider, breakReason }));
}

/**
 * The break itself: a hairline and two words.
 *
 * It is a `listitem` rather than a decoration because it is information — a
 * screen reader that skipped it would hear one undifferentiated run of players
 * — and because a `list` may not contain anything else.
 */
function TierDivider({ gap }: { gap: number | null }) {
  return (
    <div className="tier-divider" role="listitem" data-testid="tier-divider">
      <span className="tier-divider-label">
        Tier drop
        {gap == null ? null : <span className="tier-divider-gap"> ~{Math.round(gap)} picks</span>}
      </span>
    </div>
  );
}

/**
 * One recommendation.
 *
 * The header is the button and the detail is its sibling rather than its child:
 * the expanded view contains its own controls (Advanced, Show all reasons), and
 * a button may not contain buttons.
 */
/**
 * How hard the line has to be squeezed to keep every number on it.
 *
 * Measured rather than chosen: four quantities need 332px, five need 345, and
 * the row offers 315 at 360px and 330 at 375. `yes` rescues four, `max`
 * rescues five, and a line of three or fewer needs neither.
 */
function densityOf(components: number): 'no' | 'yes' | 'max' {
  if (components >= 5) return 'max';
  return components >= 4 ? 'yes' : 'no';
}

/**
 * The market line's own tooltip: what each number is, spelled out.
 *
 * Null when there is nothing to add — a line of single-market numbers already
 * says what it is, and a tooltip repeating the text under the text is noise.
 * It earns its place only where the card shows a quantity this app composed.
 */
function marketLineTitle(rec: DraftRecommendation): string | undefined {
  const props = rec.marketProps;
  if (!props || !props.derived) return undefined;
  return props.components
    .map((c) =>
      c.derived
        ? `${c.text} = ${c.parts.map((p) => `${p.line} ${seasonMarketLabel(p.market)}`).join(' + ')}`
        : `${c.text} — ${seasonMarketLabel(c.parts[0]!.market)}`,
    )
    .join('; ');
}

/**
 * The raw numbers the compact row's deltas were made from — one line.
 *
 * The row says `ADP +6` because it is answering "what does taking him here cost
 * me against this market", which is the decision. This is the working: both
 * markets' own positions, the pick they were measured against, and the value
 * column the row no longer prints. A reader who wants to check the arithmetic
 * can, and a reader who wants the raw market position — to compare against
 * somewhere else, or because they think in ADP — still has it.
 *
 * It sits in the expanded card's resting state, above the disclosure, because
 * it is the working for a number the reader has just tapped and one line is
 * what it costs. The rest of the market — what the points are made of, who
 * priced them — is provenance rather than working, and lives behind the card's
 * one control.
 *
 * Nothing is computed here; every number is one the board already sent.
 */
function MarketRaw({
  rec,
  currentPick,
}: {
  rec: DraftRecommendation;
  /** The pick the row's deltas were measured against, printed as the working. */
  currentPick: number | null;
}) {
  if (rec.adp == null && rec.dogAdp == null) return null;
  return (
    <div className="market-raw" data-testid="market-raw">
      <span className="metric">
        Sleeper ADP <strong>{rec.adp == null ? <Unknown what="Sleeper ADP" /> : rec.adp}</strong>
      </span>
      {rec.dogAdp == null ? null : (
        <span className="metric" data-testid="market-raw-dog">
          DOG ADP <strong>{rec.dogAdp}</strong>
        </span>
      )}
      {currentPick == null ? null : (
        <span className="metric">
          Pick <strong>{currentPick}</strong>
        </span>
      )}
      <span className="metric">
        Val{' '}
        <strong
          className={rec.adpValue == null ? '' : rec.adpValue > 0 ? 'sig-pos' : rec.adpValue < 0 ? 'sig-neg' : ''}
        >
          {rec.adpValue == null ? <Unknown what="value" /> : `${rec.adpValue > 0 ? '+' : ''}${rec.adpValue}`}
        </strong>
      </span>
    </div>
  );
}

/**
 * Where the `MKT` line's numbers came from.
 *
 * The card has room for the quantities and not for their provenance, so the
 * provenance lives here — and it has to live somewhere, because two of those
 * quantities are sums this app performed rather than lines a book published.
 * Every component names the markets behind it and the line each contributed;
 * anything the sum wanted and did not have is named as absent rather than
 * quietly counted as nothing; and the snapshot says who priced it and when.
 */
function MarketProvenance({
  rec,
  source,
  scoringLabel,
}: {
  rec: DraftRecommendation;
  source: DraftBoard['marketSource'];
  /** The league's own scoring, which is what turned lines into points. */
  scoringLabel: string | null;
}) {
  const props = rec.marketProps;
  if (!props || props.components.length === 0) return null;

  const baseline = rec.marketBaseline;

  return (
    <div className="market-detail" data-testid="market-detail">
      <DetailLabel>Market</DetailLabel>
      {/*
        The market-implied points, said in full before the components it is
        made of.

        Three facts, and the second two are what stop the first from being a
        projection wearing a market's clothes: how much of what this position
        scores on actually had a market, and whose scoring turned the lines into
        points. A number labelled `pts` without the league behind it would mean
        something different in every league that read it.
      */}
      {baseline?.points == null ? null : (
        <div className="market-points" data-testid="market-points">
          <strong>
            MKT PTS {baseline.missing.length > 0 ? '~' : ''}
            {baseline.points}
          </strong>{' '}
          <span className="muted">
            {Math.round(baseline.coverage * 100)}% of what a {rec.position} scores on had a market
            {scoringLabel ? `, converted at this league's scoring (${scoringLabel})` : ''}.{' '}
            {baseline.missing.length > 0
              ? 'Missing markets are left out rather than counted as nothing, so the total is a floor.'
              : ''}
          </span>
        </div>
      )}
      {/*
        And whether that number is a good one, which is the question a reader
        actually has at a draft.

        Two markets, both already in the Score as separate components, put on
        one positional scale so their disagreement can be read rather than
        guessed at. No weighting maths is shown: the sentence says what the
        markets think of him, not what the model did about it.
      */}
      {rec.marketStrategy ? (
        <div className="market-strategy" data-testid="market-strategy" data-kind={rec.marketStrategy.kind}>
          {rec.marketStrategy.standing}
          {rec.marketStrategy.disagreement ? ` · ${rec.marketStrategy.disagreement}` : ''}
          {rec.marketStrategy.caveat ? ` · ${rec.marketStrategy.caveat}` : ''}
        </div>
      ) : null}
      <ul className="market-components">
        {props.components.map((c) => (
          <li key={c.label} data-testid="market-component" data-derived={c.derived ? 'yes' : 'no'}>
            <strong>{c.text}</strong>{' '}
            <span className="muted">
              {c.derived
                ? `— ${c.parts.map((p) => `${p.line} ${seasonMarketLabel(p.market)}`).join(' + ')}, added here rather than quoted as one market`
                : `— ${seasonMarketLabel(c.parts[0]!.market)}${
                    c.parts[0]!.bookCount ? ` across ${c.parts[0]!.bookCount} books` : ''
                  }`}
              {c.missing.length > 0
                ? `. No market for ${c.missing.map(seasonMarketLabel).join(' or ')}, which is why this is not a total.`
                : ''}
            </span>
          </li>
        ))}
      </ul>
      {source ? (
        <div className="muted market-source" data-testid="market-source">
          {source.provider} · {source.season} season · fetched {new Date(source.fetchedAt).toLocaleDateString()}
        </div>
      ) : null}
    </div>
  );
}

function RecommendationRow({
  rank,
  rec,
  expanded,
  showCliffProximity,
  horizonPick,
  /**
   * The pick on the clock, straight from the board.
   *
   * The market deltas are measured against this and nothing else — not the
   * row's rank, not the reader's next turn, not a cached copy. See
   * `marketDelta.ts`.
   */
  currentPick,
  marketSource,
  scoringLabel,
  onToggle,
  onQueue,
  busy,
  reorderable = false,
  onReorderStart,
  dragging = false,
  offset = 0,
}: {
  rank: number;
  rec: DraftRecommendation;
  expanded: boolean;
  /** Mixed-position boards tag the last of a tier; filtered ones draw the line. */
  showCliffProximity: boolean;
  /** The pick survival is measured against — your next one after this. */
  horizonPick: number | null;
  /** The pick on the clock, which the market deltas are measured against. */
  currentPick: number | null;
  /** Who priced the season markets, for the expanded card's provenance. */
  marketSource: DraftBoard['marketSource'];
  /** The league's own scoring label, which is what `MKT PTS` was converted at. */
  scoringLabel: string | null;
  onToggle: () => void;
  onQueue: (playerId: string, queued: boolean) => void;
  busy: boolean;
  /** True only inside the ★ filter, where the order is the reader's own. */
  reorderable?: boolean;
  onReorderStart?: (event: React.PointerEvent) => void;
  dragging?: boolean;
  /** How far this row is drawn from where it normally sits, mid-drag. */
  offset?: number;
}) {
  const pos = (rec.position ?? '').toUpperCase();
  return (
    <div
      className={positionCardClass(pos, expanded ? 'player-row-open' : '')}
      data-testid="recommendation-row"
      data-player-id={rec.playerId}
      data-position={pos}
      data-dragging={dragging ? 'yes' : undefined}
      /*
       * Mid-drag the rows are drawn where the gesture puts them.
       *
       * A transform rather than a reflow, so moving a row costs the compositor
       * a paint and costs the layout engine nothing — which is what keeps a
       * drag at sixty frames on a list of two hundred. The transition is
       * suppressed on the row under the finger, because that one must track the
       * finger exactly rather than easing toward it.
       */
      style={
        offset === 0
          ? undefined
          : {
              transform: `translateY(${offset}px)`,
              transition: dragging ? 'none' : 'transform 160ms ease',
              zIndex: dragging ? 2 : undefined,
              position: 'relative',
            }
      }
      role="listitem"
    >
      <button className="row-button" aria-expanded={expanded} onClick={onToggle}>
        <div className="player-row-top">
          {/*
            The grip, inside the queue only.

            It replaces the rank number rather than sitting beside it: on the
            queue the position in the list *is* the rank, so a separate numeral
            was saying the same thing twice — and a phone row has no spare
            column. `touch-action: none` is what actually lets the drag cancel
            the scroll; without it the browser has already committed the gesture
            by the time the first move arrives.
          */}
          {reorderable ? (
            <span
              className="drag-handle"
              data-testid="queue-drag-handle"
              aria-hidden="true"
              style={{ touchAction: 'none' }}
              onPointerDown={onReorderStart}
              /* The row underneath is a toggle; picking it up is not opening it. */
              onClick={(event) => event.stopPropagation()}
            >
              ⠿
            </span>
          ) : (
            <span className="rank">{rank}</span>
          )}
          <QueueControl queued={rec.queued} busy={busy} onChange={(queued) => onQueue(rec.playerId, queued)} />
          <span className="player-name">{rec.name}</span>
          {/*
            The tally, beside the name it is about.

            It used to be a fifth column of the metrics row reading "▲ +6 pos",
            which spent three tokens and a third of the line on a number. Up
            here it is one token attached to the player, and the row below is
            free for the four numbers that describe the decision.
          */}
          {/*
            The tally and the availability tag share one fixed-width field, so
            the club's mark after them lands on the same edge on every row —
            see `--row-meta`. Both are still exactly what they were; only the
            box around them is new.
          */}
          <span className="player-row-meta">
            <CompactTally net={rec.newsLifetimeNet} label="Lifetime research tally" />
            <InjuryTag status={rec.status} />
          </span>
          <PositionBadge position={rec.position} team={rec.team} />
        </div>

        {/*
          No tag row at all any more.

          Take Now, Risky to Wait and Can Probably Wait went first: they were on
          nearly every card, which made a row of chips that told the reader
          nothing, and the chance he reaches your next pick is a number that does
          the same job in less space. AVOID has now followed them, and for a
          related reason — it said out loud what the signed tally beside the name
          already says. `-5` is the reading; `⚠ AVOID — lifetime tally -5` was
          the same reading, in a red chip, costing a line of every card it landed
          on. The reader interprets the number directly.

          **Nothing about the recommendation changed.** The tally is still
          computed and still shown, the lifetime threshold still exists, and the
          bounded penalty the engine applies below it is untouched — see
          core/draft/decisions.ts. This removed a label, not a judgement.
        */}

        {/*
          Four numbers, four different questions, in the order they are asked.

          Score is how strongly this app recommends him; ADP is where the market
          takes him; Val is the difference between the market and this pick; Next
          is whether he survives to your following turn. The labels are short
          because at 360px four labelled numbers is exactly what one line holds —
          `Value` and `Next pick` cost the fourth column its space.
        */}
        {/*
          What the badge cannot fit: the body part, and how the week went. Shown
          only when the report added something `Q` alone does not say, so most
          rows still carry nothing at all.
        */}
        {rec.injuryLine ? (
          <div className="injury-line" data-testid="injury-line">
            {rec.injuryLine}
          </div>
        ) : null}

        {/*
          The bottom of the card: the four numbers on the left, and whatever
          warning belongs to the right-hand end of that same line.

          A grid of `1fr auto` rather than a third row. The numbers take the
          space they need and the chip takes the space it needs, so the two can
          never land on top of each other — and a card with a warning is exactly
          as tall as a card without one, which is the whole point. Before this,
          a tier cliff cost a line, and because cliffs arrive in runs the board
          gained a stutter wherever a position was thinning out.
        */}
        <div className="player-row-bottom">
          <div className="player-row-metrics">
            <span className="metric" data-testid="score-metric">
              Score{' '}
              <strong
                className="score-value"
                title={
                  rec.score == null
                    ? `No market has priced him, so his composite (raw ${rec.total}) is not comparable with a priced player's`
                    : `Composite recommendation strength, 0-100 (raw ${rec.total})`
                }
              >
                {/*
                  A dash rather than a number, for the same reason ADP, Val and
                  Next already show one on this row: the composite is real but
                  it is not on the priced players' scale, because the component
                  that dominates that scale is missing rather than low.
                */}
                {rec.score == null ? <Unknown what="Score" /> : rec.score}
              </strong>
            </span>
            {/*
              What each market says about taking him *right now*, rather than
              where each market has him.

              These were two raw positions and a value column — `ADP 170  DOG
              145.1  Val -6` — and all three asked the reader to subtract
              against the pick on the clock before any of them meant anything.
              The board does the subtraction: `+6` is six picks ahead of that
              market and costs you, `-19` is nineteen picks past it and is the
              reason to take him. Three columns become two and the row reads in
              one pass.

              Nothing about the model moved. `rec.adp`, `rec.dogAdp` and
              `rec.adpValue` are all still computed, still sent, and still what
              the sort controls sort on — only the compact row's rendering
              changed, and the raw numbers are on the expanded card underneath.
            */}
            <MarketDeltaMetric label="ADP" marketAdp={rec.adp} currentPick={currentPick} source="Sleeper" />
            {/*
              Absent rather than blank when Underdog has not priced him, so a
              card costs nothing for a player the source does not cover and the
              line stays the height it always was.
            */}
            {rec.dogAdp == null ? null : (
              <MarketDeltaMetric
                label="DOG"
                marketAdp={rec.dogAdp}
                currentPick={currentPick}
                source="Underdog"
                testId="dog-metric"
                note={rec.marketDisagreement?.note ?? null}
              />
            )}
            <SurvivalMetric probability={rec.survivalProbability} horizonPick={horizonPick} />
          </div>

          <TierCliffChip rec={rec} enabled={showCliffProximity} />
        </div>

        {/*
          What the market expects of him this season, in the market's own units.
          One line, no prices, no book names, no over/under language — this is
          information about expected production, not an invitation to bet. It
          appears only when a real line exists; an empty placeholder would cost
          the same space and say nothing.
        */}
        {rec.marketHeadline ? (
          <div
            className="market-line"
            data-testid="market-line"
            /*
              A quantity this app summed is flagged on the element rather than
              decorated in the text. The label already refuses to lie — a
              receiver priced on receiving yards alone reads `rec yd`, never
              `scrim yd` — and the expanded card prints the components. This is
              what lets a test assert the distinction without a glyph competing
              for the width the fourth number needs.
            */
            data-derived={rec.marketProps?.derived ? 'yes' : 'no'}
            /*
              Four quantities need 338px and a 360px phone offers 315, so a
              quarterback's line was being ellipsised at exactly the number
              this line was widened to carry. `data-dense` is what the
              stylesheet tightens; it is set from the component count rather
              than from the position, because the width problem is the count.
            */
            data-dense={densityOf(rec.marketProps?.components.length ?? 0)}
            title={marketLineTitle(rec)}
          >
            <span className="market-label">MKT</span>
            {/*
              Components as elements, not as a joined string.

              The separator becomes the stylesheet's problem rather than three
              characters of the text, which is where the width to fit a fourth
              number comes from. `marketHeadline` is still the contract and is
              still what an older client renders.
            */}
            {rec.marketProps ? (
              rec.marketProps.components.map((c, i) => (
                /*
                  `data-rank` is what the stylesheet drops when the row runs out
                  of width, in the order the brief sets: the points total first
                  because it is the one number that compares across positions,
                  then receptions, then the yardage, then the touchdowns. A
                  component removed this way is removed deliberately and is
                  still in the expanded card — the alternative was an ellipsis
                  deciding it, which hides whichever component happens to be
                  last rather than whichever matters least.
                */
                <span
                  className="market-part"
                  key={c.label}
                  data-rank={i + 1}
                  data-derived={c.derived ? 'yes' : 'no'}
                  data-partial={c.missing.length > 0 ? 'yes' : 'no'}
                >
                  {c.text}
                </span>
              ))
            ) : (
              <span className="market-part">{rec.marketHeadline}</span>
            )}
          </div>
        ) : null}
      </button>

      {/*
        The reveal, in place and at a native speed.

        The row above it does not move and the page does not jump: only this
        card's own height changes, so whatever the reader was looking at stays
        under their thumb. Nothing is fetched until the card is actually opened
        — see usePlayerDetail — so animating the reveal costs one card's work
        and never forty.
      */}
      <Disclose open={expanded}>
        <DraftPlayerDetail rec={rec} marketSource={marketSource} scoringLabel={scoringLabel} currentPick={currentPick} />
      </Disclose>
    </div>
  );
}

/**
 * The expanded player: a preview the height of two rows, and one way in.
 *
 * It has been cut three times, and each cut answered a different question. The
 * first removed the grid of restated numbers. The second removed the ranking
 * rationale — the bullets under "Why this rank", the counterpoint, the
 * component arithmetic — because all three explained a position the reader can
 * already see. This one is about *height*: what survived those cuts still ran
 * to eight or nine times a collapsed row, which pushes the rest of the board
 * off a phone. Opening a player should not cost you the board you opened him
 * from.
 *
 * So the card now rests at four things — where his position is breaking, the
 * raw markets behind the row's deltas, two lines of outlook, and last season on
 * one line — and everything else is behind a single control. One control, not
 * one per section: a card with three "more" links is a card the reader has to
 * shop in, and the whole point is that a draft pick is a thirty-second
 * decision.
 *
 * What that control reveals is not new and not summarised — it is the same
 * newsletter takeaway, market provenance, injury detail and profile flags this
 * card has always drawn, plus the outlook at full length, all from
 * `components/playerDetail.tsx`, which every other screen also uses. Nothing
 * was deleted to make the card short; it was moved one tap further in.
 *
 * The rationale is still not rendered anywhere here. The board response carries
 * every reason, counterpoint, component, weight and contribution, and the
 * engine still computes them.
 */
function DraftPlayerDetail({
  rec,
  marketSource,
  scoringLabel,
  currentPick,
}: {
  rec: DraftRecommendation;
  marketSource: DraftBoard['marketSource'];
  scoringLabel: string | null;
  /** The pick the compact row's market deltas were measured against. */
  currentPick: number | null;
}) {
  const { detail, failed } = usePlayerDetail(rec.playerId);
  /*
   * Resets itself, because `Disclose` unmounts this component a moment after
   * the row closes. A player reopened is a player looked at afresh, and a card
   * that remembered being fully open would reopen at nine rows tall.
   */
  const [everything, setEverything] = useState(false);

  return (
    <div className="explain explain-compact" data-testid="player-detail" data-everything={everything ? 'yes' : 'no'}>
      {/*
        The one piece of ranking context that survives, because it is a fact
        about the board rather than about the model: where this position breaks,
        how many are left before it does, and whether the teams picking before
        you still need one. Absent whenever the tier is ordinary — most of the
        time — which is what keeps it from becoming wallpaper.
      */}
      {rec.tierContext ? (
        <div className="tier-context" data-testid="tier-context">
          {rec.tierContext}
        </div>
      ) : null}

      {/*
        The working for the deltas on the row above, one line, always shown.
        The provenance behind it is a different question and waits below.
      */}
      <MarketRaw rec={rec} currentPick={currentPick} />
      {/*
        Two lines by default — clamped in the stylesheet rather than cut here,
        so the text is whole and the truncation is the browser's, with the
        ellipsis that says so. `everything` hands it the full version.
      */}
      <SeasonOutlook detail={detail} failed={failed} heading={everything} whole={everything} />

      {everything ? (
        <>
          {/*
            Why the tally reads the way it does. Below the outlook now rather
            than above it: at rest the card is a snapshot, and once the reader
            has asked for everything the order is the reading order.
          */}
          <NewsletterTakeaway detail={detail} />
          <MarketProvenance rec={rec} source={marketSource} scoringLabel={scoringLabel} />
          <InjuryDetail detail={detail} />
          <ProfileFlags detail={detail} />
        </>
      ) : null}

      {/*
        Last season and the way in, sharing a line.

        Two short things that both belong at the bottom, and stacking them
        spends a row of the card on air. The stat line is left, the control is
        right, which is the arrangement every grouped list on this phone already
        uses for "here is the summary, here is the way in".
      */}
      <div className="detail-foot">
        <LastSeasonLine detail={detail} failed={failed} position={rec.position} compact />
        <button
          type="button"
          className="link-button detail-more"
          data-testid="detail-more"
          aria-expanded={everything}
          onClick={(e) => {
            // The row underneath is a toggle; asking for the rest of the card
            // is not "collapse this player".
            e.stopPropagation();
            setEverything((v) => !v);
          }}
        >
          {everything ? 'Show less' : 'Full detail'}
        </button>
      </div>
    </div>
  );
}

/**
 * The chance he is still there when you pick again.
 *
 * `horizonPick` is your next selection *after* the one on the clock, which is
 * the only reading of "next pick" that means anything while you are choosing:
 * asking whether a player available now is available now is true of everybody.
 * It is named in the tooltip so nobody has to work out which pick was meant.
 */
function SurvivalMetric({ probability, horizonPick }: { probability: number | null; horizonPick: number | null }) {
  const band = survivalBand(probability);
  if (probability == null) {
    return (
      <span className="metric">
        Next <Unknown what="survival" />
      </span>
    );
  }
  const pct = Math.round(probability * 100);
  return (
    <span className="metric" data-testid="survival">
      Next{' '}
      <strong
        className={`survival survival-${band}`}
        data-band={band}
        title={
          horizonPick == null
            ? `${pct}% chance he is still available at your next pick`
            : `${pct}% chance he is still available at pick ${horizonPick}, your next one after this`
        }
      >
        {pct}%
      </strong>
    </span>
  );
}

/**
 * His group is nearly gone, said at the end of the line that is already there.
 *
 * The warning itself is unchanged — same rule, same threshold, same one-away
 * and two-away wording, computed by `tierCliffProximity` over the same tier
 * model. What changed is where it is drawn: it used to open a row of its own
 * above the metrics, which made every card carrying it a line taller than the
 * cards either side. Cliffs do not arrive alone — a thinning position tags a
 * run of consecutive players — so that cost showed up as a stutter in the
 * board's rhythm exactly where the reader most needs to compare rows.
 *
 * It is quiet on purpose. The reader's eye should still land on the name, then
 * the numbers; this is a note in the margin of a line they are already reading.
 *
 * Absent rather than empty when there is no cliff, so the grid column collapses
 * and an unwarned card spends nothing on it.
 */
/**
 * One market's consequence, as one column of the compact row.
 *
 * The label, the signed number, and a tone the stylesheet paints — nothing
 * else. `data-tone` is the contract a test reads, deliberately in preference to
 * a colour: what "reach" looks like is the design's business and may change,
 * but that a positive delta *is* a reach is the semantics and may not.
 *
 * An unknown market prints the app's own unknown mark rather than a zero. Zero
 * is the claim "he is going at about this market", which is a real reading and
 * a different one.
 */
function MarketDeltaMetric({
  label,
  marketAdp,
  currentPick,
  source,
  testId,
  note,
}: {
  /** What the column is called on the row: `ADP` or `DOG`. */
  label: string;
  marketAdp: number | null;
  /** The pick on the clock, from the board itself. Never derived from a row. */
  currentPick: number | null;
  /** Whose market it is, for the sentence in the title. */
  source: string;
  testId?: string;
  /** Anything the board wants to say about this market, kept in the title. */
  note?: string | null;
}) {
  const delta = marketDelta(marketAdp, currentPick);
  return (
    <span
      className="metric"
      {...(testId ? { 'data-testid': testId } : { 'data-testid': 'adp-metric' })}
      data-tone={delta?.tone ?? 'unknown'}
    >
      {label}{' '}
      {delta == null || marketAdp == null || currentPick == null ? (
        <Unknown what={`${source} ADP`} />
      ) : (
        <strong
          className={`delta delta-${delta.tone}`}
          title={note ?? marketDeltaTitle(source, marketAdp, currentPick, delta)}
        >
          {delta.label}
        </strong>
      )}
    </span>
  );
}

function TierCliffChip({ rec, enabled }: { rec: DraftRecommendation; enabled: boolean }) {
  const warning = enabled ? tierCliffWarning(rec.tierCliff) : null;
  if (warning == null) return null;
  return (
    <span
      className="player-row-cliff"
      data-testid="tier-cliff-tag"
      data-remaining={warning.remaining}
      /*
       * The whole sentence, always, for anything that is not counting pixels:
       * the accessible name does not change with the viewport, so a screen
       * reader hears the same thing on a 360px phone and on a desktop.
       */
      aria-label={warning.label.replace(' · ', ', ')}
      /*
       * "The best group on the board" is accurate again.
       *
       * It was accurate under the original rule, wrong for one release while
       * the warning was allowed to mark any small group at a position, and
       * accurate once more now that it marks only the active tier — the group
       * you are actually choosing from, which is the only group that can be
       * about to run out.
       */
      title={
        warning.remaining === 1
          ? `The last ${rec.position} in the best group left on the board`
          : `Two ${rec.position}s left in the best group on the board`
      }
    >
      {/*
        Two spellings, and the stylesheet picks by width — see `.player-row-cliff`.

        The four numbers beside this are not negotiable: a card that drops
        `Next` to make room for a warning about `Next` has its priorities
        backwards. So on the two narrowest phones, where a three-digit ADP and
        a three-digit Val leave no room for nineteen characters, the warning is
        what gives. It gives the least it can — the count and the word that
        makes the colour redundant survive in both.

        Both spellings are the same length as the ones they replace, so the
        widths the stylesheet was measured against still hold.
      */}
      <span className="cliff-full">{warning.label}</span>
      <span className="cliff-tight">{warning.short}</span>
    </span>
  );
}
