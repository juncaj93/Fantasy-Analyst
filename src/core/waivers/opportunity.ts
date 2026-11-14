/**
 * The Opportunity finder (Round 26, upgrade A, behind `WAIVERS_LOOKAHEAD`).
 *
 * When a starter loses his job for weeks (out for the season, on IR, a long
 * injury, traded away, or benched), his work does not disappear. The next
 * player in line on his club's depth chart gets most of it. If that player is
 * a free agent, he is a pickup the projections have not caught up with yet.
 *
 * ## The estimate
 *
 * The vacated work is the starter's points a game over his last four games
 * played, in this league's scoring (targets and carries are already inside
 * those points). Who gets it:
 *
 *  1. **Measured**, when his club has already played games without him: the
 *     backup's own points a game in those games. Two games at least.
 *  2. **Inferred** otherwise: the backup's own points a game plus a share of
 *     the vacated points. The next man in line takes
 *     {@link OPPORTUNITY.nextShare}, the one after him
 *     {@link OPPORTUNITY.secondShare}. The shares are the injury module's own
 *     (`injury/beneficiaries.ts`), so one rule says how a vacated role splits.
 *
 * A lead needs the backup to gain at least the toss-up bar a game. Whether he
 * is worth a roster spot to Alex is the upside stash's question
 * (`upsideStash.ts`: would he start in Alex's best season lineup?), not this
 * file's.
 *
 * ## Reads
 *
 * None. Everything comes from rows the Waivers screen already holds: the
 * season's points by week (`sleeper.seasonPoints.<season>`), Sleeper's depth
 * order and injury notes (`sleeper.playerNotes`), the player table, and the
 * fixtures for byes. A trade is read from the same notes row, which the
 * daily player sync now keeps (`moved`, `core/sleeper/playerNotes.ts`).
 *
 * The injury rules are the shared ones, read only: `stashVerdict` for a
 * season-ending or long injury, `isOutThisWeek` for a backup who cannot play.
 *
 * Pure.
 */

import { BENEFICIARY } from '../injury/beneficiaries.ts';
import { normalizeDesignation, type Designation } from '../injury/model.ts';
import { isOutThisWeek } from '../injury/weekAvailability.ts';
import { TOSSUP_POINTS } from '../startsit/tossup.ts';
import { stashVerdict, type InjuryNote } from './stash.ts';

export const OPPORTUNITY = {
  /** The vacated work: his points a game over this many of his latest games. */
  recentGames: 4,
  /** He was a starter: at least this many points a game over those games. */
  starterPoints: { QB: 14, RB: 9, WR: 9, TE: 7 } as Readonly<Record<string, number>>,
  /** ...and played at least this many of them. */
  minGames: 2,
  /** A fresh vacancy: his latest game no more than this many weeks before the latest stored week. */
  freshWeeks: 5,
  /** The next man in line's share of the vacated points (`beneficiaries.ts`). */
  nextShare: BENEFICIARY.depthInferenceShare,
  /** The man after him. */
  secondShare: BENEFICIARY.secondaryInferenceShare,
  /** Games the club played without him before the backup's own number there is trusted. */
  measuredGames: 2,
  /** The backup has to gain at least this a game: the toss-up bar. */
  minGain: TOSSUP_POINTS,
  /** A trade this many weeks old or newer is a fresh vacancy. */
  movedWeeks: 6,
  /** An Out player whose return is this many weeks away or more is a long injury. */
  longWeeks: 3,
  /** The role is taken: read over this many of his club's latest games without him (fewer if that is all there is). */
  takenGames: 4,
  /** ...by a teammate scoring at least this share of the starter bar a game in them. */
  takenShare: 0.75,
} as const;

const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);

export type VacancyCause = 'season' | 'ir' | 'long' | 'traded' | 'benched';

/** A starter's role, open now. */
export interface Vacancy {
  playerId: string;
  name: string;
  position: string;
  /** The club whose role is open: his club, or the one he was traded from. */
  team: string;
  cause: VacancyCause;
  /** His points a game over his latest games: the work that is open. */
  points: number;
}

