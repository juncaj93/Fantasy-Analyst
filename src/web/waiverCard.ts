/**
 * What a waiver card prints, decided once for every place a card appears.
 *
 * Waivers' three tiers, Team's "Waiver moves", the defence and unscored rows
 * and the older board all draw `WaiverCard` from one of these. The card is a
 * face, a name, one line of chips that never wraps, one gain chip and at most
 * one short reason. Everything else the old cards printed is on the detail
 * sheet (Alex, 21 October 2026: "way too much text all over the place").
 *
 * Presentation only. Every number and word here is read from the engine's row
 * as it arrived; nothing is recomputed, re-ranked or re-tiered.
 */

import type { TierRow } from '../core/waivers/tierPlan.ts';
import type { WaiverBoardRow } from '../core/waivers/board.ts';

/** The fixed set of chips a card may carry, two at most. */
export interface CardChip {
  key: 'free' | 'waivers' | 'open' | 'needs' | 'bid' | 'drop' | 'ir' | 'pick' | 'starter' | 'injury';
  label: string;
}

export interface WaiverCardModel {
  playerId: string;
  name: string;
  position: string;
  team: string;
  /** `+10.8`, or `IR stash` / a verdict word. The same number the row always carried. */
  gain: string;
  /** Spoken form of the gain chip. */
  gainSpoken: string;
  /** The tint: `tag-take` for Do this, `tag-calm` for Worth considering, none for the rest. */
  gainTone: string;
  /** At most two, in priority order. */
  chips: CardChip[];
  /** The chips that did not fit; the sheet carries what they say. */
  overflow: CardChip[];
  /** An injured-reserve stash: no points to print, so the score column shows Team's dash. */
  stash?: boolean;
  /** One short reason, about 32 characters, or none. */
  reason: string | null;
  /** The full reason, for the accessible name and the sheet. */
  fullReason: string | null;
}

/** The longest reason a card prints before the sheet takes over. */
export const CARD_REASON_MAX = 32;
export const CARD_CHIPS_MAX = 2;

const TIER_TONE: Record<TierRow['tier'], string> = { do_this: 'tag-take', consider: 'tag-calm', watch: '' };

/** `Wed`: the day a player on waivers clears, in the reader's own time zone. */
export function clearDay(iso: string | null): string {
  if (!iso) return 'the next run';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? 'the next run' : at.toLocaleDateString('en-US', { weekday: 'short' });
}

/** `Sam LaPorta` → `LaPorta`; `Amon-Ra St. Brown` → `St. Brown`; a suffix stays with the surname. */
export function surname(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name.trim();
  const last = parts[parts.length - 1]!;
  if (/^(Jr\.?|Sr\.?|II|III|IV|V)$/i.test(last) && parts.length > 2) return `${parts[parts.length - 2]} ${last}`;
  if (parts.length > 2 && /^(St\.?|De|Van|Von|Le|La|Di)$/i.test(parts[parts.length - 2]!)) return parts.slice(-2).join(' ');
  return last;
}

/** `Braelon Allen` → `B. Allen`. */
function initialled(name: string): string {
  const last = surname(name);
  const first = name.trim().split(/\s+/)[0] ?? '';
  return first && first !== last ? `${first[0]}. ${last}` : last;
}

/** Clip to the card's limit with an ellipsis. The sheet has the rest. */
function clip(text: string): string {
  return text.length <= CARD_REASON_MAX ? text : `${text.slice(0, CARD_REASON_MAX - 1).trimEnd()}…`;
}

/**
 * The engine's reason, in the card's few words.
 *
 * Pattern by pattern over the sentences `core/waivers/tiers.ts` writes; an
 * unknown sentence is clipped rather than guessed at. Null when the reason
 * only restates the gain chip.
 */
