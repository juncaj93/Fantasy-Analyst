/**
 * One waiver row, for every place a waiver move is drawn.
 *
 * A variant of the Team lineup row, built from its own classes rather than
 * a second design (Alex, 22 October 2026: Waivers and Team "looked like two
 * different apps"):
 *
 * - `player-row` and `player-row-top`: the lineup row's padding, tap height
 *   and first line, with the position tint from `positionAccentClass`;
 * - `PlayerIdentity` and `player-name`: the same pill, logo and name type;
 * - `row-value`: the score column, holding the gain as a `fixture-chip`,
 *   Team's small pill (green-tinted for Do this, gray otherwise);
 * - `verdict-line`: the lineup's indented sub-line, carrying the chips, then
 *   the short reason in the muted style.
 *
 * Rows sit in a `slot-group`, the one rounded card with hairline dividers
 * that holds "Your lineup". No photo on a row; the face is on the sheet. The
 * whole row is one button onto the detail sheet, and nothing on it is a
 * second tap target. What goes on it is `web/waiverCard.ts`.
 *
 * Nothing here adds, drops or bids: Alex makes every move in Sleeper.
 */

import type { ReactNode } from 'react';
import type { WaiverCardModel } from '../waiverCard.ts';
import { PlayerIdentity, positionAccentClass } from './common.tsx';

export function WaiverCard({
  model,
  onOpen,
  testId,
  gainTestId,
  reasonTestId,
  reasonWarn = false,
  data,
}: {
  model: WaiverCardModel;
  onOpen: () => void;
  testId: string;
  gainTestId: string;
  reasonTestId: string;
  /** The plan left him out on purpose: the reason is a warning. */
  reasonWarn?: boolean;
  /** `data-*` attributes the screens and tests read. */
  data?: Record<string, string>;
}) {
  const pos = model.position.toUpperCase();
  return (
    <button
      type="button"
      className={positionAccentClass(pos, 'player-row waiver-row')}
      data-testid={testId}
      data-player-id={model.playerId}
      data-position={pos}
      aria-label={[model.name, model.gainSpoken, model.fullReason].filter(Boolean).join(', ')}
      onClick={onOpen}
      {...data}
    >
      <div className="player-row-top">
        <PlayerIdentity position={model.position} team={model.team} />
        <span className="player-name">{model.name}</span>
        <span className="row-value">
          <span className="fixture-chip" data-rating={model.gainTone === 'tag-take' ? 'soft' : undefined} data-testid={gainTestId}>
            {model.gain}
          </span>
        </span>
      </div>
      {model.chips.length > 0 ? (
        <div className="verdict-line wrow-chips" data-testid="wcard-chips">
          {model.chips.map((chip) => (
            <span
              key={chip.key}
              className="fixture-chip"
              data-rating={chip.key === 'injury' ? 'tough' : undefined}
              data-testid="wcard-chip"
              data-chip={chip.key}
            >
              {chip.label}
            </span>
          ))}
        </div>
      ) : null}
      {model.reason ? (
        <div className={`verdict-line faint${reasonWarn ? ' waiver-notes-warn' : ''}`} data-testid={reasonTestId}>
          {model.reason}
        </div>
      ) : null}
    </button>
  );
}

/** Rows in one rounded card with hairline dividers, like "Your lineup". Nothing when there are no rows. */
export function WaiverRowGroup({ children, testId }: { children: ReactNode; testId?: string }) {
  const rows = (Array.isArray(children) ? children.flat() : [children]).filter(Boolean);
  if (rows.length === 0) return null;
  return (
    <div className="slot-group" data-testid={testId}>
      {rows}
    </div>
  );
}
