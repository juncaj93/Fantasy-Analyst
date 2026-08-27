/**
 * What "reproduced" means, for every surface, in one place.
 *
 * `replay.ts` states the Draft contract as seven named terms because a draft
 * board's output is hand-written into the file and each term is a claim
 * somebody chose to make. The five in-season lanes carry the engines' own
 * outputs whole — see `payloads.ts` — so their contract is stated once, here,
 * as a structural walk: **every leaf of the captured output must equal the same
 * leaf of the replayed output, exactly, by path.**
 *
 * That is a stronger claim than a list of terms, not a weaker one. A list is the
 * fields somebody remembered; the field they forgot is not compared and its
 * disappearance is invisible. A walk compares the field that was added last
 * Tuesday without anybody having remembered anything, and names it by the path a
 * reader can find in the file.
 *
 * ## No tolerance, and the one concession
 *
 * Nothing here forgives a difference of any magnitude. Every number on these
 * paths is produced by the same double arithmetic in the same order from the
 * same inputs, so an exact match is achievable and a tolerance would be a place
 * for real drift to hide.
 *
 * The single concession is **signed zero**, and it is not numeric: JSON has no
 * `-0`, so a value captured as `-0` is written `0` and replays as `-0`. They are
 * the same quantity, sort identically, and print the same everywhere a reader
 * can see. `replay.ts` carries the same concession for the same reason.
 *
 * ## Both sides go through the wire
 *
 * The captured side has been serialised and parsed; the replayed side has not.
 * Comparing them directly would report a difference for every `undefined` the
 * engine returned and for every `Date` it produced, neither of which is a
 * difference — so the replayed side is normalised through JSON before the walk.
 *
 * That normalisation would also hide a `Map`, which becomes `{}` on both sides
 * and compares equal while carrying nothing. It cannot: `lossless.ts` refuses
 * the *capture* of any value JSON would change, so a `Map` never reaches this
 * comparison in the first place. The two modules are halves of one guarantee.
 */

import { findRedactionViolations } from './redaction.ts';
import {
  IMPLEMENTED_KINDS,
  SUPPORT_SNAPSHOT_SCHEMA,
  type DecisionKind,
  type DecisionPayload,
  type PayloadFor,
  type ReplayOutcome,
  type SnapshotRehearsal,
  type SupportSnapshot,
} from './schema.ts';

/** One way in which the replay and the capture disagreed. */
export interface ReplayDifference {
  /** Which term of the contract failed — `order`, `output.slots[0].score`, … */
  term: string;
  /** Where, in terms a reader can find in the file. */
  at: string;
  captured: unknown;
  replayed: unknown;
}

/**
 * How much was compared, in the units of the surface being replayed.
 *
 * `what` is the **plural** noun — `starting slots`, `claims`, `surfaced offers`
 * — and a reader printing it drops the trailing `s` at a count of one. Every
 * label used here pluralises regularly, which is a property of the labels rather
 * than of English, and is the reason a three-line rule is enough.
 */
export interface ComparedCount {
  what: string;
  count: number;
}

/** `3 claims`, `1 claim`. */
export function describeCount(entry: ComparedCount): string {
  const noun = entry.count === 1 && entry.what.endsWith('s') ? entry.what.slice(0, -1) : entry.what;
  return `${entry.count} ${noun}`;
}

