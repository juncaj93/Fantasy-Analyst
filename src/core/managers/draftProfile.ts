/**
 * How this room drafts, learned from how it has drafted.
 *
 * Every draft simulator in existence runs on a market prior — ADP, or a
 * positional curve, or both. That prior describes the average of every fantasy
 * league on earth, and the room you are actually sitting in is not average. The
 * league that takes three quarterbacks in round four every year does it again
 * this year, and a simulation built on ADP will be surprised by it annually.
 *
 * Sleeper keeps completed drafts for a league and for its previous-season chain,
 * so the room's own history is available for the asking. What comes out is a
 * **bounded profile**, deliberately: a handful of named tendencies, each with the
 * sample behind it, each expressed as a deviation from the market rather than as
 * a replacement for it.
 *
 * Ownership note, because it matters for how this is consumed: this module
 * produces *evidence*. It does not modify Next%, the survival model, or any
 * draft-board ranking. `core/draft/nextpick/` owns those, and a profile is
 * offered to it as an input rather than applied behind its back. That separation
 * is what keeps a room prior from quietly becoming a second, uncalibrated ADP.
 */

/** Below this many observed drafts, nothing is called a room tendency. */
export const MIN_DRAFT_SAMPLE = 2;
/** Below this many picks by one manager, nothing is called *his* tendency. */
export const MIN_MANAGER_PICKS = 12;

export interface HistoricalPick {
  season: string;
  draftId: string;
  pickNo: number;
  round: number;
  rosterId: number | null;
  position: string | null;
  /**
   * The player's market rank at the time, when it is known. Absent for old
   * drafts, and absent is a limit rather than a zero — a reach cannot be
   * measured without a market to reach past.
   */
  marketRank?: number | null;
  /** Years of NFL experience at draft time; 0 is a rookie. */
  yearsExp?: number | null;
}

export interface PositionTiming {
  position: string;
  /** Median round the position first goes off the board, across drafts. */
  medianFirstRound: number | null;
  /** Median round *this manager* first takes one. Null below his pick minimum. */
  managerMedianRound: number | null;
  /** Negative means earlier than the room. */
  vsRoom: number | null;
  sample: number;
}

export interface DraftProfile {
  scope: 'room' | 'manager';
  rosterId: number | null;
  ownerName: string | null;
  draftsObserved: number;
  picksObserved: number;
  minSample: number;
  confident: boolean;
  /** QB and TE timing are the two that actually change a draft plan. */
  timing: PositionTiming[];
  /**
   * Median picks earlier than market rank. Positive means this room reaches.
   * Null when no draft in the sample carried market ranks.
   */
  reachTendency: number | null;
  /** Rookies as a share of picks in the first five rounds. Null when unknown. */
  rookieRate: number | null;
  /** Positive means RB-leaning, negative WR-leaning, in the first five rounds. */
  rbWrBias: number | null;
  /**
   * How often a pick follows the same position as the pick before it, above
   * what the position mix alone would produce. The "runs" effect.
   */
  runFollowing: number | null;
  notes: string[];
  seasons: string[];
}

/**
 * Build the room's prior: how this league as a whole drafts.
 *
 * The room is the unit that most affects a plan — a positional run happens to
 * everybody at the table, whoever started it.
 */
export function buildRoomProfile(picks: HistoricalPick[], opts: { minSample?: number } = {}): DraftProfile {
  const minSample = opts.minSample ?? MIN_DRAFT_SAMPLE;
  const drafts = new Set(picks.map((p) => p.draftId));
  const seasons = [...new Set(picks.map((p) => p.season))].sort();
  const confident = drafts.size >= minSample;

  const profile: DraftProfile = {
    scope: 'room',
    rosterId: null,
    ownerName: null,
    draftsObserved: drafts.size,
    picksObserved: picks.length,
    minSample,
    confident,
    timing: confident ? ['QB', 'TE'].map((pos) => roomTiming(picks, pos)) : [],
    reachTendency: confident ? reachTendency(picks) : null,
    rookieRate: confident ? rookieRate(picks) : null,
    rbWrBias: confident ? rbWrBias(picks) : null,
    runFollowing: confident ? runFollowing(picks) : null,
    notes: [],
    seasons,
  };

  profile.notes = roomNotes(profile, drafts.size);
  return profile;
}

