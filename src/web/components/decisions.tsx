/**
 * Decision-quality controls, and the list shape the reasons behind them use.
 *
 * What is left here is what something on screen still calls. The badges this
 * file was originally written for — `Take Now` / `can probably wait`, a tier
 * cliff of its own, a stars flag, a verdict block over an expanded player — are
 * gone, each of them replaced rather than merely dropped:
 *
 *  - wait guidance is not shown as a badge at all any more. It was the loudest
 *    thing on a dense board and it said less than the numbers beside it;
 *  - the tier cliff is drawn by the Draft board itself, as a row pill that
 *    knows the row's width and abbreviates with it — see `player-row-cliff` in
 *    `DraftScreen`, which is the only tier-cliff mark left;
 *  - the heart is a control now, not a read-only tag: `MyGuyControl` below;
 *  - a verdict over a player belongs to the weekly card, which draws its own —
 *    see `weekly.tsx`.
 *
 * None of the model behind them changed. Every one of those judgements is still
 * computed and still travels on the API; this file simply stopped being a
 * second place they could be drawn.
 *
 * The one rule that still governs what is here: state is never expressed by
 * colour alone. Every control carries a word or a glyph, so it survives a
 * colourblind reader and a bright phone screen in sunlight.
 */

import type { ReactNode } from 'react';
import type { MyGuyFlag } from '../api.ts';

/**
 * Drop lines that have already been said.
 *
 * Presentation only: the underlying reason data is untouched and the full set
 * is always still reachable. This exists because the same fact legitimately
 * arrives as a badge, as the wait detail and as a Why bullet, and reading it
 * three times in a row costs a live drafter time for no new information.
 */
export function withoutRepeats(lines: string[], alreadySaid: (string | null | undefined)[] = []): string[] {
  const seen = new Set(alreadySaid.filter((s): s is string => !!s).map(normalise));
  const out: string[] = [];
  for (const line of lines) {
    const key = normalise(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A short bulleted list. Used for Why and for Counterpoints, so they match. */
export function ReasonList({ items, muted = false }: { items: ReactNode[]; muted?: boolean }) {
  return (
    <ul className={muted ? 'reason-list counterpoints' : 'reason-list'}>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/**
 * ♡ → ♥ → ♥♥ → ♥♥♥ → ♡, on the players list.
 *
 * One control rather than four: on a phone the user has one thumb, and cycling
 * costs at most three taps to reach any level with no menu, no long-press and
 * no second screen.
 *
 * This is an opinion, and it moves the ranking by a bounded amount. It is not
 * the draft queue — see `QueueControl` — because "I rate him" and "remind me
 * about him" are different things and only one of them should change a board.
 */
export function MyGuyControl({
  myGuy,
  onChange,
  busy,
}: {
  myGuy: MyGuyFlag;
  onChange: (level: 0 | 1 | 2 | 3) => void;
  busy?: boolean;
}) {
  const next = ((myGuy.level + 1) % 4) as 0 | 1 | 2 | 3;
  const labels: Record<number, string> = {
    0: 'Not one of your guys',
    1: 'My Guy',
    2: 'Strong My Guy',
    3: 'Must-Have',
  };

  return (
    <button
      type="button"
      className={`heart-btn${myGuy.level > 0 ? ' heart-btn-on' : ''}`}
      disabled={busy}
      aria-label={`${labels[myGuy.level]}. Tap to set: ${labels[next]}.`}
      title={`${labels[myGuy.level]} — moves him up your board`}
      data-testid="my-guy-control"
      data-level={myGuy.level}
      data-icon="heart"
      /*
        No `stopPropagation` any more, and its absence is the fix rather than an
        omission.

        This control used to be *inside* the row's button, so a tap on it was
        also a tap on the row and the only thing standing between rating a
        player and opening his page was a line of JavaScript. It is a sibling of
        the row's button now — see `.row-action` — so the two actions are
        separate to the browser, to the keyboard and to a screen reader, and
        there is no propagation left to stop.
      */
      onClick={() => onChange(next)}
    >
      {/*
        The mark, in a box of its own, because the button around it is now the
        44px a thumb needs and the tint belongs to the 28px a reader sees.
      */}
      <span className="control-glyph">{myGuy.level > 0 ? '♥'.repeat(myGuy.level) : '♡'}</span>
    </button>
  );
}

/**
 * ☆ → ★, on the draft board. A bookmark, and nothing else.
 *
 * During a draft the star is how you find the man you meant to take: tap it,
 * then tap the ★ filter and there he is. It has exactly two states because a
 * bookmark has two states, and it deliberately does **not** touch the ranking —
 * the board comes back in the same order whether the star is lit or not.
 *
 * That is the whole difference from the heart. Rating a player is an opinion
 * the engine is allowed to hear; queueing him is a note to yourself.
 */
/**
 * The same slot, in a rehearsal, meaning something else entirely.
 *
 * A star is a bookmark — "remind me later" — and there is no later in a mock
 * draft: the reader is the one picking, right now, and a shortlist they will
 * never come back to is a control that does nothing. So the slot carries a `+`
 * instead, and it takes the player.
 *
 * Deliberately the same size, the same position and the same slot as the star
 * it replaces, so a row in a rehearsal is the row from the real board with one
 * glyph changed rather than a second kind of row.
 */
export function PickControl({
  onPick,
  busy,
  name,
}: {
  onPick: () => void;
  busy?: boolean;
  /** Whose row this is, so the control says what it will do to whom. */
  name: string;
}) {
  return (
    <button
      type="button"
      className="star-btn pick-btn"
      disabled={busy}
      aria-label={`Draft ${name} in this mock draft`}
      title="Draft him — practice only"
      data-testid="mock-pick-control"
      /* A sibling of the row's own button, not a child of it — see `QueueControl`. */
      onClick={onPick}
    >
      <span className="control-glyph">+</span>
    </button>
  );
}

export function QueueControl({
  queued,
  onChange,
  busy,
}: {
  queued: boolean;
  onChange: (queued: boolean) => void;
  busy?: boolean;
}) {
  const label = queued ? 'Queued' : 'Not queued';
  return (
    <button
      type="button"
      className={`star-btn${queued ? ' star-btn-on' : ''}`}
      disabled={busy}
      aria-label={`${label}. Tap to ${queued ? 'remove from' : 'add to'} your queue.`}
      aria-pressed={queued}
      title={`${label} — a bookmark; it does not change the ranking`}
      data-testid="queue-control"
      data-queued={queued ? '1' : '0'}
      /* A sibling of the row's own button, not a child of it — see `MyGuyControl`. */
      onClick={() => onChange(!queued)}
    >
      <span className="control-glyph">{queued ? '★' : '☆'}</span>
    </button>
  );
}
