# How each in-season screen gets a player's number and pick (agreement trace)

Repo `/home/user/Fantasy-Analyst`, branch `claude/new-session-xlfaay` = main `101ad32`. Production switches read from
`wrangler.toml:81,86,92` (`TRADES_SCREENS="new"`, `PLAYERS_INSEASON="on"`, `WAIVERS_LOOKAHEAD="on"`), wired in
`src/worker/index.ts:223-226`. Method: code reading, plus one local seeded run of the real routes against an in-memory
SQLite built from the repo migrations and test fixtures (`scratchpad/agreement/local-divergence.ts`, output in
`local-divergence.out.txt`). No repo file was changed; nothing contacted production, Sleeper or Cloudflare.

Paths below are repo-relative unless they start with `scratchpad/`, which means
`/tmp/claude-0/-home-user-Fantasy-Analyst/888e0c9d-79c7-5a10-9224-61d9addd6497/scratchpad/`.

## 0. The short answer

- Every this-week number on Team, Compare, Matchup (pregame), Waivers (week 0), Pick up and start and the Players card is
  `decisionPoints` (`src/core/startsit/decisionPoints.ts:196`) over inputs from `startSitInputsFor`
  (`src/server/services/startSitInputs.ts:45`). Same function, so they agree at one instant on one input set.
- They stop agreeing for five structural reasons: (1) some routes pass Alex's IR slot (`reserveIds`) and some do not;
  (2) Trades and Players value players on the 75/25 rest-of-season rate, including the Trades "This week" line;
  (3) the weekly card sheet (Team and Matchup) prints the bare market or Rotowire figure, not the decision number;
  (4) injury chips come from two sources (Sleeper's raw word vs the merged worse-wins state, and Waivers' daily Sleeper notes);
  (5) caches of different ages (client stale-while-revalidate, Players 10-minute memo, per-isolate memos).
- The pick rules are mostly shared (`rankingNumber`, `isTossUp`, `tossUpLean`), but Compare ignores kickoff locks,
  Waivers' board uses its own yardstick and bars, Trades and Players never apply the minus 1, and toss-up labels can differ.
- `POST /api/startsit/compare` is NOT public: it needs the passphrase session (401 otherwise). All in-scope GETs are public
  and none writes to the database. Only Matchup takes `?week=`.
- `scripts/numbers-agree-report.ts` still rebuilds Team, Matchup and the waiver week-0 figure, but its Trades and Compare
  columns no longer match production, it reads removed fields (`cmp.tie`, `cmp.tiebreak`), and it covers neither the new
  Trades screens, the Players tab, the Waivers look-ahead, the weekly card, the chips, nor the IR-slot split.

## 1. Shared core (one copy, used by every screen)

| Piece | Where | What it decides |
|---|---|---|
| Inputs | `src/server/services/startSitInputs.ts:45-278` | props in `slateWindow(now)` (`:98`, 12 h back, 9 days ahead, `src/core/nfl/slateWindow.ts:37,46,56`), previous props, news signals, merged injury (`:114`), usage weeks, kickoff (fixture list first, priced kickoff second, `:204`), `onReserve` only when the caller passes `reserveIds` (`:268`), `onBye` from the fixture list (`:273`) |
| League context | `startSitInputs.ts:369-492` | this week's fixtures for the app week (`:395-398`), game lines, home/indoor, defence tendencies (per-isolate memo 6 h, `src/server/services/usageService.ts:77,88,691`) |
| App week | `src/server/services/appWeek.ts:44-52`, rule `src/core/season/appWeek.ts:48-66` | Sleeper week + 1 once the week's last game is final and not before Tue 03:00 ET; last-kickoff memo 3 h per isolate (`appWeek.ts:24-41`) |
| Injury merge | `src/server/services/injuryService.ts:656-702` then `src/core/injury/model.ts:337-357,373-427` | worse status wins unless it is 24 h older than a cleaner one (`CLEARLY_OLDER_HOURS`, `model.ts:308`); report row = latest week stored for the player (`src/server/repos/injury.ts:136-139`) |
| This-week rule | `src/core/injury/weekAvailability.ts:42-51` | Questionable full value + chip; Doubtful = Out; Out/IR/PUP/SUS gate -99 (`src/core/injury/startsit.ts:87-118` sets `gate: true` for Doubtful too) |
| Engine | `src/core/startsit/engine.ts:384-720` | components, `score`, `ruledOut = gate or onReserve` (`:720`), `lock` (`src/core/startsit/decisions.ts:102-110`, kickoff <= now) |
| Decision number | `decisionPoints.ts:196-224` | complete market: `score`; incomplete market + published: Rotowire week + same nudges (`basis: 'published'`); else `partial` / `unpriced` |
| Minus 1 | `decisionPoints.ts:71,85-87` | ranking only, `basis === 'published'` |
| Printed week number | `src/core/startsit/weekPoints.ts:55-68` | null for `partial`/`unpriced`, Out for ruled out, clamped at 0 |
| Team row base | `weekPoints.ts:80-91` (`weekPointsBeforeStatus`) | decision number before the status charge, not clamped |
| Weekly card "Proj" | `src/core/startsit/projection.ts:270-312` (`weeklyProjection`) | bare complete-market expectation, else bare published, else preseason/17 |
| Toss-up | `src/core/startsit/tossup.ts:41,64,72-74,111-117,126-134,137-139,174-185` | under 2.0 on ranking numbers, 3.5 when the pick is Sleeper-only or Questionable, never against a real hole; lean by mode |
| Published week | `src/server/services/sleeperProjectionService.ts:236-271` | stored feed only, scored in league rules, QB rescore lines |
| Season rate | `src/core/tradeValue/rate.ts:242-333` + `src/core/value/restOfSeason.ts:48,112,137-152,213-218` | 75% mean(this week + up to 3 ahead weeks) + 25% per-game production (share scales to full at 4 games); weekly availability shares (`src/core/tradeValue/availability.ts`) |

