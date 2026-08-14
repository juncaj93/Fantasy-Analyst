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
  Notice,
  PositionBadge,
  Unknown,
  formatShortAge,
  positionCardClass,
} from '../components/common.tsx';
import { NavBar, SegmentedControl, SkeletonRows } from '../components/native.tsx';
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
/* What Sleeper says about a player's availability right now. Never a ranking input. */
import { injuryStatusTag } from '../../core/draft/injury.ts';
import { AvoidBadge, QueueControl } from '../components/decisions.tsx';

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

  return (
    <>
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
        title={<span data-testid="board-league-name">{board.league.name}</span>}
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
            {updatedAt != null ? (
              <span className="draft-updated" data-testid="draft-updated">
                {formatShortAge(updatedAt, now)}
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
      <SegmentedControl
        label="Filter by position"
        value={position}
        onChange={setPosition}
        segments={[QUEUE_FILTER, ALL_FILTER, ...(board.startablePositions ?? [])].map((p) => ({
          id: p,
          label: p,
          ...(p === QUEUE_FILTER
            ? { ariaLabel: 'Show only your queue', className: 'chip-queue', testId: 'queue-filter' }
            : {}),
        }))}
      />

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
          The only tag left is the one that is a genuine warning. Take Now,
          Risky to Wait and Can Probably Wait were on nearly every row, which
          made a row of chips that told the reader nothing; the chance he
          reaches your next pick is a number and does the same job in less
          space. AVOID stays, because "the research is against him" is not
          something a percentage can say.
        */}
        <DecisionTags rec={rec} showCliffProximity={showCliffProximity} />

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
            <strong className={rec.adpValue == null ? '' : rec.adpValue > 0 ? 'sig-pos' : rec.adpValue < 0 ? 'sig-neg' : ''}>
              {rec.adpValue == null ? <Unknown what="value" /> : `${rec.adpValue > 0 ? '+' : ''}${rec.adpValue}`}
            </strong>
          </span>
          <SurvivalMetric probability={rec.survivalProbability} horizonPick={horizonPick} />
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
 * `Q`, `D`, `OUT`, `IR` — beside the name, without expanding anything.
 *
 * This is the one fact about a player that can change a pick before any of the
 * numbers do, and it was previously invisible on the board: it lived in the
 * player dictionary and appeared on the Players screen, which is not where
 * drafting happens.
 *
 * Two letters at most, because forty rows have room for two letters. The word
 * is in the accessible name and the tooltip, so the colour is an accelerator
 * and never the thing carrying the meaning — the same rule the position tint
 * follows. A healthy player renders nothing at all: a badge on every row is a
 * badge that means nothing.
 */
function InjuryTag({ status }: { status: string | null }) {
  const tag = injuryStatusTag(status);
  if (!tag) return null;
  return (
    <span
      className={`injury-tag injury-${tag.tone}`}
      data-testid="injury-tag"
      data-status={tag.code}
      title={tag.label}
      aria-label={tag.label}
    >
      {tag.code}
    </span>
  );
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
