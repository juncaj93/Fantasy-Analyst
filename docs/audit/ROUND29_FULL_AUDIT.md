# Round 29: full site audit (report only)

Sunday 15 to Monday 16 November 2026, week 10. All times Eastern (EST, UTC-5). Production `101ad32` (Round 28). Report only: no app code, schema or setting changed. One combined production check (Probe run PROBE_RUN, PROBE_ROWS database rows, PROBE_PCT of the day), plus code reading, a local copy of the app at iPhone Air size, and the saved data from Rounds 16 to 28.

Supporting files in this folder:

- `round29-probe.txt`: the production check's printed output.
- `round29-data.json`: the saved data the accuracy and freshness numbers come from (league ids removed).
- `round29-*.txt`: the output of each analysis.
- `method/`: the scripts that made them (no database read needed to re-run).
- `helpers/`: the four helper reports this audit drew on, word for word (screen trace, freshness map, screen inventory, code health).

<!-- SUMMARY -->

## 4. Screen inventory (iPhone Air, 420 x 912)

Measured on a local copy of the app with the three production switches on, in Chromium at 420 x 912, home-screen mode (62 px top safe area assumed, floating tab bar at 835 px, so 773 px of visible content). Seeded data, not Alex's league; nothing was fetched from production for this part.

### What breaks the north star (pick, one reason, tap for the comparison)

| # | Finding | Where | Cost |
|---|---|---|---|
| S1 | Team contradicts itself. The QB row says "Start Rhys Donnelly instead", but tapping Donnelly on the bench opens a card that says "Bench this week". Every bench row opens its card with `starting: false`. | `TeamScreen.tsx:666`, `core/startsit/weekCard.ts:355-398` | 1-2 h |
| S2 | Matchup contradicts Team. Matchup's player card says "Start at QB" for the man Team says to bench, because it follows Sleeper's current lineup; it says it for the opponent's QB too. Its "Compare" button only closes the card. | `core/matchup/build.ts:518-522`, `MatchupScreen.tsx:240` | 1-2 h |
| S3 | One Doubtful player, four words: "D" on Team, Compare and Players; "OUT" on Matchup; "who is Out" in Best move; "Out" as the Compare score. IR is "IR" or "OUT"; Out is "OUT" or "O". | `core/matchup/model.ts:619`, `waiverCard.ts:216` | 1 h |
| S4 | A standing disclaimer on every player card: "Not known yet: role trend, opponent tendency, expected points from usage", plus a "high confidence" caption. | `weekly.tsx:186`, `common.tsx:666` | 0.5 h |
| S5 | Two numbers for one week: the row says 16.3, the card he opens says "Proj 15.8" (the card prints the bare market or Rotowire figure, the row the decision number). | `core/startsit/weekCard.ts:320-337` | 1 h |
| S6 | A waiver card says "+66.2" (3 weeks, no unit); the sheet it opens shows 22.1 for this week. | `waiverTiers.tsx:18-20`, `waiverSheet.tsx` | 1 h |
| S7 | The one bid reason is cut off: one line, 515 px of text in a 388 px box, so it reads "...so $9...". | waiver sheet CSS | 0.5 h |
| S8 | Developer text on screens Alex opens: "Model matchup-1.0.0", "4,000 simulated afternoons", "See docs/DATA_HEALTH.md.", "Accept all non-mixed >=0.6 confidence", "GraphQL schema". | `MatchupScreen.tsx:293,347`, `core/health/quota.ts:149`, `ReviewScreen.tsx:211`, `playerDetailService.ts:947` | 0.5 h |
| S9 | Refresh works five ways: Team button and pull (all sources), Waivers button and pull (Sleeper only), Matchup pull only, Trades pull that only re-reads, Players nothing. "Updated" is written four ways. | | 2 h |

### Blurbs, help lines and explanatory sentences

Distinct sentences Alex can see beyond the pick itself, seen on screen in this run plus those the code shows in other states:

| Screen | Seen | Other states | Worst examples |
|---|---|---|---|
| Team | 11 | 12 | "Cannot be scored this week", "No projection", "Cal Whitfield is doubtful, so he is not a playable starter" |
| Player card (Team, Matchup) | 9 | 6 | the "Not known yet" line and the confidence caption on every card |
| Compare | 2 | 6 | raw server error lines in red |
| Matchup and its odds sheet | 8 | 4 | "4,000 simulated afternoons", "Model matchup-1.0.0" |
| Waivers and its sheet | 10 | 11 | clipped bid reason; "Cover, stash and block" lines have no comparison |
| Trades (Offers, sheet, Build, Check) | 22 | 16 | "Edge -11%" with no owner; the same trade written two ways |
| Players list, card, page | 20 | 8 | "Rank" meaning two things; three help lines under "More on him" |
| Setup and its areas | 60+ | | 14 sentences in the player-card data disclosure alone |
| Data health | 14 | 3 | "no analytics token to ask with. See docs/DATA_HEALTH.md." |
| Review | 7 | 8 | "Accept all non-mixed >=0.6 confidence" |

