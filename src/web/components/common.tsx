/**
 * Shared presentational primitives.
 *
 * Accessibility rule enforced here: a positive/negative state is ALWAYS
 * expressed with a glyph and a word in addition to colour.
 */

import type { ReactNode } from 'react';

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
 * A player's position, colour-coded so a long list can be scanned at a glance.
 *
 * The letters stay: colour is an accelerator, never the carrier of the meaning,
 * so this reads identically to somebody who cannot separate the hues. The
 * palette is deliberately restrained — a small pill rather than a coloured row,
 * because forty of these on one screen is what the draft board actually looks
 * like and saturated blocks at that density stop being information.
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

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="stat" title={hint}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
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
