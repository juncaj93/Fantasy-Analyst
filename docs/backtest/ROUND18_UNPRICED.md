# Round 18: how much less reliable is a number with no Vegas line?

Run Wednesday 11 November 2026, on the Round 16 data
(`docs/backtest/round16-data.json`, weeks 1 to 9). No database read. Times
are Eastern.

```
python3 -I scripts/round18-unpriced.py docs/backtest/round16-data.json
```

Full output: `round18-unpriced.txt`. A number is "unpriced" when it is
Sleeper's week (no complete Vegas market). The app takes 1 point off it
(Round 17), and so does this measurement. Out and Doubtful players are left
out: they are real holes and never a judgment call.

## What was measured

1. **Spread**: how far real points land from the number, at the same number
   level.
2. **As a decision**: two players at one position in one week. How often does
   the higher number score more, by gap? Then: at what gap does an unpriced
   lead win as often as a priced lead of exactly 2.0 (the toss-up bar)? A
   logistic fit on each set, 300 redraws of week and position for the noise.
3. **Questionable**: the same, for an unpriced lead whose player was
   Questionable on that week's report. Counted two ways: only games he played,
   and the real outcome where a no-show scores 0.

## Results

| | Played only | Real outcome (no-show = 0) |
|---|---|---|
| Priced lead of 2.0 wins | 57.3% | 56.6% |
| Unpriced lead needs, to win as often | 1.46 (90% range 0.65 to 2.13) | 1.96 (1.13 to 2.68) |
| Unpriced and Questionable lead needs | 2.87 (1.89 to 3.50) | 6.13 (4.44 to 10.26) |
| Priced and Questionable lead needs | 2.75 (1.55 to 3.64) | 4.93 (2.94 to 6.60) |

- **Spread at the same level** is about the same for priced and unpriced
  numbers (within 10% in every band from 3 to 17 points). After the minus 1,
  bias is about the same too (+0.66 priced, +0.78 unpriced, played only).
- **No-shows**: Questionable players missed the game 27% (priced, 33) and 28%
  (unpriced, 36) of the time; healthy players 3% and 6%.
- **Unpriced and Questionable leading a priced player**, real outcome: gap 0
  to 2 won 29%, gap 2 to 3 won 47%, gap 3 to 5 about 50%.

## The bar chosen: 3.5 (`UNPRICED_TOSSUP_POINTS`, `startsit/tossup.ts`)

A pick whose own number is unpriced needs a 3.5-point lead; under it the call
is a toss-up. The 2.0 bar is unchanged for everything else, and a priced lead
over an unpriced player keeps 2.0 (it wins at least as often).

Why 3.5: on its own, a missing line costs little once the minus 1 is taken
(the same-confidence gap is 1.96, noise up to 2.68). The spread widens when
the unpriced player is also Questionable: 2.87 even in games he played, noise
up to 3.50. 3.5 is the top of that range. Alex's real case on 11 November
(McConkey 10.3, unpriced and Questionable, over Cooper 7.3, priced: a 3.0 gap)
is now a toss-up.

## Limits

- 36 unpriced Questionable player-weeks. The Questionable ranges are wide.
- Injury status is the last report stored for the week, not the status at the
  minute Alex decides.
- Most of the Questionable risk is the no-show, which the 3.5 bar does not
  fully cover. That is a question about the Questionable rule (full value with
  a chip), which this round does not reopen.
