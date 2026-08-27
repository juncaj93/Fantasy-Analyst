/**
 * The three checks every capture passes before it is a file.
 *
 * All three refuse rather than repair, and all three run over the *finished*
 * snapshot rather than over each field on the way in — because the failure mode
 * worth catching is the field somebody adds next year without reading any of
 * these modules.
 *
 *   - **redaction** (`redaction.ts`): nothing that identifies a person, and
 *     nothing that identifies a credential. A partly-redacted file is worse than
 *     none, because it looks safe;
 *   - **losslessness** (`lossless.ts`): nothing the wire would quietly change. A
 *     snapshot whose manager priors were all neutralised by `JSON.stringify`
 *     replays as a different decision that looks like the right one, which is
 *     the worst thing a diagnostic file can be;
 *   - **readability** (`contract.ts`): the reader's own acceptance, run on the
 *     writer's side. See below.
 *
 * Six adapters call this and none of them can forget one of the three, which is
 * the whole reason it is a function rather than a convention.
 *
 * ## Write and read are the same gate, run twice
 *
 * `readSnapshot` is the only thing that decides whether a support file can be
 * replayed at all, and until this function called it, the writer's checks and
 * the reader's checks were two lists maintained in two places. Every gap between
 * them had the same shape and it is the worst one this feature has: **Copy
 * support snapshot succeeds, the person sends the file in, and the one command
 * that exists to read it refuses.** They have already spent their goodwill by
 * then, and the refusal is a message about our tooling rather than about their
 * problem.
 *
 * So the finished snapshot is put on the wire here — serialised and parsed,
 * because that is the artifact the user actually receives, not the object graph
 * that produced it — and handed to `readSnapshot`. Nothing can now be emitted
 * that the reader would reject, and a gate added to the reader tomorrow is a
 * gate the writer starts enforcing in the same commit, without anybody having to
 * remember this file exists.
 *
 * The one refusal that gets its own treatment is emptiness, because it is the
 * one that is not a bug. A league with nothing to decide about produces a
 * *legitimately* empty capture; the person tapping the button is owed the
 * screen's own sentence and a 409, not a stack trace. Every other refusal is a
 * programming error and is raised as one — loudly, here, where the test suite
 * catches it, rather than quietly, in a file somebody is waiting on.
 */

import { SnapshotRedactionError, findRedactionViolations } from './redaction.ts';
import { SnapshotLossyError, findLossyValues } from './lossless.ts';
import { SnapshotRejected, readSnapshot } from './contract.ts';
import type { DecisionPayload, SupportSnapshot } from './schema.ts';

/**
 * Check a finished snapshot, or throw.
 *
 * Redaction first: a file carrying a secret should be reported as carrying a
 * secret, whatever else is wrong with it. Losslessness second, because a value
 * the wire would change has to be found *before* anything is put on the wire.
 * Readability last, on what the wire produced.
 */
export function sealSnapshot<P extends DecisionPayload>(snapshot: SupportSnapshot<P>): SupportSnapshot<P> {
  const violations = findRedactionViolations(snapshot);
  if (violations.length > 0) throw new SnapshotRedactionError(violations);

  const lossy = findLossyValues(snapshot);
  if (lossy.length > 0) throw new SnapshotLossyError(lossy);

  /*
   * The artifact the user receives, not the object that produced it.
   *
   * `lossless.ts` has just established that this round trip changes nothing, so
   * the parse is a formality in the healthy case — and the case it is not a
   * formality in is precisely the one worth catching.
   */
  const wire = JSON.parse(JSON.stringify(snapshot)) as unknown;

  try {
    readSnapshot(wire);
  } catch (err) {
    /*
     * One refusal is translated and the rest are raised as they are.
     *
     * `reader` is set on exactly the refusal that is not a bug — a capture with
     * nothing in it to rebuild — and carrying it on the error rather than
     * re-deriving it here is what keeps this from becoming a second copy of the
     * reader's gate order. Anything else that reaches this line is a snapshot
     * this build wrote and cannot read, which is a programming error and is
     * allowed to look like one.
     */
    if (err instanceof SnapshotRejected && err.reader != null) throw new SnapshotUnavailable(err.reader);
    throw err;
  }

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