export function shortReason(row: Pick<TierRow, 'reason' | 'reasonCode' | 'stashLabel'>): string | null {
  const r = row.reason.trim();
  let m: RegExpMatchArray | null;
  if ((m = r.match(/^Your [A-Z/]+ (.+?) is on bye in week (\d+)$/))) return clip(`${surname(m[1]!)} on bye wk ${m[2]}`);
  if ((m = r.match(/^Your [A-Z/]+ (.+?) is (Out|on IR|on PUP|suspended|Doubtful|Questionable|questionable|doubtful|out)(?: for week (\d+))?$/)))
    return clip(`${surname(m[1]!)} ${m[2]!.toLowerCase()}${m[3] ? ` wk ${m[3]}` : ''}`);
  if ((m = r.match(/^Nobody on your roster can start at ([A-Z/]+) in week (\d+)$/))) return clip(`No ${m[1]} to start wk ${m[2]}`);
  if ((m = r.match(/^Starts over (.+?)(?:, \+[\d.]+ pts in week (\d+))?$/))) return clip(`Starts over ${initialled(m[1]!)}${m[2] ? ` wk ${m[2]}` : ''}`);
  if (/^Makes your lineup better by/.test(r)) return null;
  if ((m = r.match(/^Backup for your [A-Z/]+ (.+?), who is/))) return clip(`Backs up ${surname(m[1]!)}`);
  if ((m = r.match(/^Better depth than (.+?); he would not start yet$/))) return clip(m[1] === 'what you hold' ? 'Bench depth' : `Depth over ${initialled(m[1]!)}`);
  if (/^Starts this week:/.test(r)) return 'Starts this week';
  /* A tie is about this week, and the gain beside it is three weeks: say which (22 October 2026). */
  if ((m = r.match(/^Ties (.+) this week$/))) return clip(m[1] === 'your best lineup' ? 'Ties your lineup this week' : `Ties ${initialled(m[1]!)} this week`);
  if (row.reasonCode === 'ir_stash') {
    if (row.stashLabel === 'return unknown') return 'Out now, return unknown';
    return row.stashLabel ? clip(`IR stash, ${row.stashLabel}`) : 'IR stash, out now';
  }
  return r ? clip(r) : null;
}

/** `+10.8`, `IR stash`, `Return unknown`: the gain chip, without the unit. */
export function gainChip(row: Pick<TierRow, 'gain' | 'reasonCode'> & { stashLabel?: string | null }): string {
  if (row.reasonCode === 'ir_stash') return row.stashLabel === 'return unknown' ? 'Return unknown' : 'IR stash';
  return `+${Math.max(0, row.gain).toFixed(1)}`;
}

/** `$3–7` or `$3`: the bid band the engine set. */
function bidLabel(bid: TierRow['bid']): string | null {
  if (bid.kind !== 'claim' || bid.recommended == null) return null;
  if (bid.low != null && bid.high != null && bid.low !== bid.high) return `$${bid.low}–${bid.high}`;
  return `$${bid.recommended}`;
}

/**
 * `Waivers $3–7`, or `Waivers until Wed` with no price. Short, because it sits
 * on the name line like Team's matchup pill (22 October 2026); the day the
 * claim clears is on the sheet's pickup line.
 */
export function waiverChip(until: string | null, band: string | null): string {
  if (band) return `Waivers ${band}`;
  return until ? `Waivers until ${clearDay(until)}` : 'Waivers';
}

/** The card for one tier move. */
export function tierCard(row: TierRow): WaiverCardModel {
  const all: CardChip[] = [];
  /*
   * One chip for a claim: the waiver status and the bid band together,
   * `Waivers until Wed $3–7` (Alex, 22 October 2026), so neither gives way to
   * the other. The bid history stays on the sheet.
   */
  const bid = bidLabel(row.bid);
  if (row.bid.kind === 'free') all.push({ key: 'free', label: 'Free agent' });
  else if (row.bid.kind === 'claim') all.push({ key: 'waivers', label: waiverChip(row.bid.until, bid) });
  if (row.needsSpot) all.push(row.tier === 'do_this' ? { key: 'pick', label: 'Pick your drop' } : { key: 'needs', label: 'Needs a drop' });
  else if (row.drop?.viaReserve) all.push({ key: 'ir', label: `IR: ${surname(row.drop.name)}` });
  else if (row.drop) all.push({ key: 'drop', label: `Drop: ${surname(row.drop.name)}` });
  else all.push({ key: 'open', label: 'Open spot' });
  if (row.reasonCode === 'hole_injury') all.push({ key: 'starter', label: 'Starter out' });
  const gain = gainChip(row);
  return {
    playerId: row.playerId,
    name: row.name,
    position: row.position,
    team: row.team,
    gain,
    gainSpoken: gain.startsWith('+') ? `${gain} points` : gain,
    gainTone: TIER_TONE[row.tier],
    ...(row.reasonCode === 'ir_stash' ? { stash: true } : {}),
    chips: all.slice(0, CARD_CHIPS_MAX),
    overflow: all.slice(CARD_CHIPS_MAX),
    reason: shortReason(row),
    fullReason: row.reason || null,
  };
}

/**
 * A tier, highest gain chip first.
 *
 * The engine ranks Worth considering and the Watch list by each move's gain
 * with its first-choice drop, then shares the drops out, which can change a
 * move's gain; a tie joins the list whatever its gain. So the list could read
 * +3.9, +2.4, +3.3, +0.0 (Alex, 22 October 2026). Sorted here by the number
 * the chip shows, stable, so equal gains keep the engine's order. "Do this"
 * is never resorted: its order is the order to enter the claims.
 */
export function byGain<T extends Pick<TierRow, 'gain'>>(rows: readonly T[]): T[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => Math.max(0, b.row.gain) - Math.max(0, a.row.gain) || a.i - b.i)
    .map(({ row }) => row);
}

