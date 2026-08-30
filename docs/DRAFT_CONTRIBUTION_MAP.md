# Draft Score — contribution map

Every input that reaches a Draft Score, what kind of claim it makes, and what it
is worth. Written to answer one question the strategy brief asks directly:

> Repair any duplicate path where the same prop information reaches Draft Score
> twice.

The numbers below were measured against the ranking engine by
[`scripts/probe-mkt-pts-influence.mjs`](../scripts/probe-mkt-pts-influence.mjs),
not read off the weights table. The findings are held in place by
[`tests/marketStrategy.test.ts`](../tests/marketStrategy.test.ts), and the
arithmetic behind them by [`tests/marketPoints.test.ts`](../tests/marketPoints.test.ts)
and [`tests/season.markets.test.ts`](../tests/season.markets.test.ts).

---

## The map

Categories are the brief's own: **quality** (how good is he), **cost** (what
does the draft market charge), **scarcity** (what happens to the position if I
wait), **fit** (what does *my* roster need), **preference** (what did the user
say), **explanation** (shown, never scored).

| Component | Weight | Kind | Source |
|---|---|---|---|
| `market_value` | 1.00 | **cost** | DOG/Sleeper blend vs the current pick |
| `my_guy` | 0.50 | preference | the user's own ★ |
| `news_lifetime` | 0.35 | quality | newsletter tally, all time |
| `avoid` | 0.30 | quality | the user's accumulated research, negative |
| `opportunity` | 0.30 | scarcity | what waiting would cost, from the composite |
| `league_fit` | 0.25 | quality | position multiplier under this league's scoring |
| `separation` | 0.25 | scarcity | gap to the next three at his position |
| `survival` | 0.22 | scarcity | urgency, from the survival estimate |
| `scarcity` | 0.20 | scarcity | ADP density at the position |
| `news_30d` | 0.20 | quality | newsletter tally, trend |
| `market_expectation` | 0.20 × coverage | **quality** | **season props → `MKT PTS`** |
| `team_concentration` | 0.15 | fit | NFL-team overlap with the drafted roster |
| `tier_cliff` | 0.15 | scarcity | distance to the next tier break |
| `news_7d` | 0.12 | quality | newsletter tally, acceleration |
| `need` | 0.10 × ramp | fit | unfilled starting slots, ramped by round |

Total weight in play: **4.29**.

Explanation-only, and deliberately not in the table: `marketProps` /
`marketHeadline` (the `MKT` line itself), `marketBaseline`, `Val`, `Next%`, the
tier label, and the draft-provenance line. These are shown and never summed.

---

## There is exactly one prop path

`market_expectation` is the only component built from player props, and
`src/core/vegas/season.ts` is the only Vegas import anywhere in
`src/core/draft/engine.ts`. There are no legacy prop bonuses to consolidate,
because there was never a second one.

More precisely: the number the card prints as `MKT PTS` **is**
`marketBaseline.points` — the same object `marketExpectationScore` is handed, not
a parallel derivation from the same lines. A second conversion path cannot drift
from the first because there is no second conversion path. That is asserted, not
assumed, in `tests/marketPoints.test.ts`.

Two things the brief lists as double-count risks are absent from the draft
entirely rather than merely separated:

- **Game total / spread / game script.** No draft component reads them. They are
  a weekly Start/Sit input.
- **VORP.** There is no replacement-value module in `core/draft`. The draft's
  scarcity claims are made by `scarcity`, `tier_cliff`, `separation` and
  `opportunity`, none of which computes points above replacement.
  `market_expectation` is a *within-position standing*, not a replacement value,
  which is why it does not duplicate them.

---

## What `MKT PTS` is worth, measured

Nominal weight is 0.20, which is **4.7%** of the 4.29 of weight in play. That is
a ceiling: the component is scored in [-1, 1] and then multiplied by coverage,
so a partial picture reaches less of it.

On a 160-player synthetic board with props that disagree with ADP by a realistic
amount:

| Measurement | Result |
|---|---|
| Mean \|contribution\| at full coverage | 0.104 |
| Players that move when props are removed | 134 / 160 |
| Mean displacement | 1.88 places |
| Worst displacement | 10 places |

