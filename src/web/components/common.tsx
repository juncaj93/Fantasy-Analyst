/**
 * Shared presentational primitives.
 *
 * Every screen builds from these, so a card, a position badge or a metric row
 * looks and behaves identically on Draft, Team, Trades, Players, Review and
 * Setup. Two rules are enforced here:
 *
 *  1. a positive/negative state is ALWAYS expressed with a glyph and a word in
 *     addition to colour;
 *  2. nothing names a colour — only a semantic role from the theme tokens — so
 *     Light and Dark stay two settings of one design system.
 */

import { useEffect, useState, type ReactNode } from 'react';
/* What Sleeper says about a player's availability right now. Never a ranking input. */
import { injuryStatusTag } from '../../core/draft/injury.ts';

/**
 * An inline disclosure that opens in place.
 *
 * The reveal is a grid row going from `0fr` to `1fr`, which is the only way to
 * animate to a height nobody knows in advance without measuring it in
 * JavaScript on every frame. Two things matter as much as the movement:
 *
 *  1. the children are **not** mounted while it is closed, so a card that
 *     fetches something when it opens still fetches nothing until it does;
 *  2. nothing above it moves, so the reader's place on a forty-row board is
 *     exactly where they left it.
 *
 * Under reduced motion the stylesheet takes the transition to nothing and this
 * becomes an ordinary conditional render, which is the correct answer there.
 */
export function Disclose({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // A frame between mounting at 0fr and growing to 1fr: without it React
      // applies both in one commit and there is nothing to transition between.
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const handle = window.setTimeout(() => setMounted(false), 240);
    return () => window.clearTimeout(handle);
  }, [open]);

  if (!mounted) return null;
  return (
    <div className={shown ? 'disclose disclose-open' : 'disclose'} data-disclosed={shown ? 'yes' : 'no'}>
      <div>{children}</div>
    </div>
  );
}

/**
 * `Q`, `D`, `OUT`, `IR` — current availability, beside the name.
 *
 * The one fact about a player that can change a decision before any of the
 * numbers do, and it reads the same on every screen that shows a player. Two or
 * three characters at most, because forty rows have room for two or three
 * characters; the word itself is in the accessible name and the tooltip, so the
 * colour is an accelerator and never the thing carrying the meaning.
 *
 * A healthy player renders nothing at all. `Active` is not a status worth a
 * badge — it is the absence of one — and a board where every row carries a
 * badge is a board where the badge means nothing.
 */
export function InjuryTag({ status }: { status: string | null | undefined }) {
  const tag = injuryStatusTag(status);
  if (!tag) return null;
  return (
    <span
      className={`injury-tag injury-${tag.tone}`}
      data-testid="injury-tag"
      data-status={tag.code}
      title={tag.label}
      aria-label={tag.label}
    >
      {tag.code}
    </span>
  );
}

export function Signal({ net, items, label }: { net: number; items?: number; label?: string }) {
  const cls = net > 0 ? 'sig sig-pos' : net < 0 ? 'sig sig-neg' : 'sig sig-none';
  const glyph = net > 0 ? '▲' : net < 0 ? '▼' : '–';
  const word = net > 0 ? 'pos' : net < 0 ? 'neg' : 'flat';
  const value = net === 0 ? '0' : `${net > 0 ? '+' : ''}${net}`;
  return (
    <span className={cls} title={`${label ?? 'news signal'}: ${value} net${items != null ? ` over ${items} item(s)` : ''}`}>
      {glyph} {value} {word}
      {items != null && items > 0 ? <span className="faint"> ({items})</span> : null}
    </span>
  );
}

/**
 * The tally, as small as it can be and still mean something: `+6` or `-2`.
 *
 * The long form above — `▲ +6 pos` — earned its glyph and its word honestly: a
 * state must never be carried by colour alone. But it was printed on forty rows
 * of a draft board next to the name, and three tokens where one would do is how
 * a dense list stops being scannable. The sign is the glyph here. `+` and `-`
 * are not decoration and not colour; they are the thing being said, and they
 * survive greyscale, low vision and a screen reader identically.
 *
 * The title carries the full sentence for anyone who wants it, and the richer
 * lifetime/30d/7d breakdown still lives on the Players and Trades screens where
 * there is room for it.
 */
export function CompactTally({ net, label }: { net: number; label?: string }) {
  if (net === 0) return null;
  const cls = net > 0 ? 'tally tally-pos' : 'tally tally-neg';
  return (
    <span
      className={cls}
      data-testid="compact-tally"
      title={`${label ?? 'Research tally'}: ${net > 0 ? '+' : ''}${net} net`}
    >
      {net > 0 ? `+${net}` : net}
    </span>
  );
}

