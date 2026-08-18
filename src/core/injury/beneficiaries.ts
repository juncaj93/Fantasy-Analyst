/**
 * When a starter is out, the football does not disappear.
 *
 * Twenty carries and eight targets are still going to be handed out on Sunday,
 * and the only useful question is who to. This builds the answer from the one
 * piece of evidence that is not speculation — **the games the team has already
 * played without him** — and falls back to depth-chart inference only when that
 * evidence does not exist, saying which of the two it used every time.
 *
 * ## What it measures
 *
 * For every teammate, opportunity per game in the weeks the absent player
 * played against the weeks he did not. The difference is the claim: not "he is
 * the backup", which is a guess about a depth chart nobody publishes reliably,
 * but "in the two games this man missed, this teammate carried it six more
 * times a game", which is a fact about football that already happened.
 *
 * Weeks the absent player missed are *derived* rather than trusted: a week with
 * no row for him and rows for several teammates is a game he missed, while a
 * week with no rows for anybody is the team's bye. That distinction is the
 * whole reliability of the without-sample, so it is made from the data rather
 * than from an injury table that may not go back far enough.
 *
 * ## Where it refuses
 *
 * A starter who has never missed a game and a team with no second player at his
 * position both produce `unknown`. There is no synthetic depth chart here and
 * no imputed share: the brief's instruction — *if data insufficient, say
 * unknown* — is implemented as an early return rather than as a low confidence
 * on a number that was invented anyway.
 *
 * ## What it is not
 *
 * Nothing here scores a lineup, adds a player or drops one. It produces a
 * ranked list of names with an opportunity delta and a stated basis, which
 * Waivers, Start/Sit, Trades and the emergency-pivot sentence all read. The
 * confidence travels with the number, because a one-game sample and a five-game
 * sample are not the same claim and the caller must be able to tell.
 */

import type { UsageWeek } from '../usage/role.ts';

export const BENEFICIARY = {
  /** Games without the starter at which the read is high confidence. */
  strongSample: 3,
  /** ...and below which nothing is claimed from absence at all. */
  minSample: 1,
  /**
   * Teammates with a row, below which a missing week is a bye rather than a
   * game he missed. Two, because one teammate's row can be a practice-squad
   * call-up in a week the team did not play.
   */
  minTeammatesForMissedGame: 2,
  /**
   * Share of a departing player's own volume that depth inference hands to the
   * next man, when there is no absence to measure.
   *
   * Deliberately well below 1: the carries of an injured starter are spread
   * across a committee, a formation change and a game script that is now
   * different, and handing them all to one name is the single most common way a
   * projection like this embarrasses itself.
   */
  depthInferenceShare: 0.55,
  /** How much of the remainder the second man in line is credited with. */
  secondaryInferenceShare: 0.25,
  /** Opportunity per game below which a delta is not worth a sentence. */
  material: 1.5,
} as const;

export type BeneficiaryBasis = 'prior_absence' | 'depth_inference';

export interface TeammateUsage {
  playerId: string;
  name: string;
  position: string;
  weeks: UsageWeek[];
}

export interface BeneficiaryInput {
  team: string;
  /** The player who is Out, IR or strongly limited. */
  absent: TeammateUsage;
  /** Everyone else on the same offence with stored usage. */
  teammates: TeammateUsage[];
}

export interface Beneficiary {
  playerId: string;
  name: string;
  position: string;
  /** Extra carries per game, when carries are part of his job. Null if not. */
  carriesDelta: number | null;
  /** Extra targets per game, same rule. */
  targetsDelta: number | null;
  basis: BeneficiaryBasis;
  /** Games this rests on. Zero for a depth inference, and it says so. */
  gamesWithout: number;
  confidence: 'high' | 'medium' | 'low';
  /** `If Gibbs OUT -> Montgomery expected carries +6, receiving role +2 targets` */
  display: string;
}

export interface BeneficiaryGraph {
  team: string;
  absentPlayerId: string;
  absentName: string;
  /** The opportunity that is actually in play, per game. */
  vacated: { carries: number | null; targets: number | null };
  /** Biggest gain first. Empty when nothing can be said. */
  beneficiaries: Beneficiary[];
  unknown: boolean;
  /** Plain sentences about what the answer rests on, and what it does not. */
  notes: string[];
}

/**
 * Who gains, and by how much.
 *
 * The two bases are never mixed inside one graph. Absence evidence, where it
 * exists, is the whole answer; depth inference is what happens instead when it
 * does not. Blending them would produce a number nobody could interpret and a
 * confidence nobody could defend.
 */
