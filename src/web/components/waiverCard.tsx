/**
 * One waiver card, for every place a waiver move is drawn.
 *
 * The Team row's look (22 October 2026: Alex wants no photos on a list, as on
 * Team and Matchup): position pill, team logo, name and the gain chip on the
 * first line; at most two chips on the second, which never wraps; one short
 * reason on a third line when there is one. The face is on the sheet. The
 * whole card is one button onto the detail sheet, and nothing on it is a
 * second tap target. What goes on it is `web/waiverCard.ts`.
 *
 * Nothing here adds, drops or bids: Alex makes every move in Sleeper.
 */

import type { WaiverCardModel } from '../waiverCard.ts';
import { PlayerIdentity } from './common.tsx';

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
      className="player-row waiver-row wcard"
      data-testid={testId}
      data-player-id={model.playerId}
      data-position={pos}
      aria-label={[model.name, model.gainSpoken, model.fullReason].filter(Boolean).join(', ')}
      onClick={onOpen}
      {...data}
    >
      <span className="wcard-main">
        <span className="wcard-top">
          <PlayerIdentity position={model.position} team={model.team} />
          <span className="player-name">{model.name}</span>
          <span className={`tag waiver-strength ${model.gainTone}`} data-testid={gainTestId}>
            {model.gain}
          </span>
        </span>
        {model.chips.length > 0 ? (
          <span className="wcard-chips" data-testid="wcard-chips">
            {model.chips.map((chip) => (
              <span key={chip.key} className={`tag tag-mini${chip.key === 'injury' ? ' badge-warn' : ''}`} data-testid="wcard-chip" data-chip={chip.key}>
                {chip.label}
              </span>
            ))}
          </span>
        ) : null}
        {model.reason ? (
          <span className={`wcard-reason${reasonWarn ? ' waiver-notes-warn' : ''}`} data-testid={reasonTestId}>
            {model.reason}
          </span>
        ) : null}
      </span>
    </button>
  );
}
