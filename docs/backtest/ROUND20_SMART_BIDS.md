# Round 20: smart bids (11 November 2026)

Alex: the app often told him to bid more than he should, and it never used
what people in this league actually bid. This round makes the bid the lowest
amount that likely wins in this league, never more than the player is worth
to him, never into the $20 he keeps for the playoffs.

Full numbers: `round20-bid-history.txt` (made by
`scripts/bid-history-report.ts`).

## The history

Sleeper's documented endpoints, walked back through the league's
previous-season links: 2024, 2025 and 2026 (weeks 1 to 9; week 10's games and
run had not happened yet). That is as far back as the league goes. 622 claims,
303 players won. 101 Sleeper calls in all, cached, one at a time.

- Half of all players were won for $0 or $1 (52%).
- 69% of won players had one bidder. Only 94 of 303 had a second bid.
- When somebody else did bid on a starter-level player (the winner started him
  two or more weeks), the bid that would have beaten every other bid was $3
  half the time and $7 three times in four. Winners paid $11 (median).
- Position (contested starters): RB $7 half the time, $11 three in four; WR $6
  and $10; DEF $2 and $3. QB (4 contested) and TE (4) are too few: they use
  every starter's numbers.
- Depth players: $2 and $4. Late season is cheaper: weeks 9 to 13, the price
  to win a contested player was $1 (median).
- 38 of 94 contested winners bid $5 or more over the next bid: $633 paid over
  what it took, about as much as the $596 spent on players nobody else wanted.
- FAAB left now: Alex $48 (spendable $28). Every rival has $28 or more, and 8
  of 9 have $48 or more. Money is not what stops them; interest is.
- Price per point: a paid pickup ($3 or more) cost a median $0.50 per point he
  scored in the weeks he started (2024 and 2025).

## The rule (`src/core/faab/smartBid.ts`)

1. Chance a bid wins = chance nobody else bids (the app's rival read) + chance
   somebody does × share of contested starters at his position that bid would
   have won here. Bid the lowest whole dollar that wins 3 times in 4 ("Do
   this") or half the time ("Worth considering"). $0 when nobody else is
   likely to bid.
2. Never above his gain over the player he replaces times $0.50 a point.
3. Never into the $20 playoff reserve. A block stays $1 to $3, a stash $0 or
   $1. One number on the chip; the sheet adds one short reason.

## Backtest

Each season priced from the other two seasons only. Old = what Alex actually
bid. No rival read or gain exists for past weeks, so the new number here is the
league price alone, read as contested: the live rule's $0 and value cap would
only lower it.

| Season | Players he meant to start (bid $3+) | Old | New |
| --- | --- | --- | --- |
| 2026 | won | 5 for $67 | 5 for $50 |
| 2025 | won | 8 for $193 | 8 for $72 |
| 2024 | won | 5 for $153 | 2 for $12 |

All Alex's claims, three seasons: the new rule keeps 90 of his 97 wins, loses
7, adds 8 he lost, and saves $103 on the kept wins. Every contested starter in
the league: the new price wins 30 of 38 (79%) for $236, where the winners paid
$296.

2024 is the weak season: it was a bidding-war year (Tee Higgins $73 over $52,
Evan Engram $19 over $15), priced from two cheaper years. The rule loses those.

On the demo league the new bids are at or under the old ones: $2 where the old
rule said $3, $0 where it said $1.
