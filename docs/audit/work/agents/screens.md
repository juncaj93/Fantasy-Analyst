## Phone audit (iPhone Air, week 10)

**REPORT.md was not written.** The environment refused it ("Subagents should return findings as text, not write report files"), so the full report is below for you to save to `/tmp/claude-0/-home-user-Fantasy-Analyst/888e0c9d-79c7-5a10-9224-61d9addd6497/scratchpad/screens/REPORT.md`. The 138 screenshots, per-state data and scripts are already in that folder. The repo is unchanged (`git status` is clean; only `dist/` was built). Nothing contacted the network: every outbound fetch was blocked.

### Top findings, most annoying to Alex first

1. **Team contradicts itself.** The QB row says "→ Start Rhys Donnelly instead", but tapping Donnelly (or Grant Aldous, the Best-move pick) on the bench opens a card reading "Bench this week". Bench rows always open with `starting:false` (TeamScreen.tsx:666, core/startsit/weekCard.ts:396). Screenshot: `contradiction-row-vs-bench-card.png`.
2. **Matchup contradicts Team.** Halloran's Matchup card says "Start at QB" while Team says bench him. The opponent's QB also gets a green "Start at QB". Cards follow Sleeper's current lineup (core/matchup/build.ts:519). The card's "Compare" button only closes it (MatchupScreen.tsx:240).
3. **One Doubtful player gets four labels:** "D" on Team, Compare and Players; "OUT" on Matchup (core/matchup/model.ts:619); "who is Out" in Best move; "Out" as the Compare score. IR shows as "IR" or "OUT", Out as "OUT" or "O" (waiverCard.ts:216), and the chip styles differ between screens.
4. **A disclaimer on every player card:** "Not known yet: role trend, opponent tendency, expected points from usage." (weekly.tsx:186), plus a "high confidence" caption.
5. **Two numbers for one week:** the Vance row says 16.3, his card says "Proj 15.8".
6. **Waiver card vs sheet:** the card shows "+66.2" (3 weeks, no unit); the sheet opens on "This week" showing 22.1.
7. **The bid reason is cut off** in the waiver sheet: one nowrap line, 515px of text in a 388px box ("…so $9…").
8. **Checking a received offer takes about 10-11 taps** through Trades > Check. The "Offers" tab holds the app's own suggestions, not offers Alex received.
9. **Developer text** reaches Alex: "Model matchup-1.0.0", "4,000 simulated afternoons", "See docs/DATA_HEALTH.md.", "Accept all non-mixed ≥0.6 confidence", "GraphQL schema".
10. **Refresh differs on every screen:** Team uses a button plus pull (all sources), Waivers a button plus pull (Sleeper only), Matchup pull only, Trades pull that only re-reads, Players nothing. "Updated" time is shown in four formats.
11. **Matchup's player buttons are 167x31.7.** Other targets under 44px include the Compare chip × (28 wide), the weekly-card Compare (36 tall), Players QB/RB/TE chips (40 wide), Back buttons (36 tall), many Setup and Review buttons (32 tall), and the "Demo Mode" summary (15 tall).
12. **"Rank" means two things in Players:** list position (renumbered per filter) vs draft rank on the card. "Season" also means three different numbers on three screens.
13. **The same trade reads differently** in the Offers sheet ("for Dermot", has a Playoffs row) and in Check ("for you now", adds "thinner at").
14. **Team's "Waiver moves" falls below the fold** with a full roster: the first row (with the bid chip) sits half under the tab bar.

### Tap counts and fold