## 2. Access, week parameter, writes, D1 rows

Auth middleware: `src/server/app.ts:334-348` lets any GET/HEAD through and needs a session for every other method unless the
path is in `PUBLIC_PATHS` (`src/server/http/auth.ts:110-127`). `READ_ONLY_POSTS` (`src/core/http/readShaped.ts:36`) only
exempts Compare from the Demo/Mock guards, not from the passphrase. Login: `POST /api/auth/login {passphrase}`
(`app.ts:463-476`, 8 attempts per 5 min). `scripts/site-check-round13-report.ts:18,90` and `probe-site-check-round13.mjs:11`
confirm production Compare needs the passphrase; `probe-startsit-round7.mjs:115` called it without a cookie and would get 401.

| Route | Public | Week param | Writes on read | D1 rows per call (source) |
|---|---|---|---|---|
| `GET /api/leagues/:id/roster` | yes | no | no | small; part of Team's total |
| `GET /api/leagues/:id/lineup` | yes | no | no | Team screen (roster+lineup+waivers) about 13,300 rows / 83 statements in Oct (`docs/AUDIT_2026-10_ROUND2.md:55-73`), of which the 3,310-row player list is now a few rows (`src/server/repos/playerListCache.ts:1-30`); lineup sub-reads: latest lines 370 (15 players), previous lines 405, injury 251 (`docs/AUDIT_2026-10.md:58`) |
| `GET /api/leagues/:id/waivers` | yes | no (`lookahead=1` forces Round 26 lines) | no | about 9,200 / 49 statements (Oct table); `?cost=1` reports rows returned (`app.ts:992`, `src/server/meter.ts:1-15`: a lower bound on rows read) |
| `GET /api/leagues/:id/matchup` | yes | `?week=` (`app.ts:1348-1352`) | no DB write (ledger moved to cron, `app.ts:1327-1344`); one Sleeper `getMatchups` request per call (`matchupService.ts:138-139`) | about 3,700 per read (`docs/BUDGETS.md:275-277`) |
| `GET /api/leagues/:id/compare-pool` | yes | no | no | Compare picker about 2,200 / 16 statements (Oct table); `tab=waivers` reads the whole player list and the whole published week (`src/server/services/comparePool.ts:109,122-130`) |
| `POST /api/startsit/compare` | **no, passphrase** | no (app week) | no | no figure; 2-4 players plus its own context and the whole published week |
| `GET /api/players/season` | yes | no | no (memo in Worker memory) | old Players list 4,600 (Oct); new board runs `prepareRosters` (Trades-sized) on a memo miss, 10-minute memo per Worker (`playersSeasonService.ts:63,92`); `?cost=1` |
| `GET /api/players/:id/season` | yes | no | no | "a few dozen rows" (`docs/PLAYERS_INSEASON.md:39-46`); `?cost=1` |
| `GET /api/trades/screens/offers`, `/teams`, `/verdict` | yes | no (`week=quiet` only on the preview upload, `app.ts:2939-2944`) | no | Trades about 7,100 / 37 (Oct, old screens, same `prepareRosters`); no `cost`; use `GET /api/leagues/:id/trades/check?...&cost=1` (same engine, `app.ts:3093-3116`) to meter |
| `GET /api/leagues/:id/trades/build` | yes | no | no | `?cost=1`; not used by the production client (new screens) |
| `GET /api/leagues/:id/support-snapshot?context=` | yes | `week` (matchup only), `mode` | no | the screen's own gather plus the Data health view (`app.ts:1913`, `snapshotHealth` `app.ts:3854`); its priced-player count alone was about 4,176 rows a call (`docs/DATA_HEALTH.md:477`) |
| `GET /api/leagues/:id/bench`, `/plan` | yes | no | no | not called by the production web client (no caller under `src/web`) |

Avoid `GET /api/players/:id/detail` in a probe: it can start a background cache fill and a Sleeper call (`app.ts:2521-2531`).

## 3. Screen by screen

### 3.1 Team (`src/web/screens/TeamScreen.tsx`)

Endpoints: `/roster` (`:175`), `/lineup` (`:195`), `/waivers` (`:211`), all `api.get` with `onFresh` (stale-while-revalidate,
repaint when the answer changes). Not called: `/bench`, `/plan`.

- (a) Row number: evaluation from `lineup.starters|bench|undecidable[]` (`:339-345`), `rowWeek` = `weekPointsBeforeStatus`
  (`:797-801`), then `rowFigure` (`src/web/rowFigure.ts`; `:952`), printed `toFixed(1)`. Out/Doubtful/IR: label plus
  "if he played" figure; partial/unpriced: dash; not clamped at 0. Best move numbers: `weekPointsOf(e)` (`:1784-1787`,
  `fmt` `:2061-2063`), clamped, Out as "Out". Weekly card (tap a row): `buildWeeklyCard` (`:375-376`) prints
  `weeklyProjection` (`src/core/startsit/weekCard.ts:327`).