export interface OpportunityLead {
  /** The free agent who inherits the role. */
  playerId: string;
  name: string;
  position: string;
  team: string;
  vacancy: Vacancy;
  /** His points a game in the role. */
  estimate: number;
  /** His own points a game before, over his latest games. 0 when he has not played. */
  own: number;
  /** The share of the vacated points he takes, 0 to 1. */
  share: number;
  basis: 'measured' | 'inferred';
  /** `Chase out for the season, gets his targets`: the line's one reason. */
  reason: string;
}

export interface OpportunityPlayer {
  id: string;
  fullName: string;
  lastName?: string;
  team: string;
  position: string;
  active: boolean;
  /** Sleeper's injury status on the player table, when the notes row has none. */
  status?: string | null;
}

export interface OpportunityInput {
  /** The current NFL week. */
  week: number;
  players: readonly OpportunityPlayer[];
  /** Everyone on a roster in this league: never a lead. */
  rosteredIds: ReadonlySet<string>;
  /** Sleeper's depth-chart order, 1 to 3. */
  depthOrder: ReadonlyMap<string, number>;
  /** Sleeper's injury status, body part and note. */
  injuryNotes: ReadonlyMap<string, InjuryNote>;
  /** League points by week, index 0 is week 1. */
  seasonPoints: ReadonlyMap<string, readonly number[]>;
  /** The latest week the points cover. */
  through: number;
  /** Players who changed clubs recently (the notes row keeps about six weeks), with the club they left. */
  moved?: ReadonlyMap<string, { from: string; to: string; week?: number }>;
  /** A club with no game that week: its zero is a bye, not a missed game. */
  onBye?: (team: string, week: number) => boolean;
}

/** Every role a free agent inherits, best first. One lead per free agent: his best. */
export function findOpportunities(input: OpportunityInput): OpportunityLead[] {
  const recentOf = memo((id: string) => recentForm(input.seasonPoints.get(id) ?? [], input.through));
  const byClub = new Map<string, OpportunityPlayer[]>();
  for (const p of input.players) {
    if (!p.team) continue;
    const club = p.team.toUpperCase();
    const list = byClub.get(club);
    if (list) list.push(p);
    else byClub.set(club, [p]);
  }

  const leads = new Map<string, OpportunityLead>();
  for (const vacancy of vacancies(input, byClub, recentOf)) {
    /* Round 26 fix: a teammate who already took the role in the games without him leaves nothing for anyone else. */
    const taker = roleTaker(vacancy, input, byClub);
    const mates = (byClub.get(vacancy.team) ?? [])
      .filter(
        (m) =>
          m.id !== vacancy.playerId &&
          m.active &&
          m.position.toUpperCase() === vacancy.position &&
          !isOutThisWeek(designationOf(m, input.injuryNotes)) &&
          !sittingOut(m, input),
      )
      /* Next in line: the depth chart, then (with no chart) the bigger role this season, points a game played. */
      .sort(
        (a, b) =>
          (input.depthOrder.get(a.id) ?? 9) - (input.depthOrder.get(b.id) ?? 9) ||
          seasonRate(input.seasonPoints.get(b.id), input.through) - seasonRate(input.seasonPoints.get(a.id), input.through) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, 2);
    mates.forEach((mate, index) => {
      if (input.rosteredIds.has(mate.id) || (taker != null && taker !== mate.id)) return;
      const lead = leadFor(vacancy, mate, index, input, byClub, recentOf);
      if (!lead) return;
      const held = leads.get(mate.id);
      if (!held || lead.estimate > held.estimate) leads.set(mate.id, lead);
    });
  }
  return [...leads.values()].sort((a, b) => b.estimate - a.estimate || a.playerId.localeCompare(b.playerId));
}

