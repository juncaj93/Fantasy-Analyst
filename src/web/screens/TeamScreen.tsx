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

      <ConnectCard onDone={onLeaguesChanged} busy={busy} run={run} />

      <div className="section-title">Leagues</div>
      {leagues.length === 0 ? (
        <Empty>No leagues imported yet. Connect your Sleeper username above.</Empty>
      ) : (
        leagues.map((l) => (
          <div className="card card-tight" key={l.id} data-testid="league-card">
            <div className="header-row">
              <div>
                <strong>{l.name}</strong>
                <div className="faint">
                  {l.season} · {l.teams} teams · {l.scoringLabel}
                </div>
              </div>
              <button
                className={l.isSelected ? 'btn btn-sm' : 'btn btn-sm btn-primary'}
                disabled={l.isSelected || busy != null}
                onClick={() =>
                  run(`select-${l.id}`, async () => {
                    await api.post(`/api/leagues/${l.id}/select`);
                    onLeaguesChanged();
                    return `${l.name} selected and synced`;
                  })
                }
              >
                {l.isSelected ? '✓ Selected' : 'Select'}
              </button>
            </div>
            <div className="badge-row">
              {l.notes.map((n) => (
                <Badge key={n}>{n}</Badge>
              ))}
            </div>
          </div>
        ))
      )}

      <AdpCard busy={busy} run={run} />

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

function ConnectCard({
  onDone,
  busy,
  run,
}: {
  onDone: () => void;
  busy: string | null;
  run: (key: string, fn: () => Promise<string>) => Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [season, setSeason] = useState(String(new Date().getFullYear()));

  return (
    <div className="card">
      <div className="section-title" style={{ margin: '0 0 6px' }}>
        Sleeper connection
      </div>
      <div className="field">
        <label htmlFor="sleeper-username">Sleeper username</label>
        <input
          id="sleeper-username"
          value={username}
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(e) => setUsername(e.target.value)}
          placeholder="your sleeper handle"
        />
      </div>
      <div className="field">
        <label htmlFor="sleeper-season">Season</label>
        <input id="sleeper-season" value={season} inputMode="numeric" onChange={(e) => setSeason(e.target.value)} />
      </div>
      <div className="btn-row">
        <button
          className="btn btn-primary"
          disabled={!username || busy != null}
          onClick={() =>
            run('connect', async () => {
              const res = await api.post<{ leaguesImported: number }>('/api/sleeper/connect', { username, season });
              onDone();
              return `Imported ${res.leaguesImported} league(s) for ${season}`;
            })
          }
        >
          Connect
        </button>
        <button
          className="btn"
          disabled={busy != null}
          onClick={() =>
            run('players', async () => {
              const res = await api.post<{ written: number; total: number }>('/api/sleeper/sync-players');
              return `Synced ${res.written} players (${res.total} stored)`;
            })
          }
        >
          Sync players
        </button>
      </div>
      <div className="faint" style={{ marginTop: 6 }}>
        Player sync downloads the full Sleeper dictionary (~5MB). Run it once per day at most.
      </div>
    </div>
  );
}

function AdpCard({
  busy,
  run,
}: {
  busy: string | null;
  run: (key: string, fn: () => Promise<string>) => Promise<void>;
}) {
  const [content, setContent] = useState('');
  const [label, setLabel] = useState('');

  return (
    <div className="card">
      <div className="section-title" style={{ margin: '0 0 6px' }}>
        Underdog ADP snapshot
      </div>
      <div className="faint" style={{ marginBottom: 6 }}>
        Paste a same-day CSV or JSON export. The snapshot is frozen once imported; original source
        values are preserved.
      </div>
      <div className="field">
        <label htmlFor="adp-label">Label</label>
        <input id="adp-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Underdog ADP (today)" />
      </div>
      <div className="field">
        <label htmlFor="adp-content">CSV or JSON</label>
        <textarea
          id="adp-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="name,position,team,adp&#10;Ja'Marr Chase,WR,CIN,1.4"
        />
      </div>
      <button
        className="btn btn-primary"
        disabled={!content || busy != null}
        onClick={() =>
          run('adp', async () => {
            const res = await api.post<{
              created: boolean;
              matched: number;
              ambiguous: number;
              unmatched: number;
            }>('/api/adp/import', { content, label: label || undefined });
            setContent('');
            return res.created
              ? `Imported: ${res.matched} matched, ${res.ambiguous} ambiguous, ${res.unmatched} unmatched`
              : 'Identical snapshot already imported (no duplicate created)';
          })
        }
      >
        Import ADP
      </button>
    </div>
  );
}
