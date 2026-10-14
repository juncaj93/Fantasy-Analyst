/**
 * Alex's Sell and Want marks for the trade builder, kept on this phone.
 *
 * Browser storage, one entry per league, and nothing on the server: the round
 * changes no schema, so marks do not follow Alex to another device. Every read
 * and write is wrapped, because storage throws in a private window and can be
 * cleared at any time; an empty set of marks is always a valid answer.
 */

export interface TradeMarks {
  v: 1;
  sell: string[];
  /** Want marks, by roster id. */
  want: Record<string, string[]>;
  /** The team being looked at: a roster id, or `all`. */
  team: string;
  /** Also consider players Alex did not mark. Off by default. */
  unmarked: boolean;
}

export const EMPTY_MARKS: TradeMarks = { v: 1, sell: [], want: {}, team: 'all', unmarked: false };

export function marksKey(leagueId: string): string {
  return `fa.tradeMarks.${leagueId}`;
}

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((x): x is string => typeof x === 'string' && x.length > 0))] : [];

/** The marks for a league, or none. Anything malformed reads as none. */
export function readMarks(leagueId: string, storage: Storage | null = store()): TradeMarks {
  try {
    const raw = storage?.getItem(marksKey(leagueId));
    if (!raw) return { ...EMPTY_MARKS };
    const parsed = JSON.parse(raw) as Partial<TradeMarks> | null;
    if (!parsed || parsed.v !== 1) return { ...EMPTY_MARKS };
    const want: Record<string, string[]> = {};
    for (const [team, list] of Object.entries(parsed.want ?? {})) {
      const clean = ids(list);
      if (clean.length > 0) want[team] = clean;
    }
    return {
      v: 1,
      sell: ids(parsed.sell),
      want,
      team: typeof parsed.team === 'string' && parsed.team.length > 0 ? parsed.team : 'all',
      unmarked: parsed.unmarked === true,
    };
  } catch {
    return { ...EMPTY_MARKS };
  }
}

export function writeMarks(leagueId: string, marks: TradeMarks, storage: Storage | null = store()): void {
  try {
    storage?.setItem(marksKey(leagueId), JSON.stringify(marks));
  } catch {
    /* Storage full or blocked: the marks still work for this visit. */
  }
}

export function clearMarks(leagueId: string, storage: Storage | null = store()): void {
  try {
    storage?.removeItem(marksKey(leagueId));
  } catch {
    /* Nothing to do. */
  }
}

/** Add the player when he is not marked, take him off when he is. */
export function toggle(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** The builder request for these marks. Only the players still on a roster are sent. */
export function builderQuery(marks: TradeMarks, onRoster: (rosterId: string, playerId: string) => boolean, mineId: string): string {
  const parts = [`team=${encodeURIComponent(marks.team)}`];
  const sell = marks.sell.filter((id) => onRoster(mineId, id));
  if (sell.length > 0) parts.push(`sell=${encodeURIComponent(sell.join(','))}`);
  const want = Object.entries(marks.want)
    .filter(([team]) => marks.team === 'all' || team === marks.team)
    .map(([team, list]) => [team, list.filter((id) => onRoster(team, id))] as const)
    .filter(([, list]) => list.length > 0)
    .map(([team, list]) => `${team}:${list.join(',')}`);
  if (want.length > 0) parts.push(`want=${encodeURIComponent(want.join(';'))}`);
  if (marks.unmarked) parts.push('unmarked=1');
  return parts.join('&');
}

/** `2 Sell · 3 Want`, or nothing when no player is marked. */
export function marksSummary(marks: TradeMarks): string | null {
  const want = Object.values(marks.want).reduce((n, list) => n + list.length, 0);
  const bits = [marks.sell.length > 0 ? `${marks.sell.length} Sell` : null, want > 0 ? `${want} Want` : null].filter(Boolean);
  return bits.length > 0 ? bits.join(' · ') : null;
}
