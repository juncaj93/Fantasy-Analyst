/**
 * The Matchup screen gives no advice (October 2026).
 *
 * Only the Team screen's Best move card says who to start. Matchup shows the
 * matchup, Alex's players and both benches, so the two screens cannot
 * disagree. These lock that in at the source, where a recommendation would
 * have to be written, and at the model, where one would have to be produced
 * as an insight. `e2e/matchup.spec.ts` checks the rendered page.
 *
 * The matchup model still computes its lineup decision: it feeds the win
 * probability's calibration ledger. It is simply never drawn.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assessLineupDecision, MIN_WIN_PROBABILITY_GAIN } from '../src/core/matchup/decision.ts';

const SCREEN = 'src/web/screens/MatchupScreen.tsx';
const COMPONENTS = 'src/web/components/matchup.tsx';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe('the Matchup screen recommends nothing', () => {
  it('draws no best-move row, hold row or best-move sheet', () => {
    for (const file of [SCREEN, COMPONENTS]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/matchup-best-move|best-move-sheet|BestMove|bestMoveState/);
      expect(source, file).not.toMatch(/Hold your lineup/);
    }
  });

  it('prints no start/sit sentence and no recommended mode', () => {
    const source = readFileSync(SCREEN, 'utf8');
    expect(source).not.toMatch(/>\s*Start\s*\{/);
    expect(source).not.toMatch(/Recommended mode/);
    expect(source).not.toMatch(/decision\.(best|options|note|onProjection)/);
  });

  it('gives the Matchup screen no way to write a lineup', () => {
    for (const file of [SCREEN, COMPONENTS]) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/api\.post|method: 'POST'/);
    }
  });

  it('produces no lineup-leverage insight for the sheet behind the odds', () => {
    const source = readFileSync('src/core/matchup/insights.ts', 'utf8');
    expect(source).not.toMatch(/kind: 'lineup_leverage'/);
  });
});

describe('the model underneath did not move', () => {
  it('keeps its materiality threshold at two points of win probability', () => {
    expect(MIN_WIN_PROBABILITY_GAIN).toBe(0.02);
  });

  it('is still called from exactly one place', () => {
    expect(assessLineupDecision).toBeTypeOf('function');
    const callers = sourceFiles('src').filter((file) => {
      if (file.endsWith('src/core/matchup/decision.ts')) return false;
      return readFileSync(file, 'utf8').includes('assessLineupDecision');
    });
    expect(callers).toEqual(['src/core/matchup/model.ts']);
  });
});