- (b) Season value: none on Team, except waiver tier rows from `/waivers` (`tiers.*.gain`, see Waivers).
- (c) Picks: `lineup.swaps[]` (`src/core/startsit/lineup.ts:1191-1349`, gain = undocked difference `:1289`, gated on ranked gap
  `:1297-1300` and `isTossUp` `:1319`), `lineup.fills[]`, `lineup.tossUps[]` (lean by mode, `leanTossUps` `:1373-1488`),
  `lineup.mode`. Best move order (`TeamScreen.tsx:1761-1775`): fill if bigger, else `waivers.pickupStart.start` (from the
  other request), else swap, else toss-up ("No line yet" when `waitingOnLine`, `:1894`), else "Keep your lineup". Row verdicts:
  `buildLineupVerdicts` (`src/core/startsit/sleeperLineup.ts:210`, called `TeamScreen.tsx:270`) from `lineup.slots` and `swaps`.
- (d) Chip: `InjuryTag status={subject.status}` (`:1097`, bench `:1413`) = `/roster` `starters|bench[].status`, Sleeper's raw
  word (`app.ts:798`), not the merged state; the figure's label uses `e.statusFlag` (merged).
- Server chain: `app.ts:896-982` -> `gatherLineupInputs` (`src/server/services/decisionInputs.ts:145-273`: context `:166`, inputs
  with `reserveIds` `:167`, week `:183`, opponent from the stored `matchup_forecasts` row `:198-205`, published for both rosters
  `:228-237`, mode `:239-246`, season points only for Floor/Ceiling `:253`) -> `assembleLineup`
  (`src/core/startsit/assemble.ts`, -> `recommendLineup` `lineup.ts:337-702`, decision on every evaluation `:546`).
- Locks: locked players removed from the optimisation (`lineup.ts:390-392`), locked starters keep Sleeper's slot (`currentSlotOf`).

### 3.2 Compare sheet (`src/web/components/compareSheet.tsx`)

Endpoints: `GET /api/leagues/:id/compare-pool?tab&position&q&mode` (`:143`, no `onFresh`) and `POST /api/startsit/compare
{leagueId, playerIds, slot, mode}` (`:166`). Team passes `mode = lineup.mode` (`TeamScreen.tsx:735`). The waiver sheet posts
the same route with no mode and `slot: null` (`src/web/components/waiverSheet.tsx:63`). Any POST clears the client cache
(`src/web/api.ts:175`).

- (a) Card number: `weekText(weekPointsOf(e))` over `evaluations[].decision` (`compareSheet.tsx:63-70,488-507`). Chip strip
  number: the picker row's `rows[].week` when the player is in the current list, else the comparison's (`:199-204`).
- (b) none.
- (c) `recommendedPlayerId` (null on a toss-up, `engine.ts:1371`) shown only when `slot.comparable` (`compareSheet.tsx:477-479`);
  `tossUp.{leanPlayerId, leanTag, waitingOnLine}` (`engine.ts:1206-1216`, label `compareSheet.tsx:530`); `sleeperOnly`.
- (d) `InjuryTag` of `designationOf(e.statusFlag)` or "Out" when ruled out (`:496`), merged state; picker rows use the raw
  `rows[].status` (`comparePool.ts:159`).
- Server chain: `app.ts:3560-3687`: inputs `startSitInputsFor(db, requested, { mode, seasonPoints })` (`:3593`, **no
  `reserveIds`, no shared context**), published via `gatherComparisonDisplay` (`decisionInputs.ts:439-467`, app week `:451`),
  `compareStartSit` (`engine.ts:1098-1380`, ranks on `decision.points ?? score` `:1121`, `pickOrder`
  `src/core/startsit/pickOrder.ts:39-54`, toss-up sides count `partial` as real `:1186`), `assembleComparison`.
  Pool: `comparePool` (`comparePool.ts:72-175`) passes `reserveIds` only for `tab=mine` (`:144-148`), prints
  `weekPoints` (`:164`).
- Locks: warns "already kicked off" (`engine.ts:1336-1341`) but still names the pick.

### 3.3 Matchup (`src/web/screens/MatchupScreen.tsx`, `src/web/components/matchup.tsx`)

Endpoint: `GET /api/leagues/:id/matchup` (`MatchupScreen.tsx:87`, `onFresh`); server memo of the last response per isolate,
keyed by fingerprint (`src/server/services/matchupService.ts:75,196-197`; `src/core/matchup/build.ts:453-466`).

- (a) Row: `forecast.slots[].mine|theirs.projectedFinal`, `forecast.bench.mine[]` (`src/core/matchup/model.ts:452`), printed
  `toFixed(1)` (`matchup.tsx:501-535`). Pregame it equals `projection` = `decisionPoints` for market/published, clamped and
  rounded (`build.ts:776-808`), else the preseason tier; bye 0 (`build.ts:830-832`); ruled out settles at actual (0 pregame,
  `src/core/matchup/distribution.ts:318-320`). Live: actual + pace-weighted remainder (`distribution.ts:347-352,451-453`).
  Card sheet: `cards[id].score` = `weeklyProjection` (`build.ts:518-524` -> `weekCard.ts:327`).
- (b) none. Team totals `forecast.teams.mine.projectedFinal`, `winProbability`.
- (c) No pick is drawn. `forecast.decision.fills[]` (holes only, `src/core/matchup/decision.ts:79-140`, minus 1 at `:176-178`)
  and `forecast.leverage` are in the JSON.
- (d) `statusFlag` Q / D / OUT (`model.ts:618-633`), from the merged designation, but `ruledOut` first, so Doubtful prints OUT.
- Inputs: `startSitInputsFor(this.db, playerIds)` with **no `reserveIds`** (`matchupService.ts:142`); evaluation without the
  published settle (`build.ts:308`); week `resolveWeek(opts.week, appWeek)` (`build.ts:252`), but props/fixtures are always
  the current slate.

