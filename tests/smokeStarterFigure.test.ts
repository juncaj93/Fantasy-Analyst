/**
 * The production smoke suite's check on a starter row's figure, against the
 * labels the app actually builds.
 *
 * `e2e-production/` runs only after a deploy, so it cannot import from `src/`
 * (see `support.availability.test.ts`). This reads its pattern out of the file
 * instead and holds it to `spokenRowFigure`: the bracket is optional for a
 * player ruled Out with nothing to lose, checked when he had a projection, and
 * never enough without `out` (owner's rule, 6 October 2026).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rowFigure, spokenRowFigure } from '../src/web/rowFigure.ts';

const smoke = readFileSync(join(import.meta.dirname, '..', 'e2e-production', 'smoke.spec.ts'), 'utf8');
const literal = /^const STARTER_FIGURE = \/(.+)\/i;$/m.exec(smoke);
const STARTER_FIGURE = new RegExp(literal![1]!, 'i');

const projected = (points: number | null) => (points == null ? ', projection unavailable' : `, projected ${points.toFixed(1)} points`);
const label = (projection: number | null, ruledOut: boolean) =>
  `RB: Will Shipley, keep him${spokenRowFigure(rowFigure(projection, { ruledOut, statusFlag: ruledOut ? 'Out' : null, components: [] }), projected)}, Out`;

describe('the smoke suite reads a starter figure the way the app says it', () => {
  it('is still one literal in the production suite', () => {
    expect(literal, 'STARTER_FIGURE is no longer a single-line literal in smoke.spec.ts').not.toBeNull();
  });

  it('accepts an Out player with no projection, with no bracket', () => {
    expect(label(null, true)).toBe('RB: Will Shipley, keep him, out, no projection shown, Out');
    expect(STARTER_FIGURE.test(label(null, true))).toBe(true);
  });

  it('accepts an Out player with a projection, and checks his figure', () => {
    expect(label(10.1, true)).toContain('(10.1 if he played)');
    expect(STARTER_FIGURE.test(label(10.1, true))).toBe(true);
    expect(STARTER_FIGURE.test('RB: X, keep him, out, no projection shown (n/a if he played), Out')).toBe(false);
    expect(STARTER_FIGURE.test('RB: X, keep him, out, no projection shown (if he played), Out')).toBe(false);
  });

  it('still needs "out" alongside the wording', () => {
    expect(STARTER_FIGURE.test('RB: X, keep him, no projection shown, Out')).toBe(false);
    expect(STARTER_FIGURE.test('RB: X, keep him, no projection shown (10.1 if he played)')).toBe(false);
  });

  it('accepts a healthy starter by his projection', () => {
    expect(STARTER_FIGURE.test(label(12.4, false))).toBe(true);
    expect(STARTER_FIGURE.test(label(null, false))).toBe(true);
  });
});
