/**
 * The game he is walking into: script, and weather.
 *
 * Both modules exist to *not* do the obvious thing. Game script must not treat
 * being an underdog as bad for a receiver, and weather must not apply a generic
 * penalty to everybody in the rain. Those two negatives are most of this file.
 */

import { describe, expect, it } from 'vitest';
import { GAME_SCRIPT, assessGameScript } from '../src/core/startsit/gameScript.ts';
import { WEATHER, assessWeather, type GameWeather } from '../src/core/startsit/weather.ts';

describe('game script', () => {
  it('is unknown, not neutral, with no lines at all', () => {
    const result = assessGameScript('RB', 'rushing_back', { spread: null, total: null });
    expect(result.unknown).toBe(true);
    expect(result.points).toBe(0);
  });

  it('implies a team total from the spread and the total', () => {
    const favourite = assessGameScript('RB', 'rushing_back', { spread: -7, total: 47 });
    expect(favourite.impliedTeamTotal).toBe(27);
    const underdog = assessGameScript('WR', 'deep_receiver', { spread: 7, total: 47 });
    expect(underdog.impliedTeamTotal).toBe(20);
  });

  it('helps a rushing back who is favoured', () => {
    const favoured = assessGameScript('RB', 'rushing_back', { spread: -8, total: 45 });
    const trailing = assessGameScript('RB', 'rushing_back', { spread: 8, total: 45 });
    expect(favoured.points).toBeGreaterThan(trailing.points);
  });

  it('reads trailing as better for a receiver than for a rushing back', () => {
    /*
     * The claim the model actually makes, and the one worth protecting.
     *
     * Both players are on the same underdog offence, so both carry the same
     * (lower) implied team total — being an underdog is not *good*, and a model
     * that said otherwise would be wrong. What differs is the script: trailing
     * means throwing, so the receiver gives up less of that environment than
     * the back does, and the two must not move together.
     */
    const game = { spread: 8, total: 45 };
    const receiver = assessGameScript('WR', 'intermediate_receiver', game);
    const back = assessGameScript('RB', 'rushing_back', game);
    expect(receiver.points).toBeGreaterThan(back.points);

    // And the other way round when the same offence is favoured.
    const leading = { spread: -8, total: 45 };
    expect(assessGameScript('RB', 'rushing_back', leading).points).toBeGreaterThan(
      assessGameScript('WR', 'intermediate_receiver', leading).points,
    );
  });

  it('leaves a receiving back nearly indifferent to the script', () => {
    // He is on the field on passing downs and on early downs, so the spread
    // moves him much less than it moves a two-down back.
    const swing = (bucket: 'receiving_back' | 'rushing_back') =>
      Math.abs(
        assessGameScript('RB', bucket, { spread: 9, total: 45 }).points -
          assessGameScript('RB', bucket, { spread: -9, total: 45 }).points,
      );
    expect(swing('receiving_back')).toBeLessThan(swing('rushing_back') / 2);
  });

  it('treats a rushing quarterback differently from a pocket one', () => {
    const runner = assessGameScript('QB', 'rushing_quarterback', { spread: -9, total: 45 });
    const passer = assessGameScript('QB', 'pocket_quarterback', { spread: -9, total: 45 });
    expect(runner.points).toBeGreaterThan(passer.points);
  });

  it('lets the environment outweigh the script', () => {
    // A back in a 55-point game he is favoured in, against a back in a
    // 33-point game he is favoured in by the same margin.
    const shootout = assessGameScript('RB', 'rushing_back', { spread: -3, total: 55 });
    const slog = assessGameScript('RB', 'rushing_back', { spread: -3, total: 33 });
    expect(shootout.points).toBeGreaterThan(slog.points);
  });

  it('stays inside its cap', () => {
    for (const spread of [-21, 21]) {
      for (const total of [28, 62]) {
        const result = assessGameScript('WR', 'deep_receiver', { spread, total });
        expect(Math.abs(result.points)).toBeLessThanOrEqual(GAME_SCRIPT.maxPoints);
      }
    }
  });

  it('works from a total alone, and from a spread alone', () => {
    expect(assessGameScript('WR', 'deep_receiver', { spread: null, total: 54 }).unknown).toBe(false);
    expect(assessGameScript('WR', 'deep_receiver', { spread: -7, total: null }).unknown).toBe(false);
  });
});