/** `Questionable` → `Q`, `Out` → `O`, `IR` → `IR`. Anything else stays off the chip and on the sheet. */
export function injuryLetter(flag: string | null | undefined): string | null {
  const word = (flag ?? '').trim().split(/[\s·,]+/)[0]?.toLowerCase() ?? '';
  if (word === 'questionable') return 'Q';
  if (word === 'doubtful') return 'D';
  if (word === 'out') return 'O';
  if (word === 'ir' || word === 'injured') return 'IR';
  if (word === 'pup') return 'PUP';
  if (word === 'suspended' || word === 'sus') return 'SUS';
  return null;
}

/** `$3–7`, `$4`, `12–18%`: the board row's own cost band. */
export function faabBand(faab: NonNullable<WaiverBoardRow['faab']>): string | null {
  const unit = faab.unit ?? 'percent';
  const suffix = unit === 'percent' ? '%' : '';
  const prefix = unit === 'dollar' ? '$' : '';
  if (faab.low == null && faab.high == null) return null;
  if (faab.low == null) return `≤${prefix}${faab.high}${suffix}`;
  if (faab.high == null) return `${prefix}${faab.low}${suffix}+`;
  if (faab.low === faab.high) return `${prefix}${faab.low}${suffix}`;
  return `${prefix}${faab.low}–${faab.high}${suffix}`;
}

/**
 * The card for a board row: a defence the planner named, a player the app
 * cannot score, or a league without tiers. The right-hand chip is the row's
 * verdict word, as it always was; the reason is `cardReason`'s, clipped.
 */
export function boardCard(row: WaiverBoardRow, reason: string | null, tone: string): WaiverCardModel {
  const all: CardChip[] = [];
  const band = row.pickup?.state !== 'free' && row.faab ? faabBand(row.faab) : null;
  if (row.pickup?.state === 'free') all.push({ key: 'free', label: 'Free agent' });
  else if (row.pickup?.state === 'waivers') all.push({ key: 'waivers', label: waiverChip(row.pickup.until, band) });
  else if (band) all.push({ key: 'bid', label: band });
  const letter = injuryLetter(row.statusFlag);
  /* The injury letter is the one chip that never gives way: it is a warning. */
  const chips = letter ? [...all.slice(0, CARD_CHIPS_MAX - 1), { key: 'injury' as const, label: letter }] : all.slice(0, CARD_CHIPS_MAX);
  const overflow = all.filter((c) => !chips.includes(c));
  return {
    playerId: row.playerId,
    name: row.name,
    position: row.position ?? '',
    team: row.team ?? '',
    gain: row.strength.label,
    gainSpoken: row.strength.label,
    gainTone: tone,
    chips,
    overflow,
    reason: reason ? clip(reason) : null,
    fullReason: reason,
  };
}

/* ---------------------------------------------------------- the detail sheet */

export type SheetPeriod = 'this' | 'next' | 'three';

/** A drop option on the sheet: name, position and season points, nothing else. */
export interface SheetDrop {
  playerId: string;
  name: string;
  position: string;
  /** `1.2 pts`, season points, or null when the planner gave none. */
  points: string | null;
}

/** What the waiver detail sheet opens on (22 October 2026: the sheet is a comparison and nothing else). */
export interface WaiverSheetModel {
  playerId: string;
  name: string;
  position: string;
  team: string;
  /** The status or bid chip, then the drop chip, as on the card. */
  chips: CardChip[];
  /** Who he is compared with; null when there is nobody (an open spot). */
  partner: { playerId: string; name: string } | null;
  period: SheetPeriod;
  /** Up to three, only when a drop is needed. */
  drops: SheetDrop[];
}

type Figures = NonNullable<import('../core/waivers/tierPlan.ts').WaiverTiersView['weekFigures']>;
type PickupStart = { start: { playerId: string; displaces?: { playerId: string; name: string } | null; over?: { playerId: string; name: string } | null } | null; consider: { playerId: string; displaces?: { playerId: string; name: string } | null; over?: { playerId: string; name: string } | null }[] } | null | undefined;

/**
 * The week the tiers' window treats as "this week": the window starts this
 * week while its games are still ahead (weights 1, 1, 0.5) and next week once
 * they are under way (weights 1, 0.5, 0.5). See `tierWindow`.
 */
export function currentWeekOf(window: { weeks: number[]; weights: number[] }): number {
  const first = window.weeks[0] ?? 0;
  return window.weights[1] === 1 ? first : first - 1;
}

/** The roster player named in a reason: `Starts over Braelon Allen`, `Your TE Sam LaPorta is on bye`, `Ties B. Allen`. */
function namedInReason(reason: string): string | null {
  const m =
    reason.match(/^Starts over (.+?)(?:,|$)/) ??
    reason.match(/^Your [A-Z/]+ (.+?) is /) ??
    reason.match(/^Backup for your [A-Z/]+ (.+?), who is/) ??
    reason.match(/^Ties (.+?) this week$/);
  return m && m[1] !== 'your best lineup' ? m[1]! : null;
}

