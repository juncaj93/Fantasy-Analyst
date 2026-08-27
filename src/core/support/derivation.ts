/**
 * A fingerprint of *how this build reads a league's rules*.
 *
 * Every snapshot carries what the league published — `roster_positions` and
 * `scoring_settings`, exactly as Sleeper returned them — rather than the two
 * derived values the engines actually read. There is a good reason for that and
 * it is stated at `SnapshotLeagueRules`: the derived scoring profile ends its
 * points-allowed table at `Infinity`, which JSON writes as `null`, so a file
 * carrying the profile replayed every defence a fraction of a point out.
 *
 * That choice leaves one exposure, and this module closes it. `buildRosterShape`
 * and `buildScoringProfile` sit *underneath* every engine — a change to either
 * is a change to how the whole app reads a league — so a snapshot taken before
 * such a change and replayed after it is being interpreted under rules it was
 * never made under. The replay would reproduce the difference honestly, but it
 * would attribute it to the lane's own engine, and somebody would go looking for
 * a bug in the lineup optimiser that is really a scoring table somebody widened.
 *
 * So the *derivation itself* is fingerprinted: the two functions are run over
 * the league's published rules and the result is hashed. Two builds that read a
 * league the same way produce the same fingerprint whatever else has changed
 * between them, and two builds that read it differently cannot produce the same
 * one. Nothing has to be bumped by hand and nothing has to be remembered — the
 * hash is of the behaviour, not of a number somebody maintains beside it.
 *
 * ## What a mismatch means, and what it does not
 *
 * A mismatch is reported the same way a moved engine version is: it explains a
 * difference and is therefore named ahead of it, so a replay after a scoring
 * change reads `engine_version_mismatch` rather than `output_difference`. It is
 * not a failure and it is not a regression — it is the file saying *this build
 * does not read leagues the way the build that captured me did*, which is the
 * one sentence that stops the diagnosis going to the wrong place.
 *
 * A snapshot with no fingerprint at all — every file captured before this
 * existed — is not compared and is not refused. An absent claim is not a
 * disagreement, and refusing old files to gain a check they could never have
 * carried would be trading a real capability for a theoretical one.
 */

import { buildRosterShape, buildScoringProfile } from '../sleeper/scoring.ts';
import { hashString } from '../draft/nextpick/rng.ts';

/**
 * The derived shape and profile, as a stable string.
 *
 * Two properties matter and neither is negotiable. Keys are **sorted at every
 * depth**, because object key order is insertion order and a refactor that built
 * the same profile in a different order would otherwise read as a changed
 * derivation. And non-finite numbers are written **as themselves**, because the
 * whole reason this module exists is a table that ends at `Infinity` — a
 * fingerprint that went through `JSON.stringify` would map `Infinity` and `null`
 * to the same text and be blind to exactly the change it is here to catch.
 */
function stableText(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    return Object.is(value, -0) ? '-0' : String(value);
  }
  if (typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableText).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableText(child)}`).join(',')}}`;
}

/**
 * How this build derives a league's shape and scoring, as eight hex digits.
 *
 * Short on purpose: it is printed in a report and read by a person comparing two
 * of them, and thirty-two characters would be copied wrong. It is not a security
 * claim — a collision here means two genuinely different derivations are
 * reported as the same, which is a missed warning rather than a wrong answer,
 * and the space of derivations this app has ever had is a handful.
 */
export function fingerprintOf(value: unknown): string {
  return hashString(stableText(value)).toString(16).padStart(8, '0');
}

export function derivationFingerprint(rules: {
  rosterPositions: readonly string[];
  scoringSettings: Record<string, number>;
}): string {
  const shape = buildRosterShape([...rules.rosterPositions]);
  const profile = buildScoringProfile(rules.scoringSettings, [...rules.rosterPositions]);
  return fingerprintOf({ shape, profile });
}

/** What a replay found when it re-derived the rules the snapshot was read under. */
export interface DerivationCheck {
  /** Absent on any file captured before fingerprints existed. */
  captured: string | null;
  current: string;
  /** `true` when there is nothing to disagree with, which is why absence passes. */
  matches: boolean;
}

export function checkDerivation(
  rules: { rosterPositions: readonly string[]; scoringSettings: Record<string, number>; derivation?: string },
): DerivationCheck {
  const current = derivationFingerprint(rules);
  const captured = rules.derivation ?? null;
  return { captured, current, matches: captured == null || captured === current };
}