### 3.4 Waivers (`src/web/screens/WaiversScreen.tsx`, `src/web/waiverCard.ts`, `components/waiverTiers.tsx`, `components/waiverSheet.tsx`)

Endpoint: `GET /api/leagues/:id/waivers` (`WaiversScreen.tsx:75`, `onFresh`; Team reads the same route). The sheet's
"This week" is `POST /api/startsit/compare` without a mode (`waiverSheet.tsx:63`), so it fails for a viewer without the
passphrase.

- (a) Week figure: `tiers.weekFigures[id].weeks[k].{points,out,bye,source,fromWeek}` (`src/core/waivers/assemble.ts:903-923`),
  week 0 = healthy decision number (`rate.ts:134`, rateOf `src/core/waivers/tierInputs.ts:190-235`), or an earlier week's Sleeper
  number standing in (`fromWeek`). The sheet's current-week cell prefers the Compare answer (`waiverSheet.tsx:159-176`).
  Pick up and start: `pickupStart.start.points` = decision number, market or published only (`assemble.ts:983-1004`).
- (b) Tier gain: `tiers.doThese|doThis|consider|watch[].gain` printed `+X.X pts` (`waiverTiers.tsx:18-20`), weighted window
  `[1, 0.5, 0.5]` (`src/core/waivers/tiers.ts:87`) or the season horizon with season rates (`tierInputs.ts:205-232`, same
  `buildPlayerRate` as Trades but `seasonLine: null` `:198,220`); later weeks `source: 'sleeper' | 'season'`.
- (c) Tier membership ("Do this", "Worth considering", Watch), `claimPlan.claims[]`, `pickupStart.start|consider[]`
  (`src/core/waivers/pickupStart.ts:222-372`: whole-lineup ranked gain `:261`, candidate must be fully Vegas-priced `:264`,
  `clearsTossUp(gain) || hole` `:314`), look-ahead lines `tiers.upsideStash|block|cover`, bids `TierRow.bid`. Board rows
  (`upgrades[]`, `valueAdds[]`) use the waiver yardstick (`src/core/waivers/yardstick.ts:112-217`, bars `:51,57`,
  `src/core/startsit/waivers.ts:49,543`).
- (d) Candidate chips: "Starter out" for `reasonCode === 'hole_injury'` (`waiverCard.ts:180`); `starterOut` uses Sleeper's
  daily player-notes status (`assemble.ts:1007,1015-1019`, `pickupStart.ts:436-456`; the wire pool reads the same notes, `decisionInputs.ts:599`);
  Opportunity uses the same notes (`decisionInputs.ts:603`, `src/core/waivers/opportunity.ts:447`).
- Server chain: `app.ts:990-1074` -> `gatherWaiverInputs` (`decisionInputs.ts:483-866`, week `:504` = app week, whole stored
  published week `:547`, roster inputs with `reserveIds` `:631`, candidates `:650`) -> `assembleWaiverPlan`
  (`assemble.ts:417-966`, lineup `waiverLineup` `:402-414`: Balanced, no `currentSlotOf`, no season points).
- Locks: locked slots and kicked-off candidates skipped (`src/core/startsit/waivers.ts:448,513`).

### 3.5 Trades, new screens (`src/web/screens/TradesScreenV2.tsx`, `components/trades2/*`)

Endpoints: `/api/trades/screens/offers` (`TradesScreenV2.tsx:42`, `onFresh`), `/api/trades/screens/offers?sell=|get=`
(`buildTab.tsx:57`, no `onFresh`), `/api/trades/screens/teams` (`TradesScreenV2.tsx:58`), `/api/trades/screens/verdict?b&give&get`
(`checkTab.tsx:37-41`, no `onFresh`). All use the selected league (`src/server/services/tradeScreensService.ts:65,94`).

- (a) "This week": `offers[].you.thisWeek` (`src/core/trades/finder.ts:594-598,650`) and `summary.you.thisWeek`
  (`src/core/trades/verdict.ts:180-183`), the week-0 lineup delta of the trade model, whose per-player value is the season
  `rate` times the week's share (`src/core/tradeValue/evaluate.ts:280`), printed `checkTab.tsx:110`, `offerCard.tsx:86`.
- (b) `offers[].give|get[].value` and `verdict.give|get[].value` = `rosValue` = `seasonValueOver` (weighted weeks times rate
  over replacement, `evaluate.ts:321-331,340`, `tradeScreensService.ts:26`); `restOfSeason`, `playoffs`, `edgePercent`.
  Per player on screen only "Starts N of M weeks".
- (c) `offers[].label|verdict|kind`, `summary.word|verdict|reason`, `drop`.
- (d) none on the new screens.
- Server chain: `TradeFinderService.find` (`src/server/services/tradeFinderService.ts:47-59`, `prepareRosters` for every roster) /
  `TradeValueService.check` (`tradeValueService.ts:227-290`, two rosters) -> `prepare`
  (`:618-848`): app week (`:173`), `evaluatePlayer` Balanced (`:724`), published `narrow` (`:732-740`), season lines for needy
  players (`:816`), ahead weeks and season points from settings rows (`:657-679`), `buildPlayerRate` with `ahead` and
  `production` (`:813-829`). No `rankingNumber` anywhere under `src/core/tradeValue` or `src/core/trades`.

### 3.6 Players in season (`src/web/screens/PlayersSeasonScreen.tsx`, `components/players2/seasonCard.tsx`)

