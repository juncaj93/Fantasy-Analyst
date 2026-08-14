/**
 * Decision-quality controls and tags.
 *
 * Three rules govern everything here, all from the brief:
 *
 *  1. a tag is only worth screen space if it changes what the user does, so a
 *     row shows at most the one or two that do — the rest live behind the
 *     expander with the numbers that produced them;
 *  2. state is never expressed by colour alone. Every tag carries a word, and
 *     usually a glyph, so it survives a colourblind reader and a bright phone
 *     screen in sunlight;
 *  3. the states are not peers. Take Now and AVOID stop a reader and are filled;
 *     a tier cliff is tinted; "risky to wait" is an outline; "can probably
 *     wait" is nearly silent, because that is exactly how much attention it
 *     deserves.
 */

import type { ReactNode } from 'react';
import type { AvoidTag, MyGuyFlag, TierCliff, WaitGuidance } from '../api.ts';

/** Wait guidance, shown only when it is telling the user to move. */
export function WaitTag({ wait }: { wait: WaitGuidance }) {
  if (wait.state === 'unknown') return null;
  const tone =
    wait.state === 'take_now' ? 'tag tag-take' : wait.state === 'risky_to_wait' ? 'tag tag-risky' : 'tag tag-calm';
  const glyph = wait.state === 'take_now' ? '!' : wait.state === 'risky_to_wait' ? '~' : '·';
  return (
    <span className={tone} title={wait.detail} data-testid="wait-tag" data-state={wait.state}>
      {glyph} {wait.label}
    </span>
  );
}

/** The automatic caution. Deliberately the loudest thing that can appear on a row. */
export function AvoidBadge({ avoid }: { avoid: AvoidTag }) {
  if (!avoid.active) return null;
  return (
    <span className="tag tag-avoid" title={avoid.trendNote ?? avoid.message} data-testid="avoid-tag">
      ⚠ {avoid.message}
    </span>
  );
}

export function TierCliffTag({ cliff }: { cliff: TierCliff }) {
  if (cliff.severity === 'none' || !cliff.message) return null;
  return (
    <span
      className={cliff.severity === 'last_in_tier' ? 'tag tag-cliff' : 'tag tag-risky'}
      title={cliff.message}
      data-testid="tier-cliff-tag"
    >
      ▚ {cliff.severity === 'last_in_tier' ? 'Tier cliff' : 'Tier thinning'}
    </span>
  );
}

export function MyGuyStars({ myGuy }: { myGuy: MyGuyFlag }) {
  if (myGuy.level === 0) return null;
  return (
    <span className="tag tag-star" title={`${myGuy.label} — your own flag, separate from the news tally`} data-testid="my-guy-stars">
      {myGuy.stars}
    </span>
  );
}

/**
 * The conclusion, stated once at the top of an expanded player.
 *
 * One label and one supporting sentence — both of them text the engine already
 * produced. Nothing is recomputed here; this only decides which of the existing
 * strings is the headline and which are the supporting detail, so the same
 * point stops appearing three times down the card.
 */
export function Verdict({
  tone,
  label,
  detail,
  glyph,
}: {
  tone: 'take' | 'avoid' | 'risky' | 'calm';
  label: string;
  detail?: string | null;
  glyph?: string;
}) {
  return (
    <div className={`verdict verdict-${tone}`} data-testid="verdict" data-tone={tone}>
      <div className="verdict-label">
        {glyph ? <span aria-hidden="true">{glyph}</span> : null}
        {label}
      </div>
      {detail ? <div className="verdict-detail">{detail}</div> : null}
    </div>
  );
}

/**
 * Which conclusion leads an expanded draft player.
 *
 * A caution outranks urgency, and urgency outranks the fact that somebody can
 * wait — the same order the row's tags use, so the tag and the headline never
 * disagree. When the engine has no wait guidance and no caution there is no
 * conclusion to state, and this returns null rather than inventing one.
 */
export function draftVerdict(
  avoid: AvoidTag,
  wait: WaitGuidance,
): { tone: 'take' | 'avoid' | 'risky' | 'calm'; label: string; detail: string | null; glyph: string } | null {
  if (avoid.active) {
    return { tone: 'avoid', label: avoid.message, detail: avoid.trendNote, glyph: '⚠' };
  }
  if (wait.state === 'unknown') return null;
  const tone = wait.state === 'take_now' ? 'take' : wait.state === 'risky_to_wait' ? 'risky' : 'calm';
  const glyph = wait.state === 'take_now' ? '!' : wait.state === 'risky_to_wait' ? '~' : '·';
  return { tone, label: wait.label, detail: wait.detail, glyph };
}

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

/**
 * Has this already been said, in this form or inside a longer sentence?
 *
 * Looser than `withoutRepeats` on purpose: the wait guidance often quotes the
 * tier-cliff message inside a longer sentence, and printing the quoted half
 * again two blocks later is the exact repetition this pass is removing.
 */
export function saidAlready(text: string | null | undefined, alreadySaid: (string | null | undefined)[]): boolean {
  if (!text) return true;
  const key = normalise(text);
  if (!key) return true;
  return alreadySaid.some((said) => {
    if (!said) return false;
    const other = normalise(said);
    return other.includes(key) || key.includes(other);
  });
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
      onClick={(event) => {
        // The row itself is a button that expands; rating must not also open it.
        event.stopPropagation();
        onChange(next);
      }}
    >
      {myGuy.level > 0 ? '♥'.repeat(myGuy.level) : '♡'}
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
      onClick={(event) => {
        // The row itself is a button that expands; queueing must not also open it.
        event.stopPropagation();
        onChange(!queued);
      }}
    >
      {queued ? '★' : '☆'}
    </button>
  );
}
