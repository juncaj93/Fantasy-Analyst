/**
 * Trades.
 *
 * Sections in a fixed order so the screen does not reshuffle under the reader
 * as evidence arrives, and every row says why it is there. A trade call with no
 * reason attached is a horoscope.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, type TradeBoard, type TradeSuggestion } from '../api.ts';
import { Badge, Empty, Loading, Notice, PositionBadge, Signal } from '../components/common.tsx';

export function TradesScreen() {
  const [board, setBoard] = useState<TradeBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBoard(await api.get<TradeBoard>('/api/trades'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!board) return <Loading what="trade ideas" />;

  return (
    <>
      <div className="card card-tight">
        <strong>Trades</strong>
        <div className="faint">
          {board.league ? `${board.league.name} — from your newsletter evidence, last 30 days leading.` : 'No league selected.'}
        </div>
      </div>

      {board.warnings.map((w) => (
        <Notice key={w}>{w}</Notice>
      ))}

      {board.sections.length === 0 ? (
        <Empty>
          Nothing to suggest yet. Trade ideas come from newsletter evidence moving in the last 30 days — once a few
          issues have been read, this fills in.
        </Empty>
      ) : (
        board.sections.map((section) => (
          <div key={section.verdict}>
            <div className="section-title">
              {section.label} ({section.players.length})
            </div>
            {section.players.map((s) => (
              <TradeRow
                key={s.playerId}
                suggestion={s}
                expanded={openId === s.playerId}
                onToggle={() => setOpenId(openId === s.playerId ? null : s.playerId)}
              />
            ))}
          </div>
        ))
      )}

      {board.considered > 0 ? (
        <div className="faint" style={{ margin: '8px 2px' }}>
          {board.considered} player{board.considered === 1 ? '' : 's'} with evidence were considered. Players nobody
          has written about recently are left out rather than listed as holds.
        </div>
      ) : null}
    </>
  );
}

const CONFIDENCE_TONE = { high: 'pos', medium: 'neutral', low: 'warn' } as const;

function TradeRow({
  suggestion,
  expanded,
  onToggle,
}: {
  suggestion: TradeSuggestion;
  expanded: boolean;
  onToggle: () => void;
}) {
  const w = suggestion.windows;
  return (
    <button className="player-row" data-testid="trade-row" aria-expanded={expanded} onClick={onToggle}>
      <div className="player-row-top">
        <span className="player-name">{suggestion.name}</span>
        <PositionBadge position={suggestion.position} team={suggestion.team} />
      </div>

      <div className="player-row-metrics">
        <Signal net={w.last30} label="last 30 days" />
        <Signal net={w.last7} label="last 7 days" />
        <Signal net={w.lifetime} label="lifetime" />
        <span className="metric">
          <Badge tone={CONFIDENCE_TONE[suggestion.confidence]}>{suggestion.confidence} confidence</Badge>
        </span>
      </div>

      {expanded ? (
        <div className="explain">
          <strong style={{ fontSize: '0.8rem' }}>Why</strong>
          <ul>
            {suggestion.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {suggestion.counterpoints.length > 0 ? (
            <>
              <strong style={{ fontSize: '0.8rem' }}>Counterpoints</strong>
              <ul>
                {suggestion.counterpoints.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : (
        <div className="faint">{suggestion.reasons[0]}</div>
      )}
    </button>
  );
}
