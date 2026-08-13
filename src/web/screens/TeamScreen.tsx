/**
 * Team screen: Sleeper connection, league selection, roster, ADP import and
 * the start/sit comparison.
 *
 * There is no lineup-editing control anywhere here — the app never changes a
 * fantasy lineup.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type LeagueSummary,
  type RosterPlayer,
  type StartSitComparison,
} from '../api.ts';
import { Badge, Empty, Loading, Notice, Signal, Unknown, formatAge } from '../components/common.tsx';

interface RosterResponse {
  league: { id: string; name: string; scoringLabel: string; notes: string[] };
  starters: RosterPlayer[];
  bench: RosterPlayer[];
  found: boolean;
}

export function TeamScreen({
  leagues,
  onLeaguesChanged,
}: {
  leagues: LeagueSummary[];
  onLeaguesChanged: () => void;
}) {
  const selected = leagues.find((l) => l.isSelected) ?? null;
  const [roster, setRoster] = useState<RosterResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [comparison, setComparison] = useState<StartSitComparison | null>(null);

  const loadRoster = useCallback(async () => {
    if (!selected) return;
    try {
      setRoster(await api.get<RosterResponse>(`/api/leagues/${selected.id}/roster`));
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }, [selected]);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setMessage(null);
    try {
      setMessage({ tone: 'ok', text: await fn() });
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const toggleCompare = (playerId: string) => {
    setComparison(null);
    setCompareIds((prev) =>
      prev.includes(playerId) ? prev.filter((id) => id !== playerId) : [...prev, playerId].slice(-3),
    );
  };

  const compare = () =>
    run('compare', async () => {
      const result = await api.post<StartSitComparison>('/api/startsit/compare', {
        leagueId: selected?.id,
        playerIds: compareIds,
      });
      setComparison(result);
      return result.recommendedPlayerId
        ? `Recommendation ready (${result.confidence} confidence)`
        : 'No recommendation: insufficient data';
    });

  return (
    <>
      {message ? <Notice tone={message.tone === 'ok' ? 'ok' : message.tone === 'error' ? 'error' : 'warn'}>{message.text}</Notice> : null}

      {selected ? (
        <div className="card card-tight" data-testid="league-card">
          <div className="header-row">
            <div>
              <strong>{selected.name}</strong>
              <div className="faint">
                {selected.season} · {selected.teams} teams · {selected.scoringLabel}
              </div>
            </div>
            <button
              className="btn btn-sm"
              disabled={busy != null}
              onClick={() =>
                run('sync', async () => {
                  await api.post(`/api/leagues/${selected.id}/sync`);
                  onLeaguesChanged();
                  await loadRoster();
                  return 'Roster refreshed from Sleeper.';
                })
              }
            >
              {busy === 'sync' ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          <div className="badge-row">
            {selected.notes.map((n) => (
              <Badge key={n}>{n}</Badge>
            ))}
          </div>
        </div>
      ) : (
        <Empty>No league chosen yet. Open Setup to connect Sleeper and pick your league.</Empty>
      )}

      {selected ? (
        <>
          <div className="section-title">Roster — {selected.name}</div>
          {!roster ? (
            <Loading what="roster" />
          ) : !roster.found ? (
            <Empty>Your roster was not found in this league. Check the connected Sleeper user.</Empty>
          ) : (
            <>
              <div className="faint" style={{ margin: '0 2px 6px' }}>
                Tap players to compare start/sit (2–3).
              </div>
              <div className="section-title">Starters</div>
              {roster.starters.map((p) => (
                <RosterRow key={p.playerId} player={p} selected={compareIds.includes(p.playerId)} onToggle={toggleCompare} />
              ))}
              <div className="section-title">Bench</div>
              {roster.bench.map((p) => (
                <RosterRow key={p.playerId} player={p} selected={compareIds.includes(p.playerId)} onToggle={toggleCompare} />
              ))}

              {compareIds.length >= 2 ? (
                <div className="card">
                  <button className="btn btn-primary" onClick={compare} disabled={busy === 'compare'}>
                    Compare {compareIds.length} players
                  </button>
                </div>
              ) : null}

              {comparison ? <ComparisonCard comparison={comparison} /> : null}
            </>
          )}
        </>
      ) : null}
    </>
  );
}

function RosterRow({
  player,
  selected,
  onToggle,
}: {
  player: RosterPlayer;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <button
      className="player-row"
      aria-expanded={selected}
      onClick={() => onToggle(player.playerId)}
      data-testid="roster-row"
      data-player-id={player.playerId}
    >
      <div className="player-row-top">
        <span className="rank">{selected ? '✓' : ''}</span>
        <span className="player-name">{player.name}</span>
        <span className="pos-team">
          {player.position} · {player.team || 'FA'}
        </span>
      </div>
      <div className="player-row-metrics">
        <Signal net={player.recentNet} label="recent news (21d)" />
        <span className="metric">
          Lifetime <strong>{player.newsNet > 0 ? `+${player.newsNet}` : player.newsNet}</strong>
        </span>
        {player.status ? <Badge tone="warn">{player.status}</Badge> : null}
        {player.pending > 0 ? <Badge tone="warn">{player.pending} to review</Badge> : null}
      </div>
    </button>
  );
}

function ComparisonCard({ comparison }: { comparison: StartSitComparison }) {
  const winner = comparison.evaluations.find((e) => e.playerId === comparison.recommendedPlayerId);
  return (
    <div className="card" data-testid="comparison">
      <div className="header-row">
        <strong data-testid="comparison-verdict">
          {winner ? `Start ${winner.name}` : 'No recommendation'}
        </strong>
        <Badge tone={comparison.confidence === 'high' ? 'pos' : comparison.confidence === 'low' ? 'neg' : 'warn'}>
          {comparison.confidence} confidence
        </Badge>
      </div>
      <div className="faint">
        Vegas data {comparison.dataFreshness.provider ?? 'none'} · {formatAge(comparison.dataFreshness.fetchedAt)}
      </div>

      {comparison.warnings.map((w) => (
        <Notice key={w}>{w}</Notice>
      ))}

      {comparison.reasons.length > 0 ? (
        <ul style={{ paddingLeft: 16, margin: '6px 0' }}>
          {comparison.reasons.map((r) => (
            <li key={r} style={{ fontSize: '0.8rem' }}>
              {r}
            </li>
          ))}
        </ul>
      ) : null}

      <table className="compact">
        <thead>
          <tr>
            <th>Player</th>
            <th>Vegas</th>
            <th>Score</th>
            <th>Coverage</th>
          </tr>
        </thead>
        <tbody>
          {comparison.evaluations.map((e) => (
            <tr key={e.playerId}>
              <td>
                {e.playerId === comparison.recommendedPlayerId ? '★ ' : ''}
                {e.name}
              </td>
              <td>{e.expectation.points == null ? <Unknown what="Vegas expectation" /> : e.expectation.points.toFixed(1)}</td>
              <td>{e.score == null ? <Unknown what="score" /> : e.score.toFixed(1)}</td>
              <td>{Math.round(e.expectation.coverage * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>

      {comparison.evaluations.map((e) => (
        <details key={e.playerId} style={{ marginTop: 6 }}>
          <summary className="muted">{e.name} breakdown</summary>
          <div className="components">
            {e.components.map((c) => (
              <div className="component" key={c.key}>
                <span className="component-label">
                  {c.label}
                  {c.unknown ? ' (unknown)' : ''}
                </span>
                <span className="component-value">{c.value.toFixed(2)}</span>
                <span className="component-detail">{c.display}</span>
              </div>
            ))}
          </div>
          {e.expectation.contributions.length > 0 ? (
            <div className="components">
              {e.expectation.contributions.map((c) => (
                <div className="component" key={c.market}>
                  <span className="component-label">{c.market}</span>
                  <span className="component-value">{c.points.toFixed(2)}</span>
                  <span className="component-detail">{c.detail}</span>
                </div>
              ))}
            </div>
          ) : null}
          {e.expectation.notes.map((n) => (
            <div className="faint" key={n}>
              {n}
            </div>
          ))}
        </details>
      ))}
    </div>
  );
}
