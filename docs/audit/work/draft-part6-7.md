# Draft: parts 6 and 7 (to be merged into ROUND29_FULL_AUDIT.md)

## 6. Code health (light, only what affects Alex)

Unit tests: 423 files, 7,466 tests, all pass in 115 s. Last main CI: all 12 phone-width e2e shards green on the first try; sampled shards show no flaky test.

| # | Finding | Why it matters to Alex | Cost |
|---|---|---|---|
| C1 | Three unit tests build the season from today's calendar year (`tests/integration.api.test.ts:823`, `tests/matchup.service.test.ts:212`, `tests/startSitReadCost.test.ts:40`); the app's data is 2026. From 1 January they fail, and CI and Release both run them. | No fix can deploy during championship week (week 17 is Sunday 3 January). | 0.5 h |
| C2 | One failed `/api/auth/status` read puts the old Trades and Players screens back for the whole session, silently (`web/features.ts:22-31`, `App.tsx:212-220`). | Alex could be looking at retired screens with older logic and not know. | 0.5-1 h |
| C3 | Tuesday 3 AM to Wednesday evening, the odds refresh and the 3-hourly read use Sleeper's week, the screens use the app week (`vegasRefresh.ts:1066-1076`, `worker/index.ts:498-512`). | During waiver night the wrong opponent's players get lines, and the third look-ahead week is missing. | 1-2 h |
| C4 | Size budgets nearly full: CSS 19.2 of 20 KB gzip (the standing cap), entry JS 122.1 of 125 KB. The old Trades screens are 12 KB of the JS and about 2 KB of the CSS because `TradesTab.tsx:10` imports them directly. | The next visible change may not fit the stylesheet cap. | 4-6 h to delete the old screens |
| C5 | The e2e suite starts the app with the three switches at their old values (`dev-server.mjs:140-144`); the live Trades, Players and look-ahead screens get 7, 9 and 1 tests. | The browser tests mostly guard screens Alex no longer sees. | 1-2 h |
| C6 | Five-minute job failures only reach `console.error`; the cron watch reads run outcomes only (`worker/index.ts:341-610`). | An odds-clock or league-read failure every tick raises no alert. | 2-3 h |
| C7 | Failed reads say nothing: Compare's picker prints "Nobody matches that." on an error; a failed waivers read drops Team's waiver card; a failed injury read falls back to Sleeper's word. | Empty or stale answers look like real ones. | 2 h |
| C8 | Team runs the whole Waivers assembly on every open (`TeamScreen.tsx:211`), and every GET (7 diagnostics routes, trade sweeps) is public with no rate limit. | Cost on a heavy day; a stuck tab or crawler could spend the day's reads. | 1-2 h |
| C9 | Dead code still maintained: decision feed (about 550 lines, nothing writes to it), 18 test-only routes, about 4,670 lines reached only by tests. | Slows every change; no direct harm. | 2 h |
| C10 | Two source files contain NUL bytes (`server/repos/rankDecomposition.ts`, `core/managers/ledger.ts`), so searches skip them. | Future audits can miss code. | 10 min |

Dead switches: `PLAYERS_INSEASON` and `WAIVERS_LOOKAHEAD` (both on since 12-13 November) can go once the e2e suite runs the live values (60-80 and about 40 lines). `TRADES_SCREENS` can go with the old screens (C4). Keep `TRIM_OLD_ROWS` (a brake). `CLOUDFLARE_ACCOUNT_ID` is empty, so the in-app database meter says "not connected": fill it in (an id, not a secret) or remove the panel.

## 7. Gaps: what a very good in-season tool does that this one does not

Ranked cheapest and most valuable first. Rough cost in brackets.

1. **Pulled lines as a late-scratch alarm** (half a day). When sportsbooks pull a player's props at the 1.5 h or 0.5 h look, the app now shows "No line yet" and ranks him on Sleeper's number. A pulled line that close to kickoff almost always means inactive. Flag it red on Team and Matchup. Uses data already bought; covers the 4 PM, night and Thursday games the once-a-day Sleeper download misses.
2. **Honest freshness labels** (half a day). Team's "Updated" shows when a refresh finished, not how old the data is; Data health's Vegas and Injuries rows are almost never stale; two Setup messages can never be true. One age per input on Data health, and "lines from 1:00 PM" on a row when it matters.
3. **A Sunday 11:45 AM check** (1 day). One card on Team: starters on bye, Out or Doubtful, Questionable in a late game with a safe early fallback, empty slots, and the pulled-lines flag. "All clear" or the two things to fix.
4. **How the app did last week** (1 day). A Tuesday card: the app's lineup against Alex's and the best possible, picks right and wrong, waiver adds that paid off. The grading code already exists (`core/grading`), nothing shows it.
5. **Playoff outlook** (2 days). Weeks 15 to 17: each starter's and defense's matchups, and Alex's chance to make the playoffs from the remaining schedule, using the Matchup model he already has.
6. **Push alerts** (2-3 days, free web push on a home-screen app). A starter ruled Out or his lines pulled, waiver results, an empty slot an hour before lock. Never acts for Alex.
7. **Win-chance on a swap** (1-2 days). "Starting X raises your win chance from 54 to 57 percent", from the Matchup simulation, shown on toss-ups only.
8. **Weather for outdoor December games** (1-2 days, free source). Wind and snow move passing numbers; the engine has a weather slot but no live feed.
