/**
 * Rain is said in inches an hour, and nothing about it moved.
 *
 * The feed and the thresholds stay in mm/h; only the words convert. So the
 * same rain has to reach the same notes as before (the 2.5 mm/h onset still
 * decides whether rain is mentioned, and rain still scores nothing), while the
 * number on the card is the American one.
 */

import { describe, expect, it } from 'vitest';
import { assessWeather, rainInches, WEATHER } from '../src/core/startsit/weather.ts';

const dry = { indoor: false, windMph: 4, temperatureC: 14 } as const;

describe('rain on the card', () => {
  it('says inches an hour, one decimal', () => {
    expect(rainInches(2.5)).toBe('0.1 in/h');
    expect(rainInches(9)).toBe('0.4 in/h');
    expect(rainInches(25.4)).toBe('1.0 in/h');
    expect(rainInches(40)).toBe('1.6 in/h');
  });

  it('never prints mm', () => {
    const result = assessWeather('WR', 'deep_receiver', { ...dry, precipitationMmPerHour: 9 });
    expect(result.display).toContain('0.4 in/h rain');
    expect(result.display).not.toMatch(/mm/);
  });

  it('mentions rain at exactly the same point as before', () => {
    const below = assessWeather('WR', 'deep_receiver', { ...dry, precipitationMmPerHour: WEATHER.rainOnset - 0.1 });
    const at = assessWeather('WR', 'deep_receiver', { ...dry, precipitationMmPerHour: WEATHER.rainOnset });
    expect(below.display).not.toMatch(/rain/);
    expect(at.display).toMatch(/rain/);
  });

  it('keeps the thresholds in metric', () => {
    expect(WEATHER.rainOnset).toBe(2.5);
    expect(WEATHER.rainFull).toBe(8);
  });

  it('scores the same with or without rain', () => {
    for (const mm of [0, 0.6, 2.5, 9, 40]) {
      expect(assessWeather('WR', 'deep_receiver', { ...dry, precipitationMmPerHour: mm }).points).toBe(
        assessWeather('WR', 'deep_receiver', dry).points,
      );
    }
  });
});
