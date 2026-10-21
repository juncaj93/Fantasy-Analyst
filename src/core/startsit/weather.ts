/**
 * Weather, applied to the players it actually affects.
 *
 * The instinct — "bad weather, downgrade the game" — is wrong in a specific and
 * measurable way, and this module is built around the correction. Rain does not
 * meaningfully move an NFL offence. Cold does not, at the temperatures a
 * regular season reaches. Snow looks dramatic on television and is mostly
 * neutral. **Wind is the one that matters**, and it does not matter to
 * everybody: it takes yards off a deep passing game and leaves a screen game,
 * a short-area tight end and a running back almost untouched.
 *
 * So there is no generic weather penalty here. There is a wind model with
 * per-role sensitivity, a small precipitation effect that only engages at
 * genuinely heavy rates, and an explicit refusal to penalise cold or snow on
 * their own.
 *
 * ## Honest about precision
 *
 * These thresholds are **assumptions, centralised and tunable**, not fitted
 * coefficients. The shape — wind matters, matters more downfield, and matters
 * to kicking and deep passing before anything else — is well supported by
 * public analysis; the exact numbers are round and conservative on purpose. The
 * component is capped at {@link WEATHER.maxPenaltyPoints}, which is small
 * enough that being wrong about the coefficient cannot flip a lineup on its
 * own.
 *
 * ## Indoors
 *
 * A dome is not a mild day, it is the absence of the question. Indoor games
 * return `unknown: false` with zero points and say so, which is different from
 * having no forecast at all.
 *
 * ## Three states, since October 2026
 *
 * 1. **A real forecast.** Points move only for strong wind or snow, only for
 *    the passing game (quarterbacks, receivers, tight ends) and kickers, and by
 *    at most {@link WEATHER.maxPenaltyPoints}. Rain alone no longer moves
 *    anybody, and a back is no longer paid for his passing game's bad day: the
 *    market prices the run-heavy script into his line already.
 * 2. **Dome or closed roof.** Known, unaffected, and said so.
 * 3. **No forecast yet.** Neutral, and labelled "no forecast yet". This app has
 *    no forecast feed today, so every outdoor game is in this state.
 */

import type { RoleBucket } from './roleProfile.ts';

export const WEATHER = {
  /**
   * Wind speed, in mph, at which passing is affected at all, and where the
   * effect saturates.
   *
   * Below 12 the effect is not distinguishable from noise. Above about 25 the
   * passing game is already as compromised as this model is willing to claim.
   */
  windOnset: 15,
  windFull: 25,
  /**
   * Precipitation, in millimetres per hour, at which the ball is genuinely
   * hard to handle. A drizzle is not weather; 2.5mm/h is a real downpour.
   */
  rainOnset: 2.5,
  rainFull: 8,
  /** The most weather can take off a player, in fantasy points. */
  maxPenaltyPoints: 1,
  /** How much of a full-strength wind effect snow on its own is worth. */
  snowSeverity: 0.4,
  /**
   * The most a running back can *gain* from a passing game being suppressed.
   *
   * Deliberately a third of the penalty. Bad weather shifting an offence toward
   * the run is a real effect and a much weaker one than the effect on passing,
   * and a model that hands out points for rain would be exactly the kind of
   * overreach the rest of this file avoids.
   */
  maxRushBonusPoints: 0.45,
} as const;

/** What a forecast for one game looks like here. Every field may be absent. */
export interface GameWeather {
  /** True when the game is indoors or under a closed roof. */
  indoor: boolean;
  /** Sustained wind, mph. */
  windMph?: number | null;
  /** Gusts, mph. Used only when it is much larger than the sustained speed. */
  gustMph?: number | null;
  /** Precipitation, mm/h. */
  precipitationMmPerHour?: number | null;
  /** Air temperature, °C. */
  temperatureC?: number | null;
  /** True when the precipitation is falling as snow. */
  snow?: boolean | null;
  /** Where the forecast came from, for the card. */
  source?: string | null;
}

/**
 * How much of the wind effect each role feels.
 *
 * A deep passing game is the thing wind actually breaks. Underneath receiving
 * and check-downs survive it; running is barely affected and may benefit from
 * the offence leaning that way.
 */
