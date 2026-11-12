/**
 * Round 18 follow-up: why the app week read what it read. Read-only, a few dozen rows.
 *
 *   node --experimental-transform-types --no-warnings scripts/round18-weekdiag.ts
 */
import { d1Http } from './lib/d1Http.ts';
import { SETTING_KEYS, SettingsRepo } from '../src/server/repos/settings.ts';
import { readAppNflState, lastKickoffOf } from '../src/server/services/appWeek.ts';
import { rolloverAt } from '../src/core/season/appWeek.ts';

const db = await d1Http();
const state = await new SettingsRepo(db).get<Record<string, unknown> | null>(SETTING_KEYS.nflState, null);
console.log(`stored state: ${JSON.stringify(state)}`);
const season = String(state?.season ?? '');
const week = Number(state?.week ?? 0);
const rows = (
  await db
    .prepare(
      'SELECT week, typeof(season) AS st, COUNT(*) AS n, COUNT(kickoff) AS k, MIN(kickoff) AS first, MAX(kickoff) AS last FROM nfl_schedule WHERE week IN (?, ?) GROUP BY week, typeof(season)',
    )
    .bind(week, week + 1)
    .all<Record<string, unknown>>()
).results;
for (const r of rows) console.log(`schedule: ${JSON.stringify(r)}`);
const last = await lastKickoffOf(db, season, week);
console.log(`lastKickoffOf(${season}, ${week}) = ${last}`);
const at = rolloverAt({ sleeperWeek: week, seasonType: String(state?.seasonType ?? ''), lastKickoff: last });
console.log(`rolloverAt = ${at == null ? 'null' : new Date(at).toISOString()}`);
const app = await readAppNflState(db);
console.log(`readAppNflState: week ${app?.week}, sleeperWeek ${app?.sleeperWeek}`);
console.log(`week diag rows read: ${db.rowsRead()}`);