/** One manager's own habits, measured against the room he sits in. */
export function buildManagerDraftProfile(opts: {
  rosterId: number;
  ownerName?: string | null;
  picks: HistoricalPick[];
  minPicks?: number;
}): DraftProfile {
  const minPicks = opts.minPicks ?? MIN_MANAGER_PICKS;
  const mine = opts.picks.filter((p) => p.rosterId === opts.rosterId);
  const drafts = new Set(mine.map((p) => p.draftId));
  const seasons = [...new Set(mine.map((p) => p.season))].sort();
  const confident = mine.length >= minPicks;

  const profile: DraftProfile = {
    scope: 'manager',
    rosterId: opts.rosterId,
    ownerName: opts.ownerName ?? null,
    draftsObserved: drafts.size,
    picksObserved: mine.length,
    minSample: minPicks,
    confident,
    timing: confident
      ? ['QB', 'TE'].map((pos) => {
          const room = roomTiming(opts.picks, pos);
          const managerRounds = firstRoundsByDraft(mine, pos);
          const managerMedian = median(managerRounds);
          return {
            position: pos,
            medianFirstRound: room.medianFirstRound,
            managerMedianRound: managerMedian,
            vsRoom:
              managerMedian != null && room.medianFirstRound != null
                ? round2(managerMedian - room.medianFirstRound)
                : null,
            sample: managerRounds.length,
          };
        })
      : [],
    reachTendency: confident ? reachTendency(mine) : null,
    rookieRate: confident ? rookieRate(mine) : null,
    rbWrBias: confident ? rbWrBias(mine) : null,
    /*
     * Run-following is a property of a sequence, and one manager's picks are not
     * a sequence — they are every twelfth pick. Measuring it on a filtered list
     * would measure his own positional streaks, which is a different thing
     * wearing the same name, so it is simply not offered at manager scope.
     */
    runFollowing: null,
    notes: [],
    seasons,
  };

  profile.notes = managerNotes(profile, mine.length);
  return profile;
}

function roomTiming(picks: HistoricalPick[], position: string): PositionTiming {
  const rounds = firstRoundsByDraft(picks, position);
  return {
    position,
    medianFirstRound: median(rounds),
    managerMedianRound: null,
    vsRoom: null,
    sample: rounds.length,
  };
}

/** The round the position first appeared, once per draft. */
function firstRoundsByDraft(picks: HistoricalPick[], position: string): number[] {
  const first = new Map<string, number>();
  for (const pick of picks) {
    if (pick.position !== position) continue;
    const seen = first.get(pick.draftId);
    if (seen == null || pick.round < seen) first.set(pick.draftId, pick.round);
  }
  return [...first.values()].sort((a, b) => a - b);
}

/**
 * How far ahead of the market this population drafts, in picks.
 *
 * The median rather than the mean, and for the usual reason: one keeper taken at
 * pick 1 with a market rank of 140 is a 139-pick "reach" that describes a league
 * rule, not a habit.
 */
function reachTendency(picks: HistoricalPick[]): number | null {
  const deltas = picks
    .filter((p) => p.marketRank != null && Number.isFinite(p.marketRank))
    .map((p) => (p.marketRank as number) - p.pickNo);
  return deltas.length >= 10 ? median(deltas) : null;
}

function rookieRate(picks: HistoricalPick[]): number | null {
  const early = picks.filter((p) => p.round <= 5 && p.yearsExp != null);
  if (early.length < 10) return null;
  return round2(early.filter((p) => p.yearsExp === 0).length / early.length);
}

function rbWrBias(picks: HistoricalPick[]): number | null {
  const early = picks.filter((p) => p.round <= 5);
  const rb = early.filter((p) => p.position === 'RB').length;
  const wr = early.filter((p) => p.position === 'WR').length;
  if (rb + wr < 10) return null;
  return round2((rb - wr) / (rb + wr));
}