export interface ReplayReport {
  outcome: ReplayOutcome;
  /** One sentence a person can read before looking at anything else. */
  summary: string;
  kind: DecisionKind;
  schema: { expected: string; found: string; supported: boolean };
  engine: { captured: string; current: string; matches: boolean };
  /**
   * How this build derives a league's shape and scoring, against how the
   * capturing build did.
   *
   * Absent on the Draft report, which reads a draft rather than a league week,
   * and on any lane replaying a file captured before fingerprints existed —
   * `captured: null` there, and `matches: true`, because an absent claim is not
   * a disagreement. A mismatch folds into the same precedence a moved engine
   * gets, for the same reason: it explains a difference, so it is named ahead of
   * it. See `derivation.ts`.
   */
  derivation?: { captured: string | null; current: string; matches: boolean };
  release: { capturedSha: string };
  /**
   * Present only when the file says it was captured in a rehearsal.
   *
   * Carried through to the report rather than left in the envelope for a reader
   * to notice, because the whole risk a mock snapshot creates is that it
   * reproduces perfectly and is then read as evidence about a real draft. The
   * one line the CLI prints for it is the difference between a diagnosis and a
   * wrong diagnosis nobody can see is wrong.
   */
  rehearsal?: SnapshotRehearsal;
  compared: ComparedCount[];
  differences: ReplayDifference[];
  /**
   * Things that are different and are *known* to be, because the snapshot is a
   * distillation rather than a copy of the database.
   *
   * Reported rather than swallowed. A reader has to be able to tell a bounded
   * capture apart from a board that lost two thousand players.
   */
  distillation: ReplayDifference[];
}

/** Raised when a snapshot cannot be read at all. */
export class SnapshotRejected extends Error {
  /** Plain fields, so type-stripping alone can run this — see the CLI. */
  readonly outcome: Extract<ReplayOutcome, 'schema_unsupported' | 'data_mismatch'>;

  /**
   * The same refusal in the app's own words, when there is a version of it a
   * person should see.
   *
   * Set for exactly one refusal: a snapshot with nothing in it to rebuild. That
   * one is not a bug — a league with no decision to make produces it honestly —
   * and `sealSnapshot` uses this field to turn the refusal into the sentence the
   * screen would have shown rather than a stack trace. Every other refusal is a
   * malformed file or a broken build, and leaves this `null` so it surfaces as
   * the programming error it is. See `emit.ts`.
   */
  readonly reader: string | null;

  constructor(
    outcome: Extract<ReplayOutcome, 'schema_unsupported' | 'data_mismatch'>,
    message: string,
    reader: string | null = null,
  ) {
    super(message);
    this.name = 'SnapshotRejected';
    this.outcome = outcome;
    this.reader = reader;
  }
}

/**
 * Read a parsed JSON value as a snapshot of any implemented kind, or refuse it.
 *
 * Three gates, in this order, and the order is the point. The schema identity
 * decides whether this build knows the shape at all; a version it has never
 * heard of is not a malformed file and must not be reported as one. Then the
 * decision kind, which is the same question one level down — a build that
 * predates a lane says so rather than crashing inside an adapter. Then the
 * redaction scan runs *again*: capture already ran it, and running it here as
 * well is the point, because a snapshot is a file that travels and the copy
 * being replayed is not necessarily the copy that was emitted.
 */
export function readSnapshot(value: unknown): SupportSnapshot {
  if (value == null || typeof value !== 'object') {
    throw new SnapshotRejected('data_mismatch', 'not a JSON object');
  }
  const snapshot = value as Partial<SupportSnapshot>;

  if (snapshot.schema !== SUPPORT_SNAPSHOT_SCHEMA) {
    throw new SnapshotRejected(
      'schema_unsupported',
      `schema is ${JSON.stringify(snapshot.schema ?? null)}; this build reads ${SUPPORT_SNAPSHOT_SCHEMA}`,
    );
  }

  const decision = snapshot.decision as Partial<DecisionPayload> | undefined;
  const kind = decision?.kind;
  if (kind == null || !IMPLEMENTED_KINDS.includes(kind)) {
    throw new SnapshotRejected(
      'schema_unsupported',
      `decision.kind is ${JSON.stringify(kind ?? null)}; this build replays ${IMPLEMENTED_KINDS.join(', ')}`,
    );
  }

  for (const path of ['request', 'inputs', 'output', 'context'] as const) {
    /*
     * `output` may legitimately be null — a DST plan for a league that starts
     * no defence is `null`, and that is a decision rather than a gap. Missing
     * is still a malformed file: the key has to be there and say so.
     */
    if (!(path in decision!)) throw new SnapshotRejected('data_mismatch', `decision.${path} is missing`);
  }

  const empty = emptinessOf(decision as DecisionPayload);
  if (empty != null) throw new SnapshotRejected('data_mismatch', empty.agent, empty.reader);
  if (typeof snapshot.capturedAt !== 'string' || Number.isNaN(Date.parse(snapshot.capturedAt))) {
    throw new SnapshotRejected('data_mismatch', 'capturedAt is not an ISO-8601 instant, so the clock cannot be fixed');
  }

  /*
   * A snapshot carrying a secret is refused, not cleaned.
   *
   * Cleaning it would mean writing a file that had contained one, and the person
   * holding it would have no way to know. The honest response to "this file has
   * an API key in it" is to say so and stop.
   */
  const violations = findRedactionViolations(snapshot);
  if (violations.length > 0) {
    throw new SnapshotRejected(
      'data_mismatch',
      `this snapshot carries ${violations.length} field${violations.length === 1 ? '' : 's'} a support snapshot must never contain — ` +
        violations.map((v) => `${v.path} (${v.reason})`).join('; '),
    );
  }

  return snapshot as SupportSnapshot;
}

