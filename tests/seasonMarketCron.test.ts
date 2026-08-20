/**
 * The season-long market lines have to be on a clock.
 *
 * `SeasonMarketService` was written for a daily cadence — a twenty-four hour
 * TTL, two entities per probe, a cooldown and a budget guard — and then nothing
 * ever called it on one. Its only trigger was the button in Setup, so a
 * deployment nobody had pressed it on carried no snapshot, and every `MKT` line
 * on every draft card was blank. Production was found in exactly that state:
 * 250 players on the board, none of them priced, while the unit tests covering
 * the arithmetic were all green.
 *
 * That is the shape of failure this file exists for. No test of the conversion
 * could have caught it, because the conversion was never wrong — it was never
 * called. So the wiring is asserted here directly, read off the worker's own
 * source rather than its behaviour: `scheduled()` cannot be exercised in a unit
 * test without a live Sleeper client, and a test that needed the network would
 * be the first thing skipped the next time the network was slow.
 *
 * Structural, and deliberately so — the same argument `infrastructureIsolation`
 * makes. The question is not "does this code work", it is "is this code
 * reached", and reachability is a property of the call graph.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEASON_PROBE_ENTITIES, SEASON_TTL_MINUTES } from '../src/server/services/seasonMarketService.ts';

const WORKER = readFileSync(join(import.meta.dirname, '..', 'src', 'worker', 'index.ts'), 'utf8');

/** The body of the `0 9` daily branch, which is the clock this belongs on. */
function dailyBranch(): string {
  const start = WORKER.indexOf(`event.cron.startsWith('0 9')`);
  expect(start, 'the daily 09:00 cron branch has gone').toBeGreaterThan(-1);
  const end = WORKER.indexOf('await refreshVegas(appEnv)', start);
  expect(end, 'the daily branch no longer ends before the weekly Vegas refresh').toBeGreaterThan(start);
  return WORKER.slice(start, end);
}

describe('the season market refresh is actually reached', () => {
  it('runs on the daily tick, not only on a button in Setup', () => {
    expect(
      dailyBranch(),
      'nothing on a schedule refreshes season markets, so a fresh deployment shows no MKT line at all',
    ).toContain('new SeasonMarketService(');
  });

  it('refreshes after the player dictionary, so quotes resolve against known players', () => {
    const branch = dailyBranch();
    expect(branch.indexOf('syncPlayers()')).toBeLessThan(branch.indexOf('new SeasonMarketService('));
  });

  it('cannot take the lineup feeds down with it', () => {
    // The call sits inside its own try/catch, like every other optional feed on
    // this clock. A draft-time nicety must not stop an injury check.
    const branch = dailyBranch();
    const at = branch.indexOf('new SeasonMarketService(');
    const before = branch.slice(0, at);
    const after = branch.slice(at);
    expect(before.lastIndexOf('try {')).toBeGreaterThan(before.lastIndexOf('} catch'));
    expect(after.indexOf('} catch')).toBeGreaterThan(-1);
  });

  it('is cheap enough to sit on a daily clock', () => {
    // The reason a daily cadence is safe rather than merely convenient: one
    // probe is two entities, and the service serves a snapshot younger than a
    // day rather than re-buying it. If either of those changes, the cadence
    // above needs revisiting rather than silently costing more.
    expect(SEASON_PROBE_ENTITIES).toBe(2);
    expect(SEASON_TTL_MINUTES).toBe(24 * 60);
  });
});
