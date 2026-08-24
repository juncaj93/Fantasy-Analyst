/**
 * What every feature is *allowed* to do, declared once and enforced in code.
 *
 * §4 of the handoff calls this the non-negotiable design principle, and its
 * argument is worth restating because it is the reason this file is a registry
 * rather than a paragraph in a document:
 *
 * > The market already incorporates much of: player quality, role, opponent,
 * > injuries, game environment, expected scoring.
 *
 * A betting line on a receiver's yardage is not a neutral fact that usage data
 * can be added to. It is already somebody's projection, built by people who
 * watched the same snaps, and it moves when the same news moves. Adding a
 * "target share bonus" on top of it does not add information; it counts the
 * same information twice, and it does so in the direction that feels like
 * insight — the confident player gets more confident.
 *
 * So each feature declares one of four roles, and the projection engine asks
 * this registry before it touches a mean:
 *
 *   - **A · market-gap filler** — may contribute to the mean, but only for a
 *     component the market has not priced. Receiving yards with no receptions
 *     line: estimate the receptions, leave the yards alone.
 *   - **B · confidence / uncertainty modifier** — may widen or narrow the
 *     distribution and may move confidence. **Never the mean.** This is where
 *     most usage data belongs and it is the least intuitive thing in the design:
 *     knowing a receiver's role is stable does not tell you the market is wrong
 *     about him, it tells you the market's number is more likely to be close.
 *   - **C · fresh information** — may move the mean by a hard-capped amount, and
 *     only when the signal is demonstrably newer than the market snapshot it
 *     would be correcting. A depth-chart change published after the line was
 *     priced is information the line does not contain; the same change published
 *     before it is information the line already has.
 *   - **D · market-redundant** — may be displayed and explained, and may not
 *     touch the mean at all, ever, by any path.
 *
 * ## Why this is executable
 *
 * {@link mayMoveMean} is called by `core/projection/v2.ts` on every adjustment
 * before it is applied, and an unregistered key is refused. A feature therefore
 * cannot reach the mean by being added to the engine and forgotten here — the
 * registry is the gate, not the documentation of one. `tests/projectionV2.
 * doubleCounting.test.ts` walks this table and asserts that every B and D entry
 * leaves the central estimate byte-identical.
 */

/** The four roles, in the handoff's own letters. */
export type FeatureClass = 'A' | 'B' | 'C' | 'D';

export type FeatureRole =
  | 'market_gap_filler'
  | 'uncertainty_modifier'
  | 'fresh_information'
  | 'market_redundant';

const ROLE_OF: Record<FeatureClass, FeatureRole> = {
  A: 'market_gap_filler',
  B: 'uncertainty_modifier',
  C: 'fresh_information',
  D: 'market_redundant',
};

export interface FeatureClassification {
  /** The key the engine names when it applies or declines an adjustment. */
  key: string;
  label: string;
  class: FeatureClass;
  role: FeatureRole;
  /** Why it is this class and not the neighbouring one. */
  why: string;
}

/**
 * Every feature Projection v2 reads, and what it may do.
 *
 * Ordered by class so the shape of the design is visible at a glance: the mean
 * is moved by a short list and the long list is about uncertainty. That ratio is
 * the design working, not a gap in it.
 */
