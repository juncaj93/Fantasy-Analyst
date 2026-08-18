/**
 * Player Intelligence: search, and one card per player that opens into
 * everything the app knows about him.
 *
 * The same grammar as the draft board, deliberately. A player is the same
 * player on both screens — same identity row, same tally, same injury tag, same
 * expand-in-place disclosure — and the difference is only what the expansion
 * says. On the board it is what a drafter needs in thirty seconds. Here it is
 * the whole file: what is expected of him this season, what he did last season,
 * what is wrong with him, the tally in four windows, the categories it came
 * from, the market's lines, and every piece of evidence behind all of it, never
 * merely an aggregate.
 *
 * That file used to be a screen of its own, reached by pushing. It reads better
 * as a disclosure: the list stays where it was, the reader keeps their place in
 * it, and moving between two players is a tap rather than a round trip.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type EvidenceItem, type LeagueSummary, type MyGuyFlag, type PlayerDetail, type PlayerSignal } from '../api.ts';
import {
  InjuryDetail,
  LastSeasonLine,
  NewsletterTakeaway,
  ProfileFlags,
  SeasonOutlook,
} from '../components/playerDetail.tsx';
import { FLX_FILTER, offersFlexFilter, orderPositions } from '../../core/sleeper/eligibility.ts';
import { buildRosterShape, startablePositions } from '../../core/sleeper/scoring.ts';
import {
  Badge,
  CompactTally,
  DetailLabel,
  Disclose,
  Empty,
  InjuryTag,
  PositionBadge,
  Signal,
  SignedValue,
  Unknown,
  formatDate,
  positionCardClass,
} from '../components/common.tsx';
import { NavBar, SearchField, SegmentedControl, SkeletonRows } from '../components/native.tsx';
import { MyGuyControl } from '../components/decisions.tsx';

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

interface PlayerFile {
  player: { id: string; name: string; position: string; team: string; status: string | null; aliases: string[] };
  signal: PlayerSignal;
  evidence: EvidenceItem[];
  props: { market: string; line: number | null; bookCount: number; impliedProbability: number | null }[];
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
  const [expanded, setExpanded] = useState<string | null>(null);
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
    async (offset: number): Promise<PlayersPage> => {
      const filter = position === ALL_FILTER ? '' : `&position=${encodeURIComponent(position)}`;
      return api.get<PlayersPage>(
        `/api/players?q=${encodeURIComponent(query)}${filter}&limit=${PAGE_SIZE}&offset=${offset}`,
      );
    },
    [query, position],
  );

  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetchPage(0);
        if (cancelled) return;
        setPlayers(res.players);
        // Older deployments send neither field; treating a full page as "there
        // may be more" degrades to one extra request rather than to a truncated
        // list, which is the right way round.
        setHasMore(res.hasMore ?? res.players.length >= PAGE_SIZE);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [fetchPage]);

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
   * that is the whole of it: an open card stays open, and the hearts, the queue
   * and every tally are server state that a tab tap has no business touching.
   */
  useEffect(() => {
    if (resetNonce === 0) return;
    setQuery('');
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [resetNonce]);

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
          <div role="list" aria-label="Players, best first" data-testid="players-list">
            {players.map((p) => (
              <PlayerRow
                key={p.id}
                player={p}
                expanded={expanded === p.id}
                busy={flagging === p.id}
                onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
                onMyGuy={(level) => void setMyGuy(p.id, level)}
              />
            ))}
          </div>
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
 * One player, collapsed to the same shape a draft row has.
 *
 * Rank, the user's own flag, the name, the headline tally, the injury tag and
 * the position — then the windows and the ranking underneath. The only
 * difference from the board is which numbers are worth the second line: there
 * it is the four that decide a pick, here it is the tally over time and where
 * the ranking came from.
 */
function PlayerRow({
  player,
  expanded,
  busy,
  onToggle,
  onMyGuy,
}: {
  player: PlayerListItem;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onMyGuy: (level: 0 | 1 | 2 | 3) => void;
}) {
  return (
    <div
      className={positionCardClass(player.position, expanded ? 'player-row-open' : '')}
      data-testid="player-search-row"
      data-player-id={player.id}
      data-position={(player.position ?? '').toUpperCase()}
      role="listitem"
    >
      <button className="row-button" aria-expanded={expanded} onClick={onToggle}>
        <div className="player-row-top">
          <span className="rank" aria-hidden="true">
            {player.adjustedRank == null ? '—' : Math.round(player.adjustedRank)}
          </span>
          {/*
            A heart here, a star on the draft board — two different marks. This
            one is an opinion and moves the player up your board; the star over
            there is a bookmark and changes nothing.
          */}
          <MyGuyControl myGuy={player.myGuy ?? EMPTY_MY_GUY} busy={busy} onChange={onMyGuy} />
          <span className="player-name">{player.name}</span>
          {/*
            The same headline tally, in the same place, as on the draft board —
            and the same availability tag beside it: nothing at all for a healthy
            player, `Q` for a questionable one. This was a word-length badge
            reading "Questionable" or "Out", which is the same fact said three
            times as loudly as the board says it.

            Both sit in the same fixed-width field the board uses, so the club
            marks line up down this list too. See `--row-meta`.
          */}
          <span className="player-row-meta">
            <CompactTally net={player.signal?.raw.net ?? 0} label="Lifetime research tally" />
            <InjuryTag status={player.status} />
          </span>
          <PositionBadge position={player.position} team={player.team} />
        </div>

        <div className="player-row-metrics">
          <span className="metric">
            Lifetime <SignedValue net={player.signal?.raw.net ?? 0} />
            {(player.signal?.raw.items ?? 0) > 0 ? <span className="faint"> ({player.signal!.raw.items})</span> : null}
          </span>
          <span className="metric">
            21d <SignedValue net={player.signal?.last30.net ?? 0} />
          </span>
          {/* Say where the order came from, and what the news changed. */}
          {player.draftRank != null ? (
            <span className="metric">
              Sleeper <strong>{player.draftRank}</strong>
            </span>
          ) : (
            <span className="metric faint">unranked</span>
          )}
          {player.movement ? (
            <Badge tone={player.movement > 0 ? 'pos' : 'neg'}>
              {player.movement > 0 ? `▲ ${player.movement}` : `▼ ${Math.abs(player.movement)}`}
            </Badge>
          ) : null}
          {(player.signal?.pendingCount ?? 0) > 0 ? (
            <Badge tone="warn">{player.signal!.pendingCount} to review</Badge>
          ) : null}
        </div>
      </button>

      <Disclose open={expanded}>
        <PlayerFileView playerId={player.id} position={player.position} />
      </Disclose>
    </div>
  );
}

/**
 * Everything the app knows about him, fetched when the card opens.
 *
 * Two requests, because the answers come from two places that fail
 * independently: the tally, the categories, the market lines and the evidence
 * are this app's own record, and the outlook, last season and the injury report
 * are read from elsewhere. Either can be missing without taking the other with
 * it, and neither is asked for until somebody actually opens the card.
 */
function PlayerFileView({ playerId, position }: { playerId: string; position: string | null }) {
  const [file, setFile] = useState<PlayerFile | null>(null);
  const [detail, setDetail] = useState<PlayerDetail | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setDetail(null);
    setDetailFailed(false);
    api
      .get<PlayerFile>(`/api/players/${playerId}`)
      .then((res) => {
        if (!cancelled) setFile(res);
      })
      .catch(() => {
        /* the section simply does not appear */
      });
    api
      .get<PlayerDetail>(`/api/players/${playerId}/detail`)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch(() => {
        if (!cancelled) setDetailFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  return (
    <div className="explain" data-testid="player-file">
      {/*
        The takeaway leads, because this screen is the tally's own screen: the
        windows, the categories and the whole evidence timeline are below, and
        the one sentence that says what all of it amounts to belongs above them
        rather than buried after somebody else's season preview.
      */}
      <NewsletterTakeaway detail={detail} />
      <SeasonOutlook detail={detail} failed={detailFailed} />
      <LastSeasonLine detail={detail} failed={detailFailed} position={position} />
      <InjuryDetail detail={detail} />
      <ProfileFlags detail={detail} />

      {file ? (
        <PlayerRecord file={file} quotedEvidenceIds={detail?.newsletterTakeaway?.evidenceItemIds ?? []} />
      ) : (
        <div className="spinner">Reading his file…</div>
      )}
    </div>
  );
}

/** The tally in four windows, the categories, the market and the evidence. */
function PlayerRecord({ file, quotedEvidenceIds }: { file: PlayerFile; quotedEvidenceIds: string[] }) {
  const { signal, evidence, props } = file;
  /*
   * Which rows the takeaway above was drawn from.
   *
   * This is where the takeaway's provenance lives — down in the timeline rather
   * than beside the sentence, because a sentence followed by two item ids and a
   * derivation label is no longer a takeaway. A reader who wants to check it
   * scrolls here and finds the source rows marked.
   */
  const quoted = new Set(quotedEvidenceIds);
  return (
    <>
      <DetailLabel>News by window</DetailLabel>
      <table className="compact">
        <thead>
          <tr>
            <th>Window</th>
            <th>Pos</th>
            <th>Neg</th>
            <th>Net</th>
            <th>Items</th>
          </tr>
        </thead>
        <tbody>
          {(
            [
              ['Last 7d', signal.last7],
              ['Last 21d', signal.last30],
              ['Season', signal.seasonToDate],
              ['Lifetime', signal.raw],
            ] as const
          ).map(([label, w]) => (
            <tr key={label}>
              <td>{label}</td>
              <td>{w.positive}</td>
              <td>{w.negative}</td>
              <td>
                <Signal net={w.net} />
              </td>
              <td>{w.items}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {signal.pendingCount > 0 ? (
        <div className="hint hint-caution">
          {signal.pendingCount} news item{signal.pendingCount === 1 ? '' : 's'} still waiting for your review, so
          {signal.pendingCount === 1 ? ' it is' : ' they are'} not counted in these tallies yet.
        </div>
      ) : null}

      {Object.keys(signal.categoryBreakdown).length > 0 ? (
        <>
          <DetailLabel>Categories</DetailLabel>
          <div className="badge-row" style={{ marginTop: 0 }}>
            {Object.entries(signal.categoryBreakdown).map(([cat, v]) => (
              <Badge key={cat} tone={v.positive > v.negative ? 'pos' : v.negative > v.positive ? 'neg' : 'neutral'}>
                {cat}: +{v.positive} / −{v.negative}
              </Badge>
            ))}
          </div>
        </>
      ) : null}

      <DetailLabel>Vegas props</DetailLabel>
      {props.length === 0 ? (
        <div className="muted">
          No prop data cached for this player. <Unknown what="Vegas expectation" />
        </div>
      ) : (
        <table className="compact">
          <thead>
            <tr>
              <th>Market</th>
              <th>Line</th>
              <th>Books</th>
            </tr>
          </thead>
          <tbody>
            {props.map((p) => (
              <tr key={p.market}>
                <td>{p.market}</td>
                <td>
                  {p.line != null
                    ? p.line
                    : p.impliedProbability != null
                      ? `${Math.round(p.impliedProbability * 100)}%`
                      : '—'}
                </td>
                <td>{p.bookCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="detail-label" data-testid="evidence-heading">
        Evidence timeline ({evidence.length})
      </div>
      {evidence.length === 0 ? (
        <div className="muted">No evidence recorded yet.</div>
      ) : (
        evidence.map((e) => <EvidenceRow key={e.id} item={e} quoted={quoted.has(e.id)} />)
      )}
    </>
  );
}

export function EvidenceRow({ item, quoted = false }: { item: EvidenceItem; quoted?: boolean }) {
  const effective = item.userOverride?.polarity ?? item.polarity;
  const cls = effective === 'positive' ? 'pos' : effective === 'negative' ? 'neg' : effective === 'mixed' ? 'mixed' : '';
  const glyph = effective === 'positive' ? '▲' : effective === 'negative' ? '▼' : effective === 'mixed' ? '◆' : '–';
  return (
    <div className={`evidence ${cls}`} data-testid="evidence-item">
      <div className="evidence-meta">
        <span>
          {glyph} {effective}
          {item.userOverride ? ' (yours)' : ''}
        </span>
        {quoted ? <span data-testid="evidence-quoted">quoted above</span> : null}
        <span>mag {item.userOverride?.magnitude ?? item.magnitude}</span>
        <span>{item.category ?? 'uncategorised'}</span>
        <span>{formatDate(item.sourceDate)}</span>
        <span>{item.reviewStatus}</span>
      </div>
      {item.contextSummary ? <div className="evidence-excerpt">{item.contextSummary}</div> : null}
      <div className="faint" data-testid="evidence-excerpt">
        “{item.excerpt}”
      </div>
      <div className="evidence-meta">
        <span>{item.sourceName}</span>
        {item.ruleId ? <span>rule: {item.ruleId}</span> : null}
        <span>confidence: {item.confidence}</span>
      </div>
    </div>
  );
}
