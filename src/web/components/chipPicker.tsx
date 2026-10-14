/**
 * A roster as wrapped chips, for marking players in a few rows instead of a
 * scrolling list (Alex, 15 October 2026: the two-line rows meant scrolling
 * through a long list to see one team).
 *
 * One chip is `RB E. Johnson KC`, on one line: the position in its own colour,
 * the short name in normal weight, the club muted, and an injury letter (Q, D,
 * O, IR) where there is one. Tapping marks it; a marked chip fills with its
 * mark's colour and carries a small tag (`Sell`, `Want`, or a check). Chips
 * are ordered QB, RB, WR, TE, then the rest, so a sixteen-player roster wraps
 * to five or six rows at 390 px.
 *
 * `InfoLine` is the banner that goes with it: one line, and a small info
 * button that opens the rest.
 */

import { useState, type ReactNode } from 'react';

export interface ChipPlayer {
  playerId: string;
  name: string;
  position: string;
  team: string;
  status: string | null;
  reserve?: boolean;
}

const ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

/** `Emmett Johnson` -> `E. Johnson`; `Marvin Harrison Jr.` -> `M. Harrison Jr.`; a defence is its club. */
export function shortName(name: string, position: string, team: string): string {
  if (position.toUpperCase() === 'DEF') return team || name;
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0]!.charAt(0)}. ${parts.slice(1).join(' ')}`;
}

/** Q, D, O, IR, PUP or SUS from Sleeper's status, or nothing for a healthy player. */
export function injuryLetter(status: string | null | undefined, reserve = false): string | null {
  const s = (status ?? '').trim().toLowerCase();
  if (reserve || s === 'ir' || s.startsWith('injured reserve')) return 'IR';
  if (s.startsWith('quest')) return 'Q';
  if (s.startsWith('doubt')) return 'D';
  if (s === 'out') return 'O';
  if (s === 'pup') return 'PUP';
  if (s.startsWith('sus')) return 'SUS';
  return null;
}

export function sortChips<T extends ChipPlayer>(players: readonly T[]): T[] {
  const rank = (p: ChipPlayer) => {
    const i = ORDER.indexOf(p.position.toUpperCase());
    return i < 0 ? ORDER.length : i;
  };
  return [...players].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function ChipPicker({
  players,
  marked,
  tag,
  full = false,
  onToggle,
  testId,
  label,
}: {
  players: readonly ChipPlayer[];
  marked: readonly string[];
  /** The mark a picked chip carries. */
  tag: 'Sell' | 'Want' | 'Pick';
  /** True when no more may be picked: unpicked chips stop taking taps. */
  full?: boolean;
  onToggle: (playerId: string) => void;
  testId: string;
  /** What the group is, for assistive technology. */
  label: string;
}) {
  const kind = tag.toLowerCase();
  return (
    <div className="chip-picker" role="group" aria-label={label} data-testid={testId}>
      {sortChips(players).map((p) => {
        const on = marked.includes(p.playerId);
        const hurt = injuryLetter(p.status, p.reserve === true);
        const pos = p.position.toUpperCase();
        const disabled = !on && full;
        return (
          <button
            type="button"
            key={p.playerId}
            className="pick-chip"
            data-testid="pick-chip"
            data-kind={kind}
            data-on={on ? 'yes' : 'no'}
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onToggle(p.playerId)}
            title={`${p.name}, ${pos}${p.team ? `, ${p.team}` : ''}${p.status ? `, ${p.status}` : ''}`}
          >
            <span className={`pick-chip-pos pos-text-${pos}`}>{pos}</span>
            <span className="pick-chip-name">{shortName(p.name, pos, p.team)}</span>
            {pos !== 'DEF' && p.team ? <span className="pick-chip-team">{p.team}</span> : null}
            {hurt ? (
              <span className="pick-chip-hurt" data-testid="pick-chip-hurt" aria-label={p.status ?? 'injured'}>
                {hurt}
              </span>
            ) : null}
            {on ? (
              <span className="pick-chip-tag" data-testid="pick-chip-tag">
                {tag === 'Pick' ? '✓' : tag}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** One line of context, and a small info button that opens the rest of it. */
export function InfoLine({ text, detail, testId }: { text: ReactNode; detail?: ReactNode; testId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="info-line" data-testid={testId} data-open={open ? 'yes' : 'no'}>
      <div className="info-line-row">
        <span className="info-line-text">{text}</span>
        {detail ? (
          <button
            type="button"
            className="info-line-button"
            aria-expanded={open}
            aria-label={open ? 'Hide detail' : 'Show detail'}
            data-testid={testId ? `${testId}-info` : undefined}
            onClick={() => setOpen((o) => !o)}
          >
            ⓘ
          </button>
        ) : null}
      </div>
      {open && detail ? (
        <div className="info-line-detail" data-testid={testId ? `${testId}-detail` : undefined}>
          {detail}
        </div>
      ) : null}
    </div>
  );
}
