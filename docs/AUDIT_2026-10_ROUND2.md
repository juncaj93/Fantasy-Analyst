# Full-site audit, round 2, October 2026

Started Thursday 22 October 2026 (week 7, Tony's Pizza Fantasy), against
production `3a3fc5e`. This file is the findings register for the second
round: one row per finding, fixed or not, so a later round can pick it up
without redoing the audit. The first round is `docs/AUDIT_2026-10.md`.

Times are Eastern (EDT until 1 November), with UTC in parentheses.

Status words: **FIXED in PR #n**, **NOT DONE** (with the fix and its size), or
**NEEDS ALEX** (a decision only he can make).

## How it was measured

| Source | What it showed |
|---|---|
| `probe-audit-round2.mjs` (new), run 39876202484, 8:07 PM (00:07 UTC) | every season screen read once from production, Sleeper's roster and matchup feeds, every number per player, the injured-reserve check |
| `probe-audit-d1.mjs` (new), run 39878008681 | D1's own rows read per statement for the last 24 hours (Cloudflare analytics, no SQL) |
| Local seeded server, every screen walked with a statement meter | D1 statements per cold screen load |
| CI and the daily sweep's run history, last 12 nights | why the sweep was red |
| Error-state sweep: each screen with its read forced to fail or return empty | what a failed load draws |

## Numbers across screens (production, week 7, 8:07 PM)

Every screen agrees it is week 7 (Sleeper, Team, Matchup, Waivers plan,
Compare picker, Check a trade). Alex's roster, the number each screen shows
for the same player:

| Player | Status | Team and Compare | Matchup card | Matchup score row | Waivers keep value |
|---|---|---|---|---|---|
| C.J. Stroud | | 21.12 | 20.17 | 20.17 (bench) | 19.78 |
| Bijan Robinson | | 17.98 | 17.23 | 17.23 | 17.77 |
| Kenneth Walker III | | 15.85 | 15.50 | 15.50 | 20.36 |
| Jaxon Smith-Njigba | | 15.58 | 15.19 | 15.19 | 20.20 |
| Braelon Allen | | 13.12 | 13.12 | 13.12 | 11.65 |
| Nico Collins | | 12.33 | 11.65 | 11.65 | 11.18 |
| Sam LaPorta | | 9.41 | 9.41 | 9.41 | 10.83 |
| Cleveland Browns | | 8.57 | 8.57 | 8.57 | |
| Courtland Sutton | | 6.95 | 6.97 | 6.97 (bench) | 4.74 |
| Brian Robinson Jr. | Questionable | 5.19 | 4.91 | **3.02** (bench) | 11.24 |
| Jordan Love | Questionable | 21.01 | 21.01 | **12.94** | 23.12 |
| KC Concepcion Jr. | Questionable | 7.74 (Sleeper) | 7.70 | **4.74** | 5.47 |
| Omar Cooper Jr. | | 4.81 | 4.95 | 4.95 | 7.15 |
| Emmett Johnson | | 2.87 (Sleeper) | 2.79 | 2.79 (bench) | 5.85 |
| Jaleel McLaughlin | | 1.24 (Sleeper) | 1.22 | 1.22 (bench) | 3.33 |
| Antonio Williams | bye | none | none | 0 (bench) | 4.98 |
| Ladd McConkey | Out, IR | Out | none | 0 (bench) | |

Matchup's score rows follow the lineup Alex has set in Sleeper (Love at QB,
Concepcion at WR), not the app's suggestion. The Waivers keep value is a
rest-of-season figure, not this week's, and is listed only so a later round
can see it. Three gaps are real: the Questionable rows (B1), Sleeper-only
players (B2), and the Matchup card against Team (B13).

## D1 rows per screen

