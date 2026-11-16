# Fantasy Analyst: light code-health audit (helper report, saved verbatim by the lead)

16 November 2026, `main` at 101ad32 (branch `claude/new-session-xlfaay`). Report only: no file in the repo was changed. The web build and the stubbed build went to the scratchpad, not to `dist/`.

## Summary (the helper's own)

- Unit tests: `npx vitest run` passed: 423 files, 7,466 tests (7,465 passed, 1 skipped, 0 failed), 114.6 s.
- Deploys will be blocked from 1 January 2027 (verified). Three tests take the season from the calendar year: tests/integration.api.test.ts:823, matchup.service.test.ts:212, startSitReadCost.test.ts:40. They pass on 16 Nov and 29 Dec 2026 and all fail on 5 Jan 2027. release.yml:114 runs `npm test`, so this blocks every deploy until March. Fix: 0.5 h.
- One failed `/api/auth/status` read sends Alex back to the retired Trades and Players screens for the whole session, with no message (features.ts:22,26-31; App.tsx:212-220).
- Injury chips can contradict the numbers. Chips on Team rows and in the Compare list show Sleeper's daily status (app.ts:798, comparePool.ts:159). The numbers use the worse of Sleeper and the injury report. A "Q" chip can sit beside an "Out" number for up to a day.
- From Tuesday 3 AM to Wednesday evening, the odds refresh and the cron still use Sleeper's week while the screens use the app week (vegasRefresh.ts:1072, worker/index.ts:498-512). Result: the wrong opponent's players get Vegas lines, and one of the three ahead weeks is missing while waiver claims are entered.
- Size budgets are almost full. Main CSS is 19,203 B gzip of its 20,000 B budget; perf-budgets.json still says "~7.7KB". Entry JS is 122.1 KB of 125 KB.
- The old Trades screens are loaded on every page because TradesTab.tsx:10 imports them directly. That is 3,403 web lines, 12.0 KB gzip (measured by stubbing them out), and about 2 KB of CSS. Six routes and about 3,000 server lines exist only for them.
- The e2e suite mostly tests the old paths. The dev server defaults the three switches to old/off (dev-server.mjs:140-144, playwright.config.ts:100). The live screens get 7, 9 and 1 tests, through mocked flags.
- Duplicate rules: toss-up and minus-1 each have one owner, and their copies cannot disagree. Rules whose copies can disagree: bye detection has three rules; point rounding (12.45 prints 12.4 on Team, 12.5 on the Players card and the Compare table); Doubtful shows "OUT" on Matchup; Team has no preseason fallback while Compare and Matchup do; week rollover has three clocks.
- Dead code: a decision feed nothing writes to (about 550 lines). Of 113 routes, 42 have no web caller, 18 of them called only by tests. About 4,670 lines of maintained modules are reached only by tests; the Demo harness is kept on purpose. The web layer has almost no unused exports.
- Silent failures: Compare shows "Nobody matches that." when its read fails; a failed injury read falls back to Sleeper's status alone; five-minute cron sub-job errors only reach console.error, which the cron watcher never sees; a failed email ingest is dropped.
- D1 cost risks: Team runs the full Waivers assembly on every open, and every GET (including 7 diagnostics routes) is public with no rate limit.

Scale: `src` holds 549 TS/TSX files and 185,015 lines (core 112,622, server 35,798, worker 1,370, web 34,282), plus `styles.css` at 10,755 lines. Tests: 423 unit files (115k lines), 78 e2e specs (30k lines), 2 production smoke specs.

## 1. Duplicate logic across screens

