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
import { api, type DraftBoard, type DraftRecommendation, type LeagueSummary } from '../api.ts';
import { Badge, Empty, Loading, Notice, Signal, Stat, Unknown, formatDate } from '../components/common.tsx';

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
      <div className="statusbar">
        <Stat label="Pick" value={`#${board.currentPick}`} hint="current overall pick" />
        <Stat
          label="Until you"
          value={board.picksUntilMyTurn == null ? '—' : board.onTheClock ? 'NOW' : board.picksUntilMyTurn}
          hint="picks until your next selection"
        />
        <Stat label="Round" value={board.teams > 0 ? Math.ceil(board.currentPick / board.teams) : '—'} />
        <Stat label="Roster" value={board.myRoster.length} hint="players you have drafted" />
        <Stat label="Status" value={board.status.replace('_', ' ')} />
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {board.warnings.map((w) => (
        <Notice key={w}>{w}</Notice>
      ))}

      <div className="card card-tight">
        <div className="header-row">
          <div>
            <strong data-testid="board-league-name">{board.league.name}</strong>
            <div className="faint">{board.league.notes.join(' · ')}</div>
          </div>
          <button className="btn btn-sm" onClick={() => setAutoPoll((v) => !v)}>
            {autoPoll ? '⏸ Stop' : '▶ Live'}
          </button>
        </div>
        <div className="badge-row">
          {/* Where the draft order came from, named honestly. */}
          {board.adpSnapshot ? (
            <Badge>
              Draft order: {board.adpSnapshot.label} · {formatDate(board.adpSnapshot.capturedAt)}
            </Badge>
          ) : (
            <Badge>Draft order: Sleeper</Badge>
          )}
          {Object.entries(board.rosterCounts).map(([pos, n]) => (
            <Badge key={pos}>
              {pos} {n}
            </Badge>
          ))}
        </div>
      </div>

      <div className="filter-row" role="group" aria-label="Filter by position">
        {POSITIONS.map((p) => (
          <button key={p} className="chip" aria-pressed={position === p} onClick={() => setPosition(p)}>
            {p}
          </button>
        ))}
      </div>

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
          />
        ))
      )}
    </>
  );
}

function RecommendationRow({
  rank,
  rec,
  expanded,
  onToggle,
}: {
  rank: number;
  rec: DraftRecommendation;
  expanded: boolean;
  onToggle: () => void;
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
        <span className="player-name">{rec.name}</span>
        <span className="pos-team">
          {rec.position} · {rec.team || 'FA'}
        </span>
      </div>
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
        <Signal net={rec.newsRecentNet} label="recent news (21d)" />
      </div>

      {expanded ? (
        <div className="explain">
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