/** The free agents worth scanning: every lead. Few a week, so they cost only their own rows. */
export function opportunityScanIds(input: OpportunityInput, exclude: ReadonlySet<string> = new Set()): string[] {
  return findOpportunities(input)
    .map((l) => l.playerId)
    .filter((id) => !exclude.has(id))
    .sort();
}

/** The open roles: long injuries, trades and benchings of real starters. */
function vacancies(
  input: OpportunityInput,
  byClub: ReadonlyMap<string, OpportunityPlayer[]>,
  recentOf: (id: string) => Recent,
): Vacancy[] {
  const out: Vacancy[] = [];
  for (const p of input.players) {
    const position = p.position.toUpperCase();
    if (!SKILL.has(position) || !p.team) continue;
    const recent = recentOf(p.id);
    const bar = OPPORTUNITY.starterPoints[position] ?? Infinity;
    if (recent.games < OPPORTUNITY.minGames || recent.points < bar) continue;
    const base = { playerId: p.id, name: p.fullName, position, points: round2(recent.points) };

    /* Traded: his old club's role is open, whatever he does at the new one. */
    const move = input.moved?.get(p.id);
    if (move && move.from && move.from.toUpperCase() !== p.team.toUpperCase() && (move.week == null || input.week - move.week <= OPPORTUNITY.movedWeeks)) {
      out.push({ ...base, team: move.from.toUpperCase(), cause: 'traded' });
      continue;
    }

    const fresh = recent.lastWeek != null && input.through - recent.lastWeek <= OPPORTUNITY.freshWeeks;
    const designation = designationOf(p, input.injuryNotes);
    const cause = longInjury(p, designation, input);
    if (cause) {
      if (fresh) out.push({ ...base, team: p.team.toUpperCase(), cause });
      continue;
    }

    /* Benched: healthy, listed behind a teammate who has been scoring less. */
    const order = input.depthOrder.get(p.id);
    if (!fresh || order == null || order < 2 || isOutThisWeek(designation) || designation === 'doubtful') continue;
    const ahead = (byClub.get(p.team.toUpperCase()) ?? []).find(
      (m) => m.id !== p.id && m.position.toUpperCase() === position && input.depthOrder.get(m.id) === 1,
    );
    if (ahead && recentOf(ahead.id).points + OPPORTUNITY.minGain <= recent.points) {
      out.push({ ...base, team: p.team.toUpperCase(), cause: 'benched' });
    }
  }
  return out;
}

/**
 * A backup who has played this season but not in either of his club's last
 * two games is hurt or out of the rotation, whatever his status says: not next
 * in line. A backup who has never scored (a quarterback who has not taken a
 * snap) is not judged by this.
 */
function sittingOut(m: OpportunityPlayer, input: OpportunityInput): boolean {
  const weeks = input.seasonPoints.get(m.id) ?? [];
  if (!weeks.some((x) => x !== 0)) return false;
  const club = m.team.toUpperCase();
  let seen = 0;
  for (let w = input.through; w >= 1 && seen < 2; w--) {
    if (input.onBye?.(club, w)) continue;
    seen++;
    if ((weeks[w - 1] ?? 0) !== 0) return false;
  }
  return seen === 2;
}

/** Out for the season, on IR, or Out with a return weeks away. Null: not a long injury. */
function longInjury(p: OpportunityPlayer, designation: Designation, input: OpportunityInput): VacancyCause | null {
  if (!['out', 'ir', 'pup', 'suspended'].includes(designation)) return null;
  const verdict = stashVerdict({ designation, note: input.injuryNotes.get(p.id) ?? null, week: input.week });
  if (verdict.kind === 'season_ending') return 'season';
  if (designation === 'ir' || designation === 'pup' || designation === 'suspended') return 'ir';
  if (verdict.kind === 'too_late') return 'long';
  if (verdict.kind === 'back_by' && verdict.week - input.week >= OPPORTUNITY.longWeeks) return 'long';
  return null;
}