const WIND_SENSITIVITY: Record<string, number> = {
  deep_receiver: 1,
  intermediate_receiver: 0.6,
  underneath_receiver: 0.3,
  receiving_back: 0,
  dual_threat_back: 0,
  rushing_back: 0,
  pocket_quarterback: 0.8,
  rushing_quarterback: 0.5,
};

const POSITION_WIND_SENSITIVITY: Record<string, number> = {
  QB: 0.7,
  WR: 0.6,
  TE: 0.4,
  RB: 0,
  K: 1,
};

export interface WeatherAssessment {
  points: number;
  unknown: boolean;
  /** True when the game is indoors, which is a fact rather than an absence. */
  indoor: boolean;
  display: string;
  driver: string | null;
}

export const NO_WEATHER: WeatherAssessment = {
  points: 0,
  unknown: true,
  indoor: false,
  display: 'no forecast yet',
  driver: null,
};

export function assessWeather(
  position: string,
  bucket: RoleBucket,
  weather: GameWeather | null | undefined,
): WeatherAssessment {
  if (!weather) return NO_WEATHER;
  if (weather.indoor) {
    return {
      points: 0,
      unknown: false,
      indoor: true,
      display: 'dome or closed roof, weather does not apply',
      driver: null,
    };
  }

  const wind = effectiveWind(weather);
  const rain = weather.precipitationMmPerHour ?? null;
  const temperature = weather.temperatureC ?? null;
  if (wind == null && rain == null && temperature == null) return NO_WEATHER;

  const sensitivity =
    WIND_SENSITIVITY[bucket] ?? POSITION_WIND_SENSITIVITY[position.toUpperCase()] ?? 0;

  /*
   * Strong wind or snow, and nothing else. Rain is described but never
   * scored: the market reads a wet forecast at least as well as this could.
   */
  const windSeverity = wind == null ? 0 : ramp(wind, WEATHER.windOnset, WEATHER.windFull);
  const severity = Math.min(1, windSeverity + (weather.snow ? WEATHER.snowSeverity : 0));
  const description = describeConditions(wind, rain, temperature, weather.snow ?? false) || 'nothing that affects play';
  if (severity <= 0 || sensitivity <= 0) {
    return { points: 0, unknown: false, indoor: false, display: description, driver: null };
  }

  const points = round2(-Math.min(severity * sensitivity, 1) * WEATHER.maxPenaltyPoints);
  return {
    points,
    unknown: false,
    indoor: false,
    display: description,
    driver: driverOf(points, wind, rain, weather.snow ?? false),
  };
}

function effectiveWind(weather: GameWeather): number | null {
  const sustained = weather.windMph ?? null;
  const gust = weather.gustMph ?? null;
  if (sustained == null) return gust == null ? null : round1(gust * 0.7);
  if (gust == null || gust <= sustained) return sustained;
  return round1(sustained + (gust - sustained) * 0.4);
}

/** 0 below onset, 1 at full, linear between. */
function ramp(value: number, onset: number, full: number): number {
  if (!Number.isFinite(value) || full <= onset) return 0;
  return Math.min(1, Math.max(0, (value - onset) / (full - onset)));
}

/**
 * The conditions, said plainly — including when they are unremarkable.
 *
 * Cold and snow appear here and nowhere else in the module: they are worth
 * telling somebody about and they do not change the score. That separation is
 * the whole point. "18°F and snowing" is information; a penalty for it would be
 * a claim this app cannot support.
 */
function describeConditions(
  wind: number | null,
  rain: number | null,
  temperatureC: number | null,
  snow: boolean,
): string {
  const bits: string[] = [];
  if (wind != null) bits.push(`${Math.round(wind)} mph wind`);
  if (snow) bits.push('snow');
  else if (rain != null && rain >= WEATHER.rainOnset) bits.push(`${rain.toFixed(1)} mm/h rain`);
  if (temperatureC != null && temperatureC <= 0) bits.push(`${Math.round(temperatureC)}°C`);
  return bits.join(' · ');
}

function driverOf(points: number, wind: number | null, rain: number | null, snow: boolean): string | null {
  if (Math.abs(points) < 0.3) return null;
  const cause = wind != null && wind >= WEATHER.windOnset ? `${Math.round(wind)} mph wind` : snow ? 'snow' : `${(rain ?? 0).toFixed(1)} mm/h rain`;
  return points < 0 ? `Wind-sensitive role · ${cause}` : `Weather pushes this offense toward the run · ${cause}`;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