describe('weather', () => {
  const calm: GameWeather = { indoor: false, windMph: 4, precipitationMmPerHour: 0, temperatureC: 14 };
  const windy: GameWeather = { indoor: false, windMph: 24, precipitationMmPerHour: 0, temperatureC: 8 };
  const downpour: GameWeather = { indoor: false, windMph: 6, precipitationMmPerHour: 9, temperatureC: 12 };
  const snowing: GameWeather = { indoor: false, windMph: 6, precipitationMmPerHour: 5, temperatureC: -3, snow: true };
  const freezing: GameWeather = { indoor: false, windMph: 5, precipitationMmPerHour: 0, temperatureC: -14 };

  it('does nothing on a calm day', () => {
    expect(assessWeather('WR', 'deep_receiver', calm).points).toBe(0);
  });

  it('is a fact rather than an absence indoors', () => {
    const result = assessWeather('WR', 'deep_receiver', { indoor: true });
    expect(result.unknown).toBe(false);
    expect(result.indoor).toBe(true);
    expect(result.points).toBe(0);
  });

  it('is unknown with no forecast', () => {
    expect(assessWeather('WR', 'deep_receiver', null).unknown).toBe(true);
  });

  it('hurts a downfield receiver in strong wind and barely touches an underneath one', () => {
    const deep = assessWeather('WR', 'deep_receiver', windy).points;
    const underneath = assessWeather('WR', 'underneath_receiver', windy).points;
    expect(deep).toBeLessThan(0);
    expect(underneath).toBeGreaterThan(deep);
    expect(Math.abs(underneath)).toBeLessThan(Math.abs(deep));
  });

  it('does not penalise a running back in the wind', () => {
    expect(assessWeather('RB', 'rushing_back', windy).points).toBeGreaterThanOrEqual(0);
  });

  it('keeps any rushing benefit far smaller than the passing penalty', () => {
    const back = assessWeather('RB', 'rushing_back', windy).points;
    expect(back).toBeLessThanOrEqual(WEATHER.maxRushBonusPoints);
  });

  it('ignores a drizzle and notices a downpour', () => {
    const drizzle = assessWeather('WR', 'deep_receiver', { indoor: false, precipitationMmPerHour: 0.6 });
    expect(drizzle.points).toBe(0);
    expect(assessWeather('WR', 'deep_receiver', downpour).points).toBeLessThan(0);
  });

  it('does not downgrade an offence for snow on its own', () => {
    const result = assessWeather('WR', 'intermediate_receiver', snowing);
    expect(result.points).toBe(0);
    expect(result.display).toContain('snow');
  });

  it('does not penalise extreme cold, and still reports it', () => {
    const result = assessWeather('QB', 'pocket_quarterback', freezing);
    expect(result.points).toBe(0);
    expect(result.display).toContain('°C');
  });

  it('reads gusts as part of the wind without letting them dominate', () => {
    const steady = assessWeather('QB', 'pocket_quarterback', { indoor: false, windMph: 14 }).points;
    const gusting = assessWeather('QB', 'pocket_quarterback', { indoor: false, windMph: 14, gustMph: 34 }).points;
    const asIfSteady = assessWeather('QB', 'pocket_quarterback', { indoor: false, windMph: 34 }).points;
    expect(gusting).toBeLessThan(steady);
    expect(gusting).toBeGreaterThan(asIfSteady);
  });

  it('stays inside its cap in the worst weather it will ever see', () => {
    const storm: GameWeather = { indoor: false, windMph: 55, gustMph: 80, precipitationMmPerHour: 40 };
    for (const bucket of ['deep_receiver', 'rushing_back', 'pocket_quarterback'] as const) {
      const points = assessWeather('WR', bucket, storm).points;
      expect(points).toBeGreaterThanOrEqual(-WEATHER.maxPenaltyPoints);
      expect(points).toBeLessThanOrEqual(WEATHER.maxRushBonusPoints);
    }
  });
});