function leadFor(
  vacancy: Vacancy,
  mate: OpportunityPlayer,
  index: number,
  input: OpportunityInput,
  byClub: ReadonlyMap<string, OpportunityPlayer[]>,
  recentOf: (id: string) => Recent,
): OpportunityLead | null {
  const own = recentOf(mate.id).points;
  /* One quarterback plays: a backup already scoring like a starter has the job, and inherits nothing new. */
  if (vacancy.position === 'QB' && own >= (OPPORTUNITY.starterPoints['QB'] ?? Infinity)) return null;
  const measured = vacancy.cause === 'traded' || vacancy.cause === 'benched' ? null : measuredWithout(vacancy, mate, input, byClub);
  let estimate: number;
  let share: number;
  let basis: OpportunityLead['basis'];
  if (measured) {
    estimate = measured.without;
    share = vacancy.points > 0 ? clamp01((measured.without - measured.with) / vacancy.points) : 0;
    basis = 'measured';
  } else {
    share = index === 0 ? OPPORTUNITY.nextShare : OPPORTUNITY.secondShare;
    estimate = own + share * vacancy.points;
    basis = 'inferred';
  }
  if (estimate - own < OPPORTUNITY.minGain) return null;
  return {
    playerId: mate.id,
    name: mate.fullName,
    position: mate.position.toUpperCase(),
    team: mate.team.toUpperCase(),
    vacancy,
    estimate: round2(estimate),
    own: round2(own),
    share: round2(share),
    basis,
    reason: opportunityReason(vacancy, input.players.find((p) => p.id === vacancy.playerId)?.lastName),
  };
}

/**
 * Whether a teammate at his position has already taken over the role: over
 * his club's games without him since he last played (the latest
 * {@link OPPORTUNITY.takenGames}, or every one if fewer), the teammate
 * played at least half of them, scored at least
 * {@link OPPORTUNITY.takenShare} of the starter bar a game, and at least the
 * toss-up bar more than he did with the starter. Returns that teammate, or
 * null. A quarterback who has been starting since Week 6 has the role: no
 * other backup inherits it. When the taker is himself a free agent, he stays
 * a lead, judged on those games (the measured path).
 *
 * Injuries only: a trade's games without him are not dated here, and a
 * benching's new starter is the lead itself.
 */
export function roleTaker(vacancy: Vacancy, input: OpportunityInput, byClub: ReadonlyMap<string, OpportunityPlayer[]>): string | null {
  if (vacancy.cause === 'traded' || vacancy.cause === 'benched') return null;
  const absent = input.seasonPoints.get(vacancy.playerId) ?? [];
  let last = 0;
  for (let w = input.through; w >= 1; w--) if ((absent[w - 1] ?? 0) !== 0) { last = w; break; }
  if (last === 0) return null;
  const club = byClub.get(vacancy.team) ?? [];
  const pointsOf = (id: string, w: number) => input.seasonPoints.get(id)?.[w - 1] ?? 0;
  /* His club's games since he last played: a club with no points from two players that week did not play. */
  const without: number[] = [];
  for (let w = input.through; w > last && without.length < OPPORTUNITY.takenGames; w--) {
    if (input.onBye?.(vacancy.team, w)) continue;
    const played = club.filter((m) => m.id !== vacancy.playerId && pointsOf(m.id, w) !== 0).length;
    if (played >= BENEFICIARY.minTeammatesForMissedGame) without.push(w);
  }
  if (without.length === 0) return null;
  const together: number[] = [];
  for (let w = last; w >= 1 && together.length < OPPORTUNITY.recentGames; w--) if (pointsOf(vacancy.playerId, w) !== 0) together.push(w);
  const bar = (OPPORTUNITY.starterPoints[vacancy.position] ?? Infinity) * OPPORTUNITY.takenShare;
  const taker = club.find((m) => {
    if (m.id === vacancy.playerId || m.position.toUpperCase() !== vacancy.position) return false;
    const after = without.map((w) => pointsOf(m.id, w));
    const games = after.filter((x) => x !== 0).length;
    if (games * 2 < without.length) return false;
    const avgAfter = mean(after);
    const avgBefore = together.length ? mean(together.map((w) => pointsOf(m.id, w))) : 0;
    return avgAfter >= bar && avgAfter - avgBefore >= OPPORTUNITY.minGain;
  });
  return taker?.id ?? null;
}

