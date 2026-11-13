# Round 26 backtest: Opportunity and look-ahead

Run Friday 13 November 2026, about 3:15 PM Eastern, on
`docs/backtest/round16-data.json` (weeks 1 to 9 of this season, captured from
production on 10 November). No database read. Script:
`scripts/round26-backtest.ts`; full output: `round26-backtest.txt`.

## How

**Opportunity.** Every long absence of a starter this season (a QB, RB, WR or
TE who met the starter bar over his last four games, then missed 3 straight
games or every stored week after), plus every club change in the file. The
file has no IR flag, so the replay marks him IR on the week he first missed.
The real `findOpportunities` ran on what was known then: points through the
week before, that week's rosters and injury report. A pick is **good** when he
finished top 20 at his position that week or the next.

**Look-ahead.** Alex's roster each week from 3 to 8, the real `rosterHoles`
and `coverPickups` on Sleeper's projections for the next three weeks, byes from
the schedule. A cover is good when he outscored the player Alex would
otherwise have started there.

## Results

| | Count |
| --- | --- |
| Injury and trade cases replayed | 37 (32 long absences, 5 trades) |
| Free-agent leads found | 28, 8 good |
| Leads that pass the stash bar (would start for Alex) | 6, 3 good |
| The one stash line shown each week | 3, 1 good |
| Cover pickups recommended (look-ahead) | 2, 2 good |

Opportunity picks that passed the bar:

- Week 4: Tyquan Thornton (Rice on IR, gets his targets): **good**, 4th WR that week.
- Week 4: Tyler Higbee (Ferguson on IR): **good**, 14th and 10th TE.
- Week 4: Evan Engram (Adkins on IR): **good**, 17th TE the week after.
- Week 7: Kyle Williams (Doubs on IR): miss, 24th WR the week after.
- Week 8: Treylon Burks (McLaurin on IR): miss, 31st WR.
- Week 8: George Holani (Wilson on IR): miss. Zach Charbonnet came back that
  week; the live depth chart lists him first, the saved file has no depth chart.

The screen shows one stash a week, so the lines Alex would have seen were
Thornton (week 4, good), Kyle Williams (week 7, miss) and Holani (week 8,
miss): **1 of 3**.

Covers: Braelon Allen for the Week 5 RB bye (+10.0 that week) and Jordan Love
for the Week 6 QB bye (+22.2). Alex made both moves himself, in the same weeks (Allen for $16 in week 3, Love for $7 in week 5).

Trades: 5 found (Marvin Harrison Jr., Kaytron Allen and three backups). None
left a starter-level role to a free agent.

## Limits

- No IR flags, no depth charts and no injury status for unrostered players in
  the saved file. The live screen has all three, so the replay ranks backups by
  points instead of the depth chart (the Holani miss) and cannot see a hurt
  backup except by his missing games.
- Week 9 cases have only one week to judge.
- Small sample: 6 picks pass the bar over 9 weeks.

## Decision

The brief's bar: at least 2 of the top picks good. Read as the picks Alex would
have seen (one stash a week), it is 1 of 3, so the backtest alone left
`WAIVERS_LOOKAHEAD` **off**. Read as every pick that passes the bar, it is 3
of 6. The look-ahead covers were 2 of 2. Alex reviewed this and the preview
and turned it **on** on 13 November 2026, with the stash bid held to $0 to $1.