Setup and Data health are reference pages and can keep some text. The in-season decision screens should drop the standing card lines (S4), the developer text (S8) and the help lines under "More on him".

### Tap counts for Alex's ten most common jobs (from opening the app, which lands on Team)

| Job | Taps | Path |
|---|---|---|
| Start/sit check | 0 to read, 1 for the reason | Team row; tap for the card (a bench row's card says "Bench this week", S1) |
| Compare two players | 4 (1 if it is the suggested swap, 5 with a free agent) | Team, Compare icon, player A, player B, "Compare". Not reachable from Players, Trades or Matchup |
| See this week's matchup | 1 | Matchup tab |
| Place a waiver bid (find the amount) | 1 | Waivers, "Do this" row chip "Waivers $9"; +1 for the reason (clipped, S7) |
| Check an offer he received | 10 to 11 | Trades, Check, pick the team, add each player on both sides by hand. The "Offers" tab holds the app's own ideas, not offers he received |
| Check a trade target | 3 | Players, Trade targets, row |
| Refresh data | 1 | Team refresh (other screens differ, S9) |
| See injuries on his team | 0 to 1 | Team chips; Bench row for bench and IR |
| Find a bye cover | 1 | Waivers, "Cover, stash and block" line, which cannot be tapped for a comparison |
| See playoff outlook | not possible | No standings, playoff odds or seeding anywhere |

Worst three: check a received offer (10 to 11 taps), playoff outlook (not possible), compare a free agent (5 taps and not reachable from Players or Trades).

### Fit, tap targets and unclear states

- **Fit.** The pick and its reason are above the fold on every screen. What spills: Team with a full roster (1,004 px: the "Waiver moves" rows start under the tab bar), Check a trade 2-for-1 (1,068 px: the give/get detail), Data health (1,496 px).
- **Tap targets under 44 px.** Matchup's player buttons are 167 x 32, and they are the main thing to tap on that screen. Also: the card's "Compare" (36 tall), "More on X" (32), Compare's remove "x" (28 wide), Players' QB/RB/TE chips (about 40 wide), Back buttons (36 tall), Setup's theme and reload buttons (36), Review's Accept/Change/Ignore (32), and two Setup disclosures 15 to 17 px tall.
- **Unclear states.** Players' sort control looks like a filter; "Rank" is list position on the list and draft rank on the card; "Season" is three different numbers on three screens; "Edge -11%" does not say whose edge; "+66.2" does not say over what period; "9/9 priced" does not say what is priced; italic Sleeper numbers are explained only in tooltips a phone never shows.
- **Same thing, different behaviour.** A player row opens the weekly card on Team, a card whose Compare does nothing on Matchup, the waiver sheet on Waivers, a card and a full page on Players, and nothing on Trades. Free agent is "Free agent", "Available" or "FA". The same trade reads "for Dermot" with a Playoffs row on the offer sheet and "for you now" without it on Check.

<!-- PART 1 -->
<!-- PART 2 -->
<!-- PART 3 -->
<!-- PART 5 -->

## 6. Code health (light: only what affects Alex)

Unit tests: 423 files, 7,466 tests, all passing in 115 s. Last CI on main: all 12 phone-width browser shards green on the first try; the shards sampled show no flaky test.

| # | Finding | Why it matters to Alex | Cost |
|---|---|---|---|
| C1 | Three unit tests build the season from today's calendar year (`tests/integration.api.test.ts:823`, `tests/matchup.service.test.ts:212`, `tests/startSitReadCost.test.ts:40`); the app's data says 2026. They fail from 1 January, and CI and Release both run them. | No fix could deploy during championship week (week 17 is Sunday 3 January). | 0.5 h |
| C2 | One failed `/api/auth/status` read brings back the old Trades and Players screens for the whole session, with no message (`web/features.ts:22-31`, `App.tsx:212-220`). | Alex could be on retired screens and not know. | 0.5 to 1 h |
| C3 | From Tuesday 3 AM to Wednesday evening the odds refresh and the 3-hourly read use Sleeper's week while the screens use the app week (`vegasRefresh.ts:1066-1076`, `worker/index.ts:498-512`). | On waiver night last week's opponent gets the odds lines and the third look-ahead week is missing. | 1 to 2 h |
| C4 | Size budgets nearly full: CSS 19.2 of 20 KB gzip (the standing cap), entry JS 122.1 of 125 KB. The old Trades screens are 12 KB of that JS and about 2 KB of the CSS, because `TradesTab.tsx:10` imports them directly. | The next visible change may not fit the stylesheet cap. | 4 to 6 h to delete the old screens |
| C5 | The browser tests start the app with the three switches at their old values (`dev-server.mjs:140-144`); the live Trades, Players and look-ahead screens get 7, 9 and 1 tests. | The tests mostly guard screens Alex no longer sees. | 1 to 2 h |
| C6 | A failure inside the five-minute job only reaches `console.error`; the cron watch reads run outcomes only (`worker/index.ts:341-610`). | An odds-clock or league-read failure on every tick raises no alert. | 2 to 3 h |
| C7 | Failed reads say nothing: Compare's list prints "Nobody matches that." on an error; a failed waivers read drops Team's waiver card; a failed injury read falls back to Sleeper's word alone. | An empty or stale answer looks like a real one. | 2 h |
| C8 | Team runs the whole Waivers assembly on every open (`TeamScreen.tsx:211`), and every GET (7 diagnostics routes, trade sweeps) is public with no rate limit. | Cost on a heavy day; a stuck tab or a crawler could spend the day's reads. | 1 to 2 h |
| C9 | Dead code still maintained: the decision feed (about 550 lines, nothing writes to it), 18 routes only tests call, about 4,670 lines only tests reach. | Slows every change; no direct harm. | 2 h |
| C10 | Two source files contain NUL bytes (`server/repos/rankDecomposition.ts`, `core/managers/ledger.ts`), so code searches skip them. | A later audit can miss code. | 10 min |

Duplicate rules that can disagree (the toss-up bar and the minus 1 each have one owner and cannot): bye detection has three rules (`nfl/schedule.ts:277`, `schedule.ts:317`, `tradeValue/weeks.ts:130`); five point formatters round 12.45 two ways; Doubtful prints OUT on Matchup; Team has no preseason fallback where Compare and Matchup do; the week rolls over on three clocks.

Dead switches: `PLAYERS_INSEASON` and `WAIVERS_LOOKAHEAD` (on since 12 and 13 November) can go once the browser tests run the live values (60 to 80 and about 40 lines). `TRADES_SCREENS` goes with the old screens (C4). Keep `TRIM_OLD_ROWS` (a brake). `CLOUDFLARE_ACCOUNT_ID` is empty, so the in-app database meter says "not connected": fill it in (an id, not a secret) or remove the panel.

## 7. Gaps: what a very good in-season tool does that this one does not

Cheapest and most valuable first. Rough cost in brackets.

| # | Idea | Reward | Rough cost |
|---|---|---|---|
| G1 | **Pulled lines as a late-scratch alarm.** When the books pull a player's props at the 1.5 h or 0.5 h look, the app now shows "No line yet" and ranks him on Sleeper's number. A line pulled that close to kickoff is a strong sign he is out. Flag it red on Team and Matchup. Uses odds the app already buys and covers the 4 PM, night and Thursday games the once-a-day Sleeper download misses (see part 3). | High in the playoffs: one zero in a starting slot can end a season | half a day |
| G2 | **Honest freshness labels.** Team's "Updated" is when a refresh finished, not how old the data is; Data health's Vegas and Injuries rows almost never go stale; two Setup messages can never be true. Show one age per input on Data health, and the line time on a row when it is old. | Medium: Alex can trust or discount a number at a glance | half a day |
| G3 | **Check an offer by name.** Let Check a trade take typed names for both sides (no team picker first), and add "Check this" on an offer card. Sleeper's documented API does not show pending offers, so typing stays. | Medium: 10 to 11 taps down to about 5 | half a day |
| G4 | **A Sunday 11:45 AM check on Team.** One card: starters on bye, Out or Doubtful, Questionable in a late game with a safe early fallback, empty slots, and the pulled-lines flag. "All clear" or the two things to fix. | High: the one look Alex needs before 1 PM | 1 day |
| G5 | **How the app did last week.** A Tuesday card: the app's lineup against Alex's and the best possible, picks right and wrong, waiver adds that paid off. The grading code exists (`core/grading`) and nothing shows it. | Medium: trust, and a check that catches drift early | 1 day |
| G6 | **Playoff outlook.** Weeks 15 to 17 for each starter and the defense, and Alex's chance to make the playoffs from the remaining schedule, using the Matchup model. One of his ten jobs has no screen today. | Medium to high before the trade deadline | 2 days |
| G7 | **Push alerts** (free web push on a home-screen app): a starter ruled Out or his lines pulled, waiver results, an empty slot an hour before lock. Never acts for Alex. | High, but needs G1 first to have something worth sending | 2 to 3 days |
| G8 | **Win chance on a toss-up.** "Starting X moves you from 54 to 57 percent", from the Matchup simulation, only when the call is a toss-up. Puts Alex's underdog/favorite rule in his own terms. | Low to medium | 1 to 2 days |
| G9 | **Weather for outdoor December games** (free forecast feed). The engine has a weather slot but nothing feeds it (`startSitRefresh.ts:350`). | Low: no kicker in this league; wind moves passing a little | 1 to 2 days |