/**
 * The same number, in a place that has already labelled it — a window cell, a
 * table row — so a zero is a real reading and is printed rather than omitted.
 *
 * Shares {@link CompactTally}'s classes on purpose: `+11` under "Lifetime" on
 * Trades and `+11` beside a name on the draft board are the same fact, and they
 * should not be two different greens. Size comes from where it sits.
 */
export function SignedValue({ net }: { net: number }) {
  const cls = net > 0 ? 'tally tally-pos' : net < 0 ? 'tally tally-neg' : 'tally tally-none';
  return <span className={cls}>{net > 0 ? `+${net}` : net}</span>;
}

/**
 * A player's position, colour-coded so a long list can be scanned at a glance.
 *
 * The letters stay: colour is an accelerator, never the carrier of the meaning,
 * so this reads identically to somebody who cannot separate the hues. The
 * palette is deliberately restrained — a small tinted pill rather than a
 * coloured row, because forty of these on one screen is what the draft board
 * actually looks like and saturated blocks at that density stop being
 * information. Same size, same radius, same hues on every screen.
 */
export function PositionBadge({ position, team }: { position: string | null; team?: string | null }) {
  const pos = (position ?? '').toUpperCase();
  const known = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(pos);
  return (
    <span className="pos-team">
      <span className={known ? `pos-pill pos-${pos}` : 'pos-pill'} data-position={pos || 'UNKNOWN'}>
        {pos || '—'}
      </span>
      {team !== undefined ? <span className="team-code">{team || 'FA'}</span> : null}
    </span>
  );
}

/** The positions the palette has a hue for. Anything else stays neutral. */
const TINTED_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

/**
 * The class list that paints a card in its player's position colour.
 *
 * One function rather than a template string repeated on five screens, so
 * "which positions are tinted" and "what the classes are called" are answered
 * in one place. The colours themselves are semantic tokens in the stylesheet;
 * this only decides who gets them.
 *
 * An unknown or missing position deliberately falls through to the untinted
 * card. A grey row is honest about not knowing; picking a hue for it would be
 * inventing a fact about the player.
 */
export function positionCardClass(position: string | null | undefined, extra = ''): string {
  const pos = (position ?? '').toUpperCase();
  const tint = TINTED_POSITIONS.includes(pos) ? ` card-pos card-pos-${pos}` : '';
  return `player-row${tint}${extra ? ` ${extra}` : ''}`;
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'warn' | 'pos' | 'neg';
}) {
  const cls = tone === 'warn' ? 'badge badge-warn' : tone === 'pos' ? 'badge badge-pos' : tone === 'neg' ? 'badge badge-neg' : 'badge';
  return <span className={cls}>{children}</span>;
}

/**
 * How sure the app is, said quietly.
 *
 * Confidence qualifies a signal; it is not a rival to it. Low confidence is the
 * only level that changes what a reader does, so it is the only one that gets
 * any colour.
 */
export function Confidence({ level }: { level: string }) {
  const cls = level === 'low' ? 'badge badge-confidence badge-confidence-low' : 'badge badge-confidence';
  return <span className={cls}>{level} confidence</span>;
}

export function Notice({
  children,
  tone = 'warn',
}: {
  children: ReactNode;
  tone?: 'warn' | 'error' | 'ok';
}) {
  const cls = tone === 'error' ? 'notice notice-error' : tone === 'ok' ? 'notice notice-ok' : 'notice';
  return <div className={cls}>{children}</div>;
}

/** A headline number with a small label. Large value, quiet label, tabular. */
export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="stat" title={hint}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

/** The at-a-glance row of key numbers used at the top of any player detail. */
export function MetricGrid({ children, columns = 4 }: { children: ReactNode; columns?: 3 | 4 }) {
  return <div className={columns === 3 ? 'metric-grid metric-grid-3' : 'metric-grid'}>{children}</div>;
}

/** A small uppercase label introducing a block inside a detail view. */
export function DetailLabel({ children }: { children: ReactNode }) {
  return <div className="detail-label">{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading({ what }: { what: string }) {
  return <div className="spinner">Loading {what}…</div>;
}

/** Renders "unknown" explicitly rather than substituting a zero. */
export function Unknown({ what }: { what: string }) {
  return (
    <span className="faint" title={`${what} is unknown — no value is being invented`}>
      unknown
    </span>
  );
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatAge(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "just now" / "20s" / "4m" — short enough to sit beside a control. */
export function formatShortAge(at: number | null, now: number): string {
  if (at == null) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}
