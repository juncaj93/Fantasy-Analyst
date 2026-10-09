/**
 * The shape of a player's week, as one word: Explosive, Steady or Wide range.
 *
 * Read off the same prop lines the score is built from, so it is a description
 * of the market's view rather than a second opinion. It never changes a score.
 * The one thing it may do is break a close call (see `tiebreak.ts`): an
 * underdog wants the higher ceiling, a favourite wants the safer floor.
 *
 *  - **Explosive**: big-play upside. Long yardage per catch on a real yardage
 *    line, a high touchdown price, or a quarterback who runs.
 *  - **Steady**: a safe floor. A high catch line on short, repeatable yards, or
 *    a back with volume on the ground and through the air.
 *  - **Wide range**: could be 4 or could be 24. Few catches carrying big yards,
 *    or a week that leans on a touchdown.
 *
 * At most one pill, checked in that order of caution: Wide range first, then
 * Explosive, then Steady. Most players carry none, which is the point: a pill
 * on everybody would say nothing.
 *
 * The thresholds are round numbers chosen against this week's priced players
 * (the October 2026 audit printed how many land in each), not fitted values.
 */

import type { MarketKey, PlayerProp } from '../vegas/types.ts';
import type { VegasExpectation } from './expectation.ts';

export type Pill = 'explosive' | 'steady' | 'wide_range';

export interface PillReading {
  pill: Pill;
  /** The word on the chip. */
  label: string;
  /** Why, in a few words, from the lines that decided it. */
  reason: string;
}

export const PILL_LABEL: Record<Pill, string> = {
  explosive: 'Explosive',
  steady: 'Steady',
  wide_range: 'Wide range',
};

export const PILL_RULES = {
  receiver: {
    /** Wide range: this few catches... */
    wideMaxCatches: 3.5,
    /** ...carrying this many yards a catch. */
    wideMinYardsPerCatch: 14,
    /** Explosive: a yardage line at least this big... */
    explosiveMinYards: 60,
    /** ...at this many yards a catch. */
    explosiveMinYardsPerCatch: 13.5,
    /** Explosive on the touchdown price alone. */
    explosiveMinTd: 0.45,
    /** Steady: at least this many catches... */
    steadyMinCatches: 5.5,
    /** ...on yards this short. */
    steadyMaxYardsPerCatch: 12,
  },
  back: {
    /** Explosive: a touchdown price this high... */
    explosiveMinTd: 0.55,
    /** ...with this many yards from scrimmage. */
    explosiveMinYards: 90,
    /** Steady: rushing volume... */
    steadyMinRush: 60,
    /** ...plus a pass-catching role. */
    steadyMinCatches: 3.5,
  },
  quarterback: {
    /** Explosive: a quarterback who runs this much. */
    explosiveMinRush: 30,
    /** Steady: a passing line this high, from a pocket passer. */
    steadyMinPass: 250,
    steadyMaxRush: 20,
  },
  /** Wide range, any position: this share of the week rests on a touchdown. */
  wideMinTdShare: 0.4,
} as const;

export type PillRules = typeof PILL_RULES;

/** One player's pill, or null. Pure; reads only what is passed. */
export function pillFor(
  position: string,
  props: readonly PlayerProp[],
  expectation: VegasExpectation,
  rules: PillRules = PILL_RULES,
): PillReading | null {
  if (expectation.points == null || expectation.points <= 0) return null;
  const line = (market: MarketKey): number | null => {
    const prop = props.find((p) => p.market === market);
    return prop?.line != null && Number.isFinite(prop.line) ? prop.line : null;
  };
  const td = expectation.contributions.find((c) => c.market === 'anytime_td');
  const tdChance = td?.probability ?? null;
  const tdShare = td ? td.points / expectation.points : null;
  const pos = position.toUpperCase();

  const pick = (pill: Pill, reason: string): PillReading => ({ pill, label: PILL_LABEL[pill], reason });

  if (pos === 'QB') {
    const pass = line('pass_yards');
    const rush = line('rush_yards');
    if (rush != null && rush >= rules.quarterback.explosiveMinRush) return pick('explosive', `${rush} rush yds line`);
    if (pass != null && pass >= rules.quarterback.steadyMinPass && (rush ?? 0) < rules.quarterback.steadyMaxRush) {
      return pick('steady', `${pass} pass yds line`);
    }
    return null;
  }

  if (tdShare != null && tdShare >= rules.wideMinTdShare) {
    return pick('wide_range', `${Math.round(tdShare * 100)}% of his points need a TD`);
  }

  if (pos === 'WR' || pos === 'TE') {
    const r = rules.receiver;
    const yards = line('receiving_yards');
    const catches = line('receptions');
    const perCatch = yards != null && catches != null && catches > 0 ? yards / catches : null;
    if (catches != null && perCatch != null && catches <= r.wideMaxCatches && perCatch >= r.wideMinYardsPerCatch) {
      return pick('wide_range', `${catches} catches for ${yards} yds`);
    }
    if (yards != null && perCatch != null && yards >= r.explosiveMinYards && perCatch >= r.explosiveMinYardsPerCatch) {
      return pick('explosive', `${perCatch.toFixed(1)} yds a catch`);
    }
    if (tdChance != null && tdChance >= r.explosiveMinTd) return pick('explosive', `${Math.round(tdChance * 100)}% TD chance`);
    if (catches != null && perCatch != null && catches >= r.steadyMinCatches && perCatch <= r.steadyMaxYardsPerCatch) {
      return pick('steady', `${catches} catches line`);
    }
    return null;
  }

  if (pos === 'RB') {
    const b = rules.back;
    const rush = line('rush_yards');
    const rec = line('receiving_yards');
    const catches = line('receptions');
    const scrimmage = (rush ?? 0) + (rec ?? 0);
    if (tdChance != null && tdChance >= b.explosiveMinTd && scrimmage >= b.explosiveMinYards) {
      return pick('explosive', `${Math.round(tdChance * 100)}% TD chance, ${Math.round(scrimmage)} yds`);
    }
    if (rush != null && catches != null && rush >= b.steadyMinRush && catches >= b.steadyMinCatches) {
      return pick('steady', `${rush} rush yds and ${catches} catches`);
    }
    return null;
  }

  return null;
}