/**
 * Whether a snapshot has anything in it to rebuild a decision from.
 *
 * A file that parses, carries the right schema and names an implemented kind can
 * still be empty of the one thing that matters. Refusing it here — before any
 * adapter runs — is what makes the difference between "this build replayed your
 * file and got nothing" and "this file has nothing in it", which are two very
 * different messages to send somebody who is waiting on an answer.
 *
 * Two sentences per case, because the refusal is read by two people. `agent`
 * names the field, which is what somebody debugging a file wants; `reader` says
 * what happened in the app's own words, and travels on the thrown
 * `SnapshotRejected` so that `sealSnapshot` — which refuses a *capture* through
 * this same gate — can show it to the person holding the phone instead of a
 * path. See `emit.ts`.
 *
 * One clause per kind, and the compiler requires all six.
 */
function emptinessOf(decision: DecisionPayload): { agent: string; reader: string } | null {
  switch (decision.kind) {
    case 'draft-board':
      return Array.isArray(decision.inputs.players) && decision.inputs.players.length > 0
        ? null
        : { agent: 'decision.inputs.players is empty, so there is no board to rebuild', reader: 'No draft board could be built, so there is nothing to explain yet.' };
    case 'lineup':
      return (decision.inputs.startSit?.inputs?.length ?? 0) > 0
        ? null
        : { agent: 'decision.inputs.startSit is empty, so there is no lineup to rebuild', reader: 'No player on this roster could be read, so there is no lineup to explain yet.' };
    case 'matchup':
      return (decision.inputs.startSit?.inputs?.length ?? 0) > 0
        ? null
        : { agent: 'decision.inputs.startSit is empty, so there is no forecast to rebuild', reader: 'No player in this matchup could be read, so there is no forecast to explain yet.' };
    case 'waiver-plan':
      return (decision.inputs.roster?.inputs?.length ?? 0) > 0
        ? null
        : { agent: 'decision.inputs.roster is empty, so there is no waiver plan to rebuild', reader: 'No player on this roster could be read, so there is no waiver plan to explain yet.' };
    case 'dst-plan':
      return (decision.inputs.roster?.inputs?.length ?? 0) + (decision.inputs.candidates?.inputs?.length ?? 0) > 0
        ? null
        : {
            agent: 'decision.inputs holds no defences at all, so there is no plan to rebuild',
            reader: 'No defence could be read for this league, so there is no defence plan to explain yet.',
          };
    case 'trade-offer':
      return (decision.inputs.pool?.inputs?.length ?? 0) > 0
        ? null
        : { agent: 'decision.inputs.pool is empty, so there is no offer to rebuild', reader: 'No player on any roster in this league could be read, so there is no trade to explain yet.' };
    default:
      return null;
  }
}

/** The same read, narrowed to one kind, for an adapter that knows which it wants. */
export function expectKind<K extends DecisionKind>(
  snapshot: SupportSnapshot,
  kind: K,
): SupportSnapshot<PayloadFor<K>> {
  if (snapshot.decision.kind !== kind) {
    throw new SnapshotRejected(
      'data_mismatch',
      `this snapshot is a ${snapshot.decision.kind}, not a ${kind}`,
    );
  }
  return snapshot as SupportSnapshot<PayloadFor<K>>;
}

