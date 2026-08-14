/**
 * Player Intelligence: search, tallies by window, category breakdown and the
 * full evidence timeline (every item preserved, never just an aggregate).
 */

import { useEffect, useState } from 'react';
import { api, type EvidenceItem, type MyGuyFlag, type PlayerSignal } from '../api.ts';
import { Badge, Empty, Loading, PositionBadge, Signal, Unknown, formatDate } from '../components/common.tsx';
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

interface PlayerDetail {
  player: { id: string; name: string; position: string; team: string; status: string | null; aliases: string[] };
  signal: PlayerSignal;
  evidence: EvidenceItem[];
  props: { market: string; line: number | null; bookCount: number; impliedProbability: number | null }[];
  myGuy?: MyGuyFlag;
}

export function PlayersScreen() {
  const [query, setQuery] = useState('');
  const [players, setPlayers] = useState<PlayerListItem[]>([]);
  const [detail, setDetail] = useState<PlayerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [flagging, setFlagging] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.get<{ players: PlayerListItem[] }>(`/api/players?q=${encodeURIComponent(query)}`);
        if (!cancelled) setPlayers(res.players);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query]);

  const open = async (id: string) => {
    setDetail(await api.get<PlayerDetail>(`/api/players/${id}`));
  };

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

  if (detail) {
    return <PlayerDetailView detail={detail} onBack={() => setDetail(null)} />;
  }

  return (
    <>
      <div className="field" style={{ marginTop: 4 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search players"
          aria-label="Search players"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>
      {loading && players.length === 0 ? (
        <Loading what="players" />
      ) : players.length === 0 ? (
        <Empty>No players found. Run a Sleeper player sync from the Team screen.</Empty>
      ) : (
        players.map((p) => (
          <button
            className="player-row"
            key={p.id}
            onClick={() => void open(p.id)}
            data-testid="player-search-row"
            data-player-id={p.id}
          >
            <div className="player-row-top">
              <span className="rank" aria-hidden="true">
                {p.adjustedRank == null ? '—' : Math.round(p.adjustedRank)}
              </span>
              {/*
                A heart here, a star on the draft board — one stored value.
                Nobody is drafting on this screen, so the question is simply who
                you rate; heart a player now and he is queued when it opens.
              */}
              <MyGuyControl
                icon="heart"
                myGuy={p.myGuy ?? EMPTY_MY_GUY}
                busy={flagging === p.id}
                onChange={(level) => void setMyGuy(p.id, level)}
              />
              <span className="player-name">{p.name}</span>
              <PositionBadge position={p.position} team={p.team} />
            </div>
            <div className="player-row-metrics">
              <Signal net={p.signal?.raw.net ?? 0} items={p.signal?.raw.items ?? 0} label="lifetime" />
              <span className="metric">
                21d <strong>{p.signal?.last30.net ?? 0}</strong>
              </span>
              {/* Say where the order came from, and what the news changed. */}
              {p.draftRank != null ? (
                <span className="metric">
                  Sleeper <strong>{p.draftRank}</strong>
                </span>
              ) : (
                <span className="metric faint">unranked</span>
              )}
              {p.movement ? (
                <Badge tone={p.movement > 0 ? 'pos' : 'neg'}>
                  {p.movement > 0 ? `▲ ${p.movement}` : `▼ ${Math.abs(p.movement)}`}
                </Badge>
              ) : null}
              {p.status ? <Badge tone="warn">{p.status}</Badge> : null}
              {(p.signal?.pendingCount ?? 0) > 0 ? <Badge tone="warn">{p.signal!.pendingCount} to review</Badge> : null}
            </div>
          </button>
        ))
      )}
    </>
  );
}

function PlayerDetailView({ detail, onBack }: { detail: PlayerDetail; onBack: () => void }) {
  const { player, signal, evidence, props } = detail;
  return (
    <>
      <button className="btn btn-sm" onClick={onBack} style={{ marginBottom: 8 }}>
        ← Back
      </button>

      <div className="card">
        <div className="header-row">
          <div>
            <strong style={{ fontSize: '1.05rem' }}>{player.name}</strong>
            <div className="faint">
              <PositionBadge position={player.position} team={player.team} />
              {player.status ? ` · ${player.status}` : ''}
            </div>
          </div>
          <Signal net={signal.raw.net} items={signal.raw.items} label="lifetime" />
        </div>
        <table className="compact" style={{ marginTop: 6 }}>
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
          <div className="badge-row">
            <Badge tone="warn">{signal.pendingCount} item(s) awaiting review — excluded from tallies</Badge>
          </div>
        ) : null}
      </div>

      {Object.keys(signal.categoryBreakdown).length > 0 ? (
        <div className="card card-tight">
          <div className="section-title" style={{ margin: 0 }}>
            Categories
          </div>
          <div className="badge-row">
            {Object.entries(signal.categoryBreakdown).map(([cat, v]) => (
              <Badge key={cat} tone={v.positive > v.negative ? 'pos' : v.negative > v.positive ? 'neg' : 'neutral'}>
                {cat}: +{v.positive} / −{v.negative}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      <div className="section-title">Vegas props</div>
      {props.length === 0 ? (
        <div className="card card-tight muted">
          No prop data cached for this player. <Unknown what="Vegas expectation" />
        </div>
      ) : (
        <div className="card card-tight">
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
        </div>
      )}

      <div className="section-title" data-testid="evidence-heading">
        Evidence timeline ({evidence.length})
      </div>
      {evidence.length === 0 ? (
        <Empty>No evidence recorded yet.</Empty>
      ) : (
        evidence.map((e) => <EvidenceRow key={e.id} item={e} />)
      )}
    </>
  );
}

export function EvidenceRow({ item }: { item: EvidenceItem }) {
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