/**
 * The backup's points a game in the games his club played without the
 * starter, against the games they played together. Null when there are too
 * few games without him to trust.
 */
function measuredWithout(
  vacancy: Vacancy,
  mate: OpportunityPlayer,
  input: OpportunityInput,
  byClub: ReadonlyMap<string, OpportunityPlayer[]>,
): { without: number; with: number } | null {
  const absent = input.seasonPoints.get(vacancy.playerId) ?? [];
  const backup = input.seasonPoints.get(mate.id) ?? [];
  const club = byClub.get(vacancy.team) ?? [];
  const without: number[] = [];
  const together: number[] = [];
  for (let w = 1; w <= input.through; w++) {
    if (input.onBye?.(vacancy.team, w)) continue;
    const his = backup[w - 1] ?? 0;
    if (his === 0) continue;
    if ((absent[w - 1] ?? 0) !== 0) {
      together.push(his);
      continue;
    }
    /* A week with no points for him is a game he missed only when his club played. */
    const played = club.filter((m) => m.id !== vacancy.playerId && (input.seasonPoints.get(m.id)?.[w - 1] ?? 0) !== 0).length;
    if (played >= BENEFICIARY.minTeammatesForMissedGame) without.push(his);
  }
  if (without.length < OPPORTUNITY.measuredGames || together.length === 0) return null;
  return { without: mean(without), with: mean(together) };
}

/** `Chase out for the season, gets his targets`. */
export function opportunityReason(vacancy: Pick<Vacancy, 'name' | 'position' | 'cause'>, lastName?: string): string {
  const who = lastName?.trim() || surname(vacancy.name);
  const what =
    vacancy.cause === 'season'
      ? 'out for the season'
      : vacancy.cause === 'ir'
        ? 'on IR'
        : vacancy.cause === 'long'
          ? 'out for weeks'
          : vacancy.cause;
  const work = vacancy.position === 'RB' ? 'carries' : vacancy.position === 'QB' ? 'snaps' : 'targets';
  return `${who} ${what}, gets his ${work}`;
}

interface Recent {
  /** Points a game over his latest games played. 0 with none. */
  points: number;
  games: number;
  /** His latest week with points. */
  lastWeek: number | null;
}

/** His latest {@link OPPORTUNITY.recentGames} games played (a week with points), up to `through`. */
function recentForm(weeks: readonly number[], through: number): Recent {
  const games: number[] = [];
  let lastWeek: number | null = null;
  for (let w = Math.min(through, weeks.length); w >= 1 && games.length < OPPORTUNITY.recentGames; w--) {
    const pts = weeks[w - 1] ?? 0;
    if (pts === 0) continue;
    if (lastWeek == null) lastWeek = w;
    games.push(pts);
  }
  return { points: games.length ? mean(games) : 0, games: games.length, lastWeek };
}

/** Points a game played this season, through `through`. 0 with no games. */
function seasonRate(weeks: readonly number[] | undefined, through: number): number {
  const played = (weeks ?? []).slice(0, through).filter((x) => x !== 0);
  return played.length ? mean(played) : 0;
}

function designationOf(p: OpportunityPlayer, notes: ReadonlyMap<string, InjuryNote>): Designation {
  return normalizeDesignation(notes.get(p.id)?.status ?? p.status ?? null).designation;
}

/** `Ja'Marr Chase` → `Chase`; a suffix stays off. */
function surname(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name.trim();
  const last = parts[parts.length - 1]!;
  return /^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(last) && parts.length > 2 ? parts[parts.length - 2]! : last;
}

function memo<T>(f: (id: string) => T): (id: string) => T {
  const cache = new Map<string, T>();
  return (id) => {
    if (!cache.has(id)) cache.set(id, f(id));
    return cache.get(id)!;
  };
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
