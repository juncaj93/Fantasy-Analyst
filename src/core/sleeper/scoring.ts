/**
 * League scoring / roster-shape interpretation.
 *
 * Everything here is derived from the Sleeper league payload — nothing about the
 * league's rules is hardcoded in the recommendation engines.
 */

import { buildDstScoring, type DstScoring } from './dstScoring.ts';

export interface ScoringProfile {
  /** Points per reception (Sleeper key `rec`). */
  ppr: number;
  /** Extra points per reception for TEs beyond `ppr` (`bonus_rec_te`). */
  teBonus: number;
  pointsPerRushYard: number;
  pointsPerRecYard: number;
  pointsPerPassYard: number;
  passTd: number;
  rushTd: number;
  recTd: number;
  interception: number;
  fumbleLost: number;
  /** True when QBs can fill a SUPER_FLEX slot. */
  superflex: boolean;
  /** True when `bonus_rec_te > 0`. */
  tePremium: boolean;
  /** Label such as "Full PPR", "Half PPR", "Standard". */
  label: string;
  /**
   * What this league pays a defence for, or a refusal to guess.
   *
   * Carried on the profile rather than built at each call site because every
   * engine already receives a profile, and a defence scored one way by the
   * lineup screen and another by the trade engine is the same class of bug as
   * a player who is Questionable on one screen and healthy on the next. See
   * `dstScoring.ts` for why this cannot fall back to a standard table.
   */
  dst: DstScoring;
}

export interface RosterShape {
  /** Fixed starting slots by position, e.g. `{ QB: 1, RB: 2, WR: 3, TE: 1 }`. */
  starters: Record<string, number>;
  /** Flex slots keyed by slot name with the positions they accept. */
  flex: { slot: string; positions: string[] }[];
  benchSlots: number;
  irSlots: number;
  totalStarters: number;
  superflex: boolean;
}

/**
 * Every position this league can actually start.
 *
 * The draft board and player list are filtered by this rather than by a fixed
 * list, because "which positions matter" is a property of the league, not of
 * football. A league with no kicker slot should never be offered a kicker, and
 * one that starts a defence should see defences.
 */
export function startablePositions(shape: RosterShape): Set<string> {
  const out = new Set<string>(Object.keys(shape.starters));
  for (const flex of shape.flex) for (const p of flex.positions) out.add(p);
  return out;
}

/**
 * Which published ADP describes this league.
 *
 * ADP is not one number. The order players go in a half-PPR 1QB redraft is not
 * the order they go in full PPR, and it is nothing like superflex, where
 * quarterbacks leave the board early. Asking for the wrong one produces a board
 * that is subtly wrong everywhere rather than obviously wrong somewhere.
 *
 * Derived from the league itself so there is nothing to keep in sync by hand.
 */
export interface AdpFormat {
  scoringFormat: 'PPR' | 'HALF_PPR' | 'STANDARD';
  draftType: 'REDRAFT' | 'DYNASTY';
  qbType: '1QB' | 'SUPERFLEX';
}

export function adpFormatForLeague(
  profile: ScoringProfile,
  shape: RosterShape,
  leagueSettings: Record<string, unknown> = {},
): AdpFormat {
  const scoringFormat = profile.ppr >= 0.95 ? 'PPR' : profile.ppr >= 0.4 ? 'HALF_PPR' : 'STANDARD';

  // Sleeper's league `type`: 0 redraft, 1 keeper, 2 dynasty. A keeper league
  // drafts far closer to a redraft than to a dynasty, so it maps to redraft.
  const draftType = leagueSettings['type'] === 2 ? 'DYNASTY' : 'REDRAFT';

  // Two starting quarterbacks changes the draft the same way superflex does,
  // whether or not the slot is named SUPER_FLEX.
  const qbType = shape.superflex || (shape.starters['QB'] ?? 1) >= 2 ? 'SUPERFLEX' : '1QB';

  return { scoringFormat, draftType, qbType };
}

/** Which real positions each Sleeper roster slot accepts. */
export const FLEX_ELIGIBILITY: Record<string, string[]> = {
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  WRRB_WRT: ['RB', 'WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB'],
};

/**
 * Slots that never get a recommendation.
 *
 * `K` sits here for the same reason kickers are not synced: the app has no
 * opinion about them, so treating a kicker slot as a starting slot would
 * produce a lineup row it could never fill and a warning it could never clear.
 */
const NON_PLAYING_SLOTS = new Set(['BN', 'IR', 'TAXI', 'K']);

