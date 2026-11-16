# Round 29: full site audit (report only)

Sunday 15 to Monday 16 November 2026, week 10. All times Eastern. Production `101ad32` (Round 28). Nothing in the app changed. Sources: one combined production check (Probe run 43806507760, Sunday 11:50 PM, right after the 7 PM database reset; its own queries read 17,800 rows and the day stood at 2 percent when it started), code reading, a local copy of the app at iPhone Air size, and the saved data from Rounds 16 to 28.

Files in this folder:

- `round29-probe.txt`: what the production check printed.
- `round29-data.json`: the saved data behind the accuracy and freshness numbers (weeks 8 to 11; league ids removed).
- `round29-agreement.txt`, `round29-accuracy.txt`, `round29-freshness.txt`, `round29-cost.txt`: each analysis, in full.
- `method/`: the scripts that made them (no database read needed to re-run).
- `helpers/`: the four helper reports this audit drew on (screen-number trace, freshness map, screen inventory, code health).

## What the app is like to use

- **It answers the right questions fast.** Team opens on the pick with one reason, every row has a number, and Waivers, Trades and Players each lead with a recommendation. Underneath, one shared formula feeds Team, Compare, the Players card and Waivers' pickup check, and in production they matched to the cent for every player checked.
- **It trips over itself in the details.** The card behind a row prints a different number (up to 1.1 points off) and can say "Bench this week" for the player the row says to start. Matchup's card follows Sleeper's lineup, not the app's. A Doubtful player reads "D", "OUT", "Out" or "who is Out" depending on the screen.
- **It still talks too much.** Every player card carries a "Not known yet" line and a confidence caption; Matchup shows a model name and "4,000 simulated afternoons"; Setup has 60-plus help sentences.
- **Game day is its weak spot.** Odds are fresh (about 12 minutes old at kickoff), but a late scratch in a 4 PM, night or Thursday game is never seen before kickoff, and at 11 AM Sunday the Sleeper injury statuses are 31 hours old.
- **Its advice has been sound.** In weeks 8 to 10 it never disagreed with Alex's lineup beyond a toss-up, and its trade finder would have offered 9 deals, 7 of which helped in hindsight. The one bad call found is new: on Sunday night the top waiver move said to drop a starter whose game was already over.
- **It is cheap again.** Round 28's fix took reads from 2 to 3 million a day (up to 69 percent of the shared cap) to a projected 0.8 million on a heavy Sunday.

## Top 10, cheapest and most valuable first

| # | Finding | Cost | Reward |
|---|---|---|---|
| 1 | Three unit tests read the calendar year; from 1 January they fail and block every deploy. Week 17 is Sunday 3 January. | 0.5 h | High (insurance) |
| 2 | During games, Waivers' "Do this" and Team's Best move can say to drop a starter whose game is over for a later-game pickup Sleeper will refuse. Live, Sunday 11:51 PM: "add Quentin Johnston, drop Hunter Henry, +1.5", with every one of Alex's starters already played. | 1 to 2 h | High |
| 3 | Team's bench card says "Bench this week" for the player the row and Best move say to start. | 1 to 2 h | High |
| 4 | One failed status read silently puts Alex back on the retired Trades and Players screens for the session. | 0.5 to 1 h | Medium |
| 5 | Say it once, plainly: Doubtful reads OUT on Matchup and four ways in all; every card carries a "Not known yet" disclaimer; developer text shows on Matchup, Data health and Review. | 1 to 2 h | Medium |
| 6 | From Tuesday 3 AM to Wednesday evening the odds refresh and the 3-hourly read still use last week, so on waiver night last week's opponent gets the odds lines and the third look-ahead week is missing. | 1 to 2 h | Medium |
| 7 | The card behind a row prints a different number than the row for every priced player (up to 1.1 points), and Matchup's card says "Start at QB" for the QB Team benches. | 2 to 3 h | Medium to high |
| 8 | Heavier reads hit the free plan's CPU cap. In the production check, Data health failed, 10 of 20 Players cards failed, and all 3 metered trade checks failed with Cloudflare's "exceeded resource limits". | 2 to 4 h | Medium |
| 9 | Late scratches in 4 PM, night and Thursday games are never seen before kickoff. Odds pulled at the last look are a cheap "check his status" warning: in week 10, 6 of 9 such players did not play, but 2 of Alex's starters had theirs pulled and played. | Half a day | High in the playoffs |
| 10 | Checking an offer Alex received takes 10 to 11 taps. Let Check take typed names before the deadline (Monday 23 November). | Half a day | Medium |

