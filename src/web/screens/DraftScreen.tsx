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
  api,
  type DraftBoard,
  type DraftRecommendation,
  type LeagueSummary,
  type PlayerDetail,
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
import { matchesQuery } from '../search.ts';
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
import { groupByTier, tierCliffWarning, tierDividerFlags } from '../../core/draft/tierBoard.ts';
import { AvoidBadge, QueueControl } from '../components/decisions.tsx';
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
        setError(err instanceof Error ? err.message : String(err));
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

  /* Tapping Draft while already on Draft clears the search and nothing else. */
  useEffect(() => {
    if (resetNonce === 0) return;
    setQuery('');
    setSearchOpen(false);
    window.scrollTo({ top: 0, behavior: 'auto' });
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
  const visible = withTierDividers(board.recommendations, isSinglePosition && !searching).filter((item) =>
    matchesQuery(item.rec.name, query),
  );

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
            A reload glyph, not a connection switch. The old ▶ Live / ⏸ pair
            implied the user had to keep a link open; what they actually want is
            "show me what just happened", so that is what the control says.
          */
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
      {refreshState?.stale && !refreshNote ? (
        <div className="draft-refresh-note" data-testid="draft-sync-stale" role="status">
          Draft sync delayed · retrying
        </div>
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
          role="list"
          aria-label={position === QUEUE_FILTER ? 'Your queue, best first' : 'Available players, best first'}
          data-testid="board-list"
        >
          {visible.map((item) => (
            /* The divider goes above the row that opens the tier, not instead of it. */
            <Fragment key={item.rec.playerId}>
              {item.divider ? <TierDivider gap={item.rec.tierCliff.tierGapBefore} /> : null}
              <RecommendationRow
                rank={item.rank}
                rec={item.rec}
                showCliffProximity={!isSinglePosition}
                horizonPick={board.waitHorizonPick}
                expanded={expanded === item.rec.playerId}
                onToggle={() => setExpanded(expanded === item.rec.playerId ? null : item.rec.playerId)}
                onQueue={setQueued}
                busy={flagging === item.rec.playerId}
              />
            </Fragment>
          ))}
        </div>
      )}
    </>
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
}

/**
 * The rows, in tier order, each told whether a tier boundary falls above it.
 *
 * The grouping and the flags have to be computed over the same sequence, and
 * that sequence is not the one the server sent: a divider claims that
 * everything above it is one tier, which is only true once the tiers are
 * contiguous. See `groupByTier`.
 *
 * Off entirely on the mixed board, where there is no single position for a
 * boundary to be about — there the ranking is the order, untouched.
 */
function withTierDividers(recs: DraftRecommendation[], enabled: boolean): BoardItem[] {
  if (!enabled) return recs.map((rec, i) => ({ rec, rank: i + 1, divider: false }));
  const ordered = groupByTier(recs, (rec) => rec.tierCliff.tierIndex);
  const flags = tierDividerFlags(ordered.map((rec) => rec.tierCliff.tierIndex));
  return ordered.map((rec, i) => ({ rec, rank: i + 1, divider: flags[i] === true }));
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
function RecommendationRow({
  rank,
  rec,
  expanded,
  showCliffProximity,
  horizonPick,
  onToggle,
  onQueue,
  busy,
}: {
  rank: number;
  rec: DraftRecommendation;
  expanded: boolean;
  /** Mixed-position boards tag the last of a tier; filtered ones draw the line. */
  showCliffProximity: boolean;
  /** The pick survival is measured against — your next one after this. */
  horizonPick: number | null;
  onToggle: () => void;
  onQueue: (playerId: string, queued: boolean) => void;
  busy: boolean;
}) {
  const pos = (rec.position ?? '').toUpperCase();
  return (
    <div
      className={positionCardClass(pos, expanded ? 'player-row-open' : '')}
      data-testid="recommendation-row"
      data-player-id={rec.playerId}
      data-position={pos}
      role="listitem"
    >
      <button className="row-button" aria-expanded={expanded} onClick={onToggle}>
        <div className="player-row-top">
          <span className="rank">{rank}</span>
          <QueueControl queued={rec.queued} busy={busy} onChange={(queued) => onQueue(rec.playerId, queued)} />
          <span className="player-name">{rec.name}</span>
          {/*
            The tally, beside the name it is about.

            It used to be a fifth column of the metrics row reading "▲ +6 pos",
            which spent three tokens and a third of the line on a number. Up
            here it is one token attached to the player, and the row below is
            free for the four numbers that describe the decision.
          */}
          <CompactTally net={rec.newsLifetimeNet} label="Lifetime research tally" />
          <InjuryTag status={rec.status} />
          <PositionBadge position={rec.position} team={rec.team} />
        </div>

        {/*
          The only tag that still costs a row of its own. Take Now, Risky to
          Wait and Can Probably Wait were on nearly every row, which made a row
          of chips that told the reader nothing; the chance he reaches your next
          pick is a number and does the same job in less space. AVOID stays,
          because "the research is against him" is not something a percentage
          can say — and it is rare enough that the row it costs is affordable.

          The tier-cliff warning used to sit here too, and did not earn it: it
          lands on whole runs of the board at once, and every card it touched
          became a line taller than its neighbours. It has moved into the empty
          right-hand end of the metrics line below.
        */}
        {rec.avoid.active ? (
          <div className="tag-row" data-testid="decision-tags">
            <AvoidBadge avoid={rec.avoid} />
          </div>
        ) : null}

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
              <strong className="score-value" title={`Composite recommendation strength, 0-100 (raw ${rec.total})`}>
                {rec.score}
              </strong>
            </span>
            <span className="metric">
              ADP <strong>{rec.adp == null ? <Unknown what="ADP" /> : rec.adp}</strong>
            </span>
            <span className="metric">
              Val{' '}
              <strong
                className={rec.adpValue == null ? '' : rec.adpValue > 0 ? 'sig-pos' : rec.adpValue < 0 ? 'sig-neg' : ''}
              >
                {rec.adpValue == null ? <Unknown what="value" /> : `${rec.adpValue > 0 ? '+' : ''}${rec.adpValue}`}
              </strong>
            </span>
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
          <div className="market-line" data-testid="market-line">
            <span className="market-label">Market</span> {rec.marketHeadline}
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
        <DraftPlayerDetail rec={rec} />
      </Disclose>
    </div>
  );
}

/**
 * Last season and this season's outlook, fetched when the card opens.
 *
 * Not part of the board response on purpose. The board is what a live draft
 * waits on and it must never wait on a third party; this is asked for after the
 * user has already decided to look at one player, and a failure to answer costs
 * that one section and nothing else.
 */
function usePlayerDetail(playerId: string) {
  const [detail, setDetail] = useState<PlayerDetail | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setFailed(false);
    api
      .get<PlayerDetail>(`/api/players/${playerId}/detail`)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  return { detail, failed };
}

/**
 * The expanded player: four things, and nothing that explains the ranking.
 *
 * It has been cut twice now, and this is the cut that changes what it is for.
 * The first pass removed the grid of restated numbers. This one removes the
 * ranking rationale entirely — the bullets under "Why this rank", the
 * counterpoint, and the component arithmetic behind Advanced. All three
 * explained a position the reader can already see, in a place where the
 * question is not "why is he ranked here" but "who is this and should I take
 * him". A live draft is thirty seconds long.
 *
 * What is left is a fantasy snapshot: where his position is breaking and who
 * ahead of you still needs one, what is expected of him this season, what he
 * did last season, and whether he is coming back from something.
 *
 * The rationale is not deleted from the system — the board response still
 * carries every reason, counterpoint, component, weight and contribution, and
 * the engine still computes them. They have stopped being rendered here.
 */
function DraftPlayerDetail({ rec }: { rec: DraftRecommendation }) {
  const { detail, failed } = usePlayerDetail(rec.playerId);

  return (
    <div className="explain" data-testid="player-detail">
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

      <SeasonOutlook detail={detail} failed={failed} />
      <LastSeasonLine detail={detail} failed={failed} position={rec.position} />

      {/*
        A label, not a retelling. The outlook above has already explained the
        injury in the words of somebody who knows; saying it again in the app's
        own words would be duplication at best and paraphrase at worst.
      */}
      {detail?.injuryContext ? (
        <>
          <DetailLabel>Injury context</DetailLabel>
          <div className="muted" data-testid="injury-context">
            {detail.injuryContext}
          </div>
        </>
      ) : null}

      {/*
        What is wrong with him now, as against what he came back from above.
        Two different facts under two different headings, because a player
        returning from an ACL and a player with a sore hamstring on Friday are
        not the same situation and must not read as one.
      */}
      {detail?.injury ? (
        <>
          <DetailLabel>{detail.injury.label}</DetailLabel>
          <div className="muted" data-testid="injury-current">
            {detail.injury.line ?? detail.injury.label}
            {detail.injury.provenance ? (
              <span className="faint"> — {detail.injury.provenance}</span>
            ) : null}
          </div>
          {/*
            Disagreement is shown, never averaged away. Two sources saying
            different things is a real state of the world and the reader is the
            one who should decide what to do about it.
          */}
          {detail.injury.conflict ? (
            <div className="muted" data-testid="injury-conflict">
              Sources disagree — {detail.injury.conflict}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * What is expected of him this season, in the words of whoever wrote it.
 *
 * Sleeper serves this through a public endpoint, and it is editorial writing
 * rather than anything Sleeper or this app generated — so it carries its
 * author. Two or three sentences: the full text runs past a thousand
 * characters, and a wall of prose in a live draft is scrolled past rather than
 * read, taking whatever is under it off the screen.
 */
function SeasonOutlook({ detail, failed }: { detail: PlayerDetail | null; failed: boolean }) {
  if (failed) return null;
  if (!detail) {
    return (
      <>
        <DetailLabel>Season outlook</DetailLabel>
        <div className="muted" data-testid="outlook-pending">
          Looking it up…
        </div>
      </>
    );
  }
  if (!detail.outlook) {
    return (
      <>
        <DetailLabel>Season outlook</DetailLabel>
        <div className="muted" data-testid="outlook-none">
          {detail.outlookNote ?? 'No outlook published for him.'}
        </div>
      </>
    );
  }
  return <OutlookBody outlook={detail.outlook} />;
}

/**
 * The outlook, short by default and whole on request.
 *
 * What is printed is always the provider's own sentences in their own order —
 * the shortening is a selection, never a rewrite. But a quotation that has been
 * cut and does not say so is a misquotation, so when sentences were dropped the
 * card says how many and offers them, and the control is the only way this
 * component differs from showing the paragraph outright.
 */
function OutlookBody({ outlook }: { outlook: NonNullable<PlayerDetail['outlook']> }) {
  const [whole, setWhole] = useState(false);
  const attribution = outlook.source ? (
    <span className="outlook-source"> — {outlook.source}, via Sleeper</span>
  ) : null;

  return (
    <>
      <DetailLabel>{outlook.title}</DetailLabel>
      <div className="outlook" data-testid="outlook" data-summarised={outlook.summarised ? 'yes' : 'no'}>
        {whole ? outlook.fullText : outlook.text}
        {attribution}
      </div>
      {outlook.summarised ? (
        <button
          type="button"
          className="link-button"
          data-testid="outlook-toggle"
          onClick={(e) => {
            // The row underneath is a toggle; expanding the text is not
            // "collapse this player".
            e.stopPropagation();
            setWhole((v) => !v);
          }}
        >
          {whole ? 'Show the short version' : 'Read the full outlook'}
        </button>
      ) : null}
    </>
  );
}

/**
 * `16 GP · WR7 half-PPR`.
 *
 * Two numbers, one line, and neither is guessed. A player who did not appear
 * last season has no games and no finish, and gets a dash: Sleeper will happily
 * report him as the 1,240th receiver, which looks like a result and is really
 * his place in a directory.
 */
function LastSeasonLine({
  detail,
  failed,
  position,
}: {
  detail: PlayerDetail | null;
  failed: boolean;
  position: string | null;
}) {
  if (failed || !detail) return null;
  const season = detail.lastSeason?.season;
  const games = detail.lastSeason?.gamesPlayed;
  const rank = detail.lastSeason?.positionRank;
  if (!season) return null;
  return (
    <>
      <DetailLabel>{season}</DetailLabel>
      <div className="season-line" data-testid="last-season">
        <span className="metric">
          {games == null ? (
            <>
              GP <Unknown what={`${season} games played`} />
            </>
          ) : (
            <>
              <strong>{games}</strong> GP
            </>
          )}
        </span>
        <span className="metric" title={detail.lastSeason?.scoring}>
          {rank == null ? (
            <>
              {(position ?? '').toUpperCase() || 'Position'} rank <Unknown what={`${season} half-PPR finish`} />
            </>
          ) : (
            <>
              <strong>{rank}</strong> half-PPR
            </>
          )}
        </span>
      </div>
    </>
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
