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
  type LineupRecommendation,
  type RosterPlayer,
  type StartSitComparison,
} from '../api.ts';
import {
  Badge,
  Confidence,
  Empty,
  formatAge,
  Loading,
  Notice,
  PositionBadge,
  Signal,
  Unknown,
} from '../components/common.tsx';

interface OpenSlot {
  slot: string;
  count: number;
  accepts: string[];
}

interface RosterResponse {
  league: { id: string; name: string; scoringLabel: string; notes: string[] };
  starters: RosterPlayer[];
  bench: RosterPlayer[];
  /** True while the draft is running: `drafted` is the current truth, not `starters`. */
  live: boolean;
  drafted: (RosterPlayer & { pickNo: number | null })[];
  counts: Record<string, number>;
  filled: number;
  remaining: number;
  openStarters: OpenSlot[];
  picksMade: number;
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
  const [lineup, setLineup] = useState<LineupRecommendation | null>(null);

  const loadRoster = useCallback(async () => {
    if (!selected) return;
    try {
      setRoster(await api.get<RosterResponse>(`/api/leagues/${selected.id}/roster`));
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }, [selected]);

  const loadLineup = useCallback(async () => {
    if (!selected) return;
    try {
      setLineup(await api.get<LineupRecommendation>(`/api/leagues/${selected.id}/lineup`));
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }, [selected]);

  useEffect(() => {
    void loadRoster();
    void loadLineup();
  }, [loadRoster, loadLineup]);

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
                  await loadLineup();
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

      {selected && lineup?.found ? <LineupCard lineup={lineup} /> : null}

      {selected ? (
        <>
          <div className="section-title">Roster — {selected.name}</div>
          {!roster ? (
            <Loading what="roster" />
          ) : !roster.found ? (
            <Empty>Your roster was not found in this league. Check the connected Sleeper user.</Empty>
          ) : (
            <>
              {/*
                During a draft the live view goes first, because that is the
                current truth. It is added to rather than swapped in: if Sleeper
                also has a settled lineup, hiding it would take away the
                start/sit comparison for no reason.
              */}
              {roster.live ? <LiveDraftRoster roster={roster} /> : null}

              {roster.starters.length > 0 || roster.bench.length > 0 ? (
                <>
                  <div className="faint" style={{ margin: '0 2px 6px' }}>
                    Tap players to compare start/sit (2–3).
                  </div>
                  <div className="section-title">Starters</div>
                  {roster.starters.map((p) => (
                    <RosterRow
                      key={p.playerId}
                      player={p}
                      selected={compareIds.includes(p.playerId)}
                      onToggle={toggleCompare}
                    />
                  ))}
                  <div className="section-title">Bench</div>
                  {roster.bench.map((p) => (
                    <RosterRow
                      key={p.playerId}
                      player={p}
                      selected={compareIds.includes(p.playerId)}
                      onToggle={toggleCompare}
                    />
                  ))}
                </>
              ) : null}

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

/**
 * Whole-roster start/sit.
 *
 * The changes come first, because that is the only part that asks anything of
 * the reader. The full recommended lineup sits below it for context. Nothing
 * here can alter a lineup — Sleeper is still where a change is made.
 */
function LineupCard({ lineup }: { lineup: LineupRecommendation }) {
  const gain =
    lineup.currentPoints == null ? null : Math.round((lineup.recommendedPoints - lineup.currentPoints) * 10) / 10;

  return (
    <div className="card" data-testid="lineup-card">
      <div className="header-row">
        <strong>This week&rsquo;s lineup</strong>
        <Confidence level={lineup.confidence} />
      </div>

      {lineup.swaps.length === 0 ? (
        <div className="faint" data-testid="lineup-verdict">
          {lineup.currentPoints == null
            ? 'No changes to suggest from what is known so far.'
            : 'Your lineup already matches the recommendation.'}
        </div>
      ) : (
        <>
          <div className="faint" data-testid="lineup-verdict">
            {lineup.swaps.length} change{lineup.swaps.length === 1 ? '' : 's'} to consider
            {gain != null && gain > 0 ? ` · worth about ${gain} pts` : ''}
          </div>
          {/*
            A swap is a sentence, not a box. The card used to hold a bordered
            card per change, which made three suggestions look like three
            separate screens; an accent rule and the type do the same job in a
            third of the height.
          */}
          {lineup.swaps.map((s) => (
            <div className="swap" key={`${s.inPlayerId}-${s.outPlayerId}`} data-testid="lineup-swap">
              <div>
                <strong>Start {s.inName}</strong> over {s.outName} <span className="faint">({s.slot})</span>
              </div>
              <div className="faint">
                +{s.gain} pts · {s.reason}
              </div>
            </div>
          ))}
          <div className="faint" style={{ margin: '6px 2px 0' }}>
            Make changes in Sleeper — this app never edits a lineup.
          </div>
        </>
      )}

      {/*
        Missing data is ordinary, not an incident: it gets a caution rule and a
        readable sentence rather than an inset warning box.
      */}
      {lineup.warnings.map((w) => (
        <div className="hint hint-caution" key={w}>
          {w}
        </div>
      ))}

      <details className="disclosure">
        <summary>Recommended lineup in full</summary>
        <table className="compact">
          <thead>
            <tr>
              <th>Slot</th>
              <th>Player</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {lineup.slots.map((s, i) => (
              <tr key={`${s.slot}-${i}`}>
                <td>{s.slot}</td>
                <td>
                  {s.name ?? <Unknown what="nobody eligible" />}
                  {/* A locked slot is settled, so it never carries a change arrow. */}
                  {s.locked ? <span className="tag tag-calm" data-testid="locked-tag"> 🔒 Locked</span> : null}
                  {s.name && !s.alreadyStarting && !s.locked ? ' ←' : ''}
                </td>
                <td>{s.score == null ? <Unknown what="score" /> : s.score.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {lineup.bench.length > 0 ? (
          <div className="faint" style={{ marginTop: 6 }}>
            Bench: {lineup.bench.map((e) => `${e.name} (${e.score?.toFixed(1) ?? '—'})`).join(', ')}
          </div>
        ) : null}
        {lineup.undecidable.length > 0 ? (
          <div className="faint" style={{ marginTop: 6 }}>
            Not enough data to rank: {lineup.undecidable.map((e) => e.name).join(', ')}
          </div>
        ) : null}
        {lineup.notes.map((n) => (
          <div className="faint" key={n}>
            {n}
          </div>
        ))}
      </details>
    </div>
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
        <PositionBadge position={player.position} team={player.team} />
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
        <Confidence level={comparison.confidence} />
      </div>
      <div className="faint">
        Vegas data {comparison.dataFreshness.provider ?? 'none'} · {formatAge(comparison.dataFreshness.fetchedAt)}
      </div>

      {/*
        Compact tags for the two things a projection cannot express: whether
        kickoff timing is a problem, and whether the market has moved since the
        last look. The numbers behind them are in the reasons and warnings
        below rather than repeated here.
      */}
      <div className="tag-row">
        {comparison.lateSwap && comparison.lateSwap.verdict !== 'no_risk' && comparison.lateSwap.verdict !== 'unknown' ? (
          <span
            className={comparison.lateSwap.verdict === 'consider_early_option' ? 'tag tag-urgent' : 'tag tag-calm'}
            title={comparison.lateSwap.detail}
            data-testid="late-swap-tag"
          >
            ⏱ {comparison.lateSwap.label}
          </span>
        ) : null}
        {comparison.evaluations
          .filter((e) => e.movement?.headline)
          .map((e) => (
            <span
              key={`move-${e.playerId}`}
              className={e.movement.direction === 'up' ? 'tag tag-star' : 'tag tag-warn'}
              title={e.movement.significant.map((m) => m.display).join('; ')}
              data-testid="movement-tag"
            >
              {e.movement.direction === 'up' ? '↑' : '↓'} {e.name}: {e.movement.headline}
            </span>
          ))}
        {comparison.evaluations
          .filter((e) => e.lock?.locked)
          .map((e) => (
            <span key={`lock-${e.playerId}`} className="tag tag-calm" data-testid="locked-tag">
              🔒 {e.name} locked
            </span>
          ))}
      </div>

      {comparison.warnings.map((w) => (
        <div className="hint hint-caution" key={w}>
          {w}
        </div>
      ))}

      {comparison.reasons.length > 0 ? (
        <ul className="reason-list" style={{ margin: '8px 0' }}>
          {comparison.reasons.map((r) => (
            <li key={r}>{r}</li>
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
        <details className="disclosure" key={e.playerId}>
          <summary>{e.name} breakdown</summary>
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


/**
 * The roster during an active draft.
 *
 * Deliberately not a starters/bench split: mid-draft nobody has decided who
 * starts, and showing a lineup would invent that decision. Players held,
 * grouped by position, plus the requirements still open.
 */
function LiveDraftRoster({
  roster,
}: {
  roster: {
    drafted: (RosterPlayer & { pickNo: number | null })[];
    counts: Record<string, number>;
    filled: number;
    remaining: number;
    openStarters: OpenSlot[];
    picksMade: number;
  };
}) {
  const positions = Object.keys(roster.counts).sort();
  return (
    <>
      {/*
        Live, but quietly so: a dot and a word, not a coloured banner. What is
        still missing is the sentence worth reading here, so it gets the type.
      */}
      <div className="card card-tight" data-testid="live-draft-card">
        <div className="header-row">
          <span className="live-dot">Live draft</span>
          <span className="faint">
            {roster.picksMade} {roster.picksMade === 1 ? 'pick' : 'picks'} · {roster.filled} filled ·{' '}
            {roster.remaining} left
          </span>
        </div>
        {roster.openStarters.length > 0 ? (
          <div className="muted" style={{ marginTop: 4 }}>
            Still need:{' '}
            <strong>
              {roster.openStarters.map((o) => `${o.count > 1 ? `${o.count} ` : ''}${o.slot}`).join(', ')}
            </strong>
          </div>
        ) : (
          <div className="muted" style={{ marginTop: 4 }}>
            Every starting slot is covered.
          </div>
        )}
      </div>

      {/*
        One card per position group holding one line per player, rather than one
        card per player. Same information, roughly three times as many players
        on a phone screen.
      */}
      {roster.drafted.length === 0 ? (
        <Empty>Nothing drafted yet. Your picks appear here as you make them.</Empty>
      ) : (
        positions.map((position) => (
          <div key={position}>
            <div className="section-title">
              {position} ({roster.counts[position]})
            </div>
            <div className="list-card">
              {roster.drafted
                .filter((p) => (p.position || 'UNKNOWN') === position)
                .map((p) => (
                  <div key={p.playerId} className="roster-line" data-testid="drafted-line">
                    <span className="player-name">{p.name}</span>
                    <PositionBadge position={p.position} team={p.team} />
                    <span className="pick-no">{p.pickNo ? `#${p.pickNo}` : 'held'}</span>
                  </div>
                ))}
            </div>
          </div>
        ))
      )}
    </>
  );
}
