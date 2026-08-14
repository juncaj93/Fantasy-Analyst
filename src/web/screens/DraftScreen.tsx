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

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type DraftBoard,
  type DraftRecommendation,
  type LeagueSummary,
  type MyGuyFlag,
  type RosterAlert,
} from '../api.ts';
import {
  Badge,
  DetailLabel,
  Empty,
  Loading,
  MetricGrid,
  Notice,
  PositionBadge,
  Signal,
  Stat,
  Unknown,
  formatDate,
  formatShortAge,
} from '../components/common.tsx';
import {
  AvoidBadge,
  MyGuyControl,
  ReasonList,
  TierCliffTag,
  Verdict,
  WaitTag,
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
/** Counterpoints are an argument, not a second recommendation. */
const COUNTERPOINTS_SHOWN = 2;

export function DraftScreen({ leagues, unlocked }: { leagues: LeagueSummary[]; unlocked: boolean }) {
  const selected = leagues.find((l) => l.isSelected) ?? null;
  const draftId = selected?.draftId ?? null;

  const [board, setBoard] = useState<DraftBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [position, setPosition] = useState(ALL_FILTER);
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
   * Star a player, then reload the board.
   *
   * The flag changes the ranking, so the honest thing is to show the board it
   * produces rather than leave the old order on screen with a new star on it.
   */
  const setMyGuy = useCallback(
    async (playerId: string, level: 0 | 1 | 2 | 3) => {
      setFlagging(playerId);
      try {
        await api.post<{ myGuy: MyGuyFlag }>(`/api/players/${playerId}/my-guy`, { level });
        await load(position);
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

      <RosterAlerts alerts={board.rosterAlerts ?? []} />

      {/*
        The league's settings and the draft-order provenance still matter — they
        drive every number on the screen — but they are reference, not the thing
        being read, so they fold away rather than sit above the list.
      */}
      <details className="draft-details">
        <summary className="muted">League and draft order</summary>
        <div className="badge-row">
          {board.adpSnapshot ? (
            <Badge>
              Draft order: {board.adpSnapshot.label} · {formatDate(board.adpSnapshot.capturedAt)}
            </Badge>
          ) : (
            <Badge>Draft order: Sleeper</Badge>
          )}
          <Badge>{board.league.scoringLabel}</Badge>
          <Badge>
            Round {board.round} of {board.rounds}
          </Badge>
          <Badge>{board.status.replace('_', ' ')}</Badge>
          <Badge>Roster {board.myRoster.length}</Badge>
          {Object.entries(board.rosterCounts).map(([pos, n]) => (
            <Badge key={pos}>
              {pos} {n}
            </Badge>
          ))}
        </div>
        <div className="faint" style={{ marginTop: 4 }}>
          {board.league.notes.join(' · ')}
        </div>
      </details>

      <div className="section-title" data-testid="recommended-heading">
        {position === QUEUE_FILTER ? 'Your queue' : 'Recommended'} ({board.recommendations.length})
      </div>
      {board.recommendations.length === 0 ? (
        <Empty>
          {position === QUEUE_FILTER
            ? 'Your queue is empty. Tap the ☆ beside a player to add them.'
            : 'No available players match this filter.'}
        </Empty>
      ) : (
        board.recommendations.map((rec, i) => (
          <RecommendationRow
            key={rec.playerId}
            rank={i + 1}
            rec={rec}
            expanded={expanded === rec.playerId}
            onToggle={() => setExpanded(expanded === rec.playerId ? null : rec.playerId)}
            onMyGuy={setMyGuy}
            busy={flagging === rec.playerId}
          />
        ))
      )}
    </>
  );
}

/**
 * The alerts the shape of the roster is producing.
 *
 * Capped at three. The screen is a phone during a draft, and a list of eight
 * things to worry about is the same as no advice at all — the loudest ones are
 * the ones worth the space. One status line, one strong sentence each, one
 * quiet one: this is guidance on the way to the list, so it stays shorter than
 * the list.
 */
function RosterAlerts({ alerts }: { alerts: RosterAlert[] }) {
  const order = { urgent: 0, warn: 1, info: 2 } as const;
  const shown = [...alerts].sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 3);
  if (shown.length === 0) return null;
  return (
    <div className="card card-tight" data-testid="roster-alerts">
      <div className="section-title" style={{ margin: '0 0 2px' }}>
        Your roster
      </div>
      {shown.map((alert) => (
        <div key={alert.key} className={`roster-alert roster-alert-${alert.severity}`} data-testid="roster-alert">
          <strong>{alert.message}</strong>
          <div className="faint">{alert.detail}</div>
        </div>
      ))}
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
  onToggle,
  onMyGuy,
  busy,
}: {
  rank: number;
  rec: DraftRecommendation;
  expanded: boolean;
  onToggle: () => void;
  onMyGuy: (playerId: string, level: 0 | 1 | 2 | 3) => void;
  busy: boolean;
}) {
  return (
    <div
      className={expanded ? 'player-row player-row-open' : 'player-row'}
      data-testid="recommendation-row"
      data-player-id={rec.playerId}
    >
      <button className="row-button" aria-expanded={expanded} onClick={onToggle}>
        <div className="player-row-top">
          <span className="rank">{rank}</span>
          <MyGuyControl myGuy={rec.myGuy} busy={busy} onChange={(level) => onMyGuy(rec.playerId, level)} />
          <span className="player-name">{rec.name}</span>
          <PositionBadge position={rec.position} team={rec.team} />
        </div>

        {/*
          At most two tags on the row itself, in the order that decides a pick:
          a caution outranks urgency, and urgency outranks everything else. The
          rest of the reasoning is one tap away rather than crowding the list.
        */}
        <DecisionTags rec={rec} />

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
          <span className="metric">
            Lasts{' '}
            <strong>
              {rec.survivalProbability == null ? <Unknown what="survival" /> : `${Math.round(rec.survivalProbability * 100)}%`}
            </strong>
          </span>
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
      </button>

      {expanded ? <DraftPlayerDetail rec={rec} /> : null}
    </div>
  );
}

/**
 * The expanded player.
 *
 * Ordered the way a pick is actually made: what the app concludes, the four
 * numbers behind it, the two or three strongest reasons, the best argument
 * against, then the market context. The component-by-component arithmetic is
 * unchanged and complete — it has simply stopped being the first thing the user
 * reads during a live draft, which is what it had become.
 *
 * Nothing here recalculates anything. Every string and number on screen comes
 * from the same board response as before.
 */
function DraftPlayerDetail({ rec }: { rec: DraftRecommendation }) {
  const verdict = draftVerdict(rec.avoid, rec.wait);
  // Anything already said as the headline does not get said again as a bullet.
  const said = [verdict?.label, verdict?.detail, rec.avoid.active ? rec.avoid.trendNote : null];
  const reasons = withoutRepeats(rec.reasons, said);
  const counterpoints = withoutRepeats(rec.counterpoints, [...said, ...reasons]);
  const topReasons = reasons.slice(0, REASONS_SHOWN);
  const moreReasons = reasons.slice(REASONS_SHOWN);
  const cliffNote = saidAlready(rec.tierCliff.message, said) ? null : rec.tierCliff.message;
  const hasContext = !!cliffNote || rec.news30Net !== 0 || rec.news7Net !== 0 || rec.myGuy.level > 0;

  return (
    <div className="explain" data-testid="player-detail">
      {verdict ? (
        <Verdict tone={verdict.tone} label={verdict.label} detail={verdict.detail} glyph={verdict.glyph} />
      ) : null}

      <MetricGrid>
        <Stat label="ADP" value={rec.adp == null ? <Unknown what="ADP" /> : rec.adp} />
        <Stat
          label="Value"
          value={
            rec.adpValue == null ? (
              <Unknown what="value" />
            ) : (
              <span className={rec.adpValue > 0 ? 'sig sig-pos' : rec.adpValue < 0 ? 'sig sig-neg' : 'sig sig-none'}>
                {rec.adpValue > 0 ? '+' : ''}
                {rec.adpValue}
              </span>
            )
          }
          hint="Picks between his draft-order rank and this pick"
        />
        <Stat
          label="Lasts"
          value={
            rec.survivalProbability == null ? (
              <Unknown what="survival" />
            ) : (
              `${Math.round(rec.survivalProbability * 100)}%`
            )
          }
          hint="Chance he is still there at your next pick"
        />
        <Stat label="Lifetime" value={<Signal net={rec.newsLifetimeNet} label="lifetime news" />} />
      </MetricGrid>

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

      {counterpoints.length > 0 ? (
        <>
          <DetailLabel>{counterpoints.length === 1 ? 'Counterpoint' : 'Counterpoints'}</DetailLabel>
          <ReasonList muted items={counterpoints.slice(0, COUNTERPOINTS_SHOWN)} />
        </>
      ) : null}

      {hasContext ? (
        <>
          <DetailLabel>Market &amp; trend</DetailLabel>
          <div className="decision-detail" data-testid="player-context">
            {cliffNote ? <div className="muted">{cliffNote}</div> : null}
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
            {rec.myGuy.level > 0 ? (
              <div className="muted">
                {rec.myGuy.stars} {rec.myGuy.label} — your own flag, separate from the news tally.
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {/*
        Full explainability, kept in full and kept out of the way. Every
        component, its weight, its raw score and its contribution, exactly as
        the engine produced them.
      */}
      <details className="disclosure" data-testid="advanced-breakdown">
        <summary>Advanced breakdown</summary>
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
 * The one or two tags that change what the user does with this row.
 *
 * Priority order is the order a person reads them in: a reason not to take him
 * at all, then a reason to take him now, then the fact that he can wait. Stars
 * are not counted against the budget — they sit beside the name, are the user's
 * own mark, and are how they find the player they were looking for.
 */
function DecisionTags({ rec }: { rec: DraftRecommendation }) {
  const tags: JSX.Element[] = [];
  if (rec.avoid.active) tags.push(<AvoidBadge key="avoid" avoid={rec.avoid} />);
  if (rec.tierCliff.severity !== 'none' && tags.length < 2) {
    tags.push(<TierCliffTag key="cliff" cliff={rec.tierCliff} />);
  }
  if (tags.length < 2 && rec.wait.state !== 'unknown') tags.push(<WaitTag key="wait" wait={rec.wait} />);
  if (tags.length === 0) return null;
  return (
    <div className="tag-row" data-testid="decision-tags">
      {tags}
    </div>
  );
}
