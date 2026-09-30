/**
 * The number on a Team row, for a player who may not play.
 *
 * Reported 30 September 2026: Nico Collins `OUT` beside a plain 9.9 and RJ
 * Harvey `Q` beside a plain 9.5. See `src/web/rowFigure.ts`.
 */
import { describe, expect, it } from 'vitest';
import { rowFigure, spokenRowFigure } from '../src/web/rowFigure.ts';

const status = (value: number) => [{ key: 'status', value, unknown: false }];

describe('rowFigure', () => {
  it('shows no forecast for a player who is ruled out', () => {
    const f = rowFigure(9.94, { ruledOut: true, statusFlag: 'Out · hamstring · has not practised', components: status(-99) });
    expect(f).toEqual({ kind: 'out', was: 9.94, label: 'Out' });
  });

  it('applies the same charge the score applies to a questionable player', () => {
    const f = rowFigure(9.53, { ruledOut: false, statusFlag: 'Questionable · practised fully', components: status(-1.01) });
    expect(f).toMatchObject({ kind: 'risk', points: 8.52, was: 9.53, charge: -1.01, label: 'Questionable' });
  });

  it('never goes below zero', () => {
    expect(rowFigure(2, { statusFlag: 'Doubtful', components: status(-6) })).toMatchObject({ kind: 'risk', points: 0 });
  });

  it('leaves a healthy player alone', () => {
    expect(rowFigure(13.4, { statusFlag: null, components: status(0) })).toEqual({ kind: 'plain', points: 13.4 });
    expect(rowFigure(13.4, null)).toEqual({ kind: 'plain', points: 13.4 });
  });

  it('keeps an unknown charge out of the figure', () => {
    expect(rowFigure(7, { components: [{ key: 'status', value: -1.5, unknown: true }] })).toEqual({ kind: 'plain', points: 7 });
  });

  it('says both figures out loud', () => {
    const f = rowFigure(9.53, { statusFlag: 'Questionable', components: status(-1.01) });
    expect(spokenRowFigure(f, (p) => `, projected ${p?.toFixed(1)} points`)).toBe(
      ', projected 8.5 points after the questionable discount, 9.5 if he plays',
    );
    const out = rowFigure(9.94, { ruledOut: true, statusFlag: 'Out' });
    expect(spokenRowFigure(out, () => 'unused')).toBe(', out, no projection shown (9.9 if he played)');
  });
});