- **D1 Toss-up bar.** One owner, `core/startsit/tossup.ts:41,64,111`. Team, Compare, Pick up and start, the Waivers block (`block.ts:46`) and look-ahead (`lookAhead.ts:38`) all use it. Matchup has no bar by design; Trades has its own ROS close-call bar (`tradeValue/evaluate.ts:79`). No disagreement, except the gap is unrounded and rows print one decimal: a 1.96 gap can read "13.0 vs 11.0, Toss-up".
- **D2 Minus-1.** One constant and one function (`decisionPoints.ts:71,85`), used by Team, Compare, the Matchup hole fill and the Waivers tiers. The Waivers block skips it on purpose (`block.ts:24-27`). Cannot disagree. Stale comment "two points lower" at `engine.ts:1165`.
- **D3 Doubtful = Out.** Owner `isOutThisWeek` (`weekAvailability.ts:49-51`). Local copies agree today but would not follow a rule change: `tossup.ts:96`, `tradeValue/evaluate.ts:118`, `tradeValue/availability.ts:61`, `waivers/pickupStart.ts:428` (raw Sleeper words). Unreachable leftovers contradict the rule (`decisions.ts:42`, `matchup/model.ts:623`). Matchup flags a Doubtful player "OUT" (`model.ts:619`) while Team's chip says Doubtful.
- **D4 Questionable = full value.** Owner `weekAvailability.ts:28-31,42-46`. The lineup still adds a "Cover if he sits" charge of up to -0.9 to a Questionable player's `score` (`lineup.ts:459,704`, `replacement.ts:37`). Ranking and printed numbers leave it out, but bench order and lineup totals include it, and the old Trades ladder reads those totals.
- **D5 Injury-status merging.** Owner `resolveInjury` (`injury/model.ts:293,337,373`). Chips read Sleeper's raw daily status on Team rows (`app.ts:798`, `TeamScreen.tsx:1097,1413`) and in the Compare list (`comparePool.ts:159`), while Compare cards use the merged flag. Waivers' role finder, stash and "Starter out" chip read only Sleeper's notes (`opportunity.ts:446-447`, `upsideStash.ts:55,230`, `pickupStart.ts:428,454`). Can disagree for up to a day.
- **D6 Bye detection: three rules.** Team, Compare and Matchup use `playingTeams` + `isOnBye`, which finds no byes when fewer than 20 clubs are listed (`nfl/schedule.ts:277,286,300`). Waivers uses `byeReader` (`schedule.ts:317`). Trades, the Players card and later Waivers weeks use `tradeValue/weeks.ts:130-147` (no LA/LAR folding, gives up when two weeks are missing). On a partial fixture list the three can disagree.
- **D7 Rest-of-season value.** One blend and one rate builder feed Trades, the Waivers tiers and Players. Two other valuations live only in the retired Trades screens.
- **D8 This-week number.** Owner `decisionPoints` then `weekPoints`. Team rows have no preseason fallback while Compare and Matchup do (`TeamScreen.tsx:773-783` vs `build.ts:798-808`), so one player can read "-" on Team and "~X" on Matchup.
- **D9 Rounding.** Five one-decimal formatters. Three apply `toFixed(1)` to the cent value, two use `Math.round(x*10)/10` (`compareTable.ts:71`, `playersSeasonService.ts:202`). They disagree on 160 of every 4,000 cent values. Team also prints the same pickup gain as "+x.x" (`TeamScreen.tsx:1779`) and "+x.xx" (`:1969`).
- **D10 Kickoff/lock.** Shared rule `lockState` (`decisions.ts:102-110`); copies agree today (`rowFigure.ts:50-56` uses the phone's clock).
- **D11 Week rollover.** Screens use the app week (Tuesday 3:00 ET). The injury resolver's week starts Tuesday 00:00 Detroit (`injury/model.ts:315-319`). The odds opponent tier (`vegasRefresh.ts:1072`), the 5-minute league read (`worker/index.ts:498,506`), the refresh job (`refreshJob.ts:411`) and manager tendencies use Sleeper's week, so they disagree every Tuesday 3 AM to Wednesday evening.
- **D12 Clock helpers.** Several private Eastern/Pacific copies and a hand-rolled DST rule for kickoffs (`nfl/schedule.ts:384-401`). All agree today.
- **D13 Lineup optimisers.** Three (`recommendLineup`, `solveLineup`, Hungarian `bestLineup`) and two identical slot builders. Same best lineup; ties can break differently.

## 2. Unused or dead code

### 2a Switches (all three screen switches flipped 12-13 November 2026)

| Switch (prod) | Dead path and what removal deletes | Lines | Risk |
|---|---|---|---|
| `TRADES_SCREENS` "new" | Old Trades screens: 12 web modules, all in the entry chunk because `TradesTab.tsx:10` imports `TradesScreen` statically (12.0 KB gzip measured, plus ~2 KB CSS). Six routes used only by them (`app.ts:2890,2907,3010,3075,3093,3127`) and the server code reachable only through them. E2E: `smart-trades.spec.ts` (32 tests), `trade-ladder.spec.ts` (9). | web 3,403; server ~3,000 | Medium-low: the support snapshot and ~7 probe scripts call `/api/trades/smart` and `/trades/check` |
| `PLAYERS_INSEASON` "on" | `PlayersScreen` must stay (draft mode). Removing deletes the flag plumbing and the post-draft branches of `PlayersScreen.tsx`. | 60-80 | Low |
| `WAIVERS_LOOKAHEAD` "on" | Flag threading and off branches plus the `lookahead=1` probe parameter. | ~40 | Low |
| `TRIM_OLD_ROWS` "on" | A kill switch. Keep. | 3 | n/a |
| `VEGAS_PROVIDER` "sportsgameodds" | `the-odds-api` as primary is dead in prod; `mock` must stay. | 205 | Low |
| `PREVIEW` (unset in prod) | Preview-only code; two pieces ship in the worker. | 708 | Keep while `preview.yml` is used |
| `CLOUDFLARE_ACCOUNT_ID` "" | The in-app D1 allowance panel reports "not connected". Fill it in (an id, not a secret) or drop the panel. | 504 | Low |

### 2b Dead or test-only modules

- 491 of 549 `src` files ship; 40 are reached only by tests (11,847 lines). About 7,180 are the Demo Mode harness (kept on purpose). The other ~4,670 are unshipped but maintained: `seasonImport/*` (1,593), `grading/*` (732), `startsit/contingency|fragility|optionality` (768), `contracts/channel3` (435), `source/anomalies` (420), `league/waiverRun` (219), `league/rankMove` (190), `draft/tallyInfluence` (195), `season/keys` (116).
- Decision feed / rank explanation: nothing writes to it. `rankDecomposition.ts` is imported by nothing; `DecisionFeedRepo` is read only by two routes no screen calls; migration 0022's tables stay empty. About 550 lines.
- 49 exports have no importer; 711 value exports are used only by tests or scripts.
- `scripts/` holds 151 one-off `probe-*.mjs` files (22,334 lines). They do not ship.
- `server/repos/rankDecomposition.ts` and `core/managers/ledger.ts` contain literal NUL bytes, so grep treats them as binary and code searches silently skip them.

### 2c Unused API routes (113 in `app.ts`; 42 have no web caller, plus 6 used only by the old Trades screens)

- No caller outside tests (18): `auth/logout`, `adp/snapshots/:id/unresolved`, `adp/rows/:id/resolve`, `mock/status`, `demo/status`, `leagues/:id/sync`, `waivers/refresh`, `strategy/refresh`, `feed`, `feed/seen`, `drafts/:id/adp-snapshot`, `players/:id/draft`, `newsletter/sources` (GET, POST), `trades/offers`, `players/:id/aliases` (GET, POST), `vegas/season/refresh`.
- Probe-script only (7): `leagues/:id/bench`, `trade-fit`, `plan`, `managers`, `managers/refresh`, `vegas/status`, `vegas/season`.
- Diagnostics with no web caller (7): `projection-v2`, `nflverse`, `manager-intelligence`, `matchup-calibration`, `trade-finder`, `smart-trades`, `trade-values`. Public, like every GET.
- Ops/workflow routes (10): keep.

## 3. Oversized files

| File | Lines / bytes | Does size hurt Alex? |
|---|---|---|
| `src/web/styles.css` | 10,755 / 330,955 source; 105,186 minified | Yes. 19,203 B gzip against a 20,000 B budget: 96% used, ~0.8 KB headroom, render-blocking. `perf-budgets.json` still says "Today ~7.7KB". Old Trades rules are ~2 KB of it. |
| `src/server/app.ts` | 3,889 / 178,158 | Indirectly: 113 routes in one module; every route change touches it. |
| `src/web/screens/SetupScreen.tsx` | 3,271 / 131,842 | Little: lazy chunk, 21.0 KB of 24 KB. |
| `src/web/screens/DraftScreen.tsx` | 3,034 / 131,999 | Not in season: lazy chunk, 15.6 KB of 24 KB. |
| `src/web/screens/TeamScreen.tsx` | 2,256 / 103,163 | Some: the largest module in the entry chunk; carries its own row ladder and formatter. |

Entry JS is 122,101 B gzip of 125,000 (97.7%); with the old Trades screen stubbed out it builds to 110,105 B (88%). Worker bundle 1.27 MB, 403 KB gzip.

## 4. Risky spots

- **R1 Week split, Tuesday 3 AM to Wednesday evening.** The odds refresh finds this week's opponent using Sleeper's week (`vegasRefresh.ts:1066-1076`): it prices last week's opponent's players. The cron stores the three weeks after Sleeper's week (`worker/index.ts:498-512`), but Trades, Waivers and Players read the three after the app week (`tradeValueService.ts:657`): the third week is missing while waiver claims are entered.
- **R2 Switch fallback.** `features.ts` defaults to the old Trades and Players screens whenever `/api/auth/status` fails (`App.tsx:212-220`), with no message.
- **R3 Empty or stale answers that say nothing.** Compare picker prints "Nobody matches that." on a failed read; a failed waivers read drops Team's waiver card silently; a failed injury read falls back to Sleeper's word alone; failed line or fixture reads become "no lines" and "nobody on bye".
- **R4 Client session cache.** `api.get` without `onFresh` returns the cached copy and updates only the cache; every Compare POST empties the whole cache, so every tab is cold after Compare.
- **R5 Server memo.** The Players board is kept 10 minutes, keyed only on who holds whom.
- **R6 Cron failures nobody hears about.** The 5-minute tick's sub-jobs log with `console.error` only; `cron-health-watch.mjs` reads only run outcomes, so an odds-clock or league-read failure on every tick raises no alert.
- **R7 Email ingest.** A failed newsletter ingest is logged and dropped.
- **R8 Team pays for Waivers.** Team calls the full Waivers assembly on every open (`TeamScreen.tsx:211`), the slowest endpoint (39 statements, 1.35 s on 8 October). Team then Waivers runs it twice.
- **R9 Public reads with no limit.** Every GET is public, including 7 diagnostics routes and `sweep=1` trade sweeps; a crawler or a stuck tab could spend the 5M daily rows.
- **R10 D1 growth.** Cold isolates re-read the 3,300-row player list; `sync_log`, `matchup_forecasts`, most `*_source_runs` and `vegas_usage_log` are never trimmed (reads are indexed and limited today).
- **R11 Time zones.** The rollover rule is sound; the risk is the parallel clocks.

## 5. Tests

- **T1** 423 files, 7,466 tests (7,465 passed, 1 skipped), 114.6 s. E2E not run here: 78 specs, ~1,156 tests, on 4 WebKit widths x 3 shards in CI.
- **T2** No `.only`, `.todo`, `xit` or `.fails`. One unit test skipped by env (`usageNflverse.test.ts:304`). 14 data-dependent `test.skip(...)` calls in 6 e2e specs. Three Chromium-only touch tests never run in WebKit-only CI.
- **T3 Calendar-year time bomb.** Three tests derive the season from `new Date().getUTCFullYear()`; on 5 January 2027 all three fail; `release.yml:114` runs `npm test`, so every deploy would be blocked from 1 January to 1 March 2027.
- **T4** 53 unit files read the real clock; two can flake across UTC midnight. No unit test uses the real network.
- **T5 Coverage mismatch.** The e2e server sets none of the three screen switches; the suite exercises the retired Trades screens (41 tests) and Waivers with look-ahead off. The live screens get only 7, 9 and 1 tests.
- **T6** Known flaky tests, left alone.

## 6. Ten most valuable cleanups, ranked (the helper's)

| # | Cleanup | Cost | Reward for Alex |
|---|---|---|---|
| 1 | Seed the 3 tests with the seed's season (T3) | 0.5 h | Deploys keep working through the fantasy playoffs |
| 2 | Default the switches to the live values, or remember the last answer (R2) | 0.5-1 h | Never dropped onto retired screens by one failed read |
| 3 | Draw chips from the merged designation; point Waivers' readers at it (D5) | 3 h | Chip, number and pick always agree |
| 4 | Use the app week for the odds opponent and the cron's ahead weeks (R1) | 1-2 h | Opponent priced Tue and Wed; stable values while claims are entered |
| 5 | Delete the old Trades screens and their routes (2a) | 4-6 h | 12 KB gzip less on every load, ~2 KB CSS headroom |
| 6 | Start the e2e server with production switch values, then delete two switches (T5) | 1-2 h | E2E guards the screens Alex uses |
| 7 | Say when a read failed (R3) | 2 h | No empty or quietly stale answers |
| 8 | One shared points formatter (D9) | 1 h | Same tenth everywhere |
| 9 | Record each 5-minute sub-job's last success and alert when stale (R6) | 2-3 h | Failures show up in hours, not days |
| 10 | Make `api.get` without `onFresh` fetch fresh; stop Compare's POST emptying the cache (R4) | 1-2 h | Fresher Compare list, faster tab revisits |
