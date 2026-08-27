/**
 * The command an agent actually runs, run as a process.
 *
 * Every other test in this lane imports the modules. This one does not, and the
 * difference is the point: `npm run support:fixture` executes the shipped
 * TypeScript through Node's `--experimental-transform-types` loader, which is a
 * *stripper* rather than a compiler. It refuses anything that is a transform
 * rather than an annotation — a parameter property, an enum, a namespace — and
 * none of those fail a `tsc` build or a vitest run. The first time anybody would
 * find out is the moment somebody sends a snapshot in and the one command that
 * exists to read it will not start.
 *
 * So: a real snapshot of each of the five decisions, written to a temporary
 * directory, and the real command run over it. Slow by the standards of this
 * suite and worth every millisecond.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { DemoRuntime } from '../src/core/demo/runtime/index.ts';
import { findScenario } from '../src/core/demo/registry.ts';
import { IN_SEASON_KINDS } from '../src/core/support/contexts.ts';
import { FIXTURE_SUFFIX } from '../src/core/support/fixture.ts';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..');

/** A Tuesday for four of the five, and a Sunday for the one with a game on it. */
const scenarioFor = (context: string) => (context === 'matchup' ? 'sunday-pregame' : 'waivers-tuesday-active');

let scratch: string;
const files = new Map<string, string>();

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'support-cli-'));
  for (const context of IN_SEASON_KINDS) {
    const runtime = await DemoRuntime.forScenario(findScenario(scenarioFor(context))!);
    const leagues = (await runtime.request('GET', '/api/leagues')).body as { leagues: { id: string }[] };
    const response = await runtime.request(
      'GET',
      `/api/leagues/${leagues.leagues[0]!.id}/support-snapshot?context=${context}`,
    );
    expect(response.status, `${context}: ${JSON.stringify(response.body)}`).toBe(200);
    const path = join(scratch, `${context}.json`);
    writeFileSync(path, JSON.stringify(response.body, null, 2), 'utf8');
    files.set(context, path);
  }
}, 120_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** `npm run support:fixture -- …`, without npm in the way. */
async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ['--experimental-transform-types', '--no-warnings', 'scripts/support-fixture.ts', ...args],
      { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('npm run support:fixture', () => {
  it.each(IN_SEASON_KINDS)('replays a %s snapshot and exits 0', async (context) => {
    const result = await cli([files.get(context)!]);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('outcome        reproduced');
    /*
     * It names the decision, because an agent handed a file should not have to
     * open it to learn which of the six it is holding.
     */
    expect(result.stdout).toMatch(new RegExp(`decision {2,}\\w+ \\(${context}\\)`));
  }, 120_000);

  it('prints a machine-readable report without the replayed decision in it', async () => {
    const result = await cli([files.get('waiver-plan')!, '--json']);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report['outcome']).toBe('reproduced');
    expect(report['kind']).toBe('waiver-plan');
    expect(report['differences']).toEqual([]);
    /*
     * The verdict travels; the decision does not. A draft board is megabytes and
     * a caller piping this wants the six words and the differences.
     */
    expect(report['board']).toBeUndefined();
  }, 120_000);

  it('refuses a file it cannot read, with the outcome word and a non-zero exit', async () => {
    const broken = join(scratch, 'broken.json');
    writeFileSync(broken, JSON.stringify({ schema: 'something/else@9' }), 'utf8');
    const result = await cli([broken]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('schema_unsupported');
  }, 120_000);

  it('writes a fixture that the fixture suite then reads without being told about it', async () => {
    /*
     * Into the repository's own fixture directory, and removed again.
     *
     * `--write` resolves against `FIXTURE_DIR` by design — there is one place a
     * committed case lives and the CLI does not take a second — so the honest
     * way to exercise it is to write there and clean up. The file is
     * demo-derived and must never be committed; see the policy note in
     * `core/support/fixture.ts`.
     */
    const name = 'cli-round-trip-scratch';
    const written = join(ROOT, 'tests', 'fixtures', 'support', `${name}${FIXTURE_SUFFIX}`);
    try {
      const result = await cli([files.get('dst-plan')!, '--write', name]);
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(`wrote tests/fixtures/support/${name}${FIXTURE_SUFFIX}`);

      const raw = readFileSync(written, 'utf8');
      expect(raw.endsWith('\n'), 'a fixture is canonical on disk').toBe(true);
      /* And it replays, which is what the committed-fixture suite would do. */
      const replayed = await cli([written]);
      expect(replayed.code).toBe(0);
      expect(replayed.stdout).toContain('outcome        reproduced');
    } finally {
      rmSync(written, { force: true });
    }
  }, 180_000);

  /** A copy of a snapshot with one value changed, written to the scratch dir. */
  function tampered(context: string, name: string, edit: (snapshot: Record<string, never>) => void): string {
    const path = join(scratch, `${name}.json`);
    const snapshot = JSON.parse(readFileSync(files.get(context)!, 'utf8')) as Record<string, never>;
    edit(snapshot);
    writeFileSync(path, JSON.stringify(snapshot), 'utf8');
    return path;
  }

  it('refuses to write a fixture from a snapshot that did not reproduce', async () => {
    /*
     * A regression fixture whose expected output this code never produced is a
     * test that asserts a guess, so `--write` replays first and declines.
     */
    const path = tampered('lineup', 'moved-board', (snapshot) => {
      const output = (snapshot as unknown as { decision: { output: { recommendedPoints: number } } }).decision.output;
      output.recommendedPoints += 1;
    });

    const result = await cli([path, '--write', 'should-not-exist']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('outcome        output_difference');
    expect(result.stdout).toContain('recommendedPoints');
    expect(result.stderr).toContain('refusing to write a fixture');
  }, 120_000);

  it('reports a moved engine ahead of the difference it caused', async () => {
    /*
     * The precedence that stops Tuesday's calibration commit reading as a
     * regression: a replay that disagrees on a *moved* engine is expected, and
     * saying `output_difference` would send the reader hunting for a bug that is
     * a deliberate weight change.
     */
    const path = tampered('lineup', 'moved-engine', (snapshot) => {
      const decision = snapshot as unknown as {
        release: { engineVersion: string };
        decision: { output: { recommendedPoints: number } };
      };
      decision.release.engineVersion = 'lineup@99+startsit@99';
      decision.decision.output.recommendedPoints += 1;
    });

    const result = await cli([path]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('outcome        engine_version_mismatch');
    expect(result.stdout).toContain('MOVED');
  }, 120_000);
});
