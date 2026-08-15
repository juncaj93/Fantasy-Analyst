/**
 * Floor, Balanced, Ceiling — what the same evidence is being asked for.
 *
 * This is emphatically **not** a second engine. Every component is computed
 * once, from the same data, in the same units; the mode decides how much each
 * one is allowed to say. A player who is better on every axis is the
 * recommendation in all three modes, and that is the property that makes the
 * control trustworthy: switching to Ceiling does not roll dice, it reweights an
 * argument that is already on the screen.
 *
 * ## What each mode actually wants
 *
 * **Floor** is asking "what is the least this can go wrong". It leans on the
 * things that are true before kickoff — volume that has already been earned,
 * availability that is settled, a game environment that does not need to
 * cooperate — and it discounts the things that need something to happen: a
 * touchdown, a deep ball, a shootout.
 *
 * **Ceiling** is asking "what is the most this can be". It pays for explosive
 * usage and a role near the end zone, treats a strong market line as the
 * upside signal it is, and stops charging a player for the volatility that is
 * the entire reason to start him.
 *
 * **Balanced** is the engine as it already was, with the new signals at their
 * natural weight.
 *
 * ## Bounded on purpose
 *
 * No multiplier here leaves [0, 1.6]. A mode can halve a component or add half
 * of it again; it can never invert one, and it can never turn a component off
 * in a way that hides a fact — a player who is Out is Out in Ceiling mode too,
 * which is why the availability gate is not in this table at all.
 */

export type StartSitMode = 'balanced' | 'floor' | 'ceiling';

export const START_SIT_MODES: StartSitMode[] = ['balanced', 'floor', 'ceiling'];

export const MODE_LABEL: Record<StartSitMode, string> = {
  balanced: 'Balanced',
  floor: 'Floor',
  ceiling: 'Ceiling',
};

/** What the segmented control's tooltip says, and what the card explains. */
export const MODE_DESCRIPTION: Record<StartSitMode, string> = {
  balanced: 'Weighs safety and upside the same way the season-long engine does.',
  floor: 'Prefers settled volume and safe availability over upside that has to happen.',
  ceiling: 'Prefers explosive usage, red-zone roles and shootouts, and forgives volatility.',
};

/**
 * Per-component multipliers, keyed by the component keys the engine emits.
 *
 * A key absent from a mode's table is worth exactly 1 in that mode. Listing
 * only the differences keeps the intent readable: this table *is* the
 * definition of what Floor and Ceiling mean here.
 */
export const MODE_WEIGHTS: Record<StartSitMode, Partial<Record<string, number>>> = {
  balanced: {},
  floor: {
    // Volume already earned is the floor. Pay more for it.
    usage_level: 1.4,
    // A role that is collapsing is the clearest floor risk there is; a rising
    // one is upside that has not been banked yet, so the component is read
    // asymmetrically — see `modeWeightFor`.
    role_trend: 1.2,
    // Availability uncertainty is the thing Floor mode most wants to avoid.
    // There is one availability component, not two: the practice-adjusted
    // penalty in `status`. Weighting a second "confidence" component here would
    // charge the same designation twice.
    status: 1.3,
    replacement_risk: 1.3,
    // A downfield role is upside, and upside is not what this mode is buying.
    explosiveness: 0.4,
    // Production that needs a touchdown is exactly what a floor does not have.
    td_dependency: 1.5,
    // A market line is a mean, not a floor, so it says a little less here.
    vegas: 0.9,
    // Weather that suppresses a passing game hurts the safe outcome most.
    weather: 1.2,
    // A shootout is upside; a script that guarantees volume is floor.
    game_script: 1,
    // Thin or stale data is a floor risk in itself.
    uncertainty: 1.3,
  },
  ceiling: {
    // Upside is bought with the ball in a player's hands.
    usage_level: 1.1,
    role_trend: 1.1,
    // The market's number is the best free estimate of how big a game can be.
    vegas: 1.2,
    // A high-total, competitive game is where ceilings come from.
    game_script: 1.3,
    // Explosive role: depth of target, goal-line work.
    explosiveness: 1.5,
    // A touchdown-dependent profile is *upside* when you are chasing points.
    td_dependency: 0.5,
    // Volatility is the price of a ceiling; stop charging for it twice.
    uncertainty: 0.7,
    // Weather suppresses the top of the range too, but a ceiling chaser is
    // already accepting variance.
    weather: 0.9,
  },
};

/**
 * The multiplier for one component in one mode.
 *
 * `signedValue` is the component's own contribution, and it is read for one
 * reason: Floor mode is asymmetric about role trend. A collapsing role is a
 * floor problem and is weighted up; a rising one is upside the player has not
 * banked yet and stays at its ordinary weight. Every other component is
 * symmetric, so this is a single named exception rather than a general rule
 * about signs.
 */
export function modeWeightFor(key: string, mode: StartSitMode, signedValue: number): number {
  const table = MODE_WEIGHTS[mode];
  const base = table[key] ?? 1;
  if (mode === 'floor' && key === 'role_trend' && signedValue > 0) return 1;
  if (mode === 'ceiling' && key === 'td_dependency' && signedValue > 0) return 1;
  return base;
}

/** Parse whatever arrived on the wire. Anything unrecognised is Balanced. */
export function normalizeMode(raw: string | null | undefined): StartSitMode {
  const value = (raw ?? '').trim().toLowerCase();
  return (START_SIT_MODES as string[]).includes(value) ? (value as StartSitMode) : 'balanced';
}
