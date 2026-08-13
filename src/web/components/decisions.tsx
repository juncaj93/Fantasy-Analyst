/**
 * Decision-quality controls and tags.
 *
 * Two rules govern everything here, both from the brief:
 *
 *  1. a tag is only worth screen space if it changes what the user does, so a
 *     row shows at most the one or two that do — the rest live behind the
 *     expander with the numbers that produced them;
 *  2. state is never expressed by colour alone. Every tag carries a word, and
 *     usually a glyph, so it survives a colourblind reader and a bright phone
 *     screen in sunlight.
 */

import type { AvoidTag, MyGuyFlag, TierCliff, WaitGuidance } from '../api.ts';

/** Wait guidance, shown only when it is telling the user to move. */
export function WaitTag({ wait }: { wait: WaitGuidance }) {
  if (wait.state === 'unknown') return null;
  const tone =
    wait.state === 'take_now' ? 'tag tag-urgent' : wait.state === 'risky_to_wait' ? 'tag tag-warn' : 'tag tag-calm';
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
      className={cliff.severity === 'last_in_tier' ? 'tag tag-urgent' : 'tag tag-warn'}
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
 * Tap to cycle ☆ → ★ → ★★ → ★★★ → ☆.
 *
 * One control rather than four: on a phone, during a draft, the user has one
 * thumb and a clock. Cycling costs at most three taps to reach any level and
 * needs no menu, no long-press and no second screen.
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
    0: 'Not flagged',
    1: 'My Guy',
    2: 'Strong My Guy',
    3: 'Must-Have',
  };
  return (
    <button
      type="button"
      className={myGuy.level > 0 ? 'star-btn star-btn-on' : 'star-btn'}
      disabled={busy}
      aria-label={`${labels[myGuy.level]}. Tap to set ${labels[next]}.`}
      data-testid="my-guy-control"
      data-level={myGuy.level}
      onClick={(event) => {
        // The row itself is a button that expands; starring must not also open it.
        event.stopPropagation();
        onChange(next);
      }}
    >
      {myGuy.level > 0 ? myGuy.stars : '☆'}
    </button>
  );
}