export function buildBeneficiaryGraph(input: BeneficiaryInput): BeneficiaryGraph {
  const absentWeeks = regular(input.absent.weeks);
  const vacated = {
    carries: perGame(absentWeeks, (w) => w.carries),
    targets: perGame(absentWeeks, (w) => w.targets),
  };
  const empty: BeneficiaryGraph = {
    team: input.team,
    absentPlayerId: input.absent.playerId,
    absentName: input.absent.name,
    vacated,
    beneficiaries: [],
    unknown: true,
    notes: [],
  };

  const played = new Set(absentWeeks.map((w) => w.week));
  const teamWeeks = teamWeeksPlayed(input.teammates);
  const missed = [...teamWeeks].filter((w) => !played.has(w)).sort((a, b) => a - b);

  if (missed.length >= BENEFICIARY.minSample) {
    const beneficiaries = fromAbsence(input.teammates, played, new Set(missed));
    if (beneficiaries.length > 0) {
      return {
        ...empty,
        beneficiaries,
        unknown: false,
        notes: [
          `measured across ${missed.length} game${missed.length === 1 ? '' : 's'} the team played without ${input.absent.name} (week${missed.length === 1 ? '' : 's'} ${missed.join(', ')})`,
          ...(missed.length < BENEFICIARY.strongSample
            ? ['a small sample — one game without him is one game of game script as much as it is a role']
            : []),
        ],
      };
    }
  }

  const inferred = fromDepth(input.absent, input.teammates, vacated);
  if (inferred.length === 0) {
    return {
      ...empty,
      notes: [
        `${input.absent.name} has not missed a game in the stored weeks, and no teammate at his position has enough usage to infer from`,
        'unknown — no beneficiary is claimed',
      ],
    };
  }

  return {
    ...empty,
    beneficiaries: inferred,
    unknown: false,
    notes: [
      `${input.absent.name} has not missed a game in the stored weeks, so this is inferred from who else is already getting work at his position`,
      'inference, not measurement — the opportunity is usually split more widely than a depth chart suggests',
    ],
  };
}

/**
 * The weeks the team actually played.
 *
 * Union across teammates, kept only where enough of them have a row: this is
 * what separates a game the absent player missed from the team's bye, and it is
 * the reason the without-sample can be trusted at all.
 */
function teamWeeksPlayed(teammates: TeammateUsage[]): Set<number> {
  const counts = new Map<number, number>();
  for (const mate of teammates) {
    for (const week of regular(mate.weeks)) counts.set(week.week, (counts.get(week.week) ?? 0) + 1);
  }
  const out = new Set<number>();
  for (const [week, count] of counts) if (count >= BENEFICIARY.minTeammatesForMissedGame) out.add(week);
  return out;
}

/** With him against without him, one teammate at a time. */
function fromAbsence(teammates: TeammateUsage[], played: Set<number>, missed: Set<number>): Beneficiary[] {
  const out: Beneficiary[] = [];
  for (const mate of teammates) {
    const weeks = regular(mate.weeks);
    const withHim = weeks.filter((w) => played.has(w.week));
    const withoutHim = weeks.filter((w) => missed.has(w.week));
    if (withoutHim.length === 0 || withHim.length === 0) continue;

    const carries = delta(withHim, withoutHim, (w) => w.carries);
    const targets = delta(withHim, withoutHim, (w) => w.targets);
    if (carries == null && targets == null) continue;
    if (Math.abs(carries ?? 0) < BENEFICIARY.material && Math.abs(targets ?? 0) < BENEFICIARY.material) continue;
    if ((carries ?? 0) <= 0 && (targets ?? 0) <= 0) continue;

    out.push({
      playerId: mate.playerId,
      name: mate.name,
      position: mate.position,
      carriesDelta: carries,
      targetsDelta: targets,
      basis: 'prior_absence',
      gamesWithout: withoutHim.length,
      confidence: withoutHim.length >= BENEFICIARY.strongSample ? 'high' : withoutHim.length >= 2 ? 'medium' : 'low',
      display: describe(mate.name, carries, targets, 'prior_absence', withoutHim.length),
    });
  }
  return out.sort(byGain);
}

/**
 * Nobody has ever played a game without him. Who is next in line?
 *
 * "Next in line" is read off usage rather than off a depth chart: the teammate
 * at the same position already getting the most work is the one who gets more
 * of it, which is both the most defensible reading of a free data set and the
 * one that fails most gracefully when it is wrong.
 */
