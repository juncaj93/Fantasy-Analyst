/**
 * Trades.
 *
 * Sections in a fixed order so the screen does not reshuffle under the reader
 * as evidence arrives, and every row says why it is there. A trade call with no
 * reason attached is a horoscope.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, type TradeBoard, type TradeSuggestion } from '../api.ts';
import {
  Confidence,
  DetailLabel,
  Empty,
  Loading,
  Notice,
  PositionBadge,
  SignedValue,
} from '../components/common.tsx';
import { ReasonList, withoutRepeats } from '../components/decisions.tsx';

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

/**
 * One trade idea.
 *
 * The three tally windows used to sit side by side as three identical signals,
 * which read as the same number printed three times — `+13 pos +13 pos +13 pos`.
 * Nothing is merged and nothing is hidden: each window is simply named, so the
 * eye can see at once whether the case is a lifetime body of evidence, a recent
 * move, or both. Confidence qualifies that signal rather than competing with it,
 * so it sits at the end of the trend line in the quietest treatment that is
 * still legible.
 */
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
  const reasons = withoutRepeats(suggestion.reasons);
  const counterpoints = withoutRepeats(suggestion.counterpoints, reasons);
  return (
    <button className="player-row" data-testid="trade-row" aria-expanded={expanded} onClick={onToggle}>
      <div className="player-row-top">
        <span className="player-name">{suggestion.name}</span>
        <PositionBadge position={suggestion.position} team={suggestion.team} />
      </div>

      <div className="window-row" data-testid="trade-windows">
        <div className="window-cell">
          <div className="window-label">Lifetime</div>
          <div className="window-value">
            <SignedValue net={w.lifetime} />
          </div>
        </div>
        <div className="window-cell">
          <div className="window-label">30d</div>
          <div className="window-value">
            <SignedValue net={w.last30} />
          </div>
        </div>
        <div className="window-cell">
          <div className="window-label">7d</div>
          <div className="window-value">
            <SignedValue net={w.last7} />
          </div>
        </div>
      </div>

      <div className="trade-trend">
        <span className="trade-line">{reasons[0]}</span>
        <Confidence level={suggestion.confidence} />
      </div>

      {expanded ? (
        <div className="explain">
          <DetailLabel>Why</DetailLabel>
          <ReasonList items={reasons} />
          {counterpoints.length > 0 ? (
            <>
              <DetailLabel>{counterpoints.length === 1 ? 'Counterpoint' : 'Counterpoints'}</DetailLabel>
              <ReasonList muted items={counterpoints} />
            </>
          ) : null}
          <div className="faint" style={{ marginTop: 6 }}>
            {w.itemsLifetime} news item{w.itemsLifetime === 1 ? '' : 's'} in total, {w.items30} in the last 30 days.
          </div>
        </div>
      ) : null}
    </button>
  );
}