That is the shape the brief asks for. A signal that moved nothing would not be
worth showing; one that reordered the board would be overpowering BPA. It moves
most of the board slightly and no player more than ten places.

### Coverage damps it, and only damps it

| Coverage | Mean \|contribution\| |
|---|---|
| 1.00 | 0.104 |
| 0.66 | 0.072 |
| 0.34 | 0.032 |

Coverage is a confidence damper, never a direction: a player the market never
priced scores `null`, not zero, and a player priced on two markets out of three
is compared only against peers priced on those same two. A missing market is not
a negative opinion.

---

## BPA stays dominant

The strongest possible props disagreement against a plain ADP gap — a receiver
priced at the top of his position against one priced at the bottom:

| ADP gap | Strong props | Better ADP | Winner |
|---|---|---|---|
| 10 | −0.317 | −0.311 | better ADP |
| 20 | −0.841 | −0.317 | better ADP |
| 30 | −1.254 | −0.312 | better ADP |

The draft market wins at every gap. At ten picks it is nearly a tie, which is
the intended behaviour: `MKT PTS` separates players the board rates alike and
loses to a real bargain.

---

## No quarterback inflation

A quarterback implies far more raw fantasy points than any receiver, so feeding
raw points into the composite would float every quarterback to the top. The
component is a positional standing, so it does not:

- an identically-priced QB and WR at the same ADP both score **1** and both
  contribute **0.200** — the quarterback's much larger points total produces no
  larger contribution;
- the top 20 of a mixed board comes out `{TE: 4, WR: 5, QB: 6, RB: 5}`.

The pool a player is compared against is `poolByPosition.get(player.position)`,
built once per board, and the comparison is restricted further to peers priced
on at least the markets he has.

---

## A position you have finished with speaks more quietly

The four scarcity components — `scarcity`, `tier_cliff`, `separation`,
`opportunity` — are held to a joint ceiling (`POSITIONAL_STRUCTURE.cap`, 0.5)
because they all rise together for the same reason. What nothing decided until
now is **whether the answer is worth anything to this roster**.

Reported from a rehearsal of a one-quarterback league: a quarterback taken in
round two, and by round seven the top of the recommendation list was
quarterbacks again. The board knew the slot was closed — `need` said so, in
words, on the card — and the knowledge was worth `-0.009` against `+0.289` of
structure for the same player at the same pick.

So the ceiling is scaled by what the position can still do (`structureVoice`):

| the position can still… | ceiling | why |
|---|---|---|
| fill its own slot, or a flex it is eligible for | `cap` (0.5) | it can start for you; nothing changes |
| nothing — a **depth** position (2+ starters) that is full | `cap × 0.85` | backs and receivers keep being drafted all afternoon |
| nothing — a **single-slot** position (QB, TE, DEF) that is full | `cap × 0.3` | one slot, filled, done |

The two discounts are `DEMAND.depthFilled` and `DEMAND.singleFilled`, imported
from `nextpick/demand.ts` rather than restated: the *room* model has discounted
a simulated manager's appetite by exactly those numbers since it was written,
and the reader's own board having no equivalent was the asymmetry. One tuning,
one meaning, both sides of the same draft.

Three things it deliberately does not do. It never raises a contribution — the
ceiling only falls. It never touches a component's own score, only the weight,
so `score × weight = contribution` still checks out on the card. And it does not
reach `survival`, which is signed both ways: a filled quarterback who is likely
to *last* carries a negative survival contribution, and turning that down would
raise him.

Measured on the audit board in `tests/audit.draftScore.test.ts` (twelve
quarterbacks in bands against forty dense backs), at pick 60: with the slot open
the best quarterback leads the board, and with it filled a receiver does. He
falls by about eight picks of ADP and stays on the board, scored and comparable.

---

## The one second-order path, and why it is not a duplicate

`separation` and `opportunity` are computed from the composite, which already
contains `market_expectation`. So a player with strong props gets a higher base
*and* a slightly larger separation gap, and the component's real influence
exceeds its nominal 0.20.

This is not a prop-specific duplicate path. Both components are functions of the
whole composite and amplify every input identically — the tally, league fit and
the market baseline all reach them by the same route. Removing the props
entirely moves the board 1.88 places on average *including* that amplification,
which is the honest measure of what the props are worth end to end.