Endpoints: `/api/players/season?leagueId=` (`PlayersSeasonScreen.tsx:129-133`, `onFresh`), `/api/players/:id/season?leagueId=`
(`seasonCard.tsx:24-27`, no `onFresh`).

- (a) Card `thisWeek.{points,out,sleeper}`: `weekPoints(evaluatePlayer(...Balanced))` rounded `Math.round(x*10)/10`
  (`playersSeasonService.ts:188,199-205`), then `toFixed(1)` (`seasonCard.tsx:15,66`). Inputs have **no `reserveIds`** (`:188`).
  `next[]`: week 0 = thisWeek, later weeks = stored Sleeper ahead points, `round1` (`src/core/players/inseason.ts:179-192`).
- (b) Board `rows[].overFreeAgent` printed as "Value" (`PlayersSeasonScreen.tsx:355`) = same `seasonValueOver` as Trades
  (`inseason.ts:61-68`); card "Season X a week" = `rows[].value` = `perWeekValue(rate)` (`inseason.ts:50-53`,
  `seasonCard.tsx:75`). Rates from `TradeValueService.prepareRosters` (`playersSeasonService.ts:98`).
- (c) `rows[].trade.{willingness, gain, over, overValue, reason}` (`inseason.ts:92-98,123-177`): "Likely" = trades often and
  needs one of Alex's spares; shown `PlayersSeasonScreen.tsx:369`, `seasonCard.tsx:36-52`.
- (d) Board chip `rows[].status` = Sleeper's raw word (`playersSeasonService.ts:152`); injury filter `rows[].injury` from the
  rate's merged designation or IR slot (`inseason.ts:74-85`).
- Caching: board memo 10 minutes per Worker keyed only on who holds whom (`playersSeasonService.ts:63,73-75,92`).

## 4. Where two screens can disagree, ranked

Real risk first, by how often Alex can see it times decision impact. "Seeded" = reproduced by `scratchpad/agreement/local-divergence.ts`.

1. **Row vs weekly card (Team and Matchup). Real risk.** Row prints the decision number (`TeamScreen.tsx:797-801`;
   Matchup `build.ts:793-796`), the card the bare market or Rotowire figure (`weekCard.ts:327`, `TeamScreen.tsx:376`,
   `build.ts:518`). Seeded: market 15.0 with +0.45 news, row "15.4", card "15.0"; Doubtful bench man: Matchup row 0.0, card 5.0.
2. **Trades "This week" and every Trades/Players value use the season rate. Real risk.** `evaluate.ts:280` uses the blended
   `rate` for week 0 (`rate.ts:280-296`); Team/Compare use the week's number. Seeded: Team 15.45, Trades rate 10.52, Players
   "Season 9.8 a week". The cross-screen test agrees only because its seed (`tests/helpers/crossScreen.ts:63-131`) stores no
   `sleeper.aheadPoints` or `sleeper.seasonPoints` rows, so its Trades number (`:187`) is the unblended week.
3. **IR-slot player. Real risk.** `reserveIds` reach Team (`decisionInputs.ts:167`), Waivers (`:631`), compare-pool mine
   (`comparePool.ts:147`) and Trades/Players board (`tradeValueService.ts:473`), not Compare (`app.ts:3593`), Matchup
   (`matchupService.ts:142`) or the Players card (`playersSeasonService.ts:188`). Seeded (IR slot, Questionable, 17.0):
   Team "Out", pool chip "Out", same sheet's card "17.0 Start", Matchup bench 17.0 Q, Players card 17.0, board "out, back wk6".
4. **Kickoff locks. Real risk after the first kickoff.** Team drops locked players from the optimisation (`lineup.ts:390-392`);
   Compare still names the pick and only warns (`engine.ts:1336-1341,1371`); Waivers skips them (`waivers.ts:448`). Example:
   bench WR already playing in the early game vs a late starter: Team suggests nothing, Compare "Start" the locked bench man.
5. **Injury chip source. Real risk.** Team rows, Compare picker and Players board chip print Sleeper's raw word
   (`TeamScreen.tsx:1097,1413`, `comparePool.ts:159`, `playersSeasonService.ts:152`); numbers and Compare/Matchup chips use the
   merged worse-wins state (`compareSheet.tsx:496`, `model.ts:618`). Example: Sleeper Q, Friday report Out: Team row chip "Q" beside "Out".
6. **Doubtful chip. Real risk (display).** Matchup returns OUT whenever `ruledOut` (`model.ts:619`), and Doubtful is ruled out
   (`injury/startsit.ts:92-98`); Team row label and Compare chip say Doubtful, as `weekAvailability.ts:16` requires.
   Seeded: Team "Doubtful (5.0)", Matchup chip OUT.
7. **Waivers reads Sleeper's daily notes for "starter out" and Opportunity. Real risk.** `decisionInputs.ts:599,603`,
   `pickupStart.ts:450-455`, `opportunity.ts:447` vs merged state everywhere else (`startSitInputs.ts:114`). Example: 09:00 notes
   say Q, 16:00 report says Out: Team shows the starter Out, Pick up and start shows no "Starter out" and no Opportunity line.
8. **Cache ages. Real risk.** Players board memo 10 min per Worker, keyed on holdings only (`playersSeasonService.ts:63,92`);
   client returns the cached copy and refreshes silently for the Players card, Trades verdict and Build offers (no `onFresh`:
   `seasonCard.tsx:24-27`, `checkTab.tsx:39-41`, `buildTab.tsx:56-57`; `src/web/sessionCache.ts:250-253`) while Team/Matchup/Waivers repaint;
   defence tendencies memo 6 h per isolate (`usageService.ts:77,88`). Example: lines move at 12:00; a card first opened 11:00 shows 11:00's number.
