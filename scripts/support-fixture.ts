/**
 * Replay a support snapshot, and turn it into a regression fixture.
 *
 * The one command an agent runs after a user sends a snapshot:
 *
 *   npm run support:fixture -- path/to/snapshot.json
 *   npm run support:fixture -- path/to/snapshot.json --write my-guy-not-moving
 *   npm run support:fixture -- path/to/snapshot.json --json
 *
 * Without `--write` it replays and reports, changing nothing. With it, the
 * snapshot is committed as a fixture — but only once it has actually
 * reproduced, because a regression fixture whose expected output this code
 * never produced is a test that asserts a guess.
 *
 * ## No network, and that is checkable rather than promised
 *
 * Everything it reads is the file it was given. The board is rebuilt through
 * `core/support/replay.ts`, whose sources are Maps and whose clock is the
 * instant recorded in the snapshot; there is no provider, no database and no
 * fetch anywhere on the path. Run it with the network unplugged and it behaves
 * identically, which is the point — the state that produced the recommendation
 * is in the file, so nothing has to be rediscovered.
 *
 * TypeScript rather than `.mjs` because it imports the shipped modules
 * directly. Replaying a reimplementation of the engine would prove nothing
 * about the engine.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalSnapshotJson, fixturePath } from '../src/core/support/fixture.ts';
import { readSnapshot, replaySnapshot } from '../src/core/support/dispatch.ts';
import { describeCount, SnapshotRejected, type ReplayReport } from '../src/core/support/contract.ts';
import { DECISION_LABELS } from '../src/core/support/schema.ts';

interface Args {
  file: string | null;
  write: string | null;
  json: boolean;
  /** Write the fixture even though the replay disagreed. Deliberately awkward. */
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { file: null, write: null, json: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--write') args.write = argv[++i] ?? null;
    else if (arg === '--json') args.json = true;
    else if (arg === '--force') args.force = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else args.file = arg;
  }
  return args;
}

const USAGE = `
Replay a Junculator support snapshot and, optionally, commit it as a fixture.

Reads any of the six decisions — Draft, Team, Matchup, Waivers, Defence, Trades
— identifies which from the file, and dispatches to that surface's adapter. No
network, no database, no provider: everything it needs is in the file.

  npm run support:fixture -- <snapshot.json> [--write <name>] [--json] [--force]

  <snapshot.json>   a file captured from Setup → "Copy support snapshot"
  --write <name>    also write tests/fixtures/support/<name>.snapshot.json
  --json            print the whole report as JSON instead of as prose
  --force           write the fixture even if the replay disagreed (rare; say
                    why in the commit message)

Exit codes:   0 reproduced   1 replayed differently   2 could not be read
`.trim();

/**
 * The report, as something a person reads first.
 *
 * The outcome word is the headline because it is what an agent branches on;
 * everything under it exists to make the word checkable rather than believed.
 */
