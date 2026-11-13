/**
 * The in-season part of a player's card (Round 24): the trade pick when he is
 * one, this week's number (the one Team and Compare show), the next four
 * weeks with byes marked, and his last five games. One small request.
 *
 * A number built on Sleeper's week is italic with a dotted underline, as on
 * every other screen; the word never sits next to a number.
 */

import { useEffect, useState } from 'react';
import { api } from '../../api.ts';
import type { SeasonCard, SeasonRow, SeasonWeekCell } from '../../../core/players/seasonWire.ts';
import { SLEEPER_SPOKEN, sleeperClass } from '../../sleeperFallback.ts';

const pts = (v: number) => v.toFixed(1);

export function SeasonCardBlock({ row, leagueId }: { row: SeasonRow; leagueId: string | null }) {
  const [card, setCard] = useState<SeasonCard | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setCard(null);
    setFailed(false);
    api
      .get<SeasonCard>(`/api/players/${encodeURIComponent(row.id)}/season${leagueId ? `?leagueId=${encodeURIComponent(leagueId)}` : ''}`)
      .then((c) => live && setCard(c))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [row.id, leagueId]);

  return (
    <div className="p2-card" data-testid="p2-card">
      {row.trade ? (
        <div className="p2-pick" data-testid="p2-trade">
          <div className="p2-pick-line">
            <span className="p2-tag" data-word={row.trade.willingness} data-testid="p2-card-willing">
              {row.trade.willingness}
            </span>
            <span className="p2-why" data-testid="p2-reason">
              {row.trade.reason}
            </span>
          </div>
          {row.trade.over && row.value != null && row.trade.overValue != null ? (
            <div className="p2-versus" data-testid="p2-versus" aria-label={`${row.name} ${pts(row.value)} against ${row.trade.over} ${pts(row.trade.overValue)}, rest of season points a week`}>
              <span className="p2-versus-name">{row.name}</span>
              <span className="p2-versus-num p2-win">{pts(row.value)}</span>
              <span className="p2-versus-num">{pts(row.trade.overValue)}</span>
              <span className="p2-versus-name p2-versus-them">{row.trade.over}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="p2-this" data-testid="p2-this-week">
        <span className="p2-label">This week</span>
        {card ? (
          card.thisWeek.out ? (
            <span className="p2-big p2-out">Out</span>
          ) : card.thisWeek.points == null ? (
            <span className="p2-big faint">—</span>
          ) : (
            <span className={sleeperClass('p2-big', card.thisWeek.sleeper)}>
              {pts(card.thisWeek.points)}
              {card.thisWeek.sleeper ? <span className="sr-only">, {SLEEPER_SPOKEN}</span> : null}
            </span>
          )
        ) : (
          <span className="p2-big faint">{failed ? '—' : '…'}</span>
        )}
        {row.value != null ? (
          <span className="p2-season" data-testid="p2-season-value">
            Season <strong>{pts(row.value)}</strong> a week
          </span>
        ) : null}
      </div>

      {card && card.next.length > 0 ? (
        <div className="p2-section">
          <span className="p2-label">Next {card.next.length} weeks</span>
          <ol className="p2-cells" data-testid="p2-next">
            {card.next.map((c) => (
              <WeekCell key={c.week} cell={c} />
            ))}
          </ol>
        </div>
      ) : null}

      {card && card.last.length > 0 ? (
        <div className="p2-section">
          <span className="p2-label">Last {card.last.length} games</span>
          <ol className="p2-cells" data-testid="p2-last">
            {card.last.map((g) => (
              <li key={g.week} className="p2-cell">
                <span className="p2-cell-week">Wk {g.week}</span>
                <span className="p2-cell-num">{pts(g.points)}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

function WeekCell({ cell }: { cell: SeasonWeekCell }) {
  return (
    <li className="p2-cell" data-bye={cell.bye ? 'yes' : 'no'} data-testid="p2-next-cell">
      <span className="p2-cell-week">Wk {cell.week}</span>
      {cell.bye ? (
        <span className="p2-cell-num p2-bye">BYE</span>
      ) : cell.out ? (
        <span className="p2-cell-num p2-out">Out</span>
      ) : cell.points == null ? (
        <span className="p2-cell-num faint">—</span>
      ) : (
        <span className={sleeperClass('p2-cell-num', cell.sleeper)}>
          {pts(cell.points)}
          {cell.sleeper ? <span className="sr-only">, {SLEEPER_SPOKEN}</span> : null}
        </span>
      )}
    </li>
  );
}