// ------------------------------------------------------------ the primitives

/**
 * Equal, with the one concession JSON forces and no others.
 *
 * `Object.is` rather than `===` so that two `NaN`s compare equal — a component
 * that could not be computed should replay as the same thing it captured — and
 * so that nothing is coerced. The single exception is **signed zero**, which
 * JSON cannot express: `JSON.stringify(-0)` is `"0"`, and there is no way to
 * write one, so a value captured as `-0` replays as `-0` against a `0` in the
 * file. It is an artifact of the wire format and not a fact about the answer.
 */
export function exact(
  term: string,
  at: string,
  captured: unknown,
  replayed: unknown,
  into: ReplayDifference[],
): void {
  if (Object.is(captured, replayed)) return;
  if (captured === 0 && replayed === 0) return;
  into.push({ term, at, captured, replayed });
}

/**
 * Sentences, compared as sets rather than as an ordered list.
 *
 * The same sentences, whatever order they were assembled in. Not a fuzzy match —
 * a changed word is a difference — because a reason that reads differently is a
 * reason that argues differently, and a comparison that forgave it would hide
 * exactly the drift somebody replaying a snapshot is looking for.
 */
export function compareSets(
  term: string,
  captured: string[],
  replayed: string[],
  into: ReplayDifference[],
): void {
  const a = [...captured].sort();
  const b = [...replayed].sort();
  if (a.length === b.length && a.every((line, i) => line === b[i])) return;

  /*
   * The sorted lists, compared as sequences rather than as memberships.
   *
   * A `missing`/`added` diff over set membership alone would report *nothing*
   * for a card that said the same sentence twice where it used to say it once —
   * both sides contain it, so neither list is populated, and a real change to
   * the argument would pass as a match.
   */
  const missing = a.filter((line) => !b.includes(line));
  const added = b.filter((line) => !a.includes(line));
  into.push({
    term,
    at: 'set',
    captured: missing.length > 0 || added.length > 0 ? missing : a,
    replayed: missing.length > 0 || added.length > 0 ? added : b,
  });
}

/**
 * How many leaf differences one structural walk will report before it stops.
 *
 * A lineup that reordered wholesale produces hundreds and printing all of them
 * buries the first few, which are the ones that say what happened. The walk
 * appends a marker and stops, and `--json` is not a way to get more — the walk
 * genuinely did not continue, because a comparison that has already found forty
 * disagreements has answered the question it was asked.
 */
export const MAX_STRUCTURAL_DIFFERENCES = 40;

/**
 * Walk two values and report every leaf that differs, by path.
 *
 * The replayed side is normalised through JSON first — see the module note — so
 * an `undefined` the engine returned and a `Date` it produced are not reported
 * as differences against a file that could not express either.
 *
 * A key present on one side and absent on the other is a difference in its own
 * right and is reported as one: `output.claimPlan.claims[0].bid` vanishing is a
 * bid that stopped being made, and a walk that only compared shared keys would
 * call that a match.
 */
export function compareStructural(
  root: string,
  captured: unknown,
  replayed: unknown,
  into: ReplayDifference[],
): void {
  const wire = normalise(replayed);
  let reported = 0;

  const push = (term: string, capturedAt: unknown, replayedAt: unknown): boolean => {
    if (reported >= MAX_STRUCTURAL_DIFFERENCES) return false;
    into.push({ term, at: root, captured: capturedAt, replayed: replayedAt });
    reported += 1;
    if (reported === MAX_STRUCTURAL_DIFFERENCES) {
      into.push({
        term: `${root} · further differences`,
        at: root,
        captured: 'not listed',
        replayed: 'not listed',
      });
    }
    return true;
  };

  const walk = (a: unknown, b: unknown, path: string): void => {
    if (reported >= MAX_STRUCTURAL_DIFFERENCES) return;

    const aObject = a != null && typeof a === 'object';
    const bObject = b != null && typeof b === 'object';

    if (!aObject || !bObject) {
      if (!Object.is(a, b) && !(a === 0 && b === 0)) push(path, a, b);
      return;
    }

    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b)) {
        push(path, describeShape(a), describeShape(b));
        return;
      }
      if (a.length !== b.length) push(`${path}.length`, a.length, b.length);
      const limit = Math.min(a.length, b.length);
      for (let i = 0; i < limit; i++) walk(a[i], b[i], `${path}[${i}]`);
      return;
    }

    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      const here = `${path}.${key}`;
      const inLeft = key in left;
      const inRight = key in right;
      if (inLeft !== inRight) {
        push(here, inLeft ? left[key] : 'absent', inRight ? right[key] : 'absent');
        continue;
      }
      walk(left[key], right[key], here);
    }
  };

  walk(captured, wire, root);
}