It is recorded here rather than left implicit because a contribution map that
quoted only the nominal weight would understate the component, and the next
person to tune it should know the multiplier exists.

---

# Score, tiers and `Next%` — the separation audit

Added with the DOG-anchored tier work and the late-round `Next%` calibration.
Every claim below is read off the imports and the call graph, not off intent,
and reproduced by
[`scripts/probe-dog-next-sensitivity.mjs`](../scripts/probe-dog-next-sensitivity.mjs).

## The three jobs, and what each reads

| | Question | Primary market |
|---|---|---|
| **Score** | who should I draft now | DOG/Sleeper blend |
| **Tier** | where does the market's quality step down | DOG/Sleeper blend |
| **`Next%`** | will he last to my next pick | **Sleeper**, plus DOG as tail risk only |

`blendMarketBaseline` has exactly one call site — a pre-pass in `engine.ts` that
computes it once per player. `market_value` and the tier ladders both read that
one result, so the two cannot disagree about what the market thinks.

## Score is already DOG-anchored, measured

Move one market by N picks and hold the other still:

| Shift | standard DOG / Sleeper | best ball DOG / Sleeper |
|---|---|---|
| 10 | +0.233 / +0.226 (1.03×) | +0.356 / +0.250 (**1.42×**) |
| 20 | +0.724 / +0.614 (1.18×) | +1.026 / +0.412 (**2.49×**) |
| 30 | +1.221 / +0.947 (1.29×) | +1.423 / +0.579 (**2.46×**) |

No weight was changed to achieve this; it is what the shipped blend already did.

## `Next%` is Sleeper-first

Sleeper ADP moves it by 10 to 19 points over the same shifts. DOG reaches it
only through `idiosyncraticHazard`, as a **gain on a term that is zero for the
whole early board** — so it is structurally incapable of opening a tail the
draft's own depth has not opened, and can widen one by at most half.

| | at pick 53 | at pick 148 |
|---|---|---|
| DOG 10 picks earlier | 0.0 pts | −1.8 pts |
| DOG 40 picks earlier | 0.0 pts | −6.8 pts |

## Late-round calibration, before and after

| Case | Before | After |
|---|---|---|
| pick 148 → 153 (5 away), ADP 164 | 100.0% | **93.9%** |
| pick 148 → 165 (17 away), ADP 164 | 100.0% | **78.9%** |
| pick 148 → 151 (3 away), ADP 210 | 100.0% | **96.9%** |
| pick 10 → 15 (5 away), ADP 26 | 95.5% | **95.5%** |

The same five-pick wait is now *less* certain late (93.9%) than early (95.5%),
which is the ordering the brief asks for and the reverse of what shipped. Early
rounds did not move at all, because the floor is zero below its onset.

### The repair that would not have worked

Widening `adpSpread` late — the obvious reading of "widen the distribution" —
moves the number the **wrong way**, because a player sitting before his ADP
faces a per-pick hazard of `1.702·(1−S)/spread`:

| spread | 148 → 153, ADP 164 |
|---|---|
| 39 (shipped) | 92.5% |
| 60 | 94.4% |
| 90 | 96.0% |
| 140 | 97.3% |

That is asserted as a test in `tests/nextpick.lateVariance.test.ts` so the next
reader finds out there rather than in a draft.

## Separation, asserted structurally

- **Score does not feed `Next%`** — `nextpick/` imports neither
  `rankAvailablePlayers` nor `draftScore`.
- **`Next%` does not feed Score** — `engine.ts` never references
  `simulateNextPick`.
- **The simulator cannot see the user's private evidence** — no `myGuy`, no
  `PlayerSignal`, no season markets reach it.
- **DOG is not counted twice in `Next%`** — one call site, in the hazard, and
  only in the direction that means danger.

## Known limitation

Deep in a draft the simulator's own Sleeper sensitivity is low: every remaining
candidate is saturated in `marketPickWeight`, so a 40-pick Sleeper shift at pick
148 moves `Next%` less than a point. That saturation is much of *why* the late
estimate was overconfident, and the hazard floor treats the symptom rather than
that cause. "A Sleeper shift moves `Next%` more than a DOG shift" therefore
holds mid-draft and is not asserted deep — what is asserted deep is the stronger
structural claim that DOG cannot act on its own at any depth.