9. **One Best move line from two requests. Real risk.** "Pick up and start X over Y" prints X from `/waivers` and Y from
   `/lineup` (`TeamScreen.tsx:2011-2012`); the pickup baseline is the best owned lineup, not Sleeper's (`pickupStart.ts:239-240`).
   Example: `/waivers` served from cache before a lineup change, `/lineup` fresh: Y's number and the gain no longer match.
10. **Waiver yardstick vs decision number. Real risk where board rows still show** (DST rows, Trending, tiers failure:
    `WaiversScreen.tsx:233-300`). Bare market vs market or bare Sleeper vs Sleeper, no nudges, no minus 1, bars 2.5 and 3.0
    (`yardstick.ts:195-217`, `waivers.ts:49,543`) vs Team/Compare 2.0 and 3.5 on ranked decision numbers.
11. **Waiver sheet 3-week "Better" is unweighted. Real risk.** `waiverSheet.tsx:195` sums points; tiers weight `[1, 0.5, 0.5]`
    (`tiers.ts:87`); week 0 comes from Compare, later weeks from the planner. Example: add 8, 9, 14 vs partner 12, 9, 9:
    sheet totals 31 vs 30 ("Better" on the add), the tiers' weighting gives 19.5 vs 21 (keep the partner).
12. **Toss-up label after a mode-flipped lean. Real risk (label).** Team drops `waitingOnLine` when the lean flips
    (`lineup.ts:1405-1418`); Compare keeps it (`engine.ts:1215`). Example under Floor: bench Sleeper-only 14.0 vs priced 10.5:
    Team "Toss-up: lean 10.5 man (safer)", Compare "No line yet, Lean (safer)".
13. **Mode differs between the two Compare entry points. Real risk (lean only).** Team sheet sends `lineup.mode`
    (`TeamScreen.tsx:735`), waiver sheet sends none (Balanced, `waiverSheet.tsx:63`); Matchup forms its own live suggestion
    (`build.ts:437`). Same pair inside a toss-up: "Lean A (safer)" on one sheet, "Lean B" on the other.
14. **Players card rounding. Real risk (0.1).** `playersSeasonService.ts:202` and `inseason.ts:190` round with `Math.round`
    before `toFixed(1)`; Team, Compare, Matchup, Waivers print `toFixed(1)` of the cent value. 160 of 4,001 cent values print
    0.1 apart (`scratchpad/agreement/rounding-check.mjs`). Seeded: 15.45 is "15.4" on Team and "15.5" on the Players card.
15. **Minus 1 only on some screens. Real risk (ROS picks).** Applied in Team, Compare, Matchup decision, waiver tiers
    (`tiers.ts:1338-1341`) and pickup start; never in Trades/Players (no `rankingNumber` in `src/core/tradeValue`, `src/core/trades`,
    `src/core/players`). Example: priced RB 11.0 vs Sleeper-only RB 11.6: tiers start the priced one (10.6 ranked), Trades/Players value the other higher.
16. **Week mismatches. Real risk for probes.** `GET /matchup?week=N` takes week N's Sleeper lineup and published week but this
    slate's props, kickoffs and app-week fixtures (`build.ts:252,306`; `startSitInputs.ts:98,395-398`). `/plan` uses Sleeper's raw
    week (`app.ts:1574`), one behind the app week from Tue 03:00 ET until Sleeper rolls (not called by the client).
17. **Partial and unpriced pairs. Real risk (rare).** Cards print a dash for `partial` (`weekPoints.ts:63`) while Team ranks and
    Compare picks on the partial number (`lineup.ts:1667-1685`, `engine.ts:1186`); Compare also picks between two unpriced players
    on nudges (`engine.ts:1121`) where Team keeps Sleeper's lineup (`lineup.ts:1092-1100`). Example: "Start A" with "-" vs "-".
18. **Season line only in Trades. Real risk (latent).** Trades uses the market season line for a bye/out/no-number player
    (`tradeValueService.ts:771-779,816`); waiver tiers pass `seasonLine: null` (`tierInputs.ts:198,220`) and use an earlier week.
    The comment at `tradeValueService.ts:783-787` says the provider publishes no season lines, so usually equal.
19. **Clamp at zero. Real risk (rare).** Team row base is not clamped (`weekPoints.ts:90`), Best move, Compare and pool are
    (`weekPoints.ts:67`); a 0.3 complete market with a single book (-0.5) prints "-0.2" on the row, "0.0" elsewhere.
20. **12-hour props window. Real risk at time edges.** A game's props leave the slate 12 h after kickoff (`slateWindow.ts:37`),
    switching every live screen to the published or dash basis; memoised copies (items 8) keep the market number.
21. **By design:** Matchup live projected final (actual + remaining, `distribution.ts:347-352`) vs Team's pregame number.
22. **By design:** ruled-out wording: Team "Doubtful (5.0 if he played)", Compare "Out", Matchup 0.0, waiver sheet "Out",
    Players "Out"; all count zero this week (`weekAvailability.ts:42-58`, `weekShare` `:65-71`).
23. **By design:** waiver tier "+X pts" (weighted window or season gain), Players "Value" (season points over a free agent) and
    "Season X a week", Trades `value`/`rosValue`: rest-of-season quantities, never this week's points.
24. **By design:** Pick up and start needs a fully priced healthy free agent and measures against the best owned lineup
    (`pickupStart.ts:224-232,264,278`), so it can stay silent where Compare would say "Start" a Sleeper-only free agent.
