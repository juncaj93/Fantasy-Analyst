/**
 * Player Intelligence: a compact, sortable player database, and one tap to
 * everything the app knows about anybody in it.
 *
 * This screen used to be a list of cards that unfolded into a screen and a half
 * of prose each: the outlook, last season, the injury, four tally windows, the
 * categories, the market lines and the whole evidence ledger, all rendered
 * inside a row of the list they were opened from. It read as a page that
 * exploded rather than a database, and a reader comparing two players spent
 * their time scrolling past the first one's ledger to reach the second one's
 * name.
 *
 * So the list is now a list — a hundred rows in fixed columns, on one grouped
 * surface, separated by hairlines — and the file is now a *destination*, pushed
 * on top with a Back control (see `components/playerPage.tsx`). The reader's
 * place in the list, what they typed, and which position they had narrowed it
 * to all survive the round trip, which is the whole point of pushing rather
 * than replacing.
 *
 * Nothing about the data changed. The same two endpoints answer the same two
 * questions, and every number on the row is the number that was on the card.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type LeagueSummary, type MyGuyFlag, type PlayerSignal } from '../api.ts';
import type { CacheOptions } from '../sessionCache.ts';
import { FLX_FILTER, offersFlexFilter, orderPositions } from '../../core/sleeper/eligibility.ts';
import { buildRosterShape, startablePositions } from '../../core/sleeper/scoring.ts';
import { Empty, SignedValue } from '../components/common.tsx';
import { NavBar, SearchField, SegmentedControl, SkeletonRows } from '../components/native.tsx';
import { CompactPlayerRow } from '../components/playerRow.tsx';
import { PlayerPage, PlayerSheet, type PlayerSummary } from '../components/playerPage.tsx';
import { MyGuyControl } from '../components/decisions.tsx';
import { unwindOne } from '../tabReset.ts';

/** An unflagged player, so the control renders the same shape either way. */
const EMPTY_MY_GUY: MyGuyFlag = { level: 0, label: '', stars: '', score: 0 };

interface PlayerListItem {
  id: string;
  name: string;
  position: string;
  team: string;
  status: string | null;
  /** Sleeper's own draft-order ranking, or null if it does not rank them. */
  draftRank: number | null;
  /** Draft rank after the tally nudge; null when unranked. */
  adjustedRank: number | null;
  /** Picks the tally moved them. Positive means earlier. */
  movement: number;
  signal: PlayerSignal | null;
  /** The user's own flag. Absent on responses from an older deployment. */
  myGuy?: MyGuyFlag;
}

/** One page of the response, plus what it says about the rest of the list. */
interface PlayersPage {
  players: PlayerListItem[];
  /** Absent on an older deployment; the caller falls back to a full page. */
  hasMore?: boolean;
  total?: number;
}

const ALL_FILTER = 'ALL';

/**
 * How many players arrive per page.
 *
 * A hundred rather than the sixty this screen used to fetch and stop at, and
 * rather than everything: three thousand rows in the DOM is a phone that
 * stutters on every scroll, and nobody reads past the two hundredth name in one
 * sitting anyway. Two pages cover the browsable depth the brief asks for and a
 * third is one scroll away.
 */
const PAGE_SIZE = 100;

/**
 * How far from the bottom the next page starts loading.
 *
 * A screen and a half, so the rows are there before the reader arrives at
 * them — a spinner they actually see is a page that was requested too late.
 */
const LOAD_MORE_MARGIN = '600px';

