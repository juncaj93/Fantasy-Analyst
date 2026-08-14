/**
 * Draft Room.
 *
 * Above the fold: draft state, picks until your turn, top recommendations.
 * Tap a player to reveal the component breakdown and the reasoning.
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
import { Badge, Empty, Loading, Notice, PositionBadge, Signal, Unknown, formatDate } from '../components/common.tsx';
import { AvoidBadge, MyGuyControl, TierCliffTag, WaitTag } from '../components/decisions.tsx';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

export function DraftScreen({ leagues }: { leagues: LeagueSummary[] }) {
  const selected = leagues.find((l) => l.isSelected) ?? null;
  const draftId = selected?.draftId ?? null;

  const [board, setBoard] = useState<DraftBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [position, setPosition] = useState('ALL');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [autoPoll, setAutoPoll] = useState(false);
  const [flagging, setFlagging] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(
    async (pos: string) => {
      if (!draftId) return;
      setLoading(true);
      try {
        const query = pos === 'ALL' ? '' : `&position=${pos}`;
        setBoard(await api.get<DraftBoard>(`/api/drafts/${draftId}/board?limit=40${query}`));
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

  // Poll Sleeper for new picks while the draft is live. Interval comes from the
  // server so an inactive draft stops burning requests.
  useEffect(() => {
    if (!autoPoll || !draftId) return;
    const tick = async () => {
      try {
        const res = await api.post<{ status: string; pollIntervalSeconds: number }>(`/api/drafts/${draftId}/sync`);
        await load(position);
        if (res.pollIntervalSeconds <= 0) setAutoPoll(false);
        else timer.current = window.setTimeout(tick, res.pollIntervalSeconds * 1000);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setAutoPoll(false);
      }
    };
    void tick();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [autoPoll, draftId, load, position]);

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
        <button className="btn btn-sm" onClick={() => setAutoPoll((v) => !v)}>
          {autoPoll ? '⏸' : '▶ Live'}
        </button>
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {board.warnings.map((w) => (
        <Notice key={w}>{w}</Notice>
      ))}

      <div className="filter-row" role="group" aria-label="Filter by position">
        {POSITIONS.map((p) => (
          <button key={p} className="chip" aria-pressed={position === p} onClick={() => setPosition(p)}>
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
        Recommended ({board.recommendations.length})
      </div>
      {board.recommendations.length === 0 ? (
        <Empty>No available players match this filter.</Empty>
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
 * the ones worth the space.
 */
function RosterAlerts({ alerts }: { alerts: RosterAlert[] }) {
  const order = { urgent: 0, warn: 1, info: 2 } as const;
  const shown = [...alerts].sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 3);
  if (shown.length === 0) return null;
  return (
    <div className="card card-tight" data-testid="roster-alerts">
      <div className="section-title">Your roster</div>
      {shown.map((alert) => (
        <div key={alert.key} className={`roster-alert roster-alert-${alert.severity}`} data-testid="roster-alert">
          <strong>{alert.message}</strong>
          <div className="faint">{alert.detail}</div>
        </div>
      ))}
    </div>
  );
}

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
    <button
      className="player-row"
      aria-expanded={expanded}
      onClick={onToggle}
      data-testid="recommendation-row"
      data-player-id={rec.playerId}
    >
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

      {expanded ? (
        <div className="explain">
          {/* The full decision picture, only once the user asked for it. */}
          {rec.tierCliff.message || rec.avoid.trendNote || rec.wait.state !== 'unknown' ? (
            <div className="decision-detail">
              {rec.avoid.active ? <div className="sig-neg">{rec.avoid.message}</div> : null}
              {rec.avoid.trendNote ? <div className="muted">{rec.avoid.trendNote}</div> : null}
              {rec.tierCliff.message ? <div>{rec.tierCliff.message}</div> : null}
              {rec.wait.state !== 'unknown' ? (
                <div>
                  <strong>{rec.wait.label}</strong> — {rec.wait.detail}
                </div>
              ) : null}
            </div>
          ) : null}
          <strong style={{ fontSize: '0.8rem' }}>Why</strong>
          <ul>
            {rec.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {rec.counterpoints.length > 0 ? (
            <>
              <strong style={{ fontSize: '0.8rem' }}>Counterpoints</strong>
              <ul>
                {rec.counterpoints.map((c) => (
                  <li key={c} className="muted">
                    {c}
                  </li>
                ))}
              </ul>
            </>
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
        </div>
      ) : null}
    </button>
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
