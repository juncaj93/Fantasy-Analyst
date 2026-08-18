/**
 * Height, weight, age and experience — used almost never, and on purpose.
 *
 * Sleeper publishes all four for every player, which makes them the most
 * tempting bad inputs in the whole dataset. They are objective, complete, and
 * numeric, and they explain very little. A 5'9" receiver is not worse than a
 * 6'3" receiver; a 29-year-old back is not finished. Turn either into a ranking
 * component and the app acquires a confident opinion about body types it has no
 * evidence for, applied to six hundred players at once.
 *
 * So these are **flags, not scores**, governed by three rules:
 *
 *   1. nothing is displayed by default. Height and weight never appear on a card
 *      unless a flag fired, because a number shown is a number the reader will
 *      weigh whether or not it means anything;
 *   2. a flag fires only where the measurement meets a *role* it is genuinely in
 *      tension with. "Small frame" alone says nothing. "Small frame for the
 *      outside role he is projected into" is a question worth having;
 *   3. nothing here changes a projection, a rank, a tally or a bid. Every flag
 *      returns context, and the caller may not convert it into a penalty.
 *
 * Age is treated the same way and for the same reason. The genuine age effects
 * in fantasy are position-specific and interact with usage — an older back whose
 * carries are falling is a real signal, and the falling carries are doing most of
 * the work. Age on its own is bounded to a note.
 */

export type Position = 'QB' | 'RB' | 'WR' | 'TE' | string;

export interface PlayerPhysical {
  playerId: string;
  position: Position;
  /** Inches. Sleeper publishes a string like `"71"`; the caller normalises. */
  heightInches: number | null;
  weightPounds: number | null;
  age: number | null;
  yearsExp: number | null;
}

export interface RoleContext {
  /**
   * What the app expects him to do, when it knows. The flags are about tension
   * between measurement and role, so without a role there is no tension.
   */
  projectedRole?: 'outside_receiver' | 'slot_receiver' | 'receiving_back' | 'early_down_back' | 'move_te' | null;
  /** Whether usage is climbing, flat or falling — the age flags need this. */
  usageTrend?: 'rising' | 'flat' | 'falling' | 'unknown';
}

export interface ProfileFlag {
  key: string;
  /** `Small frame for projected outside role` */
  text: string;
  kind: 'physical' | 'age';
  /**
   * Always `context`. Present in the type so that a consumer converting this
   * into a score has to delete the field to do it.
   */
  weight: 'context';
}

/**
 * Position-aware thresholds, set where a measurement is genuinely unusual.
 *
 * These are roughly the 10th/90th percentiles of NFL players at each position —
 * far enough out that a flag is rare, which is the point. A flag that fires on a
 * third of the league is a column, not a flag.
 */
const FRAME: Record<string, { lightLbs: number; heavyLbs: number; shortIn: number; tallIn: number }> = {
  RB: { lightLbs: 195, heavyLbs: 235, shortIn: 68, tallIn: 74 },
  WR: { lightLbs: 180, heavyLbs: 220, shortIn: 69, tallIn: 76 },
  TE: { lightLbs: 235, heavyLbs: 265, shortIn: 74, tallIn: 79 },
  QB: { lightLbs: 200, heavyLbs: 245, shortIn: 72, tallIn: 78 },
};

/**
 * Physical flags — at most one or two, and usually none.
 *
 * Every branch requires both a measurement *and* a role it sits awkwardly
 * against. That conjunction is what stops this becoming a height column.
 */
export function physicalFlags(player: PlayerPhysical, context: RoleContext = {}): ProfileFlag[] {
  const frame = FRAME[player.position];
  const role = context.projectedRole ?? null;
  if (!frame || role == null) return [];

  const flags: ProfileFlag[] = [];
  const { weightPounds: lbs, heightInches: inches } = player;

  if (role === 'outside_receiver' && ((lbs != null && lbs < frame.lightLbs) || (inches != null && inches < frame.shortIn))) {
    flags.push({
      key: 'small_frame_outside',
      text: 'Small frame for projected outside role',
      kind: 'physical',
      weight: 'context',
    });
  }

  if (role === 'receiving_back' && lbs != null && lbs > frame.heavyLbs) {
    flags.push({
      key: 'large_receiving_back',
      text: 'Unusually large receiving-back profile',
      kind: 'physical',
      weight: 'context',
    });
  }

  if (role === 'early_down_back' && lbs != null && lbs < frame.lightLbs) {
    flags.push({
      key: 'light_early_down',
      text: 'Light for the early-down workload projected',
      kind: 'physical',
      weight: 'context',
    });
  }

  if (role === 'move_te' && inches != null && inches < frame.shortIn) {
    flags.push({ key: 'short_move_te', text: 'Short for the position, used as a move tight end', kind: 'physical', weight: 'context' });
  }

  return flags;
}

/**
 * The ages at which a position's decline is actually observable in fantasy.
 *
 * Backs age first and hardest; receivers hold value into their thirties; tight
 * ends and quarterbacks later still. A single age threshold across positions is
 * the error these numbers exist to avoid.
 */
const DECLINE_AGE: Record<string, number> = { RB: 28, WR: 31, TE: 32, QB: 36 };
/** The year a receiver's breakout is most commonly observed. */
const BREAKOUT_YEAR = 2;

/**
 * Age and experience flags.
 *
 * The running-back flag deliberately requires falling usage as well as age.
 * Without that conjunction it is a birthday, and a birthday has never cost
 * anybody a carry.
 */
export function ageFlags(player: PlayerPhysical, context: RoleContext = {}): ProfileFlag[] {
  const flags: ProfileFlag[] = [];
  const age = player.age;
  const exp = player.yearsExp;
  const trend = context.usageTrend ?? 'unknown';
  const threshold = DECLINE_AGE[player.position];

  if (age != null && threshold != null && age >= threshold && trend === 'falling') {
    flags.push({
      key: 'age_with_declining_usage',
      text: `${age} with usage trending down at ${player.position}`,
      kind: 'age',
      weight: 'context',
    });
  }

  if (player.position === 'WR' && exp === BREAKOUT_YEAR) {
    flags.push({ key: 'year_two_wr', text: 'Year-2 receiver breakout window', kind: 'age', weight: 'context' });
  }

  if (player.position === 'TE' && exp === 0) {
    flags.push({
      key: 'rookie_te',
      text: 'Rookie tight end — the position with the slowest first-year curve',
      kind: 'age',
      weight: 'context',
    });
  }

  return flags;
}

export interface ProfileContext {
  flags: ProfileFlag[];
  /**
   * Whether height and weight may be shown at all. False unless a physical flag
   * fired — rule 1 of the module note, enforced rather than documented.
   */
  showMeasurements: boolean;
  /** Always zero. Present so that "does this move the score" has an answer. */
  scoreDelta: 0;
}

export function profileContext(player: PlayerPhysical, context: RoleContext = {}): ProfileContext {
  const flags = [...physicalFlags(player, context), ...ageFlags(player, context)];
  return {
    flags,
    showMeasurements: flags.some((f) => f.kind === 'physical'),
    scoreDelta: 0,
  };
}

/** Sleeper publishes height as inches or as `6'1"`. Both, in one place. */
export function parseHeight(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const feetInches = /^(\d)\s*['’]\s*(\d{1,2})?\s*["”]?$/.exec(trimmed);
  if (feetInches) {
    const feet = Number(feetInches[1]);
    const inches = Number(feetInches[2] ?? 0);
    return feet * 12 + inches;
  }
  const plain = Number(trimmed);
  return Number.isFinite(plain) && plain > 0 ? Math.round(plain) : null;
}

export function parseWeight(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}