function byName(figures: Figures | undefined, name: string | null): { playerId: string; name: string } | null {
  if (!figures || !name) return null;
  for (const [playerId, f] of Object.entries(figures)) if (f.name === name) return { playerId, name: f.name };
  return null;
}

/**
 * Who the move is weighed against, one rule for every card:
 *  1. the lineup player the add displaces (Pick up and start: the player who
 *     leaves the best lineup; otherwise the starter his reason names, the one
 *     he "starts over" or the one on bye or hurt);
 *  2. if he displaces nobody (depth, an IR stash, an empty slot), the player
 *     in the Drop chip, or the first of "Pick your drop";
 *  3. nobody, when the spot is open.
 * When the displaced player and the drop differ, the comparison is with the
 * displaced player and the drop is in the chip line only.
 */
export function sheetPartner(row: TierRow, figures: Figures | undefined, pickup: PickupStart): { playerId: string; name: string } | null {
  if (row.reasonCode === 'start_now' || row.reasonCode === 'start_tie') {
    const move = [pickup?.start, ...(pickup?.consider ?? [])].find((m) => m?.playerId === row.playerId);
    const who = move?.displaces ?? move?.over ?? null;
    if (who) return { playerId: who.playerId, name: who.name };
  }
  const displaced = byName(figures, namedInReason(row.reason));
  if (displaced && displaced.playerId !== row.playerId) return displaced;
  if (row.drop) return { playerId: row.drop.playerId, name: row.drop.name };
  const first = (row.bestDrops ?? row.needsSpot ?? [])[0];
  return first ? { playerId: first.playerId, name: first.name } : null;
}

/**
 * Which period the sheet opens on, from the card: a "this week" move opens
 * this week; a move whose reason is about a later week opens that week when it
 * is next week; anything longer (depth, a stash, a week after next) opens the
 * three-week view.
 */
export function sheetPeriod(row: TierRow, window: { weeks: number[]; weights: number[] }): SheetPeriod {
  if (row.reasonCode === 'start_now' || row.reasonCode === 'start_tie') return 'this';
  const weekly = new Set(['hole_bye', 'hole_injury', 'hole_empty', 'bye_depth', 'upgrade', 'big_upgrade']);
  if (!weekly.has(row.reasonCode)) return 'three';
  const named = row.reason.match(/week (\d+)/);
  let focus = named ? Number(named[1]) : null;
  if (focus == null) {
    const k = row.byWeek.reduce((best, w, i) => (w.change > (row.byWeek[best]?.change ?? -Infinity) ? i : best), 0);
    focus = row.byWeek[k]?.week ?? null;
  }
  const now = currentWeekOf(window);
  if (focus === now) return 'this';
  if (focus === now + 1) return 'next';
  return 'three';
}

/** The drop options, only when a drop is needed or Alex picks one: up to three. */
export function sheetDrops(row: TierRow): SheetDrop[] {
  const needs = row.needsSpot != null || (row.drop != null && !row.drop.viaReserve);
  if (!needs) return [];
  const list = row.bestDrops ?? row.needsSpot ?? [];
  const options = list.length > 0 ? list : row.drop ? [{ playerId: row.drop.playerId, name: row.drop.name, position: row.drop.position, stat: undefined }] : [];
  return options.slice(0, 3).map((c) => ({
    playerId: c.playerId,
    name: c.name,
    position: c.position ?? '',
    points: c.stat && /^\d+(\.\d+)? pts$/.test(c.stat) ? c.stat : null,
  }));
}

export function tierSheet(row: TierRow, tiers: { window: { weeks: number[]; weights: number[] }; weekFigures?: Figures }, pickup: PickupStart): WaiverSheetModel {
  return {
    playerId: row.playerId,
    name: row.name,
    position: row.position,
    team: row.team,
    chips: tierCard(row).chips.filter((c) => c.key !== 'starter'),
    partner: sheetPartner(row, tiers.weekFigures, pickup),
    period: sheetPeriod(row, tiers.window),
    drops: sheetDrops(row),
  };
}

/** A board row's sheet (a defense, a trending player, an older league): this week, against the cut when there is one. */
export function boardSheet(row: WaiverBoardRow): WaiverSheetModel {
  const card = boardCard(row, null, '');
  return {
    playerId: row.playerId,
    name: row.name,
    position: row.position ?? '',
    team: row.team ?? '',
    chips: card.chips,
    partner: row.cut ? { playerId: row.cut.playerId, name: row.cut.name } : null,
    period: 'this',
    drops: [],
  };
}