export function PlayersScreen({ leagues, resetNonce }: { leagues: LeagueSummary[]; resetNonce: number }) {
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState(ALL_FILTER);
  const [players, setPlayers] = useState<PlayerListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [flagging, setFlagging] = useState<string | null>(null);
  /** Whose page is open on top of the list, and nothing about the list itself. */
  const [openId, setOpenId] = useState<string | null>(null);
  /*
   * Whether the reader has asked to leave the list.
   *
   * Opening a player no longer pushes anything: the sheet rises over the list,
   * which stays mounted with its query, its filter, its fetched pages and its
   * scroll exactly as they were. `full` is the second step — the reader saying
   * a skim has turned into a study — and it is the only one that costs a
   * navigation.
   */
  const [full, setFull] = useState(false);
  /**
   * Whether there is more of the list, and whether it is being fetched.
   *
   * This screen used to ask for one page of sixty and stop, which meant Players
   * ended around the sixtieth name and looked exactly like the end of the
   * player universe rather than the end of a page — the same failure the draft
   * board had, and the same fix: keep asking. Two hundred is browsable, six
   * hundred is browsable, and the DOM never holds more than what has actually
   * been scrolled to.
   */
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  /*
   * Where the reader was when they opened a player.
   *
   * Back must mean Back. The list itself never unmounts its *state* — the
   * fetched pages, the query and the filter all live in this component — but
   * the rows do leave the document while a player's page is on top of them, and
   * the browser has no memory of a scroll offset for a document that changed
   * height to zero and back. So it is recorded on the way in and reapplied on
   * the way out, before the browser paints. See the layout effect below.
   */
  const restoreScroll = useRef<number | null>(null);

  /*
   * The chips come from the league, exactly as the draft board's do.
   *
   * A filter that can only ever return nothing is worse than no filter — the
   * reason a defence chip stopped appearing in a league with no defence slot.
   * With no league selected the list is unfiltered and the row is not drawn at
   * all, because there is nothing to derive it from.
   */
  const selected = leagues.find((l) => l.isSelected) ?? null;
  const segments = useMemo(() => {
    if (!selected) return [];
    const startable = startablePositions(buildRosterShape(selected.rosterPositions));
    if (startable.size === 0) return [];
    // FLX last: it is a view spanning three positions, not a fourth one, and a
    // chip that reads like a position among the real ones invites exactly the
    // confusion this filter must not cause. The positions themselves are in the
    // order every fantasy site uses, shared with the draft board so the same
    // chips cannot appear in two different orders on two screens.
    return [
      ALL_FILTER,
      ...orderPositions(startable),
      ...(offersFlexFilter(startable) ? [FLX_FILTER] : []),
    ];
  }, [selected]);

  /** One page of the list. `offset` 0 replaces; anything else appends. */
  const fetchPage = useCallback(
    async (offset: number, options: CacheOptions<PlayersPage> = {}): Promise<PlayersPage> => {
      const filter = position === ALL_FILTER ? '' : `&position=${encodeURIComponent(position)}`;
      return api.get<PlayersPage>(
        `/api/players?q=${encodeURIComponent(query)}${filter}&limit=${PAGE_SIZE}&offset=${offset}`,
        options,
      );
    },
    [query, position],
  );

  /**
   * Put a first page on screen.
   *
   * Runs twice for one visit — once with whatever the session already had, and
   * again if the server's answer has moved on — so the two paths cannot drift.
   */
  const applyFirstPage = useCallback((res: PlayersPage) => {
    setPlayers(res.players);
    // Older deployments send neither field; treating a full page as "there
    // may be more" degrades to one extra request rather than to a truncated
    // list, which is the right way round.
    setHasMore(res.hasMore ?? res.players.length >= PAGE_SIZE);
  }, []);

  /*
   * The debounce is for typing, and only for typing.
   *
   * It exists so that a query being typed does not fire a request per
   * keystroke. Arriving on the screen is not typing: there is one query, it is
   * whatever the screen opened with, and waiting 220ms to ask about it put a
   * fifth of a second of blank list in front of every single visit — including
   * a revisit whose answer was already in hand. First run asks immediately;
   * every change after it waits.
   */
  const typed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetchPage(0, {
          onFresh: (fresh) => {
            if (!cancelled) applyFirstPage(fresh);
          },
        });
        if (cancelled) return;
        applyFirstPage(res);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, typed.current ? 220 : 0);
    typed.current = true;
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [fetchPage, applyFirstPage]);

  /**
   * The next page, when the reader reaches the end of this one.
   *
   * Guarded on `loadingMore` rather than debounced: the sentinel can report
   * itself visible several times while one request is in flight, and a second
   * request for the same offset would append the same players twice.
   */
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const res = await fetchPage(players.length);
      setPlayers((current) => {
        // Belt and braces against a duplicate: a page that arrives after the
        // filter changed must not splice rows from the old query into the new
        // list, and an id already on screen is the cheapest way to notice.
        const seen = new Set(current.map((p) => p.id));
        return [...current, ...res.players.filter((p) => !seen.has(p.id))];
      });
      setHasMore(res.hasMore ?? res.players.length >= PAGE_SIZE);
    } catch {
      // A failed page is not a failed screen. The reader keeps everything they
      // already have, and the sentinel will try again on the next scroll.
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, hasMore, loadingMore, players.length]);

  /*
   * Tapping Players while already on Players clears the search.
   *
   * The tab you are on is the one control that has nothing left to do, so iOS
   * gives it this job. It clears what you typed and returns to the top, and
   * that is the whole of it: the hearts, the queue and every tally are server
   * state that a tab tap has no business touching.
   */
  useEffect(() => {
    if (resetNonce === 0) return;
    unwindOne([
      { when: full, undo: () => setFull(false) },
      { when: openId != null, undo: () => setOpenId(null) },
      { when: query !== '', undo: () => setQuery('') },
    ]);
  }, [resetNonce]);

  /*
   * Put the reader back exactly where they were, before the frame is painted.
   *
   * `useLayoutEffect` rather than `useEffect` on purpose: an effect that runs
   * after paint shows the reader the top of the list for one frame and then
   * jumps them down it, which is worse than not restoring at all. The ref is
   * consumed rather than merely read, so a later render for any other reason
   * cannot scroll the page out from under somebody who has since moved.
   */
  useLayoutEffect(() => {
    if (full || restoreScroll.current === null) return;
    const top = restoreScroll.current;
    restoreScroll.current = null;
    window.scrollTo({ top, behavior: 'auto' });
  }, [full]);

  /**
   * Star a player from the list.
   *
   * Updated in place rather than by refetching: this list is not ranked by the
   * flag, so nothing about it moves, and a full reload mid-search would throw
   * away what the user typed.
   */
  const setMyGuy = async (playerId: string, level: 0 | 1 | 2 | 3) => {
    setFlagging(playerId);
    try {
      const res = await api.post<{ myGuy: MyGuyFlag }>(`/api/players/${playerId}/my-guy`, { level });
      setPlayers((current) => current.map((p) => (p.id === playerId ? { ...p, myGuy: res.myGuy } : p)));
    } finally {
      setFlagging(null);
    }
  };

  const open = openId == null ? null : (players.find((p) => p.id === openId) ?? null);

  /*
   * The player's page, on top of the list rather than instead of it.
   *
   * The list's state — every page fetched, the query, the filter, the hearts —
   * lives in this component and is untouched by the push, so Back is a genuine
   * Back rather than a reload. That is the requirement the whole navigation
   * model exists to meet.
   */
  if (open && full) {
    return (
      <PlayerPage
        player={toSummary(open)}
        backLabel="Players"
        onBack={() => setFull(false)}
        trailing={
          <MyGuyControl
            myGuy={open.myGuy ?? EMPTY_MY_GUY}
            busy={flagging === open.id}
            onChange={(level) => void setMyGuy(open.id, level)}
          />
        }
      />
    );
  }

  return (
    <>
      {/*
        The search field is this screen's navigation bar.

        A title reading "Players" over a search field, on the screen reached by
        tapping a tab labelled Players, is a row of the phone spent saying it a
        third time. The field carries the identity — and its own label, for
        anyone listening rather than looking. A magnifier, a compact field, and
        a clear control that appears only when there is something to clear;
        clearing empties the field and nothing else.
      */}
      <NavBar
        testId="players-nav"
        content={
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Search players"
            label="Search players"
            testId="player-search"
          />
        }
      />
      {segments.length > 0 ? (
        <div className="control-row" data-testid="players-controls">
          <SegmentedControl
            label="Filter by position"
            value={position}
            onChange={setPosition}
            segments={segments.map((p) => ({
              id: p,
              label: p,
              ...(p === FLX_FILTER
                ? {
                    ariaLabel: 'Flex-eligible players: running backs, receivers and tight ends',
                    testId: 'flx-filter',
                  }
                : {}),
            }))}
          />
        </div>
      ) : null}
      {loading && players.length === 0 ? (
        <SkeletonRows rows={8} testId="players-skeleton" />
      ) : players.length === 0 ? (
        <Empty>
          {query
            ? `Nobody matching “${query}”${position === ALL_FILTER ? '' : ` under ${position}`}.`
            : position === ALL_FILTER
              ? 'No players found. Run a Sleeper player sync from the Team screen.'
              : `No ${position} players found.`}
        </Empty>
      ) : (
        <>
          <div className="dense-group" role="list" aria-label="Players, best first" data-testid="players-list">
            {players.map((p) => (
              <PlayerRow
                key={p.id}
                player={p}
                busy={flagging === p.id}
                onOpen={() => setOpenId(p.id)}
                onMyGuy={(level) => void setMyGuy(p.id, level)}
              />
            ))}
          </div>
          {/*
            The player, over the list he was tapped in.

            Rendered here rather than instead of the list, which is the whole
            point: everything behind it — the query, the filter, every page
            fetched, the hearts and the scroll — is still mounted and still
            true, so dismissing the sheet is not a restoration, it is just the
            sheet going away.
          */}
          {open && !full ? (
            <PlayerSheet
              player={toSummary(open)}
              onClose={() => setOpenId(null)}
              onOpenFull={() => {
                restoreScroll.current = window.scrollY;
                setFull(true);
              }}
              trailing={
                <MyGuyControl
                  myGuy={open.myGuy ?? EMPTY_MY_GUY}
                  busy={flagging === open.id}
                  onChange={(level) => void setMyGuy(open.id, level)}
                />
              }
            />
          ) : null}

          {/*
            The end of the list, or the reason it is not the end.

            A sentinel rather than a "load more" button: on a phone the gesture
            for "show me more of this list" is scrolling, and a button asks the
            reader to do something they were already doing. The button is still
            there underneath for anyone who reaches it without an observer —
            see LoadMore.
          */}
          <LoadMore hasMore={hasMore} loading={loadingMore} onLoad={loadMore} count={players.length} />
        </>
      )}
    </>
  );
}

