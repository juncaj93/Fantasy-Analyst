# Decision intelligence: what each signal is, and what it is allowed to do

One page for the three questions this app answers — *who do I draft now*, *who
do I start this week* and *am I going to win this matchup* — written so a number
on a card can be traced back to the thing that produced it.

Every signal here obeys the same four rules:

- **bounded.** Each has a stated cap, and the cap is in the same file as the
  arithmetic.
- **explainable.** Each produces the sentence the card shows. A card cannot
  describe a signal the score did not use, because the sentence and the
  contribution come from the same object.
- **decomposed.** No signal is folded into another. Interactions between them
  live in exactly one place per engine, named below.
- **honest about not knowing.** Absent data is `unknown`, never zero. A zero is
  a measurement.

---

## Draft

### Opportunity cost — `core/draft/opportunity.ts`

*How many players I would be happy to take instead are still going to be there?*

Counts the alternatives at the same position whose composite is within
`OPPORTUNITY.comparableBand` (0.35) of his and sums their survival probabilities
to your next pick. Three expected survivors is a comfortable position and scores
nothing; none is the maximum.

Distinct from `scarcity`, which counts remaining ADPs and cannot see quality,
and from `tier_cliff`, which measures ADP spacing and does not know whether the
players inside the gap survive.

### Replacement value — same file

*How much better is he than the best player likely to still be there?*

`base − E[best available at your next pick]`, where the expectation is exact
under independent survival:

    E[best] = Σ base_i · P(i survives) · Π_{j better} P(j does not)

with the residual probability assigned to the worst alternative on the board,
which understates the loss rather than overstating it.

**The double-count guard.** The board's existing `separation` component has
already paid him for standing clear of the players behind him *now*. So the
replacement gap has the separation gap subtracted from it before it is scored,
and only the remainder — the part that exists because you would be *waiting* —
counts. `tests/draft.opportunity.test.ts` asserts this directly.

Both halves share one component and one cap: `OPPORTUNITY.weight` = 0.30 of
composite, about six picks of ADP. Split 45/55 between scarcity and size.
Damped to 40% when the roster has no use for the position.

### NFL-team concentration — `core/draft/concentration.ts`

A quarterback and his receiver share a touchdown; a running back and his
receiver split one. So:

| Situation | Effect |
| --- | --- |
| QB + WR/TE, either order | small positive (`stackBonus` 0.5, halved for the second catcher) |
| second non-QB skill player from one offence | −0.35 |
| third | −0.75 |
| fourth or more | −1 (the floor) |

Scaled by round: 40% in round one, full by the last round. Capped at
`CONCENTRATION.weight` = 0.15 of composite, about three picks of ADP — so a
player who has fallen two rounds past his ADP still wins comfortably.

**Never a ban.** Nothing in this file can remove a player from the board.

---

## Start/Sit

The score is a sum of bounded, separately-testable components, in fantasy
points. `mode` reweights them; it does not replace them.

| Component | Source | Cap | Notes |
| --- | --- | --- | --- |
| `vegas` | player props | — | the largest single input |
| `news_recent` / `news_raw` | evidence ledger | ±2.1 / ±1.2 | |
| `status` | injury model | −1.5 (Q, practice-adjusted) to −99 (gate) | |
| `uncertainty` | market coverage | — | thin or stale data costs a little |
| `usage_level` | stored weeks | ±2 | recency-weighted opportunity |
| `role_trend` | stored weeks | ±1 | change, not level |
| `td_dependency` | stored weeks | −1.2 to +0.4 | |
| `game_script` | spread + total | ±1.2 (±0.7 beside a prop line) | |
| `weather` | forecast | −1.4 to +0.45 | no feed connected yet |
| `matchup_role` | league-wide usage | ±1 | |
| `explosiveness` | role profile | ±0.5 | mostly a Ceiling signal |
| `replacement_risk` | bench + kickoffs | −0.9 | added at lineup level |

### Where interactions are centralised

Two pairs would otherwise be paid twice, and both are capped in
`evaluatePlayer` rather than rebalanced away, so the components stay readable:

