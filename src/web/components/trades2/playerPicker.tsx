/**
 * The player picker for a side of a trade (Round 19, Alex's review).
 *
 * Check the players, then "Add 2 players" at the bottom adds them and closes
 * the list. The button is grey and does nothing until a player is checked,
 * then turns the site's green and counts them. The X at the top right, a tap
 * outside, Escape or a swipe down cancel: the list closes and nothing checked
 * in this visit is kept. Players already on this side are not listed again.
 */

import { useState } from 'react';
import { ListGroup, ListRow, Sheet } from '../native.tsx';

export interface PickerPlayer {
  playerId: string;
  name: string;
  position: string;
  team: string;
}

export function PlayerPicker({
  title,
  players,
  room,
  onAdd,
  onCancel,
}: {
  title: string;
  /** Who may be picked: the roster, less anyone already on this side. */
  players: readonly PickerPlayer[];
  /** How many more this side can take. */
  room: number;
  onAdd: (ids: string[]) => void;
  onCancel: () => void;
}) {
  const [checked, setChecked] = useState<string[]>([]);
  const toggle = (id: string) =>
    setChecked((was) => (was.includes(id) ? was.filter((x) => x !== id) : was.length >= room ? was : [...was, id]));
  const n = checked.length;

  return (
    <Sheet title={title} onClose={onCancel} testId="t2-picker">
      <ListGroup testId="t2-picker-list">
        {players.map((p) => {
          const on = checked.includes(p.playerId);
          return (
            <ListRow
              key={p.playerId}
              label={p.name}
              detail={`${p.position} · ${p.team}`}
              mark={on ? '✓' : undefined}
              pressed={on}
              onClick={() => toggle(p.playerId)}
              testId="t2-check-option"
            />
          );
        })}
      </ListGroup>
      <div className="t2-picker-foot">
        <button
          type="button"
          className="btn t2-add-btn"
          data-testid="t2-picker-add"
          data-ready={n > 0 ? 'yes' : 'no'}
          disabled={n === 0}
          onClick={() => onAdd(checked)}
        >
          {n === 0 ? 'Add players' : `Add ${n} player${n === 1 ? '' : 's'}`}
        </button>
      </div>
    </Sheet>
  );
}