Rows per cold screen load = the statements the screen runs (local seeded
server) times what each statement read per call in production over the last
24 hours (D1's own counts). An estimate: production's call mix differs with
the data.

| Screen | Statements | Rows read, about | Biggest single read |
|---|---|---|---|
| Team | 83 | 13,300 | the full player list, 3,310 |
| Setup | 86 | 12,000 | season stats count, 3,309 |
| Waivers | 49 | 9,200 | the full player list, 3,310 |
| Trades | 37 | 7,100 | the full player list, 3,310 |
| Players | 9 | 4,600 | the full player list, 3,310 |
| Compare picker | 16 | 2,200 | research items, 652 |
| Matchup | not measured | | needs Sleeper's live matchup feed, which the seeded server has no week for |

Last 24 hours to 8:25 PM (00:25 UTC): 3,259,546 rows read, 65% of the
5,000,000 free allowance, across 183 statements. The full player list read
alone was 721,580 rows (218 calls, 22% of the day's reads; B14).

## Findings register

Impact is impact on Alex's decisions, in his order: Start/Sit, Waivers,
Trades, Matchup, Team, Players, Setup.

| ID | Area | What is wrong or could be better | Evidence | Impact | Status | Fix and size if not done |
|---|---|---|---|---|---|---|
| A1 | Players | The empty list said "Run a Sleeper player sync from the Team screen". Team has no such control. | Error-state sweep. | Low | FIXED in PR #393 | "No players found." |
| A2 | Server | Errors the API caught were never written to the Worker log. | Error-state sweep: a forced 500 left no trace. | Medium | FIXED in PR #394 | Both catch-alls log method, path and error. |
| A3 | Waivers | A failed load also said "Your roster was not found in this league", which was false. | Error-state sweep. | Medium | FIXED in PR #395 | Only the error shows. |
| A4 | Players | A failed load said "No players found." and threw an unhandled error. | Error-state sweep. | Medium | FIXED in PR #396 | The error notice shows. |
| A5 | Team | Tapping the Team tab again cleared a load error and left placeholder rows that never resolved. | Error-state sweep. | Medium | FIXED in PR #397 | The error stays until data arrives. |
| A6 | Setup, Data health | The D1 pace line said "by midnight UTC". | Screen text. | Low | FIXED in PR #398 | "by the 8 PM ET (00:00 UTC) reset", 7 PM ET from 1 November. |
| A7 | Trades | The market fold footer carried an explanation sentence. | North star. | Low | FIXED in PR #399 | A count: "3 players considered". |
| A8 | Code health | 7 unused web components and 8 unused style rules. | Export and class scans. | Low | FIXED in PR #400 | Removed, with two guard tests so new ones cannot pile up. |
| B1 | Team vs Matchup | Questionable players: Team counts them at full value, Matchup at 0.616 of it (its "uncertain" play-chance mix, 0.4 + 0.3 × 0.72). | Production: Love 21.01 on Team, 12.94 on Matchup; Concepcion 7.74 vs 4.74; B. Robinson 5.19 vs 3.02. Why Team uses full value: startsit@5 (PR #363, 13 October, f18cd25) made Questionable and any other reported status cost nothing and show a warning chip instead, in line with the rule not to second-guess the betting line, which already prices the risk. No backtest of that piece is recorded. | High | NEEDS ALEX | Pick one rule for both screens. Small to medium; an engine change. |
| B2 | Waivers, Trades, Matchup vs Team | Sleeper-only players: Team ranks every Vegas-priced player above them; the Waivers planner, Trades engine and Matchup Best move instead take 2 points off their number (`BORROWED_RANKING_DISCOUNT`). | Production, week 7: 3 of Alex's 17 players are Sleeper-only. One of his 10 starting spots differs: Team starts B. Robinson Jr. (5.19, priced) at FLEX; the minus-2 rule would start KC Concepcion Jr. (7.74 less 2 = 5.74). Across his roster and the top 30 free agents, 14 same-position pairs order differently under the two rules (Aaron Rodgers 21.07 on Sleeper against 9 priced free-agent QBs, for example). | Medium | NEEDS ALEX | One rule for every screen. Small to medium; an engine change. |
| B3 | CI | The nightly production sweep was red 8 of 12 nights (13 to 21 October), both times from production-only tests gone stale after UI changes, because CI never ran `e2e-production/`. | Sweep history: waiver plan check 13 and 14 October; Trades sheet selector 16 to 21 October. | Medium | FIXED in PR #403 | One CI shard runs the production suite against the seeded server (1.5 minutes). |
| B4 | All screens | A failed read showed the server's own exception text. | Error-state sweep on Team, Matchup, Trades, Setup. | Medium | FIXED in PR #402 | Reads show "Couldn’t load this yet. Pull to refresh or try again."; Setup's write messages (a wrong Sleeper username) are unchanged. |
| B5 | Matchup | Best move and the live insights read Sleeper's matchup player list, which includes injured-reserve players. | Production: all 16 IR players in the league are in the feed, and McConkey sits in Matchup's bench list. Neither Best move (6 options) nor an insight named an IR player: Best move already skips ruled-out players, and Alex's only IR player (McConkey) is ruled out. Best move is no longer drawn on any screen. | Low | NOT DONE (not confirmed) | Only reachable when a player cleared to play is still parked on IR. Filter `reserve` in `core/matchup/build.ts`. Tiny, but an engine file and a recommendation change, so out of this round's rules. |
| B6 | Accessibility | Tap targets under 44 px: every .btn button 36 px, small buttons and "View full profile" 32 px, Trades info buttons 32 × 32. | Layout measurement at 360 to 430 px. | Medium | FIXED in PR #405 | Invisible hit areas reach 44 px; nothing moves on screen. Still under 44: Matchup player rows (31 to 32 px) and the player search field (38 px). |
| B7 | Accessibility | Light mode: faint text on the sunken grey was 4.23:1, green on it 4.49:1 (AA needs 4.5). | Contrast computation. | Medium | FIXED in PR #404 | Faint 4.61:1, green 4.62:1. Stylesheet 19.2 of 20 KB. |
| B8 | Player page | The Draft market line read "Sleeper 12 · Here 10". | North star. | Low | FIXED in PR #401 | "Rank 12" with the fallback marker; a screen reader hears "Sleeper draft rank". |
| B9 | Tests | About 11 tests skipped on every run because the demo seed never meets their condition, among them all 3 Team swap tests. | CI reports. | Medium | FIXED in PR #406 | The 3 swap tests seed their own swap and run at every width. Still skipping: 3 drafted-roster tests, 1 tier-ordering FLEX test, 1 waiver-plan cut, plus 3 Chromium-only touch tests (by design). |
| B10 | Code health | 23 unused exports in engine and server files, for example `STATUS_PENALTY`, `RankDecompositionRepo`. | Export scan. | Low | NOT DONE | Protected areas. Small. |
| B11 | Demo Mode | The demo bar shows its clock in UTC. | Screen. | Low | NOT DONE | Demo Mode is protected. Tiny. |
| B12 | Matchup, Trades | An empty response body draws "Week undefined" on Matchup and crashes Trades. | Error-state sweep with `{}`. | Low | NOT DONE | Only reachable if the server sends `{}`. Small. |
| B13 | Team vs Matchup | Matchup's player card shows the raw Vegas number; Team and Compare show it after the game-script, matchup and usage nudges. | Production: Stroud 21.12 on Team, 20.17 on Matchup; up to 0.95 points across Alex's starters. | Low-medium | NEEDS ALEX | Show the adjusted number on the Matchup card, or label the two. Small. |
| B14 | D1 reads | The full player list (3,310 rows) is read on every Team, Waivers, Trades and Players load. | 721,580 rows in 24 hours, 22% of the day's reads. | Medium | NOT DONE | Keep the list in the Worker's memory between requests, or narrow the read to the players a screen needs. Medium. |
| C1 | Privacy | The repo is public and 8 probe scripts carried the real Sleeper league ID as a default. | Code search. | Medium | FIXED in PR #408 | Read from the `SLEEPER_LEAGUE_ID` secret, no default; a test fails if the ID returns to any tracked file. Alex adds the secret (`docs/SETUP.md`). |
| C2 | Offline | No service worker, so reopening the app with no signal shows the phone's offline page. | By design. | Low | Kept as is | |
| C3 | Deploy gate | The deploy gate never opened Matchup's content and ran the waiver plan check only in the nightly sweep. | `smoke.yml` @critical list. | Medium | FIXED in PR #407 | One Matchup content check and the waiver plan check on every deploy. Extra D1 rows per deploy: TBD. |

## Not changed, on purpose

- No score, ranking, tier, threshold, bid, drop choice or recommendation
  changed. No engine file was touched.
- No schema change, no migration, no new provider call. No app change adds
  a D1 read; the only new reads are the two deploy-gate checks Alex asked for
  (C3).
- Demo Mode, Draft, the odds refresh and the daily sweep schedule were not
  touched.

## Needs Alex's phone check

- B6 (#405): tap just above or below a small button (a sheet's Done, "View
  full profile", the round info button). It should still register, and
  nothing on screen should have moved.
- B7 (#404): light mode, faint grey text and green numbers on the grey cards
  read a touch darker. Dark mode unchanged.
- C3 (#407): nothing to see in the app; the deploy gate now opens Matchup and
  the waiver plan on every deploy. First run passed on 22 October, 11:31 PM
  (03:31 UTC).
- C1 (#408): add the `SLEEPER_LEAGUE_ID` secret (`docs/SETUP.md`, "The league
  ID secret"). Until then the eight league probes stop with a setup message.

## Changelog, this round

Squash merges into main, one at a time, each confirmed live by the deploy's
version check and smoke gate before the next began. Merged 22 October from
1:41 PM to 11:49 PM (17:41 to 03:49 UTC).

| PR | On main | What changed | Finding |
|---|---|---|---|
| #393 | `d8b6eeb` | Players empty list: "No players found." | A1 |
| #394 | `c4ff8af` | Every caught API error is written to the Worker log. | A2 |
| #395 | `001b108` | Waivers: no false "roster not found" on a failed load. | A3 |
| #396 | `06efcd2` | Players: a failed load shows the error, not an empty list. | A4 |
| #397 | `07b8cf6` | Team: tapping the tab again keeps a load error on screen. | A5 |
| #398 | `4185196` | Data health names the D1 reset in Eastern time. | A6 |
| #399 | `150c321` | Trades market fold footer is a count. | A7 |
| #400 | `38565a7` | Dead web components and styles removed, two guard tests. | A8 |
| #401 | `0280e58` | Player page marks Sleeper's draft rank instead of naming it. | B8 |
| #402 | `adb2210` | A failed read shows the app's own line, not the exception's words. | B4 |
| #403 | `281a7c3` | CI runs the production suite against the seeded server. | B3 |
| #404 | `e0bf9d2` | Light-mode faint grey and green clear 4.5:1. | B7 |
| #405 | `f61fd0b` | Buttons reach the 44 px tap floor, nothing moves. | B6 |
| #406 | `91c1fbf` | The three Team swap tests seed their own swap and run. | B9 |
| #407 | `5b66856` | Deploy gate checks Matchup's content and the waiver plan. | C3 |
| #408 | `44bde05` | Probe scripts read the league ID from a secret. | C1 |
| this PR | | This register, `probe-audit-round2.mjs`, `probe-audit-d1.mjs`. | |