- **opportunity + role trend** — the level and the slope of one series. Capped
  together at `USAGE_PAIR_CAP` = 2.5.
- **game script + the market's own number** — the prop line already contains
  the game total, so script is capped at `GAME_SCRIPT_WITH_MARKET_CAP` = 0.7
  whenever a line exists.

Two more are avoided by construction rather than by capping:

- **prop agreement** adds no points at all. It is a flag and a confidence
  effect (`core/startsit/market.ts`).
- **injury confidence** adds no points. It is an interpretation of the state the
  availability penalty already scored (`core/startsit/availabilityConfidence.ts`).

### Usage outranks fantasy points

`core/startsit/usageTrend.ts` never sees a fantasy total. Volume is scored
against a per-position startable baseline, recency-weighted 4/4/2/2/1 with a
tail of 1 — the last two games matter most, and one game cannot redefine a
player. `tests/startsit.usage.test.ts` asserts the consequence: a four-target
receiver with four touchdowns scores *below* a ten-target receiver with none.

### Role, and the limit of the data

`core/startsit/roleProfile.ts` classifies from depth of target, air-yards share
and the split of a back's touches:

    deep / intermediate / underneath receiver
    rushing / dual-threat / receiving back
    rushing / pocket quarterback

**Slot and outside are not available.** No free source this app ingests carries
alignment; nflverse's `snap_counts` is keyed by `pfr_player_id`, an id space the
project has deliberately never taken on. There is no code path that can emit a
`slot` label. Where even depth of target is unavailable the answer is
`unclassified` and every consumer treats it as neutral.

### Opponent tendency by role

`core/startsit/defense.ts` buckets every game a defence has faced by the *role*
of the player who produced it, and scores the **residual** — what he did minus
what he normally does — which is the whole of the strength-of-schedule
correction. Below 4 player-games across 3 weeks the answer is
`insufficient_data` and the component contributes nothing; a player whose own
role is unclassified gets the position-level figure, labelled as such.

Built from `player_usage_weeks`, which since migration 0018 stores the opponent
and the production. Current season only — there is no prior-season fallback, so
early in a year this component is quiet.

### The lineup

`recommendLineup` is a transversal-matroid greedy assignment, which is exactly
optimal for slot eligibility. On top of it:

- **replacement risk** is priced before assignment, against the players who
  could legally take his slot and their kickoff times;
- **slot placement** then moves the later kickoff into the wider slot whenever
  both are legal — same starters, same points, more options at four o'clock;
- **shape preferences** (correlation in Ceiling, game diversification in Floor)
  may only choose between players within `LINEUP_PREFERENCE_TOLERANCE` = 0.6
  points of each other. Below that the players are a tie; above it the better
  player starts.

### Refresh

`POST /api/startsit/refresh` orchestrates the services that already own each
source. It re-asks a source only past that source's on-demand staleness
threshold, collapses taps inside 20 seconds, catches each source separately, and
creates no scheduled work. The Vegas budget layer is called exactly as the cron
calls it and a refusal is reported as `blocked`, never as an update.

---

## Matchup

The third question is different in kind from the first two: draft and start/sit
compare *players*, and this compares two *totals*. Everything below therefore
runs on top of the Start/Sit section rather than beside it — a matchup
projection is the same per-player numbers, summed, with a shape put around each
of them.

### Where a projection comes from — `services/matchupService.ts`

The start/sit score, with the availability component subtracted out. That
subtraction is the only adjustment, and it exists because the same fact would
otherwise be charged twice: the engine prices a Questionable designation as
points off, and this model prices it as a probability of not playing.

Sleeper's own projection arrives on the same payload and is never read.

### The shape around it — `core/matchup/distribution.ts`

A lognormal whose mean is exactly the projection and whose coefficient of
variation is the player's position adjusted by his role: `POSITION_VOLATILITY`
(QB 0.32 through DEF 0.65) times `ROLE_VOLATILITY` (a deep threat 1.2, a
possession receiver 0.85), clamped to [0.15, 1.2]. Lognormal because fantasy
scoring is non-negative, right-skewed and unbounded above, and because a
distribution whose mean drifted from the projection would make the projected
total and the win probability two answers to one question.

