/**
 * The two checks every capture passes before it is a file.
 *
 * Both refuse rather than repair, and both run over the *finished* snapshot
 * rather than over each field on the way in — because the failure mode worth
 * catching is the field somebody adds next year without reading either module.
 *
 *   - **redaction** (`redaction.ts`): nothing that identifies a person, and
 *     nothing that identifies a credential. A partly-redacted file is worse than
 *     none, because it looks safe;
 *   - **losslessness** (`lossless.ts`): nothing the wire would quietly change. A
 *     snapshot whose manager priors were all neutralised by `JSON.stringify`
 *     replays as a different decision that looks like the right one, which is
 *     the worst thing a diagnostic file can be.
 *
 * Six adapters call this and none of them can forget one of the two, which is
 * the whole reason it is a function rather than a convention.
 */

import { SnapshotRedactionError, findRedactionViolations } from './redaction.ts';
import { SnapshotLossyError, findLossyValues } from './lossless.ts';
import type { DecisionPayload, SupportSnapshot } from './schema.ts';

/**
 * Check a finished snapshot, or throw.
 *
 * Redaction first: a file carrying a secret should be reported as carrying a
 * secret, whatever else is wrong with it.
 */
export function sealSnapshot<P extends DecisionPayload>(snapshot: SupportSnapshot<P>): SupportSnapshot<P> {
  const violations = findRedactionViolations(snapshot);
  if (violations.length > 0) throw new SnapshotRedactionError(violations);

  const lossy = findLossyValues(snapshot);
  if (lossy.length > 0) throw new SnapshotLossyError(lossy);

  return snapshot;
}

/**
 * Raised when there is no decision to capture.
 *
 * Not an error in the code and not a malformed request: a league with no
 * matchup scheduled this week, or a league that starts no defence, has nothing
 * for the snapshot to be *about*. The alternative is a file that looks exactly
 * like a bug report and contains nothing, which somebody would send and then
 * wait on — the same reason the Draft row refuses a capture when no draft is
 * loaded.
 *
 * The message is the sentence the screen itself would have shown, so a reader
 * who taps the button gets an answer rather than a status code.
 */
export class SnapshotUnavailable extends Error {
  /* A plain field, so type-stripping alone can run this — see the CLI. */
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = 'SnapshotUnavailable';
    this.status = status;
  }
}