25. **By design:** displayed numbers are undocked; the minus 1 is ranking-only (`decisionPoints.ts:78-86`), so "13.6 vs 12.9"
    can be a pick for the 12.9 priced player.
26. **Not a cross-screen split, but shared:** a single stale report row wins (`model.ts:338` returns the only observation; the
    report row is the player's latest stored week, `injury.ts:136-139`), so a player Out in week 10's report who is healthy and
    unlisted in week 11 (Sleeper status empty) reads Out on every screen. Worth one check in the probe.

## 5. What `scripts/numbers-agree-report.ts` still covers

- Still valid: Team rows rebuilt with `assembleLineup` + `rowFigure(weekPointsBeforeStatus)` (`:79-111`, but it omits
  `currentSlotOf`, which the snapshot carries as `inputs.currentSlots`, `src/core/support/lineupSnapshot.ts:182,213`); Matchup
  `projectedFinal` via `buildMatchupResponse(snapshotMatchupSources(snapshot), ...)` with the captured seed (`:113-131`); waiver
  `tiers.weekFigures[id].weeks[0]` and `pickupStart` via `assembleWaiverPlan(waiverRequestFromSnapshot(...).request)` (`:139-156`).
- Stale: Trades column is `buildPlayerRate` with no `ahead`/`production` and `byeWeek: null` (`:161,182`), so it is the
  pre-blend this-week rate, not production's; Compare column uses Balanced and the lineup inputs, which carry `onReserve`
  (`:185`), so it hides item 3; D5 uses a 0.6 bar and `cmp.tie`/`cmp.tiebreak`, fields `StartSitComparison` no longer has
  (`:225-229`; now `tossUp`, `engine.ts:327-381`); its "Waivers" column is the planner figure, while the sheet prints
  Compare's answer for week 0 (`waiverSheet.tsx:164`).
- Not covered: new Trades screens (the `trade-offer` snapshot is the old Smart Trades, `supportSnapshotService.ts:201-202`),
  Players tab (no snapshot context, `src/core/support/schema.ts:94-101`), Waivers look-ahead (capture calls `gatherWaiverInputs`
  without `lookahead`, `supportSnapshotService.ts:135`), weekly cards, chips, locks, toss-up labels, rounding.

## 6. Local seeded reproduction (no network)

`cd /home/user/Fantasy-Analyst && node --experimental-transform-types --no-warnings scratchpad/agreement/local-divergence.ts`
(full output: `scratchpad/agreement/local-divergence.out.txt`; responses dumped to `scratchpad/agreement/local-dump/`; table by
`lineup-table.ts`). Fixture: the repo's `tests/helpers/tradeLeague.ts` league, with M_WR1 (17.0) in Alex's IR slot as
Questionable, M_BN1 Doubtful, M_WR2 with +3 lifetime news, and ahead/season rows like production's.

| Player | Team row | Weekly card | Best move | Pool | Compare | Matchup row / chip / card | Waiver wk0 | Players card | Trades rate | Players value |
|---|---|---|---|---|---|---|---|---|---|---|
| M_WR2 (nudged) | 15.4 | 15.0 | 15.4 | 15.4 | | 15.4 / - / 15.0 | 15.4 | **15.5** | **10.5** (rosValue 34) | 9.8 a week, overFA 34 |
| M_WR1 (IR, Q) | Out ("Questionable", 17.0) | 17.0 | Out | Out | **17.0, Start** | **17.0 / Q** / 17.0 | Out | **17.0** | | board: out, back wk6 |
| M_BN1 (Doubtful) | Doubtful (5.0) | 5.0 | Out | Out | | 0.0 / **OUT** / **5.0** | Out | | | |

## 7. Read-only production probe plan (20 players, small reads)

When: Wednesday after 7:05 PM ET (fresh D1 day at 00:00 UTC, app week already rolled, no kickoff before Thursday night, no
game inside the 12-hour props window). Run `scripts/d1-budget-guard.mjs` first if a Cloudflare token is available; record
`GET /api/health` (`release.gitSha`) and `GET /api/vegas/status` (`fetchedAt`) before and after, and discard the run if
`fetchedAt` moved. Keep every call in one burst, in this order:

1. `GET /api/leagues` -> the selected league id (`leagues[].isSelected`). Trades and Players default to the selected league.
2. Team: `GET /api/leagues/:id/roster`, `GET /api/leagues/:id/lineup`, `GET /api/leagues/:id/waivers?cost=1`.
   Choose the 20: Sleeper starters (`roster.starters`), bench and IR (`roster.bench`, IR ids via the lineup evaluations with
   `onReserve`), and the top free agents (`waivers.pickupStart.start|consider`, `waivers.tiers.doThese|consider|watch`, top of step 4's waivers pool).
3. Matchup: `GET /api/leagues/:id/matchup` (no `week`). One Sleeper request on the server side.
4. Compare lists: `GET /api/leagues/:id/compare-pool?tab=mine&position=ALL&q=&mode=<lineup.mode>` and the same with `tab=waivers`.
5. Compare answers (passphrase needed): `POST /api/auth/login`, then `POST /api/startsit/compare` with
   `{leagueId, playerIds:[out,in], slot, mode: lineup.mode}` for each `lineup.swaps|tossUps|fills` pair and each starter against his
   best bench man at the slot (about 10 calls), plus 2-3 waiver sheet pairs with no `mode` and `slot: null`. Without the
   passphrase, skip and rebuild from step 8.
6. Players: `GET /api/players/season?leagueId=:id&cost=1` (a small `cost.statements` means a memo hit: note it), then
   `GET /api/players/:pid/season?leagueId=:id&cost=1` for the 20.
7. Trades: `GET /api/trades/screens/offers`, `GET /api/trades/screens/teams`, then 3-4 one-for-one checks on Alex's players
   with `GET /api/leagues/:id/trades/check?a=<mine>&b=<partner>&give=<pid>&get=<theirs>&cost=1` (same engine as `/verdict`,
   metered, returns per-player `rate`, `basis`, `weekly`, `rosValue`). Optionally one `/api/trades/screens/verdict` to confirm equality.
8. Snapshots for replay (each also pays the Data health view): `GET /api/leagues/:id/support-snapshot?context=lineup`,
   `?context=matchup`, `?context=waiver-plan`. Skip `trade-offer` (old Smart Trades).

Save each body under the names `lineup-table.ts` reads (`roster.json`, `lineup.json`, `waivers.json`, `matchup.json`,
`pool-mine.json`, `pool-waivers.json`, `players-board.json`, `players-card-<id>.json`, `compare-<a>-<b>.json`,
`trades-check-<give>-<get>.json`), then run `node --experimental-transform-types --no-warnings scratchpad/agreement/lineup-table.ts <dir>`.

Fields to line up per player (this week): Sleeper word (`roster.*.status`, `pool.rows[].status`); merged designation and
basis (`lineup.*[].injury.designation`, `.statusFlag`, `.decision.{points,basis}`, `.ruledOut`, `.onReserve`, `.onBye`,
`.lock`); Team row (`rowFigure(weekPointsBeforeStatus(e), e)`), weekly card (`e.projection`), Best move (`weekPointsOf(e)`);
pool (`rows[].week`); Compare card (`weekPointsOf(evaluations[])`); Matchup (`forecast.slots[].mine.projectedFinal`,
`.statusFlag`, `cards[id].score`); Waivers (`tiers.weekFigures[id].weeks[0]`, `pickupStart.*.points`); Players card
(`thisWeek`); Trades (`rate`, `rate*weekly[0]`). Season: Players `rows[].overFreeAgent` vs Trades `rosValue` (should be equal
if the memo is fresh), Players `rows[].value` vs Trades `rate`, waiver season weeks (`weekFigures[id].weeks[k].source === 'season'`) vs Trades `rate` (minus 1 and season line may differ).
Picks: Team `swaps|fills|tossUps` vs Compare `recommendedPlayerId|tossUp` for the same pair and mode; waiver tier and
`pickupStart` vs the waiver sheet's Compare; Players `trade` vs Trades offers containing the player.

Row budget, from the section 2 figures: steps 1-4 about 20,000; step 5 unknown, guess 1,000-2,000 a call; step 6 one
Trades-sized board read on a memo miss plus about 1,000 for 20 cards; step 7 about 7,000 plus 3-5,000 a check; step 8 about
30,000. Total under about 110,000 rows, about 2% of the 5,000,000 daily allowance. Dropping step 5 (replay instead) and
step 8's matchup snapshot saves the most uncertain part.

Replay (cheaper or more exact):
- Team, exact: `rehydrateLeagueRules`, `rehydrateStartSitInputs` (`src/core/support/inseason.ts:116,266`), then `assembleLineup`
  with `mode`, `published`, `currentSlotOf = new Map(Object.entries(inputs.currentSlots))`, `now = capturedAt`
  (`replayLineupSnapshot`, `lineupSnapshot.ts:204-215`, does exactly this).
- Compare as production computes it: `compareStartSit(pairInputs.map(i => ({...i, onReserve: undefined})), profile, { mode,
  published })` then `assembleComparison`; strip `onReserve` to mimic `app.ts:3593`. Players card: `weekPoints(evaluatePlayer({...input,
  onReserve: undefined, mode: 'balanced'}), published)` then `Math.round(x*10)/10`. Weekly card: `weeklyProjection(e, published.get(id))`.
- Matchup, exact pregame: `buildMatchupResponse(snapshotMatchupSources(snapshot), request.leagueId, { week: request.week, seed: output.forecast.seed })`
  (`src/core/support/matchupSnapshot.ts:344`, `replayMatchupSnapshot` `:396`).
- Waivers: `assembleWaiverPlan({ ...waiverRequestFromSnapshot(snapshot).request, lookahead: true })`
  (`src/core/support/waiverSnapshot.ts:438`); the pool still lacks the look-ahead slice because capture ran without it.
- Trades and Players: no snapshot. Approximate rates from the waiver snapshot (`request.ahead`, `request.round2.seasonPoints`,
  `request.seasonHorizon`, `request.published`) with `buildPlayerRate({ evaluation, published, seasonLine: null, weeks:
  seasonHorizon.weeks, byeWeek, byeKnown, onReserve, ahead, production: productionGames(...) })`; compare against live Trades/Players.

## 8. Scratchpad files

- `scratchpad/agreement/TRACE.md`: this report.
- `scratchpad/agreement/local-divergence.ts` and `local-divergence.out.txt`: seeded run of the real routes; `local-dump/`: its responses.
- `scratchpad/agreement/lineup-table.ts`: the line-up table over saved responses (tested on `local-dump/`).
- `scratchpad/agreement/blend-example.ts`: 75/25 rate vs this-week number for one WR (15.0 vs 10.44).
- `scratchpad/agreement/rounding-check.mjs`: Players card rounding vs `toFixed(1)` (160 of 4,001 cent values differ).
