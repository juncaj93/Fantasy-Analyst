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
/* The 32 clubs and their marks. Presentation metadata; never a ranking input. */
import { nflTeam, nflTeamLogoUrl } from '../../core/nfl/teams.ts';
import { normalizeTeam } from '../../core/identity/normalize.ts';

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
 * A club's mark, in place of its abbreviation.
 *
 * `WR · CHI` asks the reader to decode three letters; `WR · 🐻` is recognised
 * before it is read, and on a forty-row board that difference is the whole
 * point. The abbreviation does not disappear — it moves into the accessible
 * name, where a screen reader says the better thing anyway ("Chicago Bears"
 * rather than "chih").
 *
 * Three rules hold this to being decoration that never costs anything:
 *
 *  1. **the box is fixed before the image exists.** The stylesheet's
 *     `--team-logo` decides how big a mark is; the square `width`/`height` here
 *     are the intrinsic-ratio hint that reserves the slot even in the frame
 *     before the stylesheet applies. Either way a mark that has not downloaded
 *     yet occupies exactly the space it will occupy later, so a slow network
 *     re-flows nothing.
 *  2. **failure falls back to the abbreviation.** A missing file, a blocked
 *     request or an offline first paint shows `CHI`, which is what the row said
 *     before this existed. There is no state in which the reader gets an empty
 *     gap or a broken-image glyph.
 *  3. **an unknown team is not an error.** Free agents and codes we do not
 *     recognise take the same path as a failed load, because they want the same
 *     answer on screen.
 *
 * The failure is remembered per URL rather than as a bare boolean: the draft
 * board re-sorts under its rows, React reuses the component instances, and a
 * boolean would let one team's broken load blank out whichever team landed in
 * that row next.
 */
export function TeamLogo({ team }: { team: string | null | undefined }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const club = nflTeam(team);
  const src = nflTeamLogoUrl(team);

  if (club && src && failedSrc !== src) {
    return (
      <img
        className="team-logo"
        data-testid="team-logo"
        data-team={club.code}
        src={src}
        alt={club.name}
        width={22}
        height={22}
        loading="lazy"
        decoding="async"
        onError={() => setFailedSrc(src)}
      />
    );
  }

  // Whatever we can honestly call the team, which for a free agent is nothing.
  const code = club?.code ?? normalizeTeam(team);
  return (
    <span className="team-code" data-testid="team-code">
      {code || 'FA'}
    </span>
  );
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
 *
 * The club beside it is drawn as its mark rather than spelled out; see
 * {@link TeamLogo} for what happens when it cannot be.
 */
export function PositionBadge({ position, team }: { position: string | null; team?: string | null }) {
  const pos = (position ?? '').toUpperCase();
  const known = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(pos);
  return (
    <span className="pos-team">
      <span className={known ? `pos-pill pos-${pos}` : 'pos-pill'} data-position={pos || 'UNKNOWN'}>
        {pos || '—'}
      </span>
      {team !== undefined ? <TeamLogo team={team} /> : null}
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

/**
 * The class list that gives a **row** its position accent without the wash.
 *
 * The card classes above set two custom properties and a background; this sets
 * only the properties, so a row can take the position's hue on its leading edge
 * and in its pill while its surface stays the list's own. That is the whole
 * difference between the draft board's cards and the dense lists on Players and
 * Trades, and it is one word in a class name rather than a second palette.
 */
export function positionAccentClass(position: string | null | undefined, base: string): string {
  const pos = (position ?? '').toUpperCase();
  return TINTED_POSITIONS.includes(pos) ? `${base} card-pos-${pos}` : base;
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
  /**
   * The ARIA live-region role, when this notice is one.
   *
   * Off by default, because most notices are part of the page the reader is
   * already working through and announcing them all would make the screen
   * chatter. `status` for something that appeared quietly, `alert` for
   * something that should interrupt — which is a short list: the offline
   * capture banner on Draft is on it, because reading a stale board as a live
   * one is how somebody drafts a player who is already gone.
   */
  role,
  'data-testid': testId,
}: {
  children: ReactNode;
  tone?: 'warn' | 'error' | 'ok';
  role?: 'status' | 'alert';
  'data-testid'?: string;
}) {
  const cls = tone === 'error' ? 'notice notice-error' : tone === 'ok' ? 'notice notice-ok' : 'notice';
  return (
    <div className={cls} role={role} data-testid={testId}>
      {children}
    </div>
  );
}

/**
 * A statement of fact, as one line rather than a banner.
 *
 * `Notice` is a filled, bordered block, and that is the right shape for
 * something that interrupts — an offline capture, a failed write. It is the
 * wrong shape for the far more common case: the screen saying what it could not
 * work out. "Roster not identified" is not an alarm, and a yellow box the width
 * of the phone announcing it is the screen shouting about its own limitations
 * above the answers it does have.
 *
 * A mark, a sentence, and the page's own ground under it. The mark is a glyph
 * rather than a colour, so the state survives greyscale and a screen reader
 * alike; `role` is offered for the rare line that genuinely needs announcing.
 */
export function StatusRow({
  children,
  tone = 'warn',
  role,
  'data-testid': testId,
}: {
  children: ReactNode;
  tone?: 'warn' | 'error' | 'info';
  role?: 'status' | 'alert';
  'data-testid'?: string;
}) {
  return (
    <div
      className={tone === 'error' ? 'notice-row notice-row-error' : 'notice-row'}
      role={role}
      data-testid={testId}
      data-tone={tone}
    >
      <span className="notice-row-mark" aria-hidden="true">
        {tone === 'info' ? 'ⓘ' : '⚠'}
      </span>
      <span>{children}</span>
    </div>
  );
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