function num(settings: Record<string, number>, key: string, fallback = 0): number {
  const v = settings[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function buildScoringProfile(scoringSettings: Record<string, number>, rosterPositions: string[] = []): ScoringProfile {
  const s = scoringSettings ?? {};
  const ppr = num(s, 'rec', 0);
  const teBonus = num(s, 'bonus_rec_te', 0);
  const superflex = rosterPositions.some((p) => p === 'SUPER_FLEX' || p === 'QB2');
  return {
    ppr,
    teBonus,
    pointsPerRushYard: num(s, 'rush_yd', 0.1),
    pointsPerRecYard: num(s, 'rec_yd', 0.1),
    pointsPerPassYard: num(s, 'pass_yd', 0.04),
    passTd: num(s, 'pass_td', 4),
    rushTd: num(s, 'rush_td', 6),
    recTd: num(s, 'rec_td', 6),
    interception: num(s, 'pass_int', -1),
    fumbleLost: num(s, 'fum_lost', -2),
    superflex,
    tePremium: teBonus > 0,
    label: pprLabel(ppr),
    dst: buildDstScoring(scoringSettings),
  };
}

function pprLabel(ppr: number): string {
  if (ppr >= 0.95) return 'Full PPR';
  if (ppr >= 0.4) return 'Half PPR';
  if (ppr > 0) return `${ppr} PPR`;
  return 'Standard';
}

export function buildRosterShape(rosterPositions: string[]): RosterShape {
  const starters: Record<string, number> = {};
  const flex: { slot: string; positions: string[] }[] = [];
  let benchSlots = 0;
  let irSlots = 0;

  for (const raw of rosterPositions ?? []) {
    const slot = String(raw).toUpperCase();
    if (slot === 'BN') {
      benchSlots++;
      continue;
    }
    if (slot === 'IR' || slot === 'TAXI') {
      irSlots++;
      continue;
    }
    const eligible = FLEX_ELIGIBILITY[slot];
    if (eligible) {
      flex.push({ slot, positions: [...eligible] });
      continue;
    }
    if (NON_PLAYING_SLOTS.has(slot)) continue;
    const pos = slot === 'QB2' ? 'QB' : slot;
    starters[pos] = (starters[pos] ?? 0) + 1;
  }

  const totalStarters = Object.values(starters).reduce((a, b) => a + b, 0) + flex.length;
  return {
    starters,
    flex,
    benchSlots,
    irSlots,
    totalStarters,
    superflex: (rosterPositions ?? []).some((p) => p === 'SUPER_FLEX' || p === 'QB2'),
  };
}

/**
 * League-fit multiplier per position, in the range [0.85, 1.25].
 *
 * This expresses "how much more or less this league values a position than a
 * baseline half-PPR 1QB league". It is intentionally small and bounded: league
 * fit nudges ordering, it never dominates market value.
 */
export function leagueFitMultipliers(profile: ScoringProfile, shape: RosterShape): Record<string, number> {
  const fit: Record<string, number> = { QB: 1, RB: 1, WR: 1, TE: 1, K: 1, DEF: 1 };

  // Reception-heavy scoring lifts pass catchers relative to early-down backs.
  const pprDelta = profile.ppr - 0.5;
  fit['WR'] = 1 + clamp(pprDelta * 0.16, -0.08, 0.08);
  fit['TE'] = 1 + clamp(pprDelta * 0.16, -0.08, 0.08);
  fit['RB'] = 1 - clamp(pprDelta * 0.1, -0.05, 0.05);

  // TE premium.
  if (profile.teBonus > 0) fit['TE'] = fit['TE']! + clamp(profile.teBonus * 0.15, 0, 0.12);

  // Superflex / 2QB makes quarterbacks genuinely scarce.
  if (shape.superflex) fit['QB'] = 1.25;
  else if ((shape.starters['QB'] ?? 1) >= 2) fit['QB'] = 1.2;

  // Higher passing-TD scoring modestly lifts QBs.
  if (profile.passTd >= 6) fit['QB'] = clamp(fit['QB']! + 0.05, 0.85, 1.25);

  for (const k of Object.keys(fit)) fit[k] = round3(clamp(fit[k]!, 0.85, 1.25));
  return fit;
}

/** Human-readable notes explaining the league-fit multipliers. */
export function leagueFitNotes(profile: ScoringProfile, shape: RosterShape): string[] {
  const notes: string[] = [profile.label];
  if (shape.superflex) notes.push('Superflex: QB value raised');
  if (profile.tePremium) notes.push(`TE premium (+${profile.teBonus}/rec)`);
  if (profile.passTd >= 6) notes.push(`${profile.passTd} pt passing TDs`);
  if (shape.flex.length > 0) notes.push(`${shape.flex.length} flex slot${shape.flex.length > 1 ? 's' : ''}`);
  return notes;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