Three states:

- **not started** — the full pregame distribution;
- **live** — what is *left*, with the mean blended between the pregame
  projection and the pace actually observed. The blend weight is
  `elapsed × PACE_TRUST` (0.6), so a quiet first half moves the projection and
  cannot erase it, and the spread of what remains scales with the square root of
  the share still to play — which is why relative uncertainty *rises* as a game
  runs down;
- **final** — nothing. Actual points are truth and are never resampled.

### Availability — `AVAILABILITY_MIXTURE`

A mixture over playing / playing limited (× 0.72) / not playing, keyed on the
existing `AvailabilityConfidence` state so this cannot disagree with the Team
screen. `uncertain` is 40/30/30. The branch collapses the moment his game
starts, because the scoreboard has answered the question.

### Correlation — `core/matchup/correlation.ts`

A factor model, not a matrix: rules written pair by pair do not produce
something that can be factored, and the failure is a `NaN` win probability on a
Sunday. Each player loads on his club, his fixture and a per-club-and-position
competition factor with alternating signs — which is what makes two backs in one
committee negatively correlated. `MAX_IMPLIED_CORRELATION` is 0.45 and the tests
assert every pair sits under it.

### The simulation — `core/matchup/simulate.ts`

`DEFAULT_DRAWS` = 4,000, which puts the standard error of a win probability at
0.79 points at its worst — inside the whole number the card shows. Seeded from
`matchupFingerprint`, so the same state gives the same answer forever; that same
string is the cache key, so a state cannot move one without invalidating the
other. Every player is drawn, bench included, and every draw is kept.

### Leverage and thresholds — `core/matchup/needs.ts`

Leverage is measured in **win probability**, not points: the gap between the
matchup at a player's 10th percentile and at his 90th. That is why a volatile
quarterback outranks a slightly higher-projected back. A threshold is found by
bisection over that player's own simulated range against a target he can
actually reach — `MATERIAL_SWING` is 0.04, and a target outside his range is a
sentence about a miracle rather than a most-likely path.

### The lineup decision — `core/matchup/decision.ts`

Which legal lineup wins *this* matchup, which is not which has the highest
median. Computed over the same stored draws, so the difference between two
lineups carries no sampling noise of its own. `MIN_WIN_PROBABILITY_GAIN` = 0.02
is what gets *offered*; the model measures smaller effects and reports them in
`options`. Respects Sleeper's slots, eligibility, locks and ruled-out players,
and sets nothing.

### The hero card — `core/matchup/insights.ts`

Ranked by urgency (a **tier**, not a weight), then win-probability impact,
injury severity, movement since the last state, closeness to 50%, and whose side
it is about. One card per player, one per key, three at most. When nothing is
material it says so calmly and stops.

---

## Known limitations, stated plainly

- **No weather feed.** The model in `core/startsit/weather.ts` is complete,
  role-sensitive and tested, and every game's forecast is currently unknown, so
  the component contributes nothing. The refresh reports weather as
  `skipped — no forecast source connected` rather than omitting it.
- **No alignment data**, so no slot/outside split. See above.
- **No red-zone or goal-line touches**, so touchdown dependency infers a scoring
  role from consistency plus opportunity rather than from red-zone share.
- **Spreads depend on the provider's field names.** The adapter reads several,
  and an unrecognised one leaves the spread null and the game-script component
  quiet — never a number with the wrong sign.
- **Defensive tendencies are current-season only**, and thin until a defence has
  faced four players of a role.
- **The matchup clock is wall clock.** With no play-by-play feed, how far into a
  game a player is comes from how long ago it kicked off; a game nobody has
  priced has no kickoff, so its clock is inferred and the forecast's confidence
  says so.
- **Kickers and defences are not projected**, so in a league that starts them
  both sides' projected totals are low by the same amount and the confidence
  line names them. No number is invented to fill the gap.
- **Matchup win probability is uncalibrated.** The ledger is written from the
  first request; a band reports no observed rate below twenty settled weeks, and
  there are none yet.
