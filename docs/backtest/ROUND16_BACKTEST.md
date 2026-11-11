# Round 16: does the rest-of-season value pick the right players?

Run Tuesday 10 November 2026 at 7:10 PM Eastern (00:10 UTC), against
production `25265bc`, Probe run 42929286015. Report only: nothing in the app
changed. Times are Eastern.

## What was tested

The rest-of-season value (`src/core/value/restOfSeason.ts`) is half
projection, half season average per game played, with the average ramped in
over the first four games. Trades and Waivers both use it.

For each week W from 3 to 8, every QB, RB, WR and TE was valued as the app
would have valued him at the start of week W: league points from weeks 1 to
W-1 only, and this week's number as the screens read it (a full Vegas week,
or Sleeper's week). That value was compared with what he really scored per
game played from week W to week 9. Starter-level players only: the top 24
QBs, 36 RBs, 36 WRs and 12 TEs under any of the rules. That came to about 810
player-weeks and 190 players. No week was skipped.

The noise is measured by redrawing the players 2,000 times. "90% range"
below is how far a difference moves under that redraw. A difference whose
range crosses zero is noise.

**Two versions of the projection half, because neither is exactly what the
app had.** Sleeper's projections for the weeks after W were not stored as
they stood at week W. The stored ones were fetched closer to those games, so
they know more than the app did ("stored later weeks", which flatters
projection). The other version uses week W's number alone ("this week only",
which handicaps projection with one matchup's noise). A third check leaves
week W's own game out of the outcome, because that week's number was read
close to kickoff.

## Results

### Average miss, points per game (lower is better)

| Rule | Stored later weeks | This week only | This week only, week W left out |
|---|---|---|---|
| Current 50/50 | 4.12 | 4.33 | 4.71 |
| Projection only | 3.66 (−0.46, range −0.58 to −0.34) | 4.18 (−0.15, −0.28 to −0.03) | 4.58 (−0.13, −0.26 to −0.01) |
| Projection 75% | 3.86 (−0.26, −0.32 to −0.20) | 4.20 (−0.14, −0.20 to −0.07) | 4.60 (−0.11, −0.17 to −0.05) |
| Projection 25% | 4.43 (+0.31) | 4.55 (+0.22) | 4.89 (+0.18) |
| Season average only | 5.31 (+1.19) | 5.21 (+0.88) | 5.54 (+0.83) |
| Last 3 games | 5.50 (+1.38) | 5.40 (+1.07) | 5.79 (+1.08) |

Leaning toward the projection beats 50/50 in every version, by more than the
noise. Leaning toward the season average, or the last three games, is clearly
worse.

### As a decision: which of two players scores more from here

These are close calls: two players at one position, within 4 points a game
of each other. That is the call a trade or a pickup turns on.

| Rule | Stored later weeks | This week only | Week W left out |
|---|---|---|---|
| Current 50/50 | right 59%, +1.50 a game | 59%, +1.65 | 59%, +1.72 |
| Projection only | 65%, +2.36 | 60%, +1.69 | 59%, +1.71 |
| Projection 75% | 63%, +2.02 | 60%, +1.75 | 59%, +1.78 |

Projection only against today's blend, by version: +0.86 a game (range +0.68
to +1.06), then +0.03 (−0.22 to +0.25), then −0.01 (−0.30 to +0.24). Only the
version that flatters projection shows better picks. In the two fair versions
the picks are the same within the noise. The gain from more projection weight
is in the level of the number (less over-valuing), not in the order of the
players.

### By position

Every position prefers more projection on the stored version (QB −0.72, RB
−0.42, WR −0.39, TE −0.31 a game, all beyond the noise). On "this week only"
the same direction holds but no single position clears the noise on its own
(QB −0.20, range −0.52 to +0.15). Quarterbacks miss the most (6.1 points a
game) and are over-valued the most (+1.6). They do not clearly need their own
weight. Note: stored QB projections start in week 5 (the 6-point touchdown
rescoring began then), so QBs in weeks 3 and 4 rest on betting lines and
their average.

