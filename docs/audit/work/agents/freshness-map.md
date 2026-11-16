# Fantasy Analyst: input freshness map

Read-only review of main 101ad32 (branch claude/new-session-xlfaay), done 16 Nov 2026. No repo file was changed by this review. While it ran, someone else committed 259ca86 and 092be93 to the branch. Those commits touch only scripts/probe-round29*.{mjs,ts} and .github/workflows/probe.yml; no src or migrations file changed, so everything below holds for HEAD too. Nothing contacted the live site, D1 or Cloudflare. Three scratch probes ran the repo's own pure functions (clock, cadence, injury rules) on this machine; their scripts are in `scratchpad/probe/`.

**Conventions.** Times are Eastern Standard (UTC-5 since 1 Nov), so cron 09:00 UTC = 4:00 AM, Sat 23:00 UTC = Sat 6:00 PM, Sun 15:00 UTC = Sun 10:00 AM. Worked example: week 11. The app week rolls Tue 17 Nov 3:00 AM (core/season/appWeek.ts:29-32, 58-66; probe confirmed). Games: TNF Thu 19 Nov 8:15 PM, Sunday 22 Nov 1:00 PM, MNF Mon 23 Nov 8:15 PM. File paths are under `src/` unless shown otherwise.

**Odds sources.** SportsGameOdds is live (wrangler.toml:55). TheRundown and The Odds API run only if their secrets were published (.github/workflows/release.yml:245-256). A TheRundown key check is recorded for 12 Nov (docs/VEGAS.md:615). To confirm, read settings `vegas.extraSources` (S1).

**What opening the app does.** It fetches nothing from upstream. Screens read stored rows. On open, and again on return from the background, Team, Matchup, Waivers and Data health only read the last refresh-job row (web/serverRefresh.ts:90-93, 112-124). The only on-demand fetch is a tap or pull: POST /api/refresh (server/app.ts:3522-3530). The older POST /api/startsit/refresh (app.ts:3495-3501) has no caller in web/.

---

## 1. Refresh map

### 1a. What refreshes each input, and when