Just below the ten: tight ends are overvalued by 2.1 points a game on recent weeks (1 day); the stylesheet is at 19.2 of its 20 KB cap, with 12 KB of retired Trades code still in every page load (4 to 6 h); the win chance is never saved at a moment that can be graded (1 h).

## Five recommended next rounds

| Round | What | Cost | Reward |
|---|---|---|---|
| 30, quick trust fixes | Items 1, 2, 3, 4 and 5 | About half a day | Removes the wrong game-day move and every contradiction Alex can see on Team |
| 31, one number per player | Item 7, one rounding rule, the same verdict word on an offer card and in Check, and a week label on Waivers from Sunday to Tuesday | About 1 day | Every screen tells the same story |
| 32, waiver night and the deadline | Items 6 and 10, and a check of the tight end values | About 1 day | Before the trade deadline, Monday 23 November |
| 33, game day | Item 9, honest freshness labels, and a Sunday 11:45 AM check card on Team | 1 to 1.5 days | Ready before the playoffs (week 15) |
| 34, reliability and room | Item 8, browser tests on the live switches, delete the retired Trades screens, alerts for the five-minute job | 1 to 2 days | Fewer silent failures, room under the size caps |

## Needs Alex's decision

1. **Late scratches.** Add a second Sunday Sleeper download (about 3:30 PM, for the 4 PM games), past Sleeper's once-a-day request, or rely on the pulled-odds warning? Recommendation: the warning first (no new download), measure two weeks, then decide.
2. **Stale pull requests #421, #261 and #212.** Recommendation: close all three (details in part 5).
3. **Retired Trades screens and the two always-on switches.** Recommendation: delete them in Round 34, once the browser tests run on the live screens.
4. **The in-app database meter on Data health** (never connected). Recommendation: remove it. The round checks read Cloudflare's totals, and Data health is one of the pages hitting the CPU cap.

## 1. Agreement: same player, same week, same number and pick?

