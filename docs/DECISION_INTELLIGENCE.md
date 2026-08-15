# Decision intelligence: what each signal is, and what it is allowed to do

One page for the two questions this app answers — *who do I draft now* and *who
do I start this week* — written so a number on a card can be traced back to the
thing that produced it.

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