- **Tap counts from opening:** start/sit 0-1, compare 4 (1 if it's the suggested swap), matchup 1, bid amount 1, received offer about 10-11, trade target 3, refresh 1, injuries 0-1.
- **Not possible:** bye cover lines exist but can't be tapped; playoff outlook has no view at all.
- **Fold:** the pick and its reason are above the fold on every screen. What spills: Team (1004px), Check (1068px), Data health (1496px).

### How it was run

- **Servers:** a local copy of the dev server at week 10, with the three production switches on.
- **Team and Compare:** the seeded league reshaped to Alex's slots and a 17-man roster, in the local database only.
- **Trades and Players:** the e2e preview leagues.
- **Bids and look-ahead lines:** the e2e suite's injected waiver payloads.
- **Viewport:** Chromium at 420x912, standalone simulated, top safe area assumed to be 62px.
- **Demo Mode** was rejected because its data is stale.

---

# FULL REPORT (save as REPORT.md)

# Fantasy Analyst: in-season phone audit (iPhone Air, week 10)

Repo `claude/new-session-xlfaay` at 101ad32. Report-only: nothing in the repo was changed (only `dist/`, written by `npm run build` and `npm run build:server`).
All files named below without a folder are in `/tmp/claude-0/-home-user-Fantasy-Analyst/888e0c9d-79c7-5a10-9224-61d9addd6497/scratchpad/screens/`.
Quoted app text is exact, so it keeps the app's own em-dashes; the rest of this report avoids them.

## 0. How it was run

- **Server.** `tools/local-server.mjs` is a copy of `scripts/dev-server.mjs` with three changes. First, it blocks every outbound `fetch`, so nothing reached Sleeper, Cloudflare or the live site (the log shows no blocked calls). Second, it sets Sleeper's NFL state to regular season, week 10. Third, it can reshape the league (below). All three production switches were on: `TRADES_SCREENS=new`, `PLAYERS_INSEASON=on` and `WAIVERS_LOOKAHEAD=on`.
- **Worlds used.** The seeded league is permanently mid-draft and small, so each screen used the most realistic source available:
  - **A. "seeded wk10"** (port 8790): the e2e suite's seeded league plus the suite's in-season answers. `/api/overview` returns the regular season, and `/roster` returns `live:false`, `drafted:[]` (`e2e/helpers.ts` `inSeason`). This world was used for Waivers, Matchup, Setup, Data health and Review.
  - **B. "Alex-shaped"** (port 8793): the same seed, with the league reshaped in the local database only. It has QB/2RB/3WR/TE/2FLEX/DEF, 6 BN, 2 IR, 10 teams, and Alex's roster has 17 players. This world was used for Team, Compare, the weekly card and fold heights. Matchup rosters still come from the dev Sleeper mock, which has 8 slots, not 10.
  - **C. Preview leagues** for the Trades and Players lists (the `PREVIEW=trades` and `PREVIEW=players` servers on ports 8791 and 8792). The browser forwards `/api/trades/screens/*` and `/api/players/season` to them, which is the same data the e2e specs use. It is a made-up 4-team league with Alex's exact slots, at week 10, with trade deadline week 11 and playoffs from week 15.
  - **D. Bids and look-ahead lines.** The seeded league has only free agents. For these, the e2e payloads were injected over world A, moved to week 10: `waiver-tiers.spec.ts` round 2 (claims with $9 and $1 bids) and `waiver-lookahead.spec.ts` (stash, cover and block lines).
  - **Demo Mode** (`?demo=in-season`) was opened and then rejected. Its captured week-6 responses are stale: every Team row reads "No projection", Waivers draws the pre-tiers board, Trades says "not in the demo", and Players is the draft-era list.
- **Phone.** Chromium 1243 at 420x912 viewport, `hasTouch`, `isMobile`, `deviceScaleFactor` 1. Standalone mode was simulated (`navigator.standalone`) because `docs/IOS_WEB_APP.md` makes the Home Screen web app the intended way to run it. Safe areas were set to `--safe-top` 62px (an assumption for the Dynamic Island; the doc does not give the Air's value) and `--safe-bottom` 34px.
  - The floating tab bar is 60px tall, at y 835 to 895, with a 17px gap below it.
  - Visible content therefore runs from y 62 to 835 (773px). The sticky nav bar takes about 56px of that.
  - In a Safari tab, Safari's own bars take a further amount that I estimate at roughly 100 to 150px (not measured).
- **Scripts and raw data.**
  - Scripts: `tools/harness.cjs`, `tools/capture*.cjs`, `tools/strings.cjs`, `tools/where.sh` and `tools/small.cjs`.
  - Per-state text and tap-target dumps: `data/<state>.json`.
  - Grouped visible sentences: `data/inventory.txt`.
  - Extracted string literals: `data/web-strings.json` and `data/core-strings.json`.

## Top findings (ranked by how much they would bother Alex)

1. **Team contradicts itself on who to start.** The QB row says "→ Start Rhys Donnelly instead · 22.1", and Best move says "Start Grant Aldous over Cal Whitfield". Tapping Donnelly or Aldous on the bench opens a card whose verdict is **"Bench this week"**.
   - Cause: bench rows open the card with `starting:false` (TeamScreen.tsx:666, core/startsit/weekCard.ts:396).
   - Evidence: `contradiction-row-vs-bench-card.png` and `team-alex-bench-card-donnelly.png`.
2. **Matchup contradicts Team.** Tapping Trey Halloran on Matchup says **"Start at QB"**, while Team says to bench him for Donnelly. Tapping the *opponent's* QB also says "Start at QB" in green.
   - Cause: Matchup cards take `starting` from Sleeper's current lineup (core/matchup/build.ts:518-522).
   - The card's **Compare button only closes the sheet** (MatchupScreen.tsx:240).
   - Evidence: `contradiction-team-vs-matchup.png` and `matchup-seed-card-opponent.png`.
3. **One player, four status words.** Cal Whitfield (Doubtful) is shown four ways:
   - "D" chip on Team, on the Compare chips and in Players.
   - "OUT" on Matchup, where `ruledOut` wins in core/matchup/model.ts:619.
   - "who is Out" in Best move.
   - "Out" as the Compare score.
   - The same split applies elsewhere: IR is "IR" on Team but "OUT" on Matchup, and Waivers board rows use "O" (waiverCard.ts:216-225) where everyone else uses "OUT".
   - Chip styles also differ: Matchup uses square tinted marks, while Team and Players use outlined pills.
   - Evidence: `whitfield-status-three-ways.png` and `chips-compare.png`.
4. **A standing disclaimer on every player card.** Every card carries "Not known yet: role trend, opponent tendency, expected points from usage." (weekly.tsx:186, words from core/startsit/weekCard.ts:179-260). Every card also carries a "high/low confidence" caption (common.tsx:666). This is exactly the kind of line Alex dislikes, shown on every tap.
5. **Two numbers for one player-week.** Marcus Vance shows 16.3 on the Team row, on Matchup and on the Players card, but "Proj 15.8" and "Market 15.8 pts" on the weekly card. The card prints the projection; the rows print decision points (core/startsit/weekCard.ts:320-337).
   - Evidence: `number-row-vs-card.png`.
6. **A waiver card's number never appears on the sheet it opens.** The card says "+66.2" with no unit (a 3-week gain). The sheet opens on "This week" and shows 22.1 against "—". The 66.2 appears only after tapping "3 weeks", as "Total".
   - Evidence: `waiver-card-vs-sheet.png`.
7. **The bid's one reason is cut off.** "Bid $9: Two or more other managers are likely to bid, so $9 to win about 3 times in 4" is a single nowrap line (`white-space:nowrap`, ellipsis). It is 515px of text in a 388px box, so the phone shows "...so $9…".
   - Evidence: `waivers-bids-sheet.png`.
8. **No way to check a received offer quickly.** It takes 10 to 11 taps through Trades > Check, hand-entering both sides. The tab called **"Offers" holds the app's own suggestions, not offers he received**; the app never reads pending Sleeper offers.
9. **Developer text on screens Alex opens:**
   - "Model matchup-1.0.0" and "4,000 simulated afternoons" on Matchup's odds sheet (MatchupScreen.tsx:347, 293).
   - "...no analytics token to ask with. See docs/DATA_HEALTH.md." on Data health (core/health/quota.ts:149).
   - "Accept all non-mixed ≥0.6 confidence" in Review (ReviewScreen.tsx:211).
   - "...no field for it in the GraphQL schema..." in Setup (server/services/playerDetailService.ts:947).
10. **Refresh behaves differently on every screen:**
    - Team: button and pull, all sources.
    - Waivers: button and pull, Sleeper only.
    - Matchup: pull only, all sources.
    - Trades: pull only, which re-reads offers and runs no refresh.
    - Players: nothing.
    - "Updated" is shown four different ways (see section 6).
11. **Matchup's only tap targets are 32px tall.** Every player name button is 167x31.7. They are the main tappable thing on the screen.
12. **"Rank" means two things in Players.** The list's "Rank" is position by value, renumbered in every filter: Pax Holloway is 2 in All and 1 in Trade targets. His card's "RANK 5" is the draft rank. "Value 101.7" (list), "Season 16.3 a week" (card) and "+23 season" (Trades) are three different "season" numbers.
13. **The same trade reads differently in Offers and Check.**
    - The Offer sheet says "Kai Brennan WR · Starts 8 of 8 weeks for Dermot" and has a Playoffs row.
    - Check says "Starts 1 of 8 weeks for you now", has no Playoffs row, and adds "thinner at RB" and "Fair to both sides: both lineups get better.".
14. **Waiver moves on Team fall below the fold.** With a full roster, the "Waiver moves" rows (where Team shows the bid chip) start at y≈785. The first row sits half under the tab bar and the second is off screen (`team-alex-with-waivers.png`).

---

## 1. Blurbs, captions, help lines and empty states, per screen

The tables below use these abbreviations:

- **Seen**: shown at runtime in this audit.
- **Cond**: present in the code for a state this run did not reach.
- **Static**: the sentence is in the web code. **Server**: the server sends the sentence (core/server path given); where the web wraps a server phrase, both are cited.

Pure labels (column heads, button names, position pills) are left out unless they explain something. The pick line itself (for example "Start Grant Aldous over Cal Whitfield") is not counted.

**Counts, distinct texts:**

| Screen | Seen | Cond | Total |
|---|---|---|---|
| Team | 11 | 12 | 23 |
| Weekly card (Team, Matchup) | 9 | 6 | 15 |
| Compare sheet | 2 | 6 | 8 |
| Matchup | 1 | 4 | 5 |
| Odds sheet | 7 | 0 | 7 |
| Waivers | 7 | 8 | 15 |
| Waiver sheet | 3 | 3 | 6 |
| Trades Offers | 6 | 2 | 8 |
| Offer sheet | 7 | 2 | 9 |
| Build | 3 | 4 | 7 |
| Check | 6 | 8 | 14 |
| Players list | 4 | 5 | 9 |
| Player card | 10 | 2 | 12 |
| Player page | 6 | 1 | 7 |
| Setup main (folds shut / all open) | 3 / 13 | 1 | |
| Setup disclosures (Player card data, Projection, Weighting, Install, Demo) | 27 | | 27+ |
| Setup areas (Sleeper, League, Draft order, Newsletter, Vegas, Help my scores) | 33 | | 33+ |
| Data health | 14 | 3 | 17 |
| Review (+ key sheet) | 7 | 8 | 15 |

### Team (TeamScreen.tsx)
| # | Text (exact) | Source | Kind | |
|---|---|---|---|---|
| 1 | "2 changes to make" / "nothing to change" / "nothing to change, one slot unscored" (beside "Your lineup") | TeamScreen.tsx:560, 835-841 | static | Seen |
| 2 | "9/9 priced" (badge on Best move) | TeamScreen.tsx:1726 | static | Seen |
| 3 | "No projection" (under a dash on a row) | rowFigure.ts:78 via TeamScreen.tsx:1231 | static | Seen |
| 4 | "Cannot be scored this week" | TeamScreen.tsx:1185 | static | Seen |
| 5 | "Cal Whitfield is doubtful, so he is not a playable starter" | TeamScreen.tsx:986 + core/startsit/lineup.ts:990 | server | Seen |
| 6 | "is on injured reserve, so he is not a playable starter" | TeamScreen.tsx:1185 + core/startsit/lineup.ts:986/990 | server | Seen |
| 7 | "Nobody eligible yet" | TeamScreen.tsx:991 | static | Seen |
| 8 | "2 strong alternatives" / "No better option" (Bench row) | benchSummary.ts:18, 21 | static | Seen |
| 9 | "No waiver move this week." | TeamScreen.tsx:1581 | static | Seen |
| 10 | Waiver row sub-line, e.g. "Open spot · No QB to start wk 10", "Drop: Shipley · Burrow on bye wk 10" | chips waiverCard.ts:171-180; reason shortened by waiverCard.ts:91-110 from core/waivers/tiers.ts:1505 | static + server | Seen |
| 11 | "Updated 12:56 AM" (nav subtitle after a refresh job) | TeamScreen.tsx:448 | static | Seen |
| 12 | "No change to suggest yet" | TeamScreen.tsx:1910 | static | Cond |
| 13 | "{pts} projected · {slot} is empty in Sleeper" | TeamScreen.tsx:1842 | static | Cond |
| 14 | "→ This slot is empty in Sleeper" | TeamScreen.tsx:1163 | static | Cond |
| 15 | "No line yet: lean X over Y" / "Toss-up: lean X over Y"; bench "No line yet" / "Toss-up" | TeamScreen.tsx:1894; benchSummary.ts:20 | static | Cond |
| 16 | Late-swap risk line "{name}: {detail}" | TeamScreen.tsx:1917 + lineup.lateSwapRisks | server | Cond |
| 17 | Availability warning under Best move | TeamScreen.tsx:1804-1812 | static | Cond |
| 18 | " X is drop-ready." appended to No waiver move | TeamScreen.tsx:1582 | static | Cond |
| 19 | "No waiver comparison available yet." / no-move headline + nearest-miss line | TeamScreen.tsx:1622-1625 + core/waivers/noMove.ts:49 | static / server | Cond |
| 20 | Pickup Best move chips "Starter out", "drop X", "X to IR", "Pick your drop" | TeamScreen.tsx:1961-1966, 2016 | static | Cond |
| 21 | "No league chosen yet. Open Setup to connect Sleeper and pick your league." | TeamScreen.tsx:494 | static | Cond |
| 22 | "Your roster was not found in this league. Check the connected Sleeper user." | TeamScreen.tsx:500 | static | Cond |
| 23 | Error notice (raw server message) | TeamScreen.tsx:491 | server | Cond |

### Weekly player card (Team rows and Matchup rows; weekly.tsx, data from core/startsit/weekCard.ts)
| # | Text | Source | Kind | |
|---|---|---|---|---|
| 1 | "high confidence" / "low confidence" | common.tsx:666 | static + server level | Seen |
| 2 | Verdict "Start at RB", "Bench this week", "Not playable" + detail ("Doubtful", "In your IR slot.", "On IR · knee · has not practiced · sources disagree") | core/startsit/weekCard.ts:360-398 | server | Seen |
| 3 | Line "Availability · Not playing · On injured reserve — not a playable starter." / "Unlikely to play · Doubtful — treat him as unlikely to play." | core/startsit/availabilityConfidence.ts:40, 95 | server | Seen |
| 4 | Drivers "Doubtful — treat him as unlikely to play." | weekly.tsx:154 | server | Seen |
| 5 | "Sources disagree — sleeper: IR · nflverse: Out" | weekly.tsx:164 + core/startsit/weekCard.ts:317 | server | Seen |
| 6 | "Not known yet: role trend, opponent tendency, Vegas expectation, expected points from usage." (on every card) | weekly.tsx:186 + core/startsit/weekCard.ts:179, 206, 233, 260 | static + server | Seen |
| 7 | "More on Marcus Vance" | weekly.tsx:239 | static | Seen |
| 8 | Inside More: Insight text "Named the starter: first-team reps all week and the goal-line back." | playerDetail.tsx:159-166 (text from newsletter via server) | server | Seen |
| 9 | Inside More: "No 2026 outlook published for him." | playerDetail.tsx:291 + server/services/playerDetailService.ts:756 | server | Seen |
| 10 | "Rotowire projection" | weekly.tsx:102 | static | Cond |
| 11 | "What would change this" + list | weekly.tsx:175 + server | static + server | Cond |
| 12 | "Not enough data to rank him" / "He is left out of the comparison rather than assumed bad." | core/startsit/weekCard.ts:388-389 | server | Cond |
| 13 | "His game has kicked off — this spot is settled." / "Not in your Sleeper lineup yet." / "His game has kicked off." | core/startsit/weekCard.ts:377-397 | server | Cond |
| 14 | "Looking it up…" | playerDetail.tsx:281 | static | Cond |
| 15 | Last-season line "2025 · 17 GP · RB1 half-PPR" | playerDetail.tsx:366 (LastSeasonLine) | static + server | Cond (seen once) |

### Compare sheet (compareSheet.tsx)
| # | Text | Source | Kind | |
|---|---|---|---|---|
| 1 | Subtitle "Week 10 · QB slot" | compareSheet.tsx:234 | static | Seen |
| 2 | Raw error line, e.g. "player r1 not found" (red) | compareSheet.tsx:307 / waiverSheet.tsx:104 | server | Seen (via injected ids) |
| 3 | "Add two players to compare." / "Add one more player to compare." | compareSheet.tsx:327 | static | Cond |
| 4 | "Comparing…" / "Loading…" / "Nobody matches that." | compareSheet.tsx:335, 387, 389 | static | Cond |
| 5 | Notes from a pickup Best move: "{name} is a free agent: add him in Sleeper. +{gain 2 dp} pts on your best lineup this week." | TeamScreen.tsx:1969 | static | Cond |
| 6 | "Your roster is full: move X to IR first." / "...drop X to add him." / "Your roster is full: pick your drop." + numbered options; "{name}, his team's starter, is out or doubtful." | TeamScreen.tsx:1971-1978 | static | Cond |
| 7 | "Close call on waivers: X, 12.3, +1.2 pts, free agent" / "Tie on waivers: …" | TeamScreen.tsx:1779-1780 | static | Cond |
| 8 | Foot words "✓ Start", "Toss-up" / "No line yet", "Lean (tag)" | compareSheet.tsx:519-541 | static | Cond |

### Matchup (MatchupScreen.tsx, matchup.tsx)
| # | Text | Source | Kind | |
|---|---|---|---|---|
| 1 | "Scheduled" (state, top right) | matchup.tsx:719 | static | Seen |
| 2 | "no forecast" under a team score | matchup.tsx:148 | static | Cond |
| 3 | Degraded reason / "No forecast for this matchup." | matchup.tsx:95 + server degradedReason | server | Cond |
| 4 | "No matchup to show for this week." / server reason | MatchupScreen.tsx:188 | static / server | Cond |
| 5 | "No league chosen yet. Open Setup…" | MatchupScreen.tsx:184 | static | Cond |

The main Matchup screen carries no sentences. The explanations live in `title` tooltips (matchup.tsx:512-518, 533), which a phone never shows.

**"Behind the odds" sheet** (tap the win bar):

| # | Text | Source | Kind | |
|---|---|---|---|---|
| 1 | "Projected final 79.5 — 54.1" | MatchupScreen.tsx:289-291 | static | Seen |
| 2 | "90% · 4,000 simulated afternoons" | MatchupScreen.tsx:292-294 | static | Seen |
| 3 | "Confidence medium · 2 starters not projected · 2 availability unresolved" | MatchupScreen.tsx:297-298 + core/matchup/model.ts:658-659 | server | Seen |
| 4 | "Live insight" + "You remain a strong favorite · 90% win odds" | matchup.tsx:344 + core/matchup/insights.ts:475 | server | Seen |
| 5 | "Nothing has kicked off yet." | core/matchup/insights.ts:478 | server | Seen |
| 6 | "Biggest remaining swings" + rows "R. Donnelly · theirs  14% swing 14.0–30.8" | MatchupScreen.tsx:315-338 | static | Seen |
| 7 | "Model matchup-1.0.0" | MatchupScreen.tsx:347 | static | Seen |

### Waivers (WaiversScreen.tsx, waiverTiers.tsx, waiverCard.ts)
| # | Text | Source | Kind | |
|---|---|---|---|---|
| 1 | "Not updated yet · FAAB $65 of $100" / "Updated 12:58 AM · …" | WaiversScreen.tsx:190; waivers.tsx:263 | static | Seen |
| 2 | Row sub-lines (one chip + one short reason): "Open spot · No QB to start wk 10", "Drop: Shipley · Burrow on bye wk 10", "Drop: Miller · Starts over E. Egbuka wk 11", "IR stash, out now", "Out now, return unknown" | waiverCard.ts:91-110, 163-196 + core/waivers/tiers.ts:1505 | static + server | Seen |
| 3 | "Cover, stash and block" | waiverCard.ts:431 | static | Seen |
| 4 | "Stash: Christopher Montgomery-Wellington III (Chase out for the season, gets his targets), bid $6"; "Add: … (covers your Week 12 bye at TE), bid $2"; "Block: … (Matty has no RB this week), bid $3" | waiverCard.ts:423-439 + reasons from core/waivers (upsideStash, lookAhead, block) | static + server | Seen (injected) |
| 5 | "Drop Antonio Williams (drop-ready)" / "Open bench spot" / "Open IR slot" | waiverCard.ts:442-446 | static | Seen |
| 6 | Drop-ready reason "No start in weeks 10 to 12; barely better than a free agent" | waiverTiers.tsx:56 + core/waivers/tiers.ts:1609-1610 | server | Seen |
| 7 | Fold titles with counts "Watch list (1)", "Drop-ready (1)", "Trending (n)" | waiverTiers.tsx:139, 146; WaiversScreen.tsx:333 | static | Seen |
| 8 | "No must-do move this week" | WaiversScreen.tsx:361 (core/waivers/tierPlan.ts:378) | static | Cond |
| 9 | "No player move this week" / no-move headline | WaiversScreen.tsx:280 + core/waivers/noMove.ts:49 | static / server | Cond |
| 10 | "Nothing else at {pos} is worth a look." | WaiversScreen.tsx:322 | static | Cond |
| 11 | Plan headline (no claims), plan note, drop "formNote" ("… trending down this week") | waivers.tsx:71-74, 99-102, 175-179 | server | Cond |
| 12 | "Recommended move" / "Other options to consider" (old payload, no tiers) | WaiversScreen.tsx:275, 303 | static | Cond |
| 13 | Trending rows' "why" text | waivers.tsx:236 | server | Cond |
| 14 | DST line "DEF No clear upgrade Hold"; DST sheet "One week only", "Roster cost", "Show evidence" | dst.tsx:48-150 | static + server | Cond (seen in demo) |
| 15 | "No league chosen yet…" / "Your roster was not found in this league…" | WaiversScreen.tsx:218, 222 | static | Cond |

**Waiver sheet** (waiverSheet.tsx):

| # | Text | Source | Kind | |
|---|---|---|---|---|
| 1 | Chips "Free agent", "Open spot", "Waivers $9", "Drop: Shipley" | waiverCard.ts:157-180, 388-400 | static | Seen |
| 2 | "Bid $9: Two or more other managers are likely to bid, so $9 to win about 3 times in 4" (clipped to one line) | waiverCard.ts:147-150 + core/waivers/bidModel.ts:158, 410-429 | server | Seen |
| 3 | "Better" over the winning column | waiverSheet.tsx:211 | static | Seen |
| 4 | "Empty slot", "Comparing…", raw error line | waiverSheet.tsx:113, 127, 104 | static / server | Cond / Seen |

### Trades (TradesScreenV2.tsx, components/trades2)
| # | Text | Source | Kind | |
|---|---|---|---|---|
| 1 | "Trades close after week 11" / "Trades are closed" | TradesScreenV2.tsx:70-71 | static | Seen |
| 2 | Labels "Fair", "Good for you", "Close: small gain for you", … | core/trades/verdict.ts:32-42 | server | Seen |
| 3 | "This week's opponent" | offerCard.tsx:34 | static | Seen |
| 4 | "Edge −11%" | offerCard.tsx:17 | static | Seen |
| 5 | Reason "Fills your weak TE spot with Andre Sotelo." / "Two of yours for one better starter, Pax Holloway." | core/trades/finder.ts:673-682 | server | Seen |
| 6 | "No trade is fully fair to both sides right now. These come closest." | TradesScreenV2.tsx:102-105 + core/trades/finder.ts:460 | server | Seen (quiet week) |
| 7 | "No trade helps both lineups right now." | TradesScreenV2.tsx:97 / core/trades/finder.ts:473 | static / server | Seen (seeded league) |
| 8 | "Could not find trades right now. Pull down to try again." | TradesScreenV2.tsx:94 | static | Cond |

**Offer sheet**: "This week's opponent" + reason (offerCard.tsx:81-82, Seen); table This week / Rest of season / Playoffs (86-88, Seen); "−11% their way" (96, Seen); "You get better at TE", "Dermot gets better at RB, WR" (101, 107, Seen); "Dermot · Has made 6 trades this season" (119-120 + server activity line, server/services/tradeBuilderService.ts:246; Seen); "Starts 7 of 8 weeks for Dermot" / "Starts 8 of 8 weeks for you" (164, Seen); "You cut X" (113, Cond); "Bench for {who}" (164, Cond).

**Build**: "Who do you want to sell or get?" (buildTab.tsx:69, Seen); result detail "TE · Dermot, to get" / "yours, to sell" (92, Seen); "Get Andre Sotelo · TE · Dermot" + "Change" (73-74, Seen); placeholder "Type a player's name" (85, Cond); "Nobody by that name." (103, Cond); "Could not find trades right now. Try again." (109, Cond); "No trade with this player helps both lineups right now." (113 + core/trades/finder.ts:472, Cond).

**Check**:
- Seen: "Fair to both sides: both lineups get better." (checkTab.tsx:98-100 + core/trades/verdict.ts:96); "−11% their way" (119); "You get better at TE; thinner at RB" (123-126); "Dermot gets better at RB, WR; thinner at TE" (130-133); "Starts 7 of 8 weeks for you now" and "Starts 8 of 8 weeks for you" (144 and offerCard.tsx:164); picker "Add players" / "Add 2 players" (playerPicker.tsx:68).
- Cond: "On your bench now" (144); "You cut" (138); "This trade cannot be judged yet." (99) or the server's `insufficient`; "About even, but a small gain for you (+x)." (core/trades/verdict.ts:109); "Nobody to trade with yet." (51); "Could not check this trade right now." (43); "Could not read the rosters right now." (TradesScreenV2.tsx:60).

### Players, in season (PlayersSeasonScreen.tsx, players2/seasonCard.tsx, playerPage.tsx)
| # | Text | Source | Kind | |
|---|---|---|---|---|
| 1 | "Rank · Rest of season, points over a free agent" (list caption) | PlayersSeasonScreen.tsx:336-337 | static | Seen |
| 2 | Row tags "Likely" / "Maybe" / "Unlikely"; "Back Wk 11" / "Out"; owner pill "Available" / "You" / team | server core/players/inseason.ts; PlayersSeasonScreen.tsx:434; playerFilters.ts | server / static | Seen |
| 3 | Sort sheet "Value (rest of season)"; owner sheet "Who holds them" | PlayersSeasonScreen.tsx:305, 281 | static | Seen |
| 4 | "Nobody matching “zzzz”." | playerFilters.ts:217 | static | Seen |
| 5 | "Draft order, moved by your research" (caption when sorted by draft) | PlayersSeasonScreen.tsx:337 | static | Cond |
| 6 | "No trade targets right now." / "Nobody is out right now." | PlayersSeasonScreen.tsx:327, 329 | static | Cond |
| 7 | Other empty lines ("{who} has no {players}.", "No {position} players found.", …) | playerFilters.ts:205-220 | static | Cond |
| 8 | Board reason (server) | PlayersSeasonScreen.tsx:322 | server | Cond |
| 9 | "Show more players" | PlayersSeasonScreen.tsx:380 | static | Cond |

**Player card sheet** (row tap):

- Seen:
  - Trade reason "Starts at WR, Dane Petrossian to the bench, +7.0 a week" / "Starts at WR for you, +9.0 a week" (core/players/inseason.ts:167), plus the versus line (seasonCard.tsx:46-53).
  - "Season 16.3 a week" (seasonCard.tsx:74-76).
  - "Next 4 weeks" and "Last 5 games" (82, 93).
  - "Insight" + newsletter text (server).
  - "No 2026 outlook published for him." (server), or a long Rotowire outlook paragraph (Julian Reyes, about 6 lines, server).
  - "Major injury history: ACL" (core/draft/injury.ts:122).
  - "knee · has not practiced — sleeper status · practice via nflverse · undated" (playerDetail.tsx injury block + server).
  - "Sources disagree — sleeper: Out · nflverse: Doubtful" (playerDetail.tsx:530/543).
  - "View full profile" (playerPage.tsx:275).
- Cond: "Looking it up…" and "No outlook published for him." (playerDetail.tsx:281, 291).

**Player page** ("View full profile"):

- Seen:
  - "More on him" (playerPage.tsx:755) with three help lines: "What is expected of him, in his provider's words" (756), "Draft order, movement and cached prop lines" (757), "Every item behind the tally, with its own words" (760).
  - "News by window" (699).
  - "Evidence timeline (1)" plus the quoted item.
  - Market "Rank 2.4, Sleeper draft rank" and "other: +2 / −0".
- Cond: "{n} news items still waiting for your review, so…" (playerPage.tsx:734).

### Setup (SetupScreen.tsx) and its areas
- **Folds shut (3, Seen).** "5 things need attention" / "All sources current" (SetupScreen.tsx:671-672); "Weighting: balanced" (684); "Support snapshot" (701).
- **Data group rows (Seen).** Each summary below is a server sentence, mostly server/services/setupService.ts, unless a web file is given:
  - "Connected as Demo Manager" (setupService.ts:279)
  - "Demo Dynasty (Half PPR)"
  - "Demo Sleeper ADP — 19 of 19 players matched" (:307)
  - "“Camp Report: Week 2” is waiting to be scored" (:582)
  - "Camp Report: Week 2 · Nov 16"
  - "Paste the issue into your weekly ChatGPT thread, then bring its tally back here." (static, SetupScreen.tsx:2550)
  - "Using practice data — real betting lines are not connected yet" (setupService.ts:491)
  - "3 items need attention" / "Nothing waiting for you" (static, SetupScreen.tsx:578-580)
  - "1 player name needs matching — +1 net tally is not being counted" (core/identity/repair.ts:182-183)
  - "4 inputs need attention" (core/health/model.ts)
  - "The last recommendation you looked at." (static, SetupScreen.tsx:855)
  - "Not known — Setup was opened directly rather than from a recommendation." (static, SetupScreen.tsx:854; Cond)
- **Player card data disclosure (14 sentences, Seen):**
  - "19 players covered, from 19 rows. Updated 17m ago." (SetupScreen.tsx:2825)
  - "Source: Sleeper — /stats/nfl/regular. The positional finish is half-PPR — … which is what you asked for and is a different number in…" (2836)
  - "4 stored, 15 players confirmed to have none. Newest fetched 17m ago." (2868)
  - "Source: Sleeper — get_player_outlook (written by Rotowire). Fetched one player at a time…" (server/services/playerDetailService.ts:930)
  - "Sleeper publishes no roster percentage. It is not in the player dictionary and there is no field for it in the GraphQL schema, so the app shows none rather than a number it would have to invent." (playerDetailService.ts:947)
  - "Week 12 of 2026: 3 players carry a report, 100% of the source mapped (0 unmatched)." (server/services/injuryService.ts:1022)
  - "Designation comes from sleeper, which is the league host and the authority on whether a player is Questionable. …" (SetupScreen.tsx:3062)
  - "Checked 17m ago · the report itself last changed 6h ago · last stored 6h ago." (3081)
  - "Injury data is current: the source is being checked every five minutes and the last ingest completed." (injuryService.ts:1053)
  - "2025 history: not read yet." (3121)
  - "It is checked every five minutes, all day, because a player is ruled out ninety minutes before kickoff …" (3125)
  - "The report carries one practice status per week, not one per practice day, …" (3132)
  - "Recent changes: practice limited → full" (3143)
  - The usage block: "No per-game usage yet — the 2026 weekly stats have not been ingested." (server/services/usageService.ts:847); "Targets, carries, receptions and target share come from nflverse’s published weekly player stats …" (2941); "Checked not yet · …" (2960); "Nothing has been ingested yet, so the role detector has no series to read." (usageService.ts:884); "A role change is only reported once a player has 6 games — …" (2978); "It is checked once a day, not every five minutes like the injury report. …" (2984)
- **Preseason market projection (2):** "Nothing imported for Half PPR · 4pt pass TD. The Draft board shows PTS — until a snapshot is pasted here, …" (1287); "Copy the whole StartWho table and paste it below. Nothing is fetched or scraped; …" (1333).
- **Draft board weighting (1):** "How this board has always ranked: the market prices a player and your own research argues with the price. Leave it here unless you have a reason not to." (1040).
- **Install on iPhone (7):** install.tsx:100, 104, 25-30 (3 steps), 154, plus diagnostics.ts:121-131 (table rows such as "17px, the gap it floats by (correct)").
- **Demo Mode (1):** "Week 6 of a twelve-team half-PPR league, … Draft and Trades are not part of the demo." (core/demo/placeholder/index.ts:42).
- **Areas (pushed pages, Seen):**
  - Sleeper: "The player list is how Fantasy Analyst recognizes names in your newsletter. Update it once before your draft, and occasionally during the season. Currently 25 players." (1668)
  - League: "Teams this room drafts early" (1758) and "Comma-separated NFL codes. This lowers Next% for those players — …" (1795), both draft-only, still shown in season
  - Draft order: "Sleeper does not publish average draft position, …" (1836); "Without one, the draft board still ranks by news and roster need — …" (1840); "Captured Nov 16 · 19 of 19 players matched" (1850)
  - Newsletter: 1990, 2000, 2018, 2061 (4 help paragraphs); "Last issue: Received and stored. Score it with ChatGPT to move any player tallies." (2210 + server/services/newsletterService.ts:399)
  - Vegas lines: "Practice data only. Start/sit advice will say when a real line is missing rather than guessing." (setupService.ts:493); "Nothing to do here yet. Real betting lines are switched on later, …" (3185); 3191, 3202, 3218, 3233, 3249, 3258; "The reset day (the 13th) is assumed from the signup date, …" (core/vegas/billingPeriod.ts:41)
  - Help my scores: "These names appeared in your newsletters but could not be matched to a Sleeper player, … Pick who each one is." (1533); "Or search for the right player" (1578)
- **Data health page (components/dataHealth.tsx).** The subtitle "Refresh problem · refreshed 13 min ago" (dataHealth.tsx:409 + core/health/model.ts:273). Source notes, all server, server/services/dataHealthService.ts unless a file is given:
  - "Demo Dynasty has never been read from Sleeper." (:320)
  - "Practice data only — real betting lines are not connected." (:370)
  - "Nothing published for week 10 yet." (:486)
  - "No 2026 schedule stored." (:588)
  - "No trending capture stored yet." (:635)
  - "Nothing has ever been stored for this." (:802)
  - "no identity crosswalk yet; no depth chart stored; no snap counts stored" (nflverseService.ts:410)

  Web-side lines on the same page:
  - "Refresh now · Roster, injury report, Vegas lines and kickoffs." (dataHealth.tsx:211/214)
  - "Daily rows read · Cloudflare can report how much of the daily database allowance today has used, but this deployment has no analytics token to ask with. See docs/DATA_HEALTH.md." (core/health/quota.ts:149)
  - "No scheduled refresh recorded yet · Nothing has been written down since this version was deployed. The five-minute injury check records itself against the injury source instead." (dataHealth.tsx:272-273)
  - "Technical details · Exact times, source outcome codes, refresh budget and the running revision." (300)
  - Cond: "Nothing needs you." (194); "Checking what the app is working from…" (121); "The refresh did not finish" (224)
- **Review (ReviewScreen.tsx).**
  - Seen: "3 waiting for you" (151); "Accept all non-mixed ≥0.6 confidence" (211); "Why: Your ChatGPT tally scored this player twice, so neither score was applied." (261 + 39).
  - Key sheet, Seen: "How the score works"; "Neutral, or good and bad in the same breath · does not count" (368-369); "Every item counts once, however dramatic it is. …" (374); "Accept counts it. Reject throws it out. Change lets you set it yourself. Wrong player moves it to someone else. Your decision always wins, …" (379-380).
  - Cond: 42, 43, 193, 197, 206, 220, 224, 316 (eight more help or empty sentences).
- **Shell and global (Cond):**
  - "Add to your Home Screen to run without Safari’s bars." (install.tsx:65; a one-time prompt in a Safari tab)
  - "… could not be loaded. Check your connection and try again. If it keeps failing, the app was probably updated since you opened it: reload to get the new version." (screenLoad.tsx:41)
  - Generic errors (apiResponse.ts:245-251)
  - "Unlock to make changes / Passphrase" card, with "Passphrase" printed twice (App.tsx:713-720) when Setup is locked
  - "View-only: no passphrase set." (SetupScreen.tsx:471)

---

## 2. Tap paths (what is tappable, where it goes)

- **Tab bar** (54x48 each): Team, Matchup, Waivers, Trades, Players, Setup. A cold start in season lands on Team; Draft is gone from the bar but still works (`draft-mode.png`). Re-tapping the current tab unwinds one layer (sheet, page, query).
- **Team:**
  - Header: the Compare icon opens the Compare sheet with its picker on "My team"; the Refresh icon runs the all-source job and then the subtitle shows "Updated …"; pulling down does the same as Refresh.
  - Best move: a swap, fill, toss-up or pickup card opens Compare seeded with the two players (a pickup adds the note lines). "Keep your lineup as is" is not tappable.
  - Lineup rows: a row with "→ Start X instead" opens Compare for that slot. Any other row opens the weekly card (verdict, lines, "More on X" disclosure, and a "Compare" button that opens Compare seeded with him and the picker open). An empty slot opens Compare for that slot.
  - Bench and waivers: "Bench (n)" expands the bench, and a bench row opens the weekly card (which says "Bench this week"). "Waiver moves" rows (top 2) open the waiver sheet; the DST line opens the DST sheet.
  - Fixture chips, injury chips and the league name are not tappable.
- **Compare sheet:**
  - Header: the button reads "+ Add", "Hide list" or "Compare", toggles the picker, and shows the result after 2+ picks. The X closes the sheet.
  - Picker: tabs My team / Waivers / All players, a search field and position chips. A row toggles a pick (up to 4). A chip's × removes that player.
  - Columns and table cells are not tappable.
- **Weekly card:** "More on X" (disclosure); "Compare" (Team: opens Compare; Matchup: closes the card); X.
- **Matchup:** the win bar opens "Behind the odds" (leverage rows close it and open that player's card; insight rows do the same when a card exists). Player names on both sides open the weekly card, including the opponent's players; unscored players are inert. "Bench (n)" expands. Pull to refresh (no button).
- **Waivers:**
  - Refresh icon or pull: the Sleeper-only job.
  - "Do this" and "Worth considering" rows open the waiver sheet (period tabs This week / Next week / 3 weeks, a comparison with the displaced player, drop options; nothing in it is tappable beyond the tabs). "Show all (n)" expands.
  - "Cover, stash and block" lines are **not tappable** (no comparison). Drop-ready rows are not tappable.
  - Folds (Watch list, Drop-ready, Trending) expand; their tier rows open the sheet. The DST line opens the DST sheet.
- **Trades:** a segmented control switches between Offers, Build and Check.
  - Offers: a card opens the offer sheet. Player names inside are not tappable, and there is no "check this" or "build from this".
  - Build: search field, then a result row, then offers around that player; the "Change" row resets; an offer opens the sheet.
  - Check: "Trade with" (native select), "Add a player" (picker sheet: tick rows, "Add N players", X cancels), "Remove" on a picked player; the result renders inline.
  - Pull re-reads the offers.
- **Players (in season):**
  - Controls: search, position chips, "Owner" ("Who holds them" sheet), All / Trade targets / Injured, and the sort button ("Sort" sheet).
  - A row opens the player card sheet. Its "View full profile" opens the player page (Back returns to the card). The page's chips Overview / Outlook / Market / Evidence and its "More on him" rows go to the same four sections. "Show more players" pages on.
  - No refresh. No Compare. No link from a trade target to Trades.
- **Setup:**
  - Light / Dark / System.
  - Folds: Data, App behavior, Account & support.
  - Data rows: Sleeper, League, Draft order, Newsletter and Vegas lines open pages; "Copy for ChatGPT" and "Paste AI tally" (sheet) appear while an issue waits; Player card data is a disclosure with 3 reload buttons; Preseason market projection is a disclosure with "Paste snapshot" (sheet); Review, Help my scores (only when names need matching) and Data health open pages.
  - App behavior: Draft board weighting (disclosure + slider), Install on iPhone (disclosure + "Layout diagnostics"), Demo Mode (disclosure + scenario).
  - Account & support: "Current context" (a row that opens a picker) and "Copy support snapshot".
  - Data health page: "Refresh now" (all sources + waivers job), "Technical details", Back.
  - Review page: "How it works" (sheet); Evidence / Wrong player? / Already applied; "Accept all non-mixed ≥0.6 confidence"; per item Accept / Change / Wrong player / Ignore.

## 3. Tap counts from opening the app (lands on Team in season)

| Job | Taps | Exact path |
|---|---|---|
| Start/sit check for one player | 0 to read, 1 for the reason (2 if on the bench) | Team row shows his number or "→ Start X instead"; tap row → weekly card. Bench: "Bench (n)" → row (card says "Bench this week" even when Team says start him). |
| Compare two players | 4 (1 if it is the suggested swap; 5 with a free agent) | Team → Compare icon → tap player A → tap player B → "Compare". Free agent: + "Waivers" tab inside the picker. Not possible from Players, Trades or Matchup. |
| See this week's matchup | 1 | Matchup tab. Odds detail +1 (tap the win bar). |
| Waiver bid amount | 1 (0 plus a scroll on Team) | Waivers → "Do this" row chip "Waivers $9". Why that amount: +1 (tap the row; the line is clipped). Team shows the same chip under "Waiver moves", below the fold with a full roster. |
| Check an offer he received | about 10 (1-for-1) to 11 (2-for-1) | Trades → Check → "Trade with" select (open + pick) → "Add a player" → tick each give player → "Add N players" → "Add a player" (get) → tick → "Add 1 player" → result. The app cannot read the offer itself. |
| Check a trade target | 3 | Players → "Trade targets" → row → card (Likely/Maybe/Unlikely, one reason, versus line). Alternative: Trades → Build → type name → result → offer card (4 taps + typing). |
| Refresh data | 1 | Team refresh icon (or pull). Elsewhere: Waivers icon = Sleeper only; Matchup = pull only; Trades = pull re-reads only; Players = not possible; Setup → Data → Data health → "Refresh now" = 4. |
| See injuries on his team | 0 (starters), 1 (bench and IR), 2-3 for detail | Team row chips Q/D/OUT/IR; "Bench (n)" for bench + IR; row → card → "More on X" for body part and practice. Players → Injured → Owner → You (4) lists only players out this week. |
| Find a bye cover | 1 | Waivers → "Cover, stash and block": "Add: X (covers your Week 12 bye at TE), bid $2" (not tappable, no comparison). Current-week bye holes show as "Do this" rows ("Burrow on bye wk 10"). |
| See playoff outlook | not possible | No standings, playoff odds or seeding anywhere. Closest: the "Playoffs +11" row in a trade offer sheet (that trade's playoff-week value) and the Players card's "Next 4 weeks". |

## 4. What does not fit one screen

Visible area: 773px (y 62 to 835) in standalone mode. In a Safari tab there is less room, by the 100 to 150px estimated in section 0.

| Screen (data) | Document height | Above the fold | Below the fold |
|---|---|---|---|
| Team, Alex-shaped, bench shut, 2 waiver moves | 1004px | Best move + reason (y 127-197), all 10 lineup rows (to y 710), Bench row (722-766) | "Waiver moves" title ≈785; the first row (with the bid chip) half under the tab bar, the second row fully off screen (`team-alex-with-waivers-full.png`) |
| Team, bench open | 1318px | as above | bench rows from y 766; the 22.1 QB alternative is 5th of 7 |
| Team with a late-swap or availability line or a pickup card | about +20-40px | | pushes Bench toward the bar |
| Matchup (dev mock, 8 slots) | 912px | everything; Alex's 10 starters add about 86px and still fit (Bench row ends about y 720) | none |
| Waivers, 2 Do this + 2 consider + 3 look-ahead lines | 912 shut / 954 folds open | picks and bid chips at top (y 150-400) | folds under the bar when opened; more "Worth considering" rows push the look-ahead lines down |
| Trades Offers (3 cards) | 912px | all 3 (end y 646) | none |
| Trades Check, 2-for-1 | 1068px | the verdict word (y≈565) and its line | "You give / You get" detail under the bar; each extra player +52px moves the verdict down (3-for-2 about y 670) |
| Players list | long (expected) | first player at y 243 after search + 2 control rows + caption (about 120px of controls) | list |
| Compare picker | sheet body 1074 in 700 | 6-7 candidates | rest of the list (expected) |
| Compare result (2 players) / weekly card / waiver sheet / offer sheet / player card | fit (bodies 302-618px) | pick + reason at the top of each | none; the injured player's card with a 6-line outlook is 646px tall |
| Setup, folds shut / all open | 912 / 1274px | 3 folds | most rows once open |
| Data health page | 1496px | "Refresh now" (y 443-495) | "Last scheduled refresh", "Technical details" |
| Newsletter page | 1217px | | last issue, history |

## 5. Tap targets under 44px (getBoundingClientRect on buttons, links, inputs, selects, summaries, roles and React click handlers)

| Screen | Element | Size (w x h) |
|---|---|---|
| Matchup | every player name button, both sides and bench ("Trey Halloran, 0.0 points, projected 18.7") | 167 x 31.7 |
| Weekly card (Team, Matchup) | "Compare" | 81 x 36 |
| Weekly card | "More on {name}" summary | 388 x 32 |
| Compare sheet | remove "×" on each chip ("Remove Grant Aldous from the comparison") | 28 x 44 |
| Compare sheet | search field | 388 x 38 |
| Players | position chips QB / RB / TE | 41.6 / 40.2 / 39.7 x 44 |
| Players | search field; clear "×" | 396 x 38; 34 x 34 |
| Player card | "View full profile" | 90.6 x 32 |
| Player page, all Setup pages | Back button ("Players", "Setup") | 66-76 x 36 |
| Trades Build | search field; clear "×" | 396 x 38; 34 x 34 |
| Setup | Light / Dark / System | 44 x 36 each |
| Setup | "Demo Mode" summary | 364 x 15 |
| Setup | "Layout diagnostics" summary | 372 x 32 |
| Setup | "Load them again", "Read the report again", "Read the usage file again" | 127 / 158 / 181 x 36 |
| Setup | "Paste snapshot" | 105 x 32 |
| Draft order page | "Import rankings" summary | 372 x 16.6 |
| Newsletter page | "Set the address manually" summary | 372 x 16.6 |
| Newsletter page | "Copy address"; "Save sender"; "Accept every email sent here" | 96 x 32; 101 x 36; 206 x 36 |
| League page | "Save"; "✓ In use" | 44 x 32; 65 x 32 |
| Sleeper page | "Reconnect"; "Update player list" | 91 x 36; 133 x 36 |
| Review | "How it works" | 91 x 32 |
| Review | "Accept all non-mixed ≥0.6 confidence" | 240 x 32 |
| Review | per item "Accept" / "Change" / "Wrong player" / "Ignore" | 61 / 65 / 98 / 57 x 32 |
| Setup pages | text inputs | 372 x 40 |
| Draft (still exists) | sort radios Score / ADP / DOG / PTS; search; board and entry toggles | 38-48 x 30; 38 x 36; 44 x 36 |

These are fine: tab bar 54x48, Team and Waivers header icons 44x44, every sheet's X 44x44, list rows 45-55px tall, Trades tabs and Check rows 44px or more.

## 6. Unclear states and things that differ between similar screens

### Selection and sort states
1. **Players: the sort control does not look like a sort.**
   - It is a plain button labelled only "Value" or "Draft order", sitting beside the All / Trade targets / Injured chips, so it reads as another filter. "Sort" appears only in its sheet and in the aria-label.
   - The Owner button reads "Owner" when nothing is filtered.
2. **Players: "Rank" changes meaning.** In the list it is the position in the current filtered view (renumbered for Trade targets, Injured and position chips). On the card, "RANK" is the draft rank, next to "ADP".
3. **Compare: the selection is hard to see.**
   - One header button changes between "+ Add", "Hide list" and "Compare".
   - After two picks nothing visible happens until "Compare" is tapped.
   - The sheet opens on "My team", so a free agent needs a tab switch.
4. **Team bench.**
   - "Bench (7) · 2 strong alternatives" does not mark which two.
   - The list puts the OUT and IR players first and the 22.1 QB fifth.
   - IR players are counted inside "Bench".
5. **Team Best move names a different slot.** Best move says FLEX, but the swap note sits on Whitfield's WR row, and Compare then says "FLEX slot".
6. **Captions without a key:**
   - Waiver gains such as "+66.2" do not say over what period.
   - "Edge −11%" does not say whose edge; only the sheet adds "their way".
   - "9/9 priced" does not say what is priced.
   - Italic dotted numbers (Sleeper fallback) are explained only in tooltips, which a phone never shows.

### Same thing, different behaviour or wording
7. **Player row tap.**
   - Team opens the weekly card, where Compare works.
   - Matchup opens the same card, but its Compare only closes it, and its verdict follows Sleeper's lineup.
   - Waivers opens the waiver sheet.
   - Players opens the player card and a full page.
   - Trades player names are not tappable.
   - Only Players reaches the full profile.
8. **Status chips.**
   - Doubtful shows as "D", "OUT", "who is Out" or "Out" depending on the screen (finding 3).
   - IR shows as "IR" or "OUT".
   - Out shows as "OUT" or "O".
   - The chip styles differ between Matchup and Team/Players.
9. **Free agent wording.** "Free agent" (Waivers chips, Compare picker), "Available" and "FA" (Players row). Ownership: "Yours" (Compare), "You" (Players), "yours, to sell" (Build).
10. **Pick word.** Compare: "✓ Start". Waiver sheet: "Better". Trades: "Fair" or "Good for you". Weekly card: "Start at RB" or "Bench this week".
11. **Refresh.**
    - Team: button and pull, all sources.
    - Waivers: button and pull, Sleeper only.
    - Matchup: pull only.
    - Trades: pull only, re-read only.
    - Players: none.
    - Freshness is shown as "Updated 12:58 AM" (Waivers, always; Team only once a manual job is known), "refreshed 13 min ago" (Data health), "Updated 14m ago" and "Checked 17m ago" (Setup), and nothing on Matchup, Trades or Players.
12. **Numbers and rounding.**
    - Vance's week is 16.3 (rows, Matchup, Players card) against "Proj 15.8" (weekly card).
    - The waiver card shows "+66.2", while its sheet opens on 22.1.
    - The Compare note shows "+3.45 pts" (2 decimals, TeamScreen.tsx:1969), against 1 decimal everywhere else.
    - "Season" means three things: Players "Value 101.7", card "Season 16.3 a week", Trades "+23 season".
13. **Same trade, two write-ups.** Offer sheet and Check show different lines for the same players: "for Dermot" against "for you now", and a Playoffs row only in Offers (finding 13).
14. **Review wording.** The key sheet says "Reject throws it out" but the button is "Ignore".

---

## Could not check

- **Real iPhone or WebKit rendering.** Only Chromium emulation was used; fonts fall back from -apple-system, so text widths and wrap points may differ slightly. The Air's exact top safe area was assumed (62px).
- **A real league.** There was no network by design. The seeded league is synthetic: 25 players, matchups from the dev Sleeper mock (8 slots), and Vegas on mock data. Setup's Vegas text ("Practice data only…") and some Data health states come from that, not from production.
- **Live game-day states.** Live scoring, locked players, late-swap warnings, Monday-night finals, real waiver timing ("Waivers until Wed"), trending rows and real FAAB competition were not reached. The bid path used the e2e suite's injected payload; its ids are not in the local database, so its sheet comparison shows "player r1 not found" (an artifact of the injection).
- **Players dossier on the preview league.** It has no detail records, so the card dossier was checked on seeded players instead.
- **Locked Setup** (auth was disabled locally, so the app was unlocked), the one-time install prompt (Safari tab only), Dark mode text, Dynamic Type, and the swipe gestures (edge-back, sheet drag), which were not used for tap counts.
- **Demo Mode.** It was opened but not used, because its captured responses are stale.