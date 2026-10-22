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
import type { CardChip, WaiverCardModel } from '../waiverCard.ts';
import { PlayerIdentity, positionAccentClass } from './common.tsx';

/** The chips that sit on the first line, after the name, like Team's matchup pill. */
const INLINE: ReadonlySet<CardChip['key']> = new Set(['free', 'waivers', 'bid', 'injury']);

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
  /*
   * Laid out exactly like a lineup row (Alex, 22 October 2026: "follow the
   * same style and spacing as the team page"): one line with the status pill
   * after the name and the gain where Team prints a score, then at most one
   * arrow line, like "→ Start KC Concepcion instead", carrying the spot and
   * the short reason.
   */
  const inline = model.chips.filter((chip) => INLINE.has(chip.key));
  const spot = model.chips.filter((chip) => !INLINE.has(chip.key));
  const sub = spot.length > 0 || model.reason != null;
  return (
    <button
      type="button"
      className={positionAccentClass(pos, 'player-row waiver-row')}
      data-testid={testId}
      data-player-id={model.playerId}
      data-position={pos}
      data-sub={sub ? 'yes' : undefined}
      aria-label={[model.name, model.gainSpoken, model.fullReason].filter(Boolean).join(', ')}
      onClick={onOpen}
      {...data}
    >
      <div className="player-row-top">
        <PlayerIdentity position={model.position} team={model.team} />
        <span className="player-name">{model.name}</span>
        {inline.length > 0 ? (
          <span className="row-tags" data-testid="wcard-chips">
            {inline.map((chip) => (
              <span
                key={chip.key}
                className="fixture-chip"
                data-rating={chip.key === 'injury' ? 'tough' : chip.key === 'free' ? 'neutral' : undefined}
                data-testid="wcard-chip"
                data-chip={chip.key}
              >
                {chip.label}
              </span>
            ))}
          </span>
        ) : null}
        <span className="row-value">
          {/* A stash has no points yet: Team's dash, with the words on the arrow line. */}
          <span
            className={`proj${model.stash ? ' proj-out' : model.gainTone === 'tag-take' ? ' proj-gain-take' : ''}`}
            data-testid={gainTestId}
            data-label={model.gain}
          >
            {model.stash ? '—' : model.gain}
          </span>
        </span>
      </div>
      {sub ? (
        <div className="verdict-line" data-testid="wcard-sub">
          <span className="verdict-arrow" aria-hidden="true">→</span>{' '}
          {spot.map((chip, i) => (
            <span key={chip.key}>
              {i > 0 ? ' · ' : ''}
              <span className="verdict-name" data-testid="wcard-chip" data-chip={chip.key}>
                {chip.label}
              </span>
            </span>
          ))}
          {model.reason ? (
            <span className={reasonWarn ? 'waiver-notes-warn' : 'faint'}>
              {spot.length > 0 ? ' · ' : ''}
              <span data-testid={reasonTestId}>{model.reason}</span>
            </span>
          ) : null}
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