| # | Input | Refreshed by | Schedule (ET) | Conditions and caps |
|---|---|---|---|---|
| V1 | Player props and game total/spread from SportsGameOdds, one game at a time | Kickoff clock on the 5-min tick (worker/index.ts:548-559; server/services/vegasKickoffClock.ts:109-178). The tap's Vegas step (refreshJob.ts:371-389) | Looks at 120, 96, 72, 48, 24, 6, 3, 1.5 and 0.5 h before each game's own kickoff (core/vegas/kickoffClock.ts:68; the 120/96/72 looks are Round 23, d6a8bbc). **Sun 1 PM game:** Tue to Sat 1:00 PM, then Sun 7:00 AM, 10:00 AM, 11:30 AM, 12:30 PM. **TNF:** first seen Sun afternoon by discovery, then Sun to Wed 8:15 PM, Thu 2:15, 5:15, 6:45, 7:45 PM. **MNF:** Wed to Sun 8:15 PM, Mon 2:15, 5:15, 6:45, 7:45 PM | Covers only games with a player from Alex's roster, the opponent's starters, or 8 trending adds (vegasRefresh.ts:976-1054). A game is bought only when a checkpoint has passed since its last look and the look is older than 6 h, 1 h or 15 min, depending on time to kickoff (kickoffClock.ts:139-155; staleness.ts:16-22). A team is discovered only once its next game is within 120 h (vegasRefresh.ts:524-534). At most 9 games per pass, at 10 requests a minute. Leftover games are retried every 10 min, up to 6 times (budget.ts:54; vegasKickoffClock.ts:52-55, 153). The monthly cap is 2,500 games: the low tier pauses at 50%, only critical passes run from 70%, and the reserve opens at 85% (budget.ts:36-38, 181-186). The clock skips nflverse ticks and league-read ticks and catches up 5 min later (index.ts:548) |
| V2 | Game total/spread from TheRundown, if its key is set | Runs at the end of every Vegas pass and whenever the odds gate wakes (extraOddsSources.ts:133-180; vegasKickoffClock.ts:121-137) | Hourly while any tracked game is within 48 h, otherwise every 3 h (extraOddsSources.ts:51-56, 142) | Only games already in vegas_events (extraOddsSources.ts:140). Asks for 3 Eastern dates per call. Capped at 6,000 points per UTC day, which resets at 7 PM ET (extraOddsSources.ts:62, 150-156). The game row is written only when the combined line moves (gameBooks.ts:143-156) |
| V3 | Whole-slate game lines and a Friday props top-up from The Odds API, if its key is set | Same as V2 | Lines every 8 h. Props once on Friday from 9 AM, for up to 8 tracked games within 4 days (extraOddsSources.ts:55, 188, 252-256) | Stops for good at 60 credits or fewer (extraOddsSources.ts:65, 189). The odds clock ignores top-up looks when it ages a game (props.ts:39-47, 483-504), but the screens' freshness line counts them (props.ts:521-538) |
| I1 | Injury report: nflverse injuries_2026.csv | 5-min tick (index.ts:327-343). The 4 AM daily tick (index.ts:773-780). A tap, if the last check is more than 3 min old (refreshJob.ts:345-359) | Checked every 5 min. The file itself changed at about 2 AM and 9 to 10:30 AM (measured 5-13 Nov, docs/inactives/README.md:22-27). The NFL posts reports at about 4 PM on practice days: Wed to Fri for Sunday games, Mon to Wed for TNF, Thu to Sat for MNF. That timing is league custom and was not measured here | A 304 answer skips the parse. Only the latest week is read (core/injury/nflverse.ts:130). Guards: an anomaly check and a cap of 5,000 writes per UTC day (injuryService.ts:567-603), plus a 120 s lease. The file never carries game-day inactives (README.md:18) |
| I2 | Sleeper player list: injury_status (or roster status when there is none), team, depth order, notes | The 09:00 UTC daily tick, Mon to Sat (index.ts:674-680). Sunday slots on the 5-min tick (index.ts:357-368). Setup's "Update player list" button (web/screens/SetupScreen.tsx:1658) | Mon to Sat 4:00 AM. Sun 12:15 PM, with retries at 12:30 and 12:45 PM only if nothing has succeeded that day (playerListClock.ts:41, 61-79) | One download per Eastern date. No same-day retry Mon to Sat. Not part of either refresh job (refreshJob.ts:323-331) |
| I3 | Game-day inactives | Nothing new was built (docs/inactives/README.md:8-10, 118-131). The only change was the Sunday download moving from 11:45 AM to 12:15 PM (415c5a0) | Seen only through I2 at Sun 12:15 PM. Sleeper marks inactive players Out 20 to 35 min after the ~11:30 AM announcement (README.md:31-42) | 4 PM, Sunday night, Monday night, Thursday, Saturday and 9:30 AM London games are never seen before kickoff (playerListClock.ts:31-33) |
| R1 | Rosters, Sleeper's lineup (starters), users, drafts, NFL week | 5-min tick every 3 h at :15 UTC (league/waiverReadCadence.ts:18-26; index.ts:486-526). The 4 AM daily tick (index.ts:733-738). A tap, if older than 2 min (refreshJob.ts:135-144, 334-342) | 1:15, 4:15, 7:15 and 10:15, AM and PM, plus 4:00 AM | Skipped on nflverse ticks (index.ts:486). Every league read also refreshes the NFL week (sleeperSync.ts:159) |
| P1 | Sleeper weekly projections (Rotowire) | A step on the 4 AM daily tick (index.ts:932-934). The Sat 6 PM and Sun 10 AM crons (index.ts:1034-1036). A Waivers pull (refreshJob.ts:449-456) | Daily 4:00 AM, plus Sat 6:00 PM and Sun 10:00 AM. That is daily, not only twice a week | Refetched only when older than 12 h, when the last fetch was a sliver, or when defences or QB lines are missing (sleeperProjectionService.ts:54, 147-174). On Tue and Wed it fetches both Sleeper's week and the app week (index.ts:1308-1318). The Team refresh does not ask for projections (refreshJob.ts:323-331; 571714e) |
| K1 | Kickoffs and byes: nflverse games.csv, stored in nfl_schedule | refreshIfDue on the 5-min tick (index.ts:424-443). A floor on the 4 AM tick (index.ts:874-900). A tap, if older than 6 h (refreshJob.ts:392-403) | About 24 h after the last check (scheduleService.ts:88, 152-176), plus flex checks Tue 9 PM, Wed 9 AM and Wed 3 PM (nfl/flexCheck.ts:35-39) | Skipped on nflverse ticks. A moved kickoff resets the odds gate (scheduleService.ts:360) |
| D1 | Depth charts (nflverse) and Sleeper's depth order | 5-min tick windows (nflverse/cadence.ts:55-62). Sleeper's order arrives with I2 (sleeperSync.ts:52-56) | nflverse roster 4:30, depth chart 4:35, snaps 4:40, each AM and PM | Waivers reads it (decisionInputs.ts:632-633, 870-877). The start/sit score does not |
| U1 | Usage: nflverse stats_player_week | A step on the 4 AM daily tick (index.ts:802-813) | 4:00 AM | Conditional GET, one catch-up week per run, 2,000 writes a day (usageService.ts:160). Not part of any refresh job |