Production, Sunday 11:51 PM (week 10, only Monday night's game left), one burst of reads inside 12 seconds with the odds clock unchanged before and after. The 20 players: Alex's 12 starters and bench players with a number this week, and the 8 free agents Waivers and Compare put forward. Compare needs the passphrase, so its answers were rebuilt with the app's own code from the Matchup snapshot's inputs (no IR flag and Team's mode, as the live Compare route does). A second pass rebuilt Team and Compare as of 12:45 PM Sunday, before the main slate locked, to compare picks without game-lock noise.

**Short answer.** The numbers agree where they are computed: one shared formula, identical to the cent on Team, Compare, the Players card and Waivers' pickup check. They disagree in what Alex sees, six ways.

| Player | Status | Team row | Card on tap | Compare | Players card | Matchup (live) | Waivers (week 11) | Season value: Players / Trades |
|---|---|---|---|---|---|---|---|---|
| C.J. Stroud | | 32.2 | 32.3 | 32.2 | 32.2 | 26.4 | 22.9 | 56.5 / 56.5 |
| Emmett Johnson | | 15.3 | 14.9 | 15.3 | **15.4** | 32.1 | 9.1 | 24.8 / - |
| Bijan Robinson | | 17.0 | **17.5** | 17.0 | failed | 15.7 | bye | 106.6 / - |
| Nico Collins | | 16.2 | **17.3** | 16.2 | 16.2 | 19.9 | 13.8 | 76.4 / 76.4 |
| Omar Cooper Jr. | | 7.0 | 6.9 | 7.0 | failed | 0.0 | 8.6 | 29.9 / 29.9 |
| KC Concepcion Jr. | | 8.8 | **8.4** | 8.8 | failed | 10.2 | bye | 22.8 / - |
| Hunter Henry | | 8.3 | 8.1 | 8.3 | 8.3 | 3.2 | bye | 0.0 / - |
| Sam LaPorta | | 10.0 | 9.7 | 10.0 | 10.0 | 2.1 | 10.2 | 26.5 / - |
| Jaxon Smith-Njigba | | 16.4 | **15.4** | 16.4 | failed | 27.1 | bye | 121.6 / - |
| Ladd McConkey | Questionable | 9.8 | 9.7 | 9.8 | failed | 9.8 (Q) | 10.0 | 29.6 / 29.6 |
| Makai Lemon | bye | Bye | - | - | failed | 0.0 | 4.4 | 0.0 / - |
| Jonah Coleman | bye | Bye | - | - | bye | 0.0 | 15.2 | 62.9 / - |
| Quentin Johnston (FA) | | | | 6.1 (Waivers) | 6.1 | | 6.4 | 0.4 / - |
| Aaron Rodgers (FA) | | | | 21.5 | failed | | | 8.6 / - |
| Deshaun Watson (FA) | | | | 20.3 | 20.3 | | | - |
| Kirk Cousins (FA) | | | | 18.6 | failed | | | - |
| Jacoby Brissett (FA) | | | | 18.4 | **18.5** | | | - |
| Drew Lock (FA) | | | | 18.1 | failed | | | 1.0 / - |
| Geno Smith (FA) | | | | 17.9 | **18.0** | | | - |
| J.J. McCarthy (FA) | | | | 17.7 | failed | | | - |

"Failed" is Cloudflare's CPU-cap error (item 8). Trades values are shown for players in the three live offers. Bold marks a value that differs from the Team row or the Compare list.

| # | Mismatch | Screens and values | Cause |
|---|---|---|---|
| A1 | The card behind a row prints a different number | Team row vs the card it opens (Matchup opens the same card), all 13 priced players on Alex's roster: Collins 16.2 vs 17.3, JSN 16.4 vs 15.4, Bijan 17.0 vs 17.5, Emmett Johnson 15.3 vs 14.9; Kenneth Walker (Out) "Out (16.9 if he played)" vs 15.9 | The row prints the decision number (market plus news, usage and matchup nudges); the card prints the bare market or Rotowire figure (`core/startsit/weekCard.ts:320-337`) |
| A2 | The top waiver move breaks the lock rule | Waivers "Do this" and Team's Best move: add Quentin Johnston (Monday night), drop Hunter Henry, "Starts this week: +1.5 pts", with all of Alex's starters locked. Rest-of-season gain of the move: +0.01 | The pickup's drop is taken out of the lineup before it is solved, even when he is a locked starter (`core/waivers/pickupStart.ts:255-257`; the drop comes from `core/waivers/assemble.ts:761-765`) |
| A3 | The pick vs the card | Pre-kickoff, Team leans McConkey over Omar Cooper Jr. (a toss-up); McConkey's bench card says "Bench this week" | Every bench row opens its card with `starting: false` (`TeamScreen.tsx:666`) |
| A4 | One trade, two verdicts | Offer card "Close: small gain for them" vs Check a trade "Good for you" for the same deal (give Jordan Love and Nico Collins for D'Andre Swift). The other two offers matched ("Fair" both times) | The offer label comes from the finder's close-deal labels, Check's word from `core/trades/verdict.ts` |
| A5 | Players rounds the other way | Emmett Johnson 15.3 vs 15.4, Brissett 18.4 vs 18.5, Geno Smith 17.9 vs 18.0. The values are identical (15.35, 18.45, 17.95) | `Math.round` on the Players card (`playersSeasonService.ts:202`), `toFixed` elsewhere; about 1 value in 25 |
| A6 | Waivers is a week ahead from Sunday to Tuesday | Waivers' first column is week 11, the first week a claim can play, while Team, Compare and Players show week 10: Stroud 22.9 vs 32.2, and "bye" for Bijan, JSN, Concepcion and Henry | By design for claims, but nothing on the screen says which week |

**What agreed.** The this-week number on Team, Best move, the Compare list, the Compare card and the Players card for every player (apart from A5). Season values: Players "Value" equals the Trades value for all 9 players in the 3 live offers. Players' "Likely" and "Maybe" trade targets are exactly the players the offers bring in. Injury chips: no split between Sleeper's word and the merged status among the 35 players in this week's matchup. Toss-ups: Team and Compare both called McConkey over Cooper a toss-up leaning McConkey (the 3.5 bar for a Questionable player with no line). Matchup's live projection differs from Team's during games by design.

**Not seen live, but real in the code** (`helpers/agreement-trace.md`): a Questionable player in the IR slot reads Out on Team but "17.0 Start" on Compare, Matchup and the Players card; Trades' "this week" uses the season rate; Compare still names a pick for a player whose game has started. Alex's only IR player tonight is also on Sleeper's IR list, so every screen agreed he is out.

## 2. Accuracy: the last three weeks against what happened

Data: Round 16's file for weeks 1 to 7, and this round's (`round29-data.json`) for weeks 8 to 10, rebuilt with today's rules (75/25 blend, minus 1, odds read the way the app reads them since Round 23). Week 10 is final except Monday night (Baltimore at the Chargers). Lineups are judged in hindsight, which flatters every move alike.

| Decision | Weeks 8 to 10 | Round 16 | What moved |
|---|---|---|---|
| Start/sit: the app's lineup vs Alex's | The same lineup every week apart from 2 toss-ups: week 8, Makai Lemon over Omar Cooper Jr. (the app's lean scored 8.7 more); week 10, McConkey over Cooper (Monday night). No disagreement past the toss-up bar | Weeks 3 to 7: 3 toss-up differences, all went Alex's way (-14.8) | Nothing to fix: the app and Alex agree |
| Toss-up bar | A lead of 0 to 1 point won 52% of the time, 1 to 2: 55%, 2 to 3: 62%, 3 to 5: 67%, 5 or more: 72% (weeks 1 to 10) | 51, 55, 59, 67, 72 | Unchanged: the 2.0 bar holds |
| Minus 1 for a number with no Vegas line | Best-fit discount 0.94 points (range 0.40 to 1.49) | 0.94 | Unchanged: Round 17's minus 1 holds |
| Season value (75/25) | Miss 5.62 points a game against 5.58 for projection only (inside the noise); season average only +0.50, last 3 games +0.90 | 50/50 4.12; 75/25 3.86 on the same data | The blend Alex chose is as good as the best rule. Tight ends are overvalued by 2.1 a game (Round 16: 1.2); quarterbacks by 0.9 |
| Waiver planner, replayed | 3 "Worth considering" moves, 1 paid off, average -3.1 lineup points through week 10 | 9 moves, 6 paid off, +12.1 | Worse on a tiny sample (one add suggested twice) |
| Live waiver lines | Sunday night's "Do this" was wrong (A2) | | New |
| Waiver bids (Round 20) | No claim with a bid since Round 20 went live | | Not yet testable |
| Trade finder (Round 19), replayed | 9 offers, 7 helped Alex's best lineup in hindsight, +11.3 points on average over 1 to 3 weeks. 7 of 9 brought in a quarterback, which fit then: Jordan Love was Alex's only QB until he won Stroud in week 9 | The old search showed no trade at all | A big improvement |
| Win chance (Matchup) | Cannot be graded. The "first" forecast is saved at 4 AM Tuesday, before the week has numbers: 45 points low on the team total and worse than a coin flip. The Sunday-morning chance Alex sees is never saved | | Save the Sunday 11 AM forecast instead (1 h) |

Limits: weeks 9 and 10 have only one or two weeks to judge; injury status for weeks 8 and 9 is the official report only (Sleeper's word is not stored by week); trade partners' habits are approximated from this season's trades.

## 3. Freshness: how old each input is when Alex decides

Measured from production: every odds look at every game of weeks 8 to 11, the injury file's publish times, Sleeper's download times and the roster reads. Expected: the schedules in `helpers/freshness-map.md`. The two agree.

**For a Sunday 1 PM game:**

| Input | Tue 9 PM | Thu 6 PM | Sat noon | Sun 11 AM | 15 min before kickoff |
|---|---|---|---|---|---|
| Odds (props, total, spread) | 8 h (the 120-hour look at 1 PM Tuesday, new in Round 23; in weeks 9 and 10 most Sunday games had no line yet on Tuesday night) | 2 to 8 h | 23 h (measured, week 10) | 1 h | 12 min |
| Injury report | Last week's | Wednesday's practice report | Friday's final (arrives about 2 AM Saturday) | Plus Saturday's changes (arrived 2:05 AM Sunday) | Same; never has inactives |
| Sleeper status, which carries inactives | 17 h | 14 h | 8 h | **31 h** | 30 min (the 12:15 PM download) |
| Sleeper projections | 17 h | 14 h | 8 h | 1 h (the 10 AM fetch) | 2 h 45 min |
| Rosters and lineup | Under 3 h | Under 3 h | Under 3 h | 45 min | 2 h 30 min |

For later games at 15 minutes before kickoff, odds are still about 12 minutes old, but Sleeper's statuses are 4 hours old for a 4:25 PM game, 8 hours for Sunday night and 16 hours for Monday and Thursday nights.

**Does a stale input move the number?** Odds, barely after Saturday. From Saturday noon to kickoff, half the players' numbers moved 0.07 points or less and 4 of 168 moved 2 points or more (week 10). From Sunday 11 AM, 3 of 168. From Tuesday 9 PM the typical move was 0.5 to 0.7 points and 1 in 10 moved more than 2.2, because most players had no line yet.

**Where the gap is biggest: game-day status.** A player ruled inactive for a 4 PM, Sunday night, Monday or Thursday game is never seen before kickoff: Sleeper's list is downloaded once a day (at Sleeper's request), and the official injury file never carries inactives. Second: at 11 AM Sunday the statuses are 31 hours old until the 12:15 PM download. Odds are not the problem.

**Pulled odds as a warning, tested.** In week 10, 9 players had lines on Saturday or Sunday morning and none at the last look before kickoff. 6 did not play; 3 did, including two of Alex's starters (Emmett Johnson 32.1, KC Concepcion 10.2). Good enough for "check his status", not for "Out".

**The screens' freshness promises are weak** (`helpers/freshness-map.md`, section 3): Team's "Updated" is when a refresh finished, not how old the data is; Data health's Vegas row almost never goes stale; two Setup messages can never be true ("start/sit lowers its confidence" and "allowance is used up").

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


## 5. Cost and health

### Database rows per day (Cloudflare's own totals)

Caps, shared by all of Alex's sites: 5,000,000 rows read and 100,000 written a day. The day resets at 7 PM.

| Day ending 7 PM on | App reads | All sites (share of cap) | App writes | All sites (share of cap) |
|---|---|---|---|---|
| Thu 12 Nov | 2,774,267 | 3,129,459 (63%) | 18,077 | 22,453 (22%) |
| Fri 13 Nov | 3,123,525 | 3,427,820 (69%) | 15,330 | 18,491 (18%) |
| Sat 14 Nov | 2,038,680 | 2,408,045 (48%) | 9,358 | 12,167 (12%) |
| Sun 15 Nov | 3,063,476 | 3,370,873 (67%) | 14,490 | 16,243 (16%) |
| Sun 7 PM to 11:50 PM | 81,053 | 101,804 (2%) | 366 | 1,478 (1.5%) |

Rounds 10 to 15 had brought reads down to about 1.5 million a day; Round 23's extra odds looks pushed them back to 2 to 3 million. Writes are fine (they were at 93 percent on 8 November, before Round 14).

### By source (last 72 hours)

Cloudflare's per-statement report is sampled and over-counts by about 1.8 times against the hourly totals, so the shares below matter, not the counts.

| Source | Share of reads |
|---|---|
| The odds refresh re-reading the whole week's lines for each game (`server/repos/props.ts:177`). Fixed by Round 28 on Sunday at 1:43 PM: about 700 rows a call instead of 48,000 | 75% |
| Screens reading odds lines for their players (`props.ts:250`: Team, Waivers, Players, Trades), about 3,000 rows a call | 18% |
| Odds freshness counts (`props.ts:524` and `:490`) | 1.4% |
| Usage weeks, implied team totals, schedule, injury report, projections, evidence, transactions (each under 1%) | about 4% |
| Everything else | about 2% |

Writes: odds lines 42%, depth charts 21% (twice a day), the player list 7%, the old-odds trim 5%, projections 5%, injury changes 3%, trending 3%.

Since the fix, Sunday 2 PM to 11:50 PM (ten hours of live games): 227,000 reads, 50,000 of them Round 28's own check. The busiest hour was 5 PM at 88,000.

### Heavy-Sunday risk: low now

Sunday 15 November read 3.06 million app rows with the old odds read. Take that read out (three quarters of reads) and a heavy Sunday is about 0.8 million, under a fifth of the cap even with other sites. A deploy's live check costs 130,000 to 190,000 rows, so several deploys on a Sunday still fit. What could still burn a day: every read is public with no rate limit, including 7 diagnostics routes and trade sweeps, so a stuck tab or a crawler would read at full speed (part 6, C8).

Odds budget: 108 of 2,500 games used this billing period (4%), so the 70 percent brake that stops discovering new games is far off. TheRundown: 110 of 6,000 points today. The Odds API: 430 credits left. Both extra sources are live.

### Jobs and checks

- **GitHub, 12 to 16 November (last 100 runs).** CI on main green every time. One failed CI run on a pull request, fixed by its next push. One failed Probe run: `probe-d1-usage-hours.mjs` never receives the Cloudflare token (it is on the unguarded list in `probe.yml` but not on the token list), a one-line fix. Cron watch 13 of 13 and daily tick watch 4 of 4 green.
- **The app's scheduled jobs.** The 4 AM daily refresh and the Saturday 6 PM and Sunday 10 AM refreshes all succeeded on their last runs. Sleeper's player list downloaded every day (Sunday at 12:15 PM). The 3-hourly league read: 363 runs, none failed. The injury check failed in two bursts, Wednesday 4 November 12:55 to 2:00 AM (14 in a row) and Sunday 8 November 3:45 to 6:40 AM (18 in a row), and recovered on its own. Clean since 9 November. Nothing alerts on such a burst (C6).
- **Worker errors.** Cloudflare recorded one "exceeded resources" request in the four days before the check (13 November), and 5 to 27 requests a day that the phone gave up on. The check itself drew 16 such errors on the heavier reads (top 10, item 8).
- **Flaky tests.** None in the shards sampled; the two known ones were left alone.
- **Dead switches.** See part 6.

### Stale pull requests

| PR | What it is | Recommendation |
|---|---|---|
| #421 | The November expert review register (docs only, 3 November). Rounds 1 to 17 worked through its findings, and this audit supersedes it. | Close. Its file stays readable on its branch. |
| #261 | Wires the in-app database meter (fills `CLOUDFLARE_ACCOUNT_ID`, publishes a read-only analytics token). Opened 9 September, never merged; the meter still says "not connected". | Close. If Alex wants the meter, redo it as a fresh small change. A two-month-old workflow change is riskier to rebase than to rewrite. |
| #212 | A status note about the August sheet fix (docs only, 28 August). | Close. Nothing in it is current. |

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

## How it was measured

- **Production, once.** `method/probe-round29.mjs` and `method/probe-round29-gather.ts` ran once through the Probe workflow on the audit branch (run 43806507760, Sunday 11:50 to 11:51 PM, today's reads at 2 percent when it began). Reads only: Cloudflare's totals by day, hour and statement; small run-state and timestamp tables; the matchup forecasts; Sleeper's documented league endpoints; each screen's own GET; the support snapshots. Everything was packed into the log with the league ids replaced, and decoded into `round29-data.json` and the analysis files here. The probe lived on the branch only and was removed before this pull request.
- **Code.** Four helper reports (`helpers/`), each checked against the code where this report relies on it: the bench-card verdict (`TeamScreen.tsx:666`), the pickup drop (`pickupStart.ts:255`), the calendar-year tests, the weather feed, the grading code.
- **Phone.** A local copy of the app with the production switches on, in Chromium at 420 x 912 (`helpers/screen-inventory.md`). Seeded data, not Alex's league.

## Limits

- One evening, week 10, mostly after kickoff. Picks were also compared on a rebuild as of 12:45 PM Sunday from the inputs captured at 11:51 PM (the same lines and statuses, minus the locks).
- Compare was rebuilt, not read live: it needs the passphrase.
- Accuracy windows are short (one to three weeks of outcomes) and judged in hindsight; week 10 is missing Monday night.
- The screen inventory ran on Chromium with seeded data; a real iPhone may wrap text differently.
- Sixteen production reads failed on Cloudflare's CPU cap, so the Players card column has gaps and the per-player Trades rates were not read.

## Re-running

```
node docs/audit/method/unpack.mjs <saved job log> bundle.json        # the packed data, from the Probe log
python3 -I docs/audit/method/merge.py docs/backtest/round16-data.json docs/audit/round29-data.json merged.json
node --experimental-transform-types --no-warnings docs/audit/method/lineups.ts merged.json 8 10 10
LAST=10 WEEKS=8,9,10 node --experimental-transform-types --no-warnings docs/audit/method/score29.ts merged.json
node --experimental-transform-types --no-warnings docs/audit/method/freshness.ts docs/audit/round29-data.json
```

The scripts import the app's own code by absolute path from the checkout they were run in; change the path prefix to re-run elsewhere. No database read is needed.