export const FEATURE_CLASSIFICATIONS: readonly FeatureClassification[] = [
  // ------------------------------------------------------------------- A ---
  {
    key: 'fill.receptions',
    label: 'Receptions from target volume and catch rate',
    class: 'A',
    role: ROLE_OF.A,
    why:
      'Reception props are the least reliably published of the receiving markets — a provider that prices ' +
      'receiving yards for a whole slate may price receptions for a third of it. Where the line is absent, ' +
      'targets and a position catch rate estimate the component nobody has priced. Where it is present, this ' +
      'never runs.',
  },
  {
    key: 'fill.receiving_yards',
    label: 'Receiving yards from target volume and depth of target',
    class: 'A',
    role: ROLE_OF.A,
    why:
      'Same rule in the other direction. Air yards per target is the deterministic input the xFP model already ' +
      'uses to set yards per target, so the estimate is the app’s own published model rather than a second one.',
  },
  {
    key: 'fill.rush_yards',
    label: 'Rushing yards from carry volume',
    class: 'A',
    role: ROLE_OF.A,
    why:
      'Carries times the position’s yards per carry. The most stable of the fills, because carry volume is the ' +
      'most stable thing a back has and the yards-per-carry spread between backs is far narrower than the ' +
      'spread in their workloads.',
  },
  {
    key: 'fill.pass_yards',
    label: 'Passing yards from attempt volume',
    class: 'A',
    role: ROLE_OF.A,
    why: 'Attempts times yards per attempt, for a quarterback whose yardage line is missing.',
  },
  {
    key: 'fill.touchdowns',
    label: 'Touchdown expectation from opportunity',
    class: 'A',
    role: ROLE_OF.A,
    why:
      'Targets and carries times the position’s scoring rates, used only where no anytime-touchdown market ' +
      'exists. It is the weakest fill here and it is the one most in need of red-zone data, which is not ' +
      'available free on this id space — so a goal-line back and a between-the-twenties back are estimated ' +
      'alike. Stated in the reasons on every projection that uses it.',
  },

  // ------------------------------------------------------------------- B ---
  {
    key: 'uncertainty.snap_share_stability',
    label: 'Snap-share stability',
    class: 'B',
    role: ROLE_OF.B,
    why:
      'The best single role signal in the free data and deliberately not on the mean. A steady 78% of snaps ' +
      'does not say the market has mispriced him; it says the market’s number has less to go wrong with it. ' +
      'A share that has swung between 30% and 80% over four weeks says the opposite, about the same player, ' +
      'without either of them being an argument that the line is wrong.',
  },
  {
    key: 'uncertainty.target_share_stability',
    label: 'Target-share stability',
    class: 'B',
    role: ROLE_OF.B,
    why: 'Same argument on the receiving side, and the one that matters most for a wide receiver.',
  },
  {
    key: 'uncertainty.carry_share_stability',
    label: 'Carry-share stability',
    class: 'B',
    role: ROLE_OF.B,
    why: 'Same argument for a backfield, where a committee splitting 55/45 one week and 80/20 the next is the ordinary case.',
  },
  {
    key: 'uncertainty.sample_size',
    label: 'Usage sample size',
    class: 'B',
    role: ROLE_OF.B,
    why:
      'Three games is not four and four is not eight. A rate from a short window is not wrong, it is imprecise, ' +
      'and imprecision belongs in the width rather than in the centre.',
  },
  {
    key: 'uncertainty.market_coverage',
    label: 'Market coverage',
    class: 'B',
    role: ROLE_OF.B,
    why:
      'How much of the position’s expected market set was actually priced. A projection resting on one line ' +
      'out of four is a different object from one resting on four out of four, and the difference is width.',
  },
  {
    key: 'uncertainty.td_dependence',
    label: 'Touchdown dependence',
    class: 'B',
    role: ROLE_OF.B,
    why:
      'A player whose points came from the end zone rather than from volume has a wider week ahead of him than ' +
      'one with the same mean built from receptions. The mean is the mean; the shape around it is not.',
  },
  {
    key: 'uncertainty.freshness',
    label: 'Input freshness',
    class: 'B',
    role: ROLE_OF.B,
    why:
      'Stale inputs must reduce confidence rather than silently look current. This is the mechanism the handoff ' +
      'asks for in §11, and it is the reason every stored row carries an `as_of`.',
  },
  {
    key: 'uncertainty.identity',
    label: 'Identity certainty',
    class: 'B',
    role: ROLE_OF.B,
    why:
      'A player resolved through the roster bridge is one deterministic hop further from the source than one ' +
      'Sleeper published a GSIS id for. Both are trustworthy; they are not equally trustworthy.',
  },
  {
    key: 'uncertainty.injury',
    label: 'Current availability uncertainty',
    class: 'B',
    role: ROLE_OF.B,
    why:
      'Read from this app’s existing injury pipeline, never from nflverse. §8 is explicit that nflverse current ' +
      'injuries are not a live source, and this consumes the existing signal rather than duplicating it. It ' +
      'widens the distribution; the mean is left to the market, which has already priced the designation.',
  },
  {
    key: 'uncertainty.historical_injury',
    label: 'Historical injury load',
    class: 'B',
    role: ROLE_OF.B,
    why: 'Explicitly capped at a small uncertainty effect by §8, and never an inference about current health.',
  },
  {
    key: 'uncertainty.depth_role',
    label: 'Depth-chart position',
    class: 'B',
    role: ROLE_OF.B,
    why:
      'Being listed first is not evidence and §15 names this case directly: "Never narrow uncertainty just ' +
      'because a player is listed first on a depth chart." So the effect is asymmetric — being listed *outside* ' +
      'the spots his club fields widens, and being listed inside them does nothing at all.',
  },

  // ------------------------------------------------------------------- C ---
  {
    key: 'fresh.role_change',
    label: 'Role change newer than the market snapshot',
    class: 'C',
    role: ROLE_OF.C,
    why:
      'The only path by which usage data moves a mean the market has already set, and it is gated three ways: ' +
      'the evidence must be corroborated beyond the depth chart alone, it must be timestamped after the market ' +
      'snapshot, and the result is hard-capped by FRESH_INFORMATION_CAP. A depth-only change is deliberately ' +
      'not enough — §7 says a depth-only change must not create a large mean adjustment, and the honest ' +
      'reading of that is that it should not create one at all.',
  },

  // ------------------------------------------------------------------- D ---
  {
    key: 'redundant.opponent_rank',
    label: 'Opponent defensive rank',
    class: 'D',
    role: ROLE_OF.D,
    why:
      'The market prices the opponent. §9 forbids stacking defensive fantasy allowance or raw opponent rank on ' +
      'top of Vegas, and this app’s own start/sit engine already carries a matchup component for the ranking ' +
      'question. Displayed, explained, never summed into a projection.',
  },
  {
    key: 'redundant.game_environment',
    label: 'Pace, neutral pass rate and game environment',
    class: 'D',
    role: ROLE_OF.D,
    why:
      'Spread, total and team total are the environment signal and they come from the market, which is where ' +
      'the environment is priced. A second pace estimate on top is the same fact with a different provenance.',
  },
  {
    key: 'redundant.efficiency',
    label: 'Historical efficiency (EPA, yards over expectation)',
    class: 'D',
    role: ROLE_OF.D,
    why:
      'Player quality is the thing a betting line is most confident about. An efficiency adjustment is a claim ' +
      'to know a player’s quality better than the market does, from strictly less data than the market has.',
  },
  {
    key: 'redundant.production',
    label: 'Recent fantasy production',
    class: 'D',
    role: ROLE_OF.D,
    why:
      'The most tempting entry in this table and the most redundant. Last week’s points are the single most ' +
      'public fact about a player and the market has read it too.',
  },
] as const;

const BY_KEY = new Map(FEATURE_CLASSIFICATIONS.map((f) => [f.key, f]));

export function classificationOf(key: string): FeatureClassification | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * Whether a feature may contribute to the central estimate.
 *
 * **The engine calls this, and an unregistered key is refused.** That is the
 * whole point: a feature cannot reach the mean by being wired into the engine
 * and forgotten here, and adding one to this table is a deliberate act with a
 * written justification beside it.
 */
export function mayMoveMean(key: string): boolean {
  const found = BY_KEY.get(key);
  if (!found) return false;
  return found.class === 'A' || found.class === 'C';
}

/** Whether a feature may change the distribution's width or the confidence. */
export function mayMoveUncertainty(key: string): boolean {
  const found = BY_KEY.get(key);
  if (!found) return false;
  return found.class === 'B' || found.class === 'C';
}

/** The registry grouped by class, for the diagnostics report and the closeout. */
export function classificationsByClass(): Record<FeatureClass, FeatureClassification[]> {
  const out: Record<FeatureClass, FeatureClassification[]> = { A: [], B: [], C: [], D: [] };
  for (const f of FEATURE_CLASSIFICATIONS) out[f.class].push(f);
  return out;
}