function describeShape(value: unknown): string {
  if (Array.isArray(value)) return `array of ${value.length}`;
  if (value === null) return 'null';
  return typeof value;
}

/**
 * A value as the wire would have delivered it.
 *
 * `undefined` disappears, a `Date` becomes an ISO string, and nothing else
 * changes — because nothing else *can* be here: `lossless.ts` refused the
 * capture of any value JSON would alter, so there is no `Map` left to hide.
 */
function normalise(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

// -------------------------------------------------------------- the verdict

/**
 * One of six words, chosen in a fixed order of precedence.
 *
 * A moved engine version explains a difference and is therefore reported ahead
 * of the difference itself — otherwise every replay after a legitimate weight
 * change reads `output_difference`, and a real regression becomes
 * indistinguishable from Tuesday's calibration commit.
 *
 * `freshness_difference` sits between the two for the same reason at a smaller
 * scale: a decision whose *only* disagreements are about how old its data is has
 * a specific, checkable cause — a clock that did not get pinned — and calling
 * that an output difference sends the reader to the engine for a problem that is
 * not there.
 */
export function classifyOutcome(differences: ReplayDifference[], engineMatches: boolean): ReplayOutcome {
  if (differences.length === 0) return 'reproduced';
  if (!engineMatches) return 'engine_version_mismatch';
  if (differences.every((d) => isFreshnessTerm(d.term))) return 'freshness_difference';
  return 'output_difference';
}

/**
 * Whether a term is about the age of the data rather than about the answer.
 *
 * Two shapes, because the Draft lane names its freshness terms by hand and the
 * in-season lanes reach theirs through the structural walk: `freshness.dog.state`
 * and `freshness.props.fetchedAt` are both freshness, and
 * `output.slots[0].score` is not.
 */
function isFreshnessTerm(term: string): boolean {
  return term.startsWith('freshness.') || term.includes('.freshness.') || term.endsWith('.freshness');
}

/**
 * The `engine_version_mismatch` sentence, which has two causes and must not
 * name the wrong one.
 *
 * A replay reaches this outcome either because the lane's own engine has moved
 * or because this build derives a league's rules differently from the build that
 * captured the file — and those send a reader to two completely different
 * places. A single sentence naming the engine would, on a scoring-derivation
 * change, point at a lane that did not change and hide the thing that did.
 *
 * Derivation is named first when both have moved, because it is the one that
 * explains differences in every lane at once.
 */
export function describeMoved(
  engineName: string,
  thing: string,
  report: Pick<ReplayReport, 'engine' | 'derivation' | 'differences'>,
): string {
  const places = `${report.differences.length} place${report.differences.length === 1 ? '' : 's'}`;
  if (report.derivation != null && !report.derivation.matches) {
    return `This build does not read league rules the way the build that captured this file did (derivation ${report.derivation.captured} → ${report.derivation.current}), and the ${thing} came out differently in ${places}. Expected after a change to how roster shape or scoring is derived; re-capture on this build before treating it as a regression.`;
  }
  return `The ${engineName} has moved since capture (${report.engine.captured} → ${report.engine.current}) and the ${thing} came out differently in ${places}. Expected; compare against a snapshot captured on this engine before treating it as a regression.`;
}

export function describeDifference(difference: ReplayDifference): string {
  return `${difference.term} at ${difference.at} — captured ${JSON.stringify(difference.captured)}, replayed ${JSON.stringify(difference.replayed)}`;
}