function fromDepth(
  absent: TeammateUsage,
  teammates: TeammateUsage[],
  vacated: { carries: number | null; targets: number | null },
): Beneficiary[] {
  const position = absent.position.toUpperCase();
  const peers = teammates
    .filter((m) => m.position.toUpperCase() === position && m.playerId !== absent.playerId)
    .map((m) => ({ mate: m, opportunity: perGame(regular(m.weeks), (w) => (w.carries ?? 0) + (w.targets ?? 0)) }))
    .filter((p): p is { mate: TeammateUsage; opportunity: number } => p.opportunity != null && p.opportunity > 0)
    .sort((a, b) => b.opportunity - a.opportunity)
    .slice(0, 2);

  if (peers.length === 0) return [];
  if ((vacated.carries ?? 0) <= 0 && (vacated.targets ?? 0) <= 0) return [];

  return peers
    .map((peer, index) => {
      const share = index === 0 ? BENEFICIARY.depthInferenceShare : BENEFICIARY.secondaryInferenceShare;
      const carries = vacated.carries == null ? null : round1(vacated.carries * share);
      const targets = vacated.targets == null ? null : round1(vacated.targets * share);
      return {
        playerId: peer.mate.playerId,
        name: peer.mate.name,
        position: peer.mate.position,
        carriesDelta: carries,
        targetsDelta: targets,
        basis: 'depth_inference' as const,
        gamesWithout: 0,
        confidence: 'low' as const,
        display: describe(peer.mate.name, carries, targets, 'depth_inference', 0),
      };
    })
    .filter((b) => Math.abs(b.carriesDelta ?? 0) >= BENEFICIARY.material || Math.abs(b.targetsDelta ?? 0) >= BENEFICIARY.material)
    .sort(byGain);
}

/**
 * The best pickup when a starter goes down, advisory and nothing more.
 *
 * A beneficiary the user cannot have is not advice, so the graph is intersected
 * with what Sleeper says is actually available. Nothing is added, claimed or
 * queued here or anywhere downstream of here — this returns a name and a
 * sentence, and a person decides.
 */
export function emergencyPivot(
  graph: BeneficiaryGraph,
  availablePlayerIds: Iterable<string>,
): { playerId: string; name: string; detail: string; confidence: 'high' | 'medium' | 'low' } | null {
  const available = new Set(availablePlayerIds);
  const best = graph.beneficiaries.find((b) => available.has(b.playerId));
  if (!best) return null;
  return {
    playerId: best.playerId,
    name: best.name,
    detail: `${best.display} — and he is unrostered`,
    confidence: best.confidence,
  };
}

function describe(
  name: string,
  carries: number | null,
  targets: number | null,
  basis: BeneficiaryBasis,
  gamesWithout: number,
): string {
  const parts: string[] = [];
  if (carries != null && Math.abs(carries) >= BENEFICIARY.material) parts.push(`expected carries ${signed(carries)}`);
  if (targets != null && Math.abs(targets) >= BENEFICIARY.material) parts.push(`receiving role ${signed(targets)} targets`);
  const claim = parts.length > 0 ? parts.join(', ') : 'more work, below the level worth quantifying';
  const source =
    basis === 'prior_absence'
      ? ` (${gamesWithout} game${gamesWithout === 1 ? '' : 's'} without him)`
      : ' (inferred from the depth behind him, not measured)';
  return `${name} ${claim}${source}`;
}

function byGain(a: Beneficiary, b: Beneficiary): number {
  const gain = (x: Beneficiary) => (x.carriesDelta ?? 0) + (x.targetsDelta ?? 0);
  return gain(b) - gain(a);
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value}`;
}

function regular(weeks: UsageWeek[]): UsageWeek[] {
  return weeks.filter((w) => (w.seasonType ?? 'REG').toUpperCase() === 'REG');
}

/** A mean over the games where the field was actually stored. Null when none. */
function perGame(weeks: UsageWeek[], of: (w: UsageWeek) => number | null | undefined): number | null {
  const values = weeks.map(of).filter((v): v is number => v != null && Number.isFinite(v));
  return values.length === 0 ? null : round1(values.reduce((a, b) => a + b, 0) / values.length);
}

function delta(
  withHim: UsageWeek[],
  withoutHim: UsageWeek[],
  of: (w: UsageWeek) => number | null | undefined,
): number | null {
  const a = perGame(withHim, of);
  const b = perGame(withoutHim, of);
  if (a == null || b == null) return null;
  return round1(b - a);
}

function round1(v: number): number {
  const r = Math.round(v * 10) / 10;
  return r === 0 ? 0 : r;
}