### 1b. Where the last fetch is recorded, and the index that makes it cheap

| # | Recorded in (table.column or settings key) | Index used | SQL |
|---|---|---|---|
| V1 | `prop_snapshots.fetched_at`. One row per look, written even when no line changed (lookStore.ts:72-96). Settings `vegas.clock`: the gate, with next, processedThrough and last {at, fetched, spent, leftover, note}. Settings `vegas.lastRefresh`: the last pass of any kind (vegasRefresh.ts:357) | idx_prop_snapshots_event (event_id, fetched_at DESC), 0001:232. idx_prop_snapshots_scope (scope, fetched_at DESC), 0008:20. settings PK | S1-S4 |
| V2 | Settings `vegas.extraSources`: rundown.lastAt, outcome, points. Per-book times are inside `vegas.gameBooks`. `vegas_events.lines_seen_at` records the last *change* of the combined line, not the last fetch (vegasEvents.ts:52-55, 80) | settings PK. idx_vegas_events_kickoff, 0010:60 | S1, S2 |
| V3 | `vegas.extraSources`: oddsApi.linesAt, propsWeek, remaining. Top-up looks are `prop_snapshots` rows with provider `the-odds-api` and `$.topUp` set | Same as V1 | S1, S3 |
| Budget | `vegas_usage`: month is the billing key, '2026-11' for 13 Nov to 12 Dec; read provider_entities and provider_read_at. `vegas_usage_log`: month is the calendar month | vegas_usage PK. idx_vegas_usage_log_month (month, at DESC), 0010:42 | S5 |
| I1 | `injury_source_state`: checked_at (moves every 5 min), source_modified_at (the file's Last-Modified), ingested_at, consecutive_failures. `injury_source_runs` gets rows only for non-304 outcomes. `injury_events` gets one row per change | PK (source, season), 0013. idx_injury_source_runs_latest, 0037:31. idx_injury_events_recent, 0038:22 | S6 |
| I2/I3 | Settings `sleeper.players.lastSuccessAt`. `sync_log` rows with kind 'players' (ok and error). `players.updated_at` is when that player's row last *changed* (players.ts:515-536), so it shows when a status flipped | settings PK. idx_sync_log_kind (kind, started_at DESC), 0001:267. players PK | S7 |
| R1 | `sync_log` rows with kind 'league', ok only: a failed read logs nothing (sleeperSync.ts:141-161). `leagues.last_synced_at`. `rosters.updated_at` moves only when rosters changed (league.ts:94-104). `sleeper.nflState` fetchedAt. `refresh.job.startsit` checked.roster | Same as I2. rosters PK prefix | S8 |
| P1 | `sleeper_weekly_projections.fetched_at`; every row is rewritten on each fetch (sleeperProjections.ts:112-147). Settings `sleeper.qbLines.<season>.<week>` updated_at | PK (season, week, player_id), 0028. settings PK | S9 |
| K1, D1 | `nflverse_source_state` rows for 'nflverse_schedule', 'nflverse_roster', 'nflverse_depth' and 'nflverse_snaps'. `nflverse_source_runs`. `nfl_schedule.fetched_at`. Settings `sleeper.playerNotes` | PK (source, season), 0030. idx_nflverse_source_runs_fetched (source, fetched_at DESC), 0030:211. nfl_schedule PK | S10 |
| U1 | `usage_source_state` (source 'nflverse'). `usage_source_runs` | PK. idx_usage_source_runs_latest, 0037:34 | S11 |
| Runs | `cron_run_state`: one row per cron, 3 rows. The 5-min tick is never recorded (0033:29). Settings `refresh.job.startsit` and `refresh.job.waivers` | PK | S12 |

```sql
-- S1  Odds gate, last pass, extra sources, the screens' odds stamp: settings PK, 6 rows
SELECT key, updated_at, value_json FROM settings
 WHERE key IN ('vegas.clock','vegas.lastRefresh','vegas.lastSchedule','vegas.extraSources',
               'props.week.stamp','props.week.freshness');
SELECT key, updated_at FROM settings WHERE key = 'vegas.gameBooks';  -- ~15 KB value: read the stamp only

-- S2  This week's tracked games and when each combined line last moved (idx_vegas_events_kickoff)
SELECT event_id, kickoff, home_team, away_team, game_total, spread, spread_team, lines_seen_at, seen_at
  FROM vegas_events
 WHERE kickoff >= '2026-11-19T00:00:00Z' AND kickoff < '2026-11-25T00:00:00Z'
 ORDER BY kickoff;

-- S3  Looks at one game, newest first (idx_prop_snapshots_event), at most 5 rows
SELECT provider, fetched_at,
       json_extract(raw_json, '$.topUp') AS top_up, json_extract(raw_json, '$.delta') AS delta
  FROM prop_snapshots
 WHERE event_id = :event_id AND scope = 'week'
 ORDER BY fetched_at DESC LIMIT 5;

-- S4  Newest look at any game: the number Setup and Data health print (idx_prop_snapshots_scope)
SELECT event_id, provider, fetched_at FROM prop_snapshots
 WHERE scope = 'week' ORDER BY fetched_at DESC LIMIT 1;

-- S5  Odds budget, period 13 Nov to 12 Dec (vegas_usage PK; idx_vegas_usage_log_month)
SELECT month, entities, provider_entities, provider_limit, provider_read_at, updated_at
  FROM vegas_usage WHERE month = '2026-11';
SELECT at, source, event_id, entities, requests, outcome, reason
  FROM vegas_usage_log WHERE month = '2026-11' ORDER BY at DESC LIMIT 20;  -- spot 'blocked'/'refused' here

-- S6  Injury report (PK; idx_injury_source_runs_latest; idx_injury_events_recent; PK; PK)
SELECT checked_at, source_modified_at, ingested_at, last_outcome, last_note,
       consecutive_failures, failing_since, caught_up_through
  FROM injury_source_state WHERE source = 'nflverse' AND season = '2026';
SELECT fetched_at, published_at, latest_week, rows_returned, outcome, note
  FROM injury_source_runs ORDER BY fetched_at DESC, id DESC LIMIT 5;
SELECT player_id, week, kind, from_value, to_value, detected_at
  FROM injury_events ORDER BY detected_at DESC, event_key DESC LIMIT 10;
SELECT day, rows_written, updated_at FROM injury_write_budget WHERE day = '2026-11-22';
SELECT player_id, week, report_status, practice_status, published_at, fetched_at
  FROM player_injury_reports WHERE player_id IN (:roster_ids) AND season = '2026' AND week >= 10;

-- S7  Sleeper player list (settings PK; idx_sync_log_kind; players PK)
SELECT value_json AS last_success_at, updated_at FROM settings WHERE key = 'sleeper.players.lastSuccessAt';
SELECT status, detail, started_at, finished_at FROM sync_log
 WHERE kind = 'players' ORDER BY started_at DESC LIMIT 5;  -- Sunday rows should start near 17:15Z
SELECT id, full_name, status, updated_at FROM players WHERE id IN (:roster_ids);

-- S8  Rosters and NFL week (idx_sync_log_kind; leagues holds a handful of rows; settings PK)
SELECT status, detail, started_at, finished_at FROM sync_log
 WHERE kind = 'league' ORDER BY started_at DESC LIMIT 5;
SELECT id, last_synced_at FROM leagues WHERE is_selected = 1;
SELECT key, updated_at, value_json FROM settings
 WHERE key IN ('sleeper.nflState','refresh.job.startsit','refresh.job.waivers');

-- S9  Projections (settings PK; table PK)
SELECT key, updated_at, json_extract(value_json, '$.fetchedAt') AS fetched_at
  FROM settings WHERE key IN ('sleeper.qbLines.2026.11','sleeper.qbLines.2026.12');
SELECT fetched_at FROM sleeper_weekly_projections
 WHERE season = '2026' AND week = 11 AND player_id = :one_rostered_id;

-- S10 Schedule, depth chart, nflverse roster, snaps (PK; idx_nflverse_source_runs_fetched; nfl_schedule PK)
SELECT source, checked_at, source_modified_at, ingested_at, last_outcome, consecutive_failures
  FROM nflverse_source_state
 WHERE season = '2026' AND source IN ('nflverse_schedule','nflverse_roster','nflverse_depth','nflverse_snaps');
SELECT fetched_at, outcome, rows_written FROM nflverse_source_runs
 WHERE source = 'nflverse_depth' ORDER BY fetched_at DESC LIMIT 3;
SELECT team, opponent, kickoff, fetched_at FROM nfl_schedule
 WHERE season = '2026' AND week = 11 AND team IN (:teams);
SELECT key, updated_at FROM settings WHERE key = 'sleeper.playerNotes';

-- S11 Usage (PK; idx_usage_source_runs_latest)
SELECT checked_at, source_modified_at, ingested_at, last_outcome, caught_up_through, consecutive_failures
  FROM usage_source_state WHERE source = 'nflverse' AND season = '2026';
SELECT fetched_at, week, latest_week, rows_written, outcome FROM usage_source_runs
 ORDER BY fetched_at DESC, id DESC LIMIT 3;

-- S12 Run records (3 rows) and the odds waiver tier (idx_trending_snapshots_captured)
SELECT cron, started_at, finished_at, outcome, last_success_at, budget_used, budget_limit, steps_json
  FROM cron_run_state;
SELECT captured_at FROM trending_snapshots WHERE trend_type = 'add' ORDER BY captured_at DESC LIMIT 1;
```

**Queries to avoid, because they scan.**
- `MAX(seen_at) FROM vegas_events`: seen_at has no index (vegasEvents.ts:185-190).
- `MAX` or `COUNT(DISTINCT event_id)` over prop_snapshots without `scope` and `LIMIT`: about 750 rows (props.ts:521-527).
- `MAX(fetched_at) FROM sleeper_weekly_projections WHERE season=? AND week=?`: reads the whole week, about 400 rows.
- `sync_log ... ORDER BY id DESC`: sorts every row of that kind (settings.ts:62).
- `nfl_schedule` filtered by a kickoff range: no index covers it (vegasKickoffClock.ts:256-259).

**Expected look times in S3 (UTC).**
- **Sun 1 PM game:** 18:00Z Tue to Sat, then 12:00Z, 15:00Z, 16:30Z and 17:30Z Sun.
- **TNF:** 01:15Z Mon to Thu, then 19:15Z, 22:15Z and 23:45Z Thu, and 00:45Z Fri. There is also a discovery look on Sun after the team's week-10 kickoff. The Mon 01:15Z look is skipped if that discovery was under 6 h earlier.
- **MNF:** 01:15Z Thu to Mon, then 19:15Z, 22:15Z and 23:45Z Mon, and 00:45Z Tue.
- **Slippage:** allow +5 min when a checkpoint lands on a league-read or nflverse tick, and +10 min steps for leftover games.

---

## 2. Expected age at Alex's decision moments

These ages assume every scheduled run lands and nobody taps Refresh.

**A. Sunday 1:00 PM game (22 Nov)**

| Input | Tue 9 PM | Thu 6 PM | Sat noon | Sun 11 AM | Sun 12:45 PM |
|---|---|---|---|---|---|
| Props, total, spread (SportsGameOdds look) | 8 h: the Tue 1 PM first look. Sunday props are often not posted yet (docs/vegas/ROUND21_SOURCES.md:103-105) | 5 h (Thu 1 PM) | **23 h** (Fri 1 PM; next look Sat 1 PM) | 1 h (10 AM) | 15 min (12:30 PM), or 5 min if the game spilled into the 12:40 retry |
| Total/spread from TheRundown (if key) | 1 h or less (3 h or less if no tracked game is within 48 h) | 1 h or less | 1 h or less | 1 h or less | 1 h or less |
| Injury report content | Last week's final rows. The first Wednesday report has not posted yet | Wednesday's practice report (arrived ~Thu 2 AM). Thursday's arrives ~Fri 2 AM | Friday's final designations (arrived ~Sat 2 AM, ~10 h after release) | Friday's final, plus any Saturday change picked up at 2 AM or 9-10:30 AM | Same. Inactives never appear in this file |
| Sleeper statuses | 17 h (Tue 4 AM) | 14 h (Thu 4 AM) | 8 h (Sat 4 AM) | **31 h** (Sat 4 AM; there is no Sunday 4 AM download) | 30 min (12:15 PM). Includes 1 PM inactives if Sleeper had caught up |
| Projections | 17 h (Tue 4 AM, the first week-11 fetch) | 14 h | 8 h | 1 h (Sun 10 AM) | 2 h 45 min (nothing runs after 10 AM) |
| Roster and lineup | 1 h 45 min (7:15 PM read) | 1 h 45 min (4:15 PM) | 1 h 45 min (10:15 AM) | 45 min (10:15 AM) | **2 h 30 min** (10:15 AM; the next read, 1:15 PM, is after lock) |

**B. Thursday night game (19 Nov 8:15 PM).** By Sat noon and Sun 11 AM this game has been played.

| Input | Tue 9 PM | Thu 6 PM | Thu 8:00 PM |
|---|---|---|---|
| Props, total, spread | 45 min (Tue 8:15 PM) | 45 min (5:15 PM) | 15 min (7:45 PM) |
| TheRundown | 1 h or less | 1 h or less | 1 h or less |
| Injury report content | Monday's report (~Tue 2 AM). Tuesday's arrives ~Wed 2 AM | Wednesday's final designations (~Thu 2 AM) | Same. The ~6:45 PM inactives never appear |
| Sleeper statuses | 17 h | 14 h | **16 h** (Thu 4 AM; inactives missed) |
| Projections | 17 h | 14 h | 16 h (Thu 4 AM) |
| Roster | 1 h 45 min | 1 h 45 min | 45 min (7:15 PM) |

**C. Monday night game (23 Nov 8:15 PM)**

| Input | Tue 9 PM | Thu 6 PM | Sat noon | Sun 11 AM | Mon 8:00 PM |
|---|---|---|---|---|---|
| Props, total, spread | **None.** The first look is Wed 8:15 PM (120 h), so the rows read "No line yet" | 21 h 45 min (Wed 8:15 PM) | 15 h 45 min (Fri 8:15 PM) | 14 h 45 min (Sat 8:15 PM) | 15 min (7:45 PM) |
| TheRundown | None (the game is not tracked yet) | 1 h or less | 1 h or less | 1 h or less | 1 h or less |
| Injury report content | Last week's final rows | Still last week's. The first week-11 report posts Thu ~4 PM and arrives ~Fri 2 AM | Thursday's and Friday's practice reports | Saturday's final designations (~Sun 2 AM) | Same. The ~6:45 PM inactives never appear |
| Sleeper statuses | 17 h | 14 h | 8 h | 31 h | **16 h** (Mon 4 AM; inactives missed) |
| Projections | 17 h | 14 h | 8 h | 1 h | 16 h (Mon 4 AM) |
| Roster | 1 h 45 min | 1 h 45 min | 1 h 45 min | 45 min | 45 min (7:15 PM) |

**Other Sunday games, at 15 minutes before kickoff.**
- **4:25 PM game, at 4:10 PM:** props 15 min old; Sleeper 3 h 55 min (the ~2:55 PM inactives are missed); projections 6 h 10 min; roster 2 h 55 min.
- **Sunday night, at 8:05 PM:** props 15 min; Sleeper 7 h 50 min; projections 10 h 5 min; roster 50 min.

**The same at every moment.**
- The injury file is checked within the last 5 min.
- Kickoffs are checked within the last 24 h. The content changes only when a game is flexed.
- Usage runs through the last completed week and is checked at 4 AM.
- The nflverse depth chart is checked within the last 12 h; only Waivers uses it.

**What a tap (Team, Matchup or Data health) changes.**
- It does: re-read the roster and re-check the injury file. It re-buys any game whose look is older than 6 h, 1 h or 15 min. That is about 9 games at most, because this provider copy never waits out the per-minute limit (refreshJob.ts:361-370). It refreshes kickoffs if they are older than 6 h.
- It does not touch Sleeper statuses, projections or usage (refreshJob.ts:323-331).

**Where the gap is biggest, and why**
1. **Inactives outside the 1 PM window are never seen before kickoff.** This covers TNF, MNF, Sunday night and 4 PM games, which rely on a Sleeper copy 4 to 16 h old, and the injury file never has inactives. When books pull an inactive player's props at the 1.5 h or 0.5 h look, his line becomes a "gone" marker (core/vegas/combineProps.ts:87-129). He is then ranked on the frozen Sleeper projection under "No line yet" (core/startsit/decisionPoints.ts:203-212; web/rowFigure.ts:41-55). Why: Sleeper's list is downloaded once a day at its own request, and Round 27 chose not to poll (README.md:94-100, 129-131).
2. **Sunday-morning statuses are 31 h old at 11 AM.** The app is still on the Saturday 4 AM copy, because Sunday's download moved to 12:15 PM (playerListClock.ts:56-64). IR activations, elevations and downgrades that only Sleeper carries are missing until 12:15 PM.
3. **The official report reaches the app about 10 h late.** The NFL releases it around 4 PM, and nflverse rebuilds around 2 AM (README.md:22-27). So on Thursday at 6 PM, Sunday teams show only Wednesday's report, and MNF teams have no week-11 report yet. Friday's final designations arrive around 2 AM Saturday.
4. **Projections are frozen for game day.** Every Sunday game uses the Sun 10 AM fetch, so the number is 2 h 45 min to 10 h old at kickoff. TNF and MNF use the Thu or Mon 4 AM fetch, 16 h old at kickoff. The 12 h gate (sleeperProjectionService.ts:54, 172) declines even a Waivers pull, and the Team refresh never asks for projections.
5. **Vegas lines are dense near kickoff (15 min old at T-15) but have wide gaps earlier.** The widest gaps:
   - Sat noon for Sunday games: 23 h.
   - MNF on Tuesday: no line at all.
   - MNF on Thursday: 22 h.
   - Sunday props at the Tuesday 1 PM first look: often thin.

   A tap closes these if the budget allows.
6. **The roster is 2 h 30 min old at 12:45 PM Sunday.** A lineup change Alex made in Sleeper after 10:15 AM does not show on Team until he taps Refresh or the 1:15 PM read runs.

---

## 3. Freshness promises the screens make, and whether they hold

- **Team header "Updated 7:15 AM" (web/screens/TeamScreen.tsx:446-449).** This is the finish time of the last refresh job from any screen (serverRefresh.ts:56-60), whatever its sources did. Blocked or unavailable sources still read "Updated" (refreshJob.ts:301-310), cron runs never move it, and it shows no age and no stale warning. **Inaccurate** as a statement of data age.
- **Waivers "Updated X" (WaiversScreen.tsx:173, 190).** The later of the trending/transactions read and the last waivers job (web/api.ts:1704-1709). **Accurate** for those inputs. It says nothing about lines, projections or statuses.
- **Data health headline "refreshed N min ago" (dataHealthService.ts:211-221).** The newest success of any source. Because the NFL week and the roster move every 3 h, it almost always reads under 3 h. **Says nothing** about lines or injuries.
- **Data health "Vegas lines" row (dataHealthService.ts:133, 353-445).** It ages the newest look at *any* game, including TNF and the Odds API top-up. The window is max(36 h, time since the last Sat 23:00 or Sun 15:00 UTC) + 90 min (core/health/policy.ts:209-211). By probe that is 60.5 h on Tue 9 PM, 105.5 h on Thu 6 PM, 147.5 h on Sat noon and 37.5 h on Sun or Mon. **Practically never stale.** It cannot see per-game age or budget refusals; only the gate-overdue check (dataHealthService.ts:437) can fire.
- **Data health "Injuries" row (dataHealthService.ts:132).** Measured on ingested_at within 30 h, which is when the file was last republished, not when news last changed. Sleeper statuses are the faster source, but they sit on the "Player list" row, whose text is about names (policy.ts:304-311). **Misleading.**
- **Data health "Player list" and "Your roster" rows.** Both are measured on attempt age (dataHealthService.ts:777). A failed download still reads "Current" and its note is dropped (policy.ts:415-418). A failed roster read leaves no row at all (sleeperSync.ts:141-161), so the roster can read Current for up to 36 h. **Inaccurate on failure.**
- **Setup Vegas summary (setupService.ts:538-551).** It reports "updated X ago" from the newest look at any game. Past 36 h it adds "start/sit lowers its confidence accordingly". That is **false**: `propsStale` is hardcoded `false` (server/services/startSitInputs.ts:274), so the stale-props penalty and medium confidence (core/startsit/engine.ts:518-521, 678) never fire.
- **Setup "allowance is used up" (setupService.ts:506-511).** **This message can never appear.** It tests `budgetState === 'exhausted'`, a state budget.ts:57 never produces. It also says the allowance resets "at the start of next month", while the period is assumed to run from the 13th to the 12th (billingPeriod.ts:31). Setup's footnote promises lines that "stay on screen, marked as old" (SetupScreen.tsx:3258-3259); Team and Compare mark nothing.
- **Row note "No line yet" (rowFigure.ts:41-55).** It claims "the odds clock keeps asking until half an hour before kickoff". In fact the clock asks only at the 9 checkpoints, the budget can refuse, and a player whose props were pulled stays "No line yet" until kickoff. **Overstated.**
- **Player card provenance (core/injury/model.ts:497-505).** Sleeper statuses always read "undated", because statusObservedAt is never passed (injuryService.ts:681). A Friday final report stored at Sat 2 AM reads "not the latest report" from Sunday 8 AM on (30 h rule, model.ts:206; probe), even though it is the latest. **Misleading.**
- **Data health projections and nflverse rows.** The projections row reads Sleeper's week (dataHealthService.ts:470), so on Tue and Wed it vouches for last week's numbers. The nflverse row says "No live recommendation reads it" (policy.ts:325), but Waivers reads depth ranks (decisionInputs.ts:632-633). **Both inaccurate.**
- **Comments still written for daylight time.** These describe crons that no longer run that way: index.ts:793 says about 5 AM, index.ts:1041 says about 11 AM, and app.ts:2457-2459 says "daily at 09:00 ... and Sunday 11am beside the Vegas refresh". The real times are 4 AM and 10 AM, and the injury check now runs every 5 min. Developer text only.

---

## 4. Risks

### Refresh work that can be skipped silently
1. **Odds budget guard (budget.ts:181-186, 223-241).** From 70% of the monthly cap, only passes whose first game is critical run. Discovery always asks at normal priority (vegasRefresh.ts:548-559), so a new week's games would never be found and every row would read "No line yet". Refusals are logged only in vegas_usage_log as 'blocked' and in vegas.clock.last.note, and they wait for the next checkpoint (vegasKickoffClock.ts:32-34).
2. **Which looks stop first.** `contested` is true for any non-empty Sleeper status, including "Active" (vegasRefresh.ts:1048; core/sleeper/transform.ts:126). So looks within 6 h of kickoff are mostly critical, while the 120 h to 24 h looks are normal and stop first at 70%. Probe workflows spend from the same key (.github/workflows/probe.yml:45).
3. **Per-pass caps.** A pass buys at most 9 games and asks about at most 9 teams in discovery (budget.ts:54; vegasRefresh.ts:562). Extra games retry every 10 min up to 6 times, then wait for the next checkpoint anywhere in the league (vegasKickoffClock.ts:153-176). The remaining discovery teams wait for the next pass.
4. **The Odds API latch (extraOddsSources.ts:189-193).** Once `remaining` drops to 60 or fewer, the source is never called again: only a call refreshes `remaining`, and nothing resets it monthly. No note is written.
5. **Extra-source failures are swallowed.** The gate drops them with `.catch(() => null)` (vegasKickoffClock.ts:130), and the tick logs only errors and blocked items, not their notes (index.ts:553-555). The only trace is settings vegas.extraSources. TheRundown also stops at 6,000 points per UTC day.
6. **Injury check (index.ts:341-343).** Errors are caught and logged. Failures and refusals are recorded in injury_source_state.consecutive_failures, and Data health shows the row as degraded. The anomaly guard keeps refusing until the diff shrinks (injuryService.ts:567-581). There were 18 failures in a row on Sun 8 Nov, 3:45 to 6:40 AM (README.md:89-91).
7. **Player list.** There is no same-day retry Mon to Sat (playerListClock.ts:61-64). Pressing Setup's "Update player list" before 12:15 PM on Sunday counts as the day's download and cancels the game-time one, so 1 PM inactives are missed (playerListClock.ts:71-73; SetupScreen.tsx:1658).
8. **Projections fail silently by design (sleeperProjectionService.ts:18-24, 183-197).** If week 11 is not published by Tue 4 AM, the next try is Wed 4 AM unless someone pulls Waivers.
9. **Run records.** The 5-min tick is not recorded in cron_run_state (0033:29). A 09:00 run killed for CPU writes no record (index.ts:647-650). All 09:00 steps share one 48-subrequest budget (index.ts:633-636).
10. **D1 daily allowance.** Once it is spent, every read and write fails until 00:00 UTC, which is 7 PM ET (wrangler.toml:116-117). The quota panel needs CLOUDFLARE_ACCOUNT_ID, which is empty in wrangler.toml:73.
11. **The odds clock trusts Sleeper's week in sleeper.nflState (vegasKickoffClock.ts:260-279).** If that week stopped updating, the clock would see no future kickoffs and buy nothing, and the gate would raise no alarm because `next` keeps advancing. Low risk: it refreshes every 3 h. Separately, the opponent tier uses Sleeper's week (vegasRefresh.ts:1071-1078), so on Tue and Wed it prices last week's opponent.

### What the app shows when an input is stale
- **Lines.** No age is shown on Team, Compare or Matchup, and the stale-props penalty never fires (startSitInputs.ts:274). The only correction is for props older than a moved game line: they are scaled, capped at 8% (core/startsit/staleLine.ts:53-75; engine.ts:409).
- **No complete market** (never bought, pulled, or blocked by the budget). The player is ranked on the stored Sleeper projection with "No line yet" (decisionPoints.ts:203-212). An inactive player outside the 1 PM window can therefore look startable.
- **Injuries.** The worse of Sleeper's copy and the report wins, unless it is more than 24 h older (model.ts:308, 337-371). A stale designation still gates the player; it only adds "report is out of date" (core/startsit/availabilityConfidence.ts:87). Questionable carries no point charge (rowFigure.ts:15).
- **Client.** On a tab revisit the session cache paints the last answer, then revalidates. No screen passes `onStaleError`, so a failed revalidation leaves the old answer on screen unmarked (web/sessionCache.ts:222-260, 319-362). The cache does not survive a reload. The offline cache covers the Draft board only (offlineCache.ts:13-22).
- **Server copies.** The odds freshness line (props.week.freshness, 1 h backstop; propsFreshness.ts:55-63) and the stored player list (players.snapshot) are checked against stamps, so neither is older than its data. The only timed memos on decision paths are appWeek's 3 h last-kickoff memo (server/services/appWeek.ts:24) and the 6 h defence-tendency table (usageService.ts:77), which writes clear.