/**
 * How much more often a pick repeats the previous pick's position than the
 * overall mix would predict.
 *
 * The baseline subtraction is the whole measurement. In a league that spends
 * 40% of its picks on receivers, 40% of picks following a receiver will follow a
 * receiver by coincidence; only the excess is a run.
 */
function runFollowing(picks: HistoricalPick[]): number | null {
  const byDraft = new Map<string, HistoricalPick[]>();
  for (const pick of picks) {
    const list = byDraft.get(pick.draftId);
    if (list) list.push(pick);
    else byDraft.set(pick.draftId, [pick]);
  }

  let follows = 0;
  let pairs = 0;
  const counts = new Map<string, number>();
  let total = 0;

  for (const draft of byDraft.values()) {
    const ordered = [...draft].sort((a, b) => a.pickNo - b.pickNo);
    for (let i = 0; i < ordered.length; i++) {
      const pos = ordered[i]?.position;
      if (pos) {
        counts.set(pos, (counts.get(pos) ?? 0) + 1);
        total++;
      }
      if (i === 0) continue;
      const prev = ordered[i - 1]?.position;
      if (!pos || !prev) continue;
      pairs++;
      if (pos === prev) follows++;
    }
  }

  if (pairs < 30 || total === 0) return null;
  const expected = [...counts.values()].reduce((sum, n) => sum + (n / total) ** 2, 0);
  return round2(follows / pairs - expected);
}

function roomNotes(p: DraftProfile, drafts: number): string[] {
  if (!p.confident) {
    return [`Only ${drafts} completed draft(s) on record — not enough to describe how this room drafts.`];
  }
  const notes: string[] = [];
  for (const t of p.timing) {
    if (t.medianFirstRound != null) notes.push(`First ${t.position} usually goes in round ${t.medianFirstRound}.`);
  }
  if (p.reachTendency != null && p.reachTendency >= 8) notes.push('This room drafts ahead of the market.');
  if (p.reachTendency != null && p.reachTendency <= -8) notes.push('This room lets players fall past the market.');
  if (p.rookieRate != null && p.rookieRate >= 0.3) notes.push('Rookies go early here.');
  if (p.rbWrBias != null && p.rbWrBias >= 0.25) notes.push('Running back heavy in the first five rounds.');
  if (p.rbWrBias != null && p.rbWrBias <= -0.25) notes.push('Receiver heavy in the first five rounds.');
  if (p.runFollowing != null && p.runFollowing >= 0.08) notes.push('Positional runs are real in this room.');
  notes.push(`Based on ${drafts} draft(s), ${p.picksObserved} pick(s).`);
  return notes;
}

function managerNotes(p: DraftProfile, picks: number): string[] {
  if (!p.confident) {
    return [`Only ${picks} pick(s) on record for this manager — not enough to describe a tendency.`];
  }
  const notes: string[] = [];
  for (const t of p.timing) {
    if (t.vsRoom == null) continue;
    if (t.vsRoom <= -1) notes.push(`Takes his ${t.position} about ${Math.abs(t.vsRoom)} round(s) before the room does.`);
    if (t.vsRoom >= 1) notes.push(`Waits about ${t.vsRoom} round(s) longer than the room for a ${t.position}.`);
  }
  if (p.reachTendency != null && p.reachTendency >= 8) notes.push('Reaches past the market for players he wants.');
  if (p.rookieRate != null && p.rookieRate >= 0.3) notes.push('Drafts rookies early.');
  if (p.rbWrBias != null && p.rbWrBias >= 0.25) notes.push('Leans running back early.');
  if (p.rbWrBias != null && p.rbWrBias <= -0.25) notes.push('Leans receiver early.');
  notes.push(`Based on ${picks} pick(s) across ${p.seasons.length} season(s).`);
  return notes;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const a = sorted[mid - 1];
  const b = sorted[mid];
  return a != null && b != null ? round2((a + b) / 2) : null;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