function printHuman(report: ReplayReport, file: string): void {
  console.log(`${file}`);
  console.log(`  outcome        ${report.outcome}`);
  console.log(`  ${report.summary}`);
  console.log('');
  console.log(`  decision       ${DECISION_LABELS[report.kind]} (${report.kind})`);
  /*
   * Said before anything else about the file, and only when it is true.
   *
   * A mock draft's snapshot replays through the same adapter as a real one and
   * reproduces just as cleanly, which is what makes it useful and also what
   * makes it dangerous: nothing further down this report would ever hint that
   * the board it describes was a rehearsal. So the file's own claim is printed
   * here, immediately under what kind of decision it is.
   */
  if (report.rehearsal) {
    console.log(
      `  REHEARSAL      ${report.rehearsal.kind} draft — ${report.rehearsal.picksMade} pick(s) in, ` +
        `seed ${report.rehearsal.seed}. Not a real draft decision.`,
    );
  }
  console.log(`  schema         ${report.schema.found}`);
  console.log(
    `  engine         ${report.engine.captured}${report.engine.matches ? ' (unchanged)' : ` → ${report.engine.current} — MOVED`}`,
  );
  /*
   * Printed only when the file makes the claim, and only in the two states that
   * mean something.
   *
   * A line reading `derivation (unchanged)` on every healthy replay is noise a
   * reader learns to skip, which is how the one that says MOVED gets skipped
   * too. See `derivation.ts`.
   */
  if (report.derivation != null && report.derivation.captured != null) {
    console.log(
      `  derivation     ${report.derivation.captured}${
        report.derivation.matches ? ' (league rules read the same)' : ` → ${report.derivation.current} — MOVED`
      }`,
    );
  }
  console.log(`  captured from  ${report.release.capturedSha}`);
  console.log(`  compared       ${report.compared.map(describeCount).join(', ')}`);

  if (report.distillation.length > 0) {
    console.log('');
    console.log('  known distillation (not drift):');
    for (const entry of report.distillation) {
      console.log(`    ${entry.term}: captured ${entry.captured}, replayed ${entry.replayed}`);
      console.log(`      ${entry.at}`);
    }
  }

  if (report.differences.length > 0) {
    console.log('');
    console.log(`  ${report.differences.length} difference${report.differences.length === 1 ? '' : 's'}:`);
    /*
     * Forty lines, then a count.
     *
     * A board that reordered wholesale produces hundreds of these and printing
     * all of them buries the first few, which are the ones that say what
     * happened. The `--json` form carries the complete list for anything that
     * wants to process it.
     */
    for (const difference of report.differences.slice(0, 40)) {
      console.log(`    ${difference.term} · ${difference.at}`);
      console.log(`      captured  ${JSON.stringify(difference.captured)}`);
      console.log(`      replayed  ${JSON.stringify(difference.replayed)}`);
    }
    if (report.differences.length > 40) {
      console.log(`    … and ${report.differences.length - 40} more (use --json for all of them)`);
    }
  }
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }

  if (!args.file) {
    console.error(USAGE);
    return 2;
  }

  const path = resolve(args.file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`could not read ${path}: ${(err as Error).message}`);
    return 2;
  }

  let snapshot;
  try {
    snapshot = readSnapshot(parsed);
  } catch (err) {
    if (err instanceof SnapshotRejected) {
      /*
       * A refusal is a diagnosis too, and it is one of the six outcomes.
       *
       * `schema_unsupported` means this build cannot read the file — a newer
       * app, or an older one — and is not the same as the file being wrong.
       * `data_mismatch` means it is malformed or carries something a snapshot
       * must never contain. Printed in the same shape as a replay report so an
       * agent can parse either without branching on which happened.
       */
      const report = { outcome: err.outcome, summary: err.message, file: path };
      console.error(args.json ? JSON.stringify(report, null, 2) : `${path}\n  outcome        ${err.outcome}\n  ${err.message}`);
      return 2;
    }
    throw err;
  }

  const report = await replaySnapshot(snapshot);

  if (args.json) {
    /*
     * The replayed decision itself is not part of the report a caller wants
     * piped — a draft board is megabytes — so only the verdict travels. The
     * Draft adapter is the one that attaches `board`; the in-season adapters
     * attach nothing, because the file already contains what they produced.
     */
    const { board: _board, ...rest } = report as ReplayReport & { board?: unknown };
    console.log(JSON.stringify({ file: path, ...rest }, null, 2));
  } else {
    printHuman(report, path);
  }

  const reproduced = report.outcome === 'reproduced';

  if (args.write) {
    if (!reproduced && !args.force) {
      console.error('');
      console.error(
        `refusing to write a fixture from a snapshot that replayed as ${report.outcome}. ` +
          'Fix the difference first, or pass --force and say why in the commit message.',
      );
      return 1;
    }
    const out = fixturePath(args.write);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, canonicalSnapshotJson(snapshot), 'utf8');
    console.log('');
    console.log(`  wrote ${out}`);
    console.log('  tests/support.fixtures.test.ts replays every file in that directory — nothing else to register.');
    console.log('  run it with: npx vitest run tests/support.fixtures.test.ts');
  }

  return reproduced ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