/** What the page needs from the row the reader tapped, and nothing more. */
function toSummary(p: PlayerListItem): PlayerSummary {
  return {
    id: p.id,
    name: p.name,
    position: p.position,
    team: p.team,
    status: p.status,
    draftRank: p.draftRank,
    adjustedRank: p.adjustedRank,
    movement: p.movement,
  };
}

/**
 * The end of the list — and, when there is more, the thing that fetches it.
 *
 * An `IntersectionObserver` on a marker element, with a real button inside it.
 * Both are needed and neither is redundant:
 *
 *  - the observer is the interface. Scrolling is what "show me more" means on a
 *    phone, and a reader who has to find and press a control every hundred
 *    rows will conclude the list ends at a hundred rows;
 *  - the button is the fallback and the accessible affordance. A browser
 *    without `IntersectionObserver`, a test environment that does not implement
 *    it, and anybody navigating by keyboard or screen reader all reach the end
 *    of the list without ever "scrolling into view", and for them the control
 *    has to be a control.
 *
 * When the list really has ended it says so once, quietly, rather than leaving
 * the reader to wonder whether it is still loading. That line is the whole
 * difference from the failure this replaces: a list that stopped at sixty and
 * said nothing looked exactly like a list that had run out of players.
 */
function LoadMore({
  hasMore,
  loading,
  onLoad,
  count,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoad: () => void;
  count: number;
}) {
  const marker = useRef<HTMLDivElement | null>(null);
  /*
   * The latest `onLoad`, reachable from an observer that is not rebuilt on
   * every render. Re-creating the observer whenever the callback identity
   * changed would disconnect and reconnect it mid-scroll, which drops exactly
   * the intersection it exists to catch.
   */
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;

  useEffect(() => {
    const el = marker.current;
    if (!el || !hasMore) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadRef.current();
      },
      { rootMargin: LOAD_MORE_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore]);

  if (!hasMore) {
    return (
      <div className="list-end" data-testid="players-end">
        {count === 0 ? null : `${count} player${count === 1 ? '' : 's'} — that is all of them.`}
      </div>
    );
  }

  return (
    <div ref={marker} className="list-end" data-testid="players-more">
      <button type="button" className="link-button" disabled={loading} onClick={onLoad}>
        {loading ? 'Loading more…' : 'Show more players'}
      </button>
    </div>
  );
}