### Waivers: the planner replayed week by week

9 suggestions (7 different players) across weeks 3 to 8: 3 "Do this" and 6
"Worth considering". Each is scored in hindsight by how much it would have
added to Alex's best possible lineup from week W to 9.

| Week | Tier | Move | Lineup points added |
|---|---|---|---|
| 3 | Worth considering | Braelon Allen for Antonio Williams (Alex did it) | +36.3 |
| 4 | Worth considering | Braelon Allen for Emmett Johnson (Alex did it) | +14.6 |
| 4 | Worth considering | Jacoby Brissett for Rashod Bateman | −3.1 |
| 5 | Do this | Drake Maye for Emmett Johnson (QB bye) | +24.5 |
| 6 | Do this | Jordan Love for Tre' Harris (QB bye; Alex did it) | +28.9 |
| 6 | Do this | Pat Freiermuth for KC Concepcion Jr. (TE bye) | −23.9 |
| 7 | Worth considering | Jonah Coleman, open spot (Alex did it) | +28.4 |
| 8 | Worth considering | Jonah Coleman for Emmett Johnson (Alex did it) | +3.0 |
| 8 | Worth considering | Devin Singletary for Tyler Higbee | 0.0 |

6 of 9 paid off, 1 broke even, 2 lost. Average +12.1 lineup points over the
rest of the window.

### Trades: Build a trade replayed (all teams, nothing marked)

No package was shown in any of the six weeks. Every candidate failed one of
the app's own filters (no gain for one side, outside the fair-to-both band,
a spare QB or TE). There is nothing to score. The value calls a trade rests
on were checked instead: when the model rated one player 1 to 2 points a game
above another, he really scored more 58% of the time. At 2 to 3 points, 63%.
At 3 to 5, 68%. At 5 and up, 75%.

### The minus-2 for a Sleeper-only number

Weeks 2 to 9 (week 1 has no number without betting lines or earlier games).
1,084 full-Vegas player-weeks and 587 Sleeper-only.

- Vegas numbers came in 0.66 under what players scored. Sleeper-only numbers
  were about right (0.22 over).
- The discount that best fits the two at the same number level is **0.94
  points** (range 0.39 to 1.51). Two is outside that range: it is too big.
- Head to head, a Vegas player against a Sleeper-only one within 4 points:
  a discount of 1 gains 0.19 points per call over a discount of 2 (range
  −0.01 to +0.39, right at the edge of the noise). The two discounts pick
  differently in 13% of those calls.

### The 2.0 toss-up bar

Weekly calls (same position, same week): when the higher number led by under
1 point, it won 51% of the time. From 1 to 2, 55%. From 2 to 3, 59%. From 3
to 5, 67%. Under 2 is close to a coin flip, so the bar held up. On season
value it read 52%, 58%, 63% and 68%: the same.

### Bye cover

Five bye-related pickups. In the week each was added to cover, the pickup
scored: Drake Maye 47.5, Jordan Love 22.2, Jacoby Brissett 14.4, Braelon
Allen 7.7, Pat Freiermuth 2.1. Four of five covered the hole. Freiermuth was
the miss, and his drop cost more than he gave.

## Limits

- Lineups are scored in hindsight (the best lineup knowing the scores). That
  flatters every move alike, so it ranks moves fairly but is not a real
  points total.
- The waiver replay leaves out the drop-score signals, handcuff protection
  and "pick up and start". Draft-round protection is in.
- Rosters come from Sleeper's weekly matchups. Injury status is the last
  report of the week before.
- Five weeks of outcomes at most (weeks 3 to 9), so a playoff week's 1.5
  weight cannot be tested yet.

## Re-running it

```
node --experimental-transform-types --no-warnings scripts/probe-round16-score.ts docs/backtest/round16-data.json
```

No database read. `round16-data.json` is what the probe gathered (sha256
`3634d009…e80b`, 19,654 D1 rows). `round16-report.txt` is the full output.
