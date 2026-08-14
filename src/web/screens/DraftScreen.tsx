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
  DetailLabel,
  Empty,
  Loading,
  Notice,
  PositionBadge,
  Signal,
  Unknown,
  formatShortAge,
  positionCardClass,
} from '../components/common.tsx';
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
import { tierCliffProximity, tierDividerFlags } from '../../core/draft/tierBoard.ts';
import {
  AvoidBadge,
  QueueControl,
  ReasonList,
  Verdict,
  draftVerdict,
  saidAlready,
  withoutRepeats,
} from '../components/decisions.tsx';

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

/** How many reasons the expanded player shows before "Show all reasons". */
const REASONS_SHOWN = 3;
/**
 * One counterpoint, not a second list of reasons.
 *
 * Two were shown, which turned "the strongest argument against him" into a pair
 * of arguments of unequal weight — and the second was usually the first in
 * other words. The rest are still computed and still in the ledger; the card
 * shows the one that would actually change a pick.
 */
const COUNTERPOINTS_SHOWN = 1;

export function DraftScreen({ leagues, unlocked }: { leagues: LeagueSummary[]; unlocked: boolean }) {
  const selected = leagues.find((l) => l.isSelected) ?? null;
  const draftId = selected?.draftId ?? null;

  const [board, setBoard] = useState<DraftBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [position, setPosition] = useState(ALL_FILTER);
  /*
   * Which of the two tier treatments this view gets.
   *
   * Filtered to one position the board is a ladder, so the breaks in it can be
   * drawn where they fall. `ALL` and the queue are mixed-position lists where
   * consecutive rows are usually different positions, and a line across them
   * would be claiming a boundary that does not exist — so those get the
   * proximity tag on the players it is actually about instead.
   */
  const isSinglePosition = position !== ALL_FILTER && position !== QUEUE_FILTER;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [flagging, setFlagging] = useState<string | null>(null);

  /** Manual refresh state: in-flight guard, last success, last complaint. */
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  /** Seconds between automatic syncs; 0 once the draft stops moving. */
  const [pollSeconds, setPollSeconds] = useState(0);
  /** Re-renders the freshness cue without touching anything else. */
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);

  const load = useCallback(
    async (pos: string) => {
      if (!draftId) return;
      setLoading(true);
      try {
        const query =
          pos === QUEUE_FILTER ? '&queued=1' : pos === ALL_FILTER ? '' : `&position=${pos}`;
        setBoard(await api.get<DraftBoard>(`/api/drafts/${draftId}/board?limit=40${query}`));
        setUpdatedAt(Date.now());
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [draftId],
  );

  useEffect(() => {
    void load(position);
  }, [load, position]);

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
    [load, position],
  );

  /**
   * Force-sync the live draft from Sleeper, then rebuild the board.
   *
   * This is the one control the draft header needs. It pulls the latest pick
   * stream through the same sync path the app has always used, and the board
   * request that follows is what recomputes the roster, the available pool, the
   * recommendation order, the tier-cliff and wait guidance and the roster
   * alerts — none of that logic is touched here.
   *
   * Failure is not allowed to cost the user their screen: the last good board
   * stays exactly where it is and the complaint is one quiet line.
   */
  const refreshNow = useCallback(async () => {
    if (!draftId || inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    setRefreshNote(null);
    try {
      if (unlocked) {
        const res = await api.post<{ status: string; pollIntervalSeconds: number }>(`/api/drafts/${draftId}/sync`);
        // A live draft keeps updating itself afterwards, at the interval the
        // server nominates; a finished one stops asking.
        setPollSeconds(res.pollIntervalSeconds > 0 ? res.pollIntervalSeconds : 0);
      }
      await load(position);
      setNow(Date.now());
      setError(null);
    } catch (err) {
      setRefreshNote(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, [draftId, load, position, unlocked]);

  /**
   * Automatic polling, unchanged in substance: while a draft is live the app
   * keeps pulling picks on its own at the interval the server sets. The manual
   * control above is a "now" button on top of it, not a replacement — and it is
   * what arms it, so a view-only reader never starts a background write loop.
   */
  useEffect(() => {
    if (!draftId || pollSeconds <= 0) return;
    let cancelled = false;
    let handle = window.setTimeout(async function tick() {
      if (cancelled || inFlight.current) {
        if (!cancelled) handle = window.setTimeout(tick, pollSeconds * 1000);
        return;
      }
      inFlight.current = true;
      try {
        const res = await api.post<{ status: string; pollIntervalSeconds: number }>(`/api/drafts/${draftId}/sync`);
        if (cancelled) return;
        await load(position);
        if (cancelled) return;
        setNow(Date.now());
        if (res.pollIntervalSeconds <= 0) setPollSeconds(0);
        else handle = window.setTimeout(tick, res.pollIntervalSeconds * 1000);
      } catch {
        // Nobody asked for this request, so it does not get to raise an alarm.
        if (!cancelled) {
          setPollSeconds(0);
          setRefreshNote('Automatic updates stopped. Tap refresh to try again.');
        }
      } finally {
        inFlight.current = false;
      }
    }, pollSeconds * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [draftId, load, pollSeconds, position]);

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
  if (!board && loading) return <Loading what="draft board" />;
  if (error && !board) return <Notice tone="error">{error}</Notice>;
  if (!board) return <Empty>No draft data.</Empty>;

  return (
    <>
      {/*
        One line of chrome, not a banner.

        The pick number, the round, the roster count and the draft status used
        to occupy a row of stat cards above everything else, which pushed the
        only thing the user is actually reading — the players — most of a screen
        down. Every number is still here, and still comes from the same board
        state; it is just said in a sentence instead of five boxes. Everything
        beyond the league name (scoring format, roster shape, snapshot label)
        moved into the details below, where it is available without costing the
        list any height.
      */}
      <div className="draft-bar">
        <strong data-testid="board-league-name" className="draft-league">
          {board.league.name}
        </strong>
        <span className="draft-status" data-testid="draft-status">
          <span className="draft-pick">#{board.currentPick}</span>
          <span className="faint">R{board.round}</span>
          <span className={board.onTheClock ? 'draft-turn draft-turn-now' : 'draft-turn'}>
            {board.picksUntilMyTurn == null ? '—' : board.onTheClock ? 'YOUR PICK' : `${board.picksUntilMyTurn} to go`}
          </span>
        </span>
        {updatedAt != null ? (
          <span className="draft-updated" data-testid="draft-updated">
            {formatShortAge(updatedAt, now)}
          </span>
        ) : null}
        {/*
          A reload glyph, not a connection switch. The old ▶ Live / ⏸ pair
          implied the user had to keep a link open; what they actually want is
          "show me what just happened", so that is what the control says.
        */}
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
      </div>

      {refreshNote ? (
        <div className="draft-refresh-note" data-testid="draft-refresh-note" role="status">
          {refreshNote} Showing the last draft state received.
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
      <div className="filter-row" role="group" aria-label="Filter by position">
        {[QUEUE_FILTER, ALL_FILTER, ...(board.startablePositions ?? [])].map((p) => (
          <button
            key={p}
            className={p === QUEUE_FILTER ? 'chip chip-queue' : 'chip'}
            aria-pressed={position === p}
            aria-label={p === QUEUE_FILTER ? 'Show only your queue' : undefined}
            data-testid={p === QUEUE_FILTER ? 'queue-filter' : undefined}
            onClick={() => setPosition(p)}
          >
            {p}
          </button>
        ))}
      </div>

      {/*
        No heading over the list.

        "RECOMMENDED (40)" cost a line of a phone screen to say what the ranked
        list already says by being ranked. The list keeps its accessible name so
        a screen reader still hears one; sighted readers get the players sooner.
      */}
      {board.recommendations.length === 0 ? (
        <Empty>
          {position === QUEUE_FILTER
            ? 'Your queue is empty. Tap the ☆ beside a player to add them.'
            : 'No available players match this filter.'}
        </Empty>
      ) : (
        <div
          role="list"
          aria-label={position === QUEUE_FILTER ? 'Your queue, best first' : 'Available players, best first'}
          data-testid="board-list"
        >
          {withTierDividers(board.recommendations, isSinglePosition).map((item) => (
            /* The divider goes above the row that opens the tier, not instead of it. */
            <Fragment key={item.rec.playerId}>
              {item.divider ? <TierDivider gap={item.rec.tierCliff.tierGapBefore} /> : null}
              <RecommendationRow
                rank={item.rank}
                rec={item.rec}
                showCliffProximity={!isSinglePosition}
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

/** The rows, each told whether a tier boundary falls above it. */
function withTierDividers(recs: DraftRecommendation[], enabled: boolean): BoardItem[] {
  const flags = enabled ? tierDividerFlags(recs.map((rec) => rec.tierCliff.tierIndex)) : [];
  return recs.map((rec, i) => ({ rec, rank: i + 1, divider: flags[i] === true }));
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
  onToggle,
  onQueue,
  busy,
}: {
  rank: number;
  rec: DraftRecommendation;
  expanded: boolean;
  /** Mixed-position boards tag the last of a tier; filtered ones draw the line. */
  showCliffProximity: boolean;
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
          <PositionBadge position={rec.position} team={rec.team} />
        </div>

        {/*
          The only tag left is the one that is a genuine warning. Take Now,
          Risky to Wait and Can Probably Wait were on nearly every row, which
          made a row of chips that told the reader nothing; the chance he
          reaches your next pick is a number and does the same job in less
          space. AVOID stays, because "the research is against him" is not
          something a percentage can say.
        */}
        <DecisionTags rec={rec} showCliffProximity={showCliffProximity} />

        <div className="player-row-metrics">
          <span className="metric">
            ADP <strong>{rec.adp == null ? <Unknown what="ADP" /> : rec.adp}</strong>
          </span>
          <span className="metric">
            Value{' '}
            <strong className={rec.adpValue == null ? '' : rec.adpValue > 0 ? 'sig-pos' : rec.adpValue < 0 ? 'sig-neg' : ''}>
              {rec.adpValue == null ? <Unknown what="value" /> : `${rec.adpValue > 0 ? '+' : ''}${rec.adpValue}`}
            </strong>
          </span>
          <SurvivalMetric probability={rec.survivalProbability} />
          {/*
            One signal, not two.

            Lifetime and 30-day were printed side by side on every row, so a
            player nobody has written about read "– 0 flat – 0 flat" — two
            columns of nothing on forty rows. The lifetime tally is the one that
            drives AVOID and the ranking, so it is the one that stays; the recent
            window appears only when it has something of its own to say, and both
            are always in the breakdown behind the tap.
          */}
          {rec.newsLifetimeNet !== 0 || rec.news30Net !== 0 ? (
            <Signal net={rec.newsLifetimeNet} label="lifetime news" />
          ) : null}
          {rec.news30Net !== 0 && rec.news30Net !== rec.newsLifetimeNet ? (
            <span className="metric">
              30d <Signal net={rec.news30Net} label="news, last 30 days" />
            </span>
          ) : null}
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

      {expanded ? <DraftPlayerDetail rec={rec} /> : null}
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
 * The expanded player.
 *
 * Rewritten around one rule: **it may not repeat the card it opened from.**
 *
 * It used to lead with a grid of ADP, value, survival and the news tally —
 * every one of which is printed two lines above, on the collapsed row, in the
 * same units. Four tiles of restated numbers is what made the expansion feel
 * like a diagnostics panel: the reader has already read them, so the first
 * thing the card does is waste their time.
 *
 * What it says instead is what the row cannot: why this rank, the single best
 * argument against, what is expected of him this season, and what he actually
 * did last season. Then the arithmetic, in full and folded away.
 *
 * Nothing here recalculates anything.
 */
function DraftPlayerDetail({ rec }: { rec: DraftRecommendation }) {
  const { detail, failed } = usePlayerDetail(rec.playerId);

  // Only the caution leads. The timing states used to headline this card as
  // "Take Now"; the survival percentage on the row says the same thing in a
  // number, and the sentence that gave it context is the first reason below.
  const verdict = rec.avoid.active ? draftVerdict(rec.avoid, rec.wait) : null;
  // Anything already said as the headline does not get said again as a bullet.
  const said = [verdict?.label, verdict?.detail, rec.avoid.active ? rec.avoid.trendNote : null];
  const reasons = withoutRepeats(rec.reasons, said);
  const counterpoints = withoutRepeats(rec.counterpoints, [...said, ...reasons]);
  const topReasons = reasons.slice(0, REASONS_SHOWN);
  const moreReasons = reasons.slice(REASONS_SHOWN);
  const cliffNote = saidAlready(rec.tierCliff.message, said) ? null : rec.tierCliff.message;

  return (
    <div className="explain" data-testid="player-detail">
      {verdict ? (
        <Verdict tone={verdict.tone} label={verdict.label} detail={verdict.detail} glyph={verdict.glyph} />
      ) : null}

      {topReasons.length > 0 ? (
        <>
          <DetailLabel>Why this rank</DetailLabel>
          <ReasonList items={topReasons} />
          {moreReasons.length > 0 ? (
            <details className="disclosure" data-testid="all-reasons">
              <summary>Show all reasons ({reasons.length})</summary>
              <ReasonList items={moreReasons} />
            </details>
          ) : null}
        </>
      ) : null}

      {/*
        One counterpoint, not a second list of reasons.

        Two were shown before, which turned the strongest argument against him
        into a pair of arguments of unequal weight — and the second was usually
        the first restated. When there genuinely is not one, saying so is worth
        a line: "nothing argues against him" is a real answer, and inventing a
        doubt to fill the space would be worse than silence.
      */}
      <DetailLabel>Counterpoint</DetailLabel>
      {counterpoints.length > 0 ? (
        <ReasonList muted items={counterpoints.slice(0, COUNTERPOINTS_SHOWN)} />
      ) : (
        <div className="muted" data-testid="no-counterpoint">
          No major counterpoint.
        </div>
      )}

      <SeasonOutlook detail={detail} failed={failed} />
      <LastSeasonLine detail={detail} failed={failed} position={rec.position} />

      {/*
        The user's own two marks, which the row shows as glyphs and never
        explains. Separate lines because they do separate things: the heart
        moved him up this board, and the star did not and is not claiming to.
      */}
      {rec.myGuy.level > 0 || rec.queued ? (
        <div className="decision-detail" data-testid="player-marks">
          {rec.myGuy.level > 0 ? (
            <div className="muted" data-testid="detail-my-guy">
              {rec.myGuy.stars} {rec.myGuy.label} — your own rating from the players list, separate from the news
              tally. It moves him up this board.
            </div>
          ) : null}
          {rec.queued ? (
            <div className="muted" data-testid="detail-queued">
              ★ In your queue — a bookmark for the ★ filter. It does not change his ranking.
            </div>
          ) : null}
        </div>
      ) : null}

      {/*
        Full explainability, kept in full and kept out of the way. Every
        component, its weight, its raw score and its contribution, exactly as
        the engine produced them — plus the three readings that used to sit
        above it and are reference rather than decision: where the market has
        this player's position breaking, what the season line implies, and the
        recent halves of a tally whose lifetime figure is already on the row.
      */}
      <details className="disclosure" data-testid="advanced-breakdown">
        <summary>Advanced breakdown</summary>

        {cliffNote || rec.marketBaseline?.points != null || rec.news30Net !== 0 || rec.news7Net !== 0 ? (
          <div className="decision-detail" data-testid="player-context">
            {cliffNote ? <div className="muted">{cliffNote}</div> : null}
            {rec.marketBaseline?.points != null ? (
              <div className="muted" data-testid="market-baseline">
                Season market implies <strong>{rec.marketBaseline.points}</strong> points in this league&rsquo;s
                scoring — {rec.marketBaseline.note}.
              </div>
            ) : null}
            {rec.news30Net !== 0 || rec.news7Net !== 0 ? (
              <div className="player-row-metrics" style={{ marginTop: 0 }}>
                <span className="metric">
                  30d <Signal net={rec.news30Net} label="news, last 30 days" />
                </span>
                <span className="metric">
                  7d <Signal net={rec.news7Net} label="news, last 7 days" />
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="components">
          {rec.components.map((c) => (
            <div className="component" key={c.key}>
              <span className="component-label">
                {c.label}
                {c.unknown ? ' (unknown)' : ''}
              </span>
              <span className="component-value">
                {c.contribution > 0 ? '+' : ''}
                {c.contribution.toFixed(2)}
              </span>
              <span className="component-detail">
                {c.display} · score {c.score.toFixed(2)} × weight {c.weight}
              </span>
            </div>
          ))}
          <div className="component">
            <span className="component-label">
              <strong>Total</strong>
            </span>
            <span className="component-value">
              <strong>{rec.total.toFixed(2)}</strong>
            </span>
          </div>
        </div>
      </details>
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
  return (
    <>
      <DetailLabel>{detail.outlook.title}</DetailLabel>
      <div className="outlook" data-testid="outlook">
        {detail.outlook.summary}
        {detail.outlook.source ? (
          <span className="outlook-source"> — {detail.outlook.source}, via Sleeper</span>
        ) : null}
      </div>
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

function SurvivalMetric({ probability }: { probability: number | null }) {
  const band = survivalBand(probability);
  if (probability == null) {
    return (
      <span className="metric">
        Next pick <Unknown what="survival" />
      </span>
    );
  }
  const pct = Math.round(probability * 100);
  return (
    <span className="metric" data-testid="survival">
      Next pick{' '}
      <strong
        className={`survival survival-${band}`}
        data-band={band}
        title={`${pct}% chance he is still available at your next pick`}
      >
        {pct}%
      </strong>
    </span>
  );
}

/**
 * The one tag worth a row's space.
 *
 * Everything else that used to sit here — the tier cliff, and the three wait
 * states — either says what the survival percentage already says, or is
 * reference rather than a decision. Both are still computed, still ranked on,
 * and still explained inside the expanded card; they just stopped being chips
 * on forty rows. Stars are not counted against the budget: they sit beside the
 * name, are the user's own mark, and are how they find who they were looking
 * for.
 */
function DecisionTags({ rec, showCliffProximity }: { rec: DraftRecommendation; showCliffProximity: boolean }) {
  const away = showCliffProximity ? tierCliffProximity(rec.tierCliff) : null;
  if (!rec.avoid.active && away == null) return null;
  return (
    <div className="tag-row" data-testid="decision-tags">
      {rec.avoid.active ? <AvoidBadge avoid={rec.avoid} /> : null}
      {away == null ? null : (
        <span
          className="tag tag-cliff"
          data-testid="tier-cliff-tag"
          data-away={away}
          title={
            away === 1
              ? `The last ${rec.position} left in the best group on the board`
              : `Two ${rec.position}s left in the best group on the board`
          }
        >
          Tier cliff · {away} away
        </span>
      )}
    </div>
  );
}