/**
 * One player, on one row, in the columns every row shares.
 *
 * Rank, the reader's own flag, the name, the headline tally, the availability
 * tag and the position on the top line; the lifetime tally, the recent window,
 * Sleeper's own order and what the research moved him underneath. That is the
 * whole row — seven facts in two lines and a 44px tap target, where the same
 * seven used to take a card with a coloured wash and a disclosure arrow.
 *
 * Everything the card used to unfold is now one tap away on the player's own
 * page, which is where a screen and a half of prose belongs.
 */
function PlayerRow({
  player,
  busy,
  onOpen,
  onMyGuy,
}: {
  player: PlayerListItem;
  busy: boolean;
  onOpen: () => void;
  onMyGuy: (level: 0 | 1 | 2 | 3) => void;
}) {
  const lifetime = player.signal?.raw.net ?? 0;

  return (
    <div role="listitem">
      <CompactPlayerRow
        playerId={player.id}
        name={player.name}
        position={player.position}
        team={player.team}
        status={player.status}
        tally={lifetime}
        rank={player.adjustedRank == null ? '—' : Math.round(player.adjustedRank)}
        /*
          A heart here, a star on the draft board — two different marks. This
          one is an opinion and moves the player up your board; the star over
          there is a bookmark and changes nothing.

          It sits inside the row and is its own control, which is why the row is
          a button beside it rather than a button around it.
        */
        leading={<MyGuyControl myGuy={player.myGuy ?? EMPTY_MY_GUY} busy={busy} onChange={onMyGuy} />}
        onOpen={onOpen}
        testId="player-search-row"
        /*
          Two numbers clustered at the leading edge, which is how the draft
          board's own second line reads.

          This was three equal columns — `21d`, `ADP`, and a movement arrow —
          spread across the width of the row, and the spread was the problem:
          three numbers at three alignments, a rank on the leading edge and a
          heart, a club mark and a chevron on the trailing one, all at the same
          visual weight. A player index that looks like a spreadsheet is harder
          to read than one that looks like the draft board, and the draft board
          was already the answer.

          The movement column is the one that went, and it went because it was
          not a third reading. `movement` is Sleeper's own draft rank minus the
          rank after the tally nudge — and both of those are already printed on
          this row, as `ADP` and as the number on the leading edge. `1 · ADP 2.1
          · ▲1.6` is a subtraction the reader can see being done. Nothing is
          lost: the arrow is still on his page, in the metric grid at the top and
          again under Market, where a reader who wants to know how far the
          research moved him is already looking.
        */
        metrics={[
          /*
            `Life` used to lead this line and it was the same number as the
            tally beside the name on the line above — the row printing its
            loudest signal twice, once labelled and once not. What is left is
            the reading the label could not give you: how he has moved lately,
            and where the market has him.
          */
          { label: '21d', value: <SignedValue net={player.signal?.last30.net ?? 0} /> },
          {
            label: 'ADP',
            testId: 'players-adp',
            value:
              player.draftRank != null ? (
                player.draftRank
              ) : (
                <span className="faint" title="Sleeper does not rank him">
                  —
                </span>
              ),
          },
        ]}
      />
    </div>
  );
}
