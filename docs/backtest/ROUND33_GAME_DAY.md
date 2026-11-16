# Round 33: game day

All times Eastern.

## Part A: "Check status" when the books pull a player's props

**Why.** A player ruled inactive for a 4 PM, Sunday night, Monday or Thursday game is never seen before kickoff (Round 29 audit, finding 9). Sportsbooks take a player's props down when he is ruled out or in doubt, and the odds job already records that.

**The rule** (`src/core/startsit/checkStatus.ts`, one shared function):

- He had props this week, and at the newest look every line he had is gone. When the books withdraw a line everywhere, the odds job writes a "gone" marker (`core/vegas/combineProps.ts`); the time of the look that wrote his last one is the pull time.
- Shown only from 3 hours before his kickoff until the game starts.
- Not shown when he is already Out, Doubtful, on IR, in an IR slot or on a bye.
- A player who never had props, or whose props were never posted yet, has no gone marker and never gets the chip.
- A look that came back with less than half the lines of the busiest earlier look for that game (or none) is treated as a feed problem and pulls nobody (`core/vegas/pulledProps.ts`).
- It is a warning only. It changes no number, no rank and no pick (tested: the evaluation is identical apart from the chip).

**Where it shows.** Team: the row's small note reads "Check status" (where it would have said "No line yet"), and the card behind the row leads with "Check status: Props pulled at 3:42 PM". Compare (and the Waivers sheet, which uses Compare's cards): a quiet "Check status" chip on his card; a tap says "Props pulled at 3:42 PM".

**Cost.** No new query. The screens' props read already loaded the gone markers and threw them away; it now keeps their time. The look list read gains one computed column (the look's line count) from the row it already reads.

## Backtest

Data: the Round 29 audit's saved odds snapshots (`docs/audit/round29-data.json`): which players had lines at Tuesday 9 PM, Saturday noon, Sunday 11 AM and the last look before kickoff, for weeks 9 and 10. Script and output: `round33/check-status-backtest.py`, `round33/check-status-backtest.txt`. No database read.

| Games | Flags | Did not play (true) | Played (false alarm) |
|---|---|---|---|
| Sun Nov 8 (week 9, 14 games) | 0 | 0 | 0 |
| Sun Nov 15 (week 10, 13 games) | 9 | 6 | 3 |
| Thu Nov 5 and Thu Nov 12 | 0 | 0 | 0 |

- The 3 false alarms (KC Concepcion Jr. 10.2, Emmett Johnson 32.1, Cyrus Allen 11.4) were real single-player pulls in 1 PM games: each game kept its other lines (29 to 30 a look), so the feed guard does not hide them. Two were Alex's starters. That is why it says "Check status" and never "Out".
- No flagged player carried an Out or Doubtful report, so the "already ruled out" rule hid none.
- Thursday coverage is thin: the saved data has only the Tuesday 9 PM look before each Thursday game. Production looks at 120, 96, 72, 48, 24, 6, 3, 1.5 and 0.5 hours out, so the live rule sees far more than this backtest could.
- Recommendation from the audit stands: measure two more weeks before deciding on a second Sunday Sleeper download.

## Part B: compare a free agent in fewer taps

Before: 5 taps (Team, Compare icon, player A, player B, Compare), and not reachable from Players or Waivers.

After: 3 taps.

- Players (in season): Players, his row, **Compare**.
- Waivers: Waivers, his card, **Compare** (the card's sheet already shows the planner's comparison at 2 taps).

Compare opens with him in and the roster player he would most likely replace already picked (`src/web/comparePair.ts`): the weakest starter at his position, or with no starter there, the best of the bench at it. Up to three others at the position sit under the strip as one-tap swaps (names only). Nobody playable at the position: My team's list opens instead. Same request, same number and verdict as every other Compare (Round 31).
