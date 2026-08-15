# Advanced player and lineup intelligence

The layer beneath the two engines: opportunity separated from efficiency,
what happens when a starter is out, what would change a close call, what a
player is worth for the next month, and the app grading its own week.

Everything here is **pure `core/`**, tested, and consumed through one versioned
contract. None of it changes a lineup, adds a player, or sends anything to
Sleeper, and — with one deliberate exception noted below — none of it changes a
Start/Sit score either.

---

## The rule that shapes all of it

The Start/Sit score already contains opportunity (`usage_level`), the market's
own expectation (`vegas`) and touchdown fragility (`td_dependency`). Almost
everything in this document is built from the same weekly rows those come from,
which makes double counting the default failure mode rather than an unlikely
one.

So the split is explicit: **the engines decide, this layer explains and plans.**

| Module | Enters a lineup score? |
|---|---|
| `core/xfp/model.ts` | No — `points` is `0` and the engine does not import it |
| `core/injury/beneficiaries.ts` | No |
| `core/startsit/boundary.ts` | No — annotates a recommendation |
| `core/startsit/modeSuggest.ts` | Indirectly: it preselects the mode, which reweights |
| `core/startsit/correlation.ts` | Only as a bounded tiebreak inside 0.6 pts |
| `core/schedule/roleStrength.ts` | No |
| `core/value/multiWeek.ts` | No — a separate valuation |
| `core/startsit/contingency.ts` | No — alternative lineups, computed by the optimiser |
| `core/startsit/fragility.ts` | No — `projectionEffect` is `0` |
| `core/startsit/optionality.ts` | No — there is no `points` field to misuse |
| `core/startsit/streaming.ts` | No |

---

## xFP and FPOE — `core/xfp/model.ts`

*What was the opportunity worth before anybody caught anything?*

Expected points are built from targets, target depth, carries and pass attempts
at league-average rates, converted with **the league's own scoring**. Actual
points are reconstructed from the same stored rows, in the same units. `FPOE` is
the difference.

Four readings, and the order they are tried in matters:

| Reading | When |
|---|---|
| `TD regression risk` | beating expectation, and the touchdowns are why |
| `Production outrunning opportunity` | beating expectation on efficiency |
| `Role healthy despite low box score` | behind expectation, on a startable role |
| `Usage stronger than results` | behind expectation, on a thin role |

**Stated limitations**, carried in the payload beside every number rather than
buried here: no free source on this id space publishes red-zone or goal-line
touches, so a carry from the two is worth what a carry from the twenty is worth;
turnovers are not stored, so neither side of the subtraction contains them.

Depth of target *is* measured — `receiving_air_yards` is in the file — and the
payload says `depthMeasured: false` when it had to fall back to the position
average rather than passing an assumption off as a measurement.

## Injury beneficiaries — `core/injury/beneficiaries.ts`

*He is out. Who gets the football?*

Measured from **the games the team has already played without him**: opportunity
per game with him against without him, per teammate. A week with no row for him
and rows for at least two teammates is a game he missed; a week with no rows for
anybody is the bye. That distinction is what makes the without-sample
trustworthy, and it is derived rather than taken from an injury table.

With no absence to read, it falls back to depth inference — the teammate at his
position already getting the most work takes 55% of the vacated volume, the next
25% — labelled `depth_inference`, confidence `low`, and never blended with a
measured answer. With neither, the answer is `unknown` and the beneficiary list
is empty.

`emergencyPivot()` intersects the graph with what is unrostered in the league.
It returns a name and a sentence. Nothing adds, claims or queues anything.

## Decision boundaries — `core/startsit/boundary.ts`

*What would change my recommendation?*

Only for calls inside 2.5 points. Each condition is found by **re-running the
real evaluation** with one input moved and bisecting for the flip, so a boundary
cannot drift away from the engine it annotates.

- **market line** — the line the challenger would have to reach, rounded up to
  the half-yard, and only when the move is under 30% of the current line.
- **practice report** — the leader getting worse or the challenger getting
  better, as discrete states, because there is no such thing as 63% of a limited
  practice.
- **wind** — the speed at which the leader falls behind, up to 32 mph.

Anything unreachable is dropped rather than printed, and a comfortable call says
so instead of manufacturing a condition.

## Mode suggestion — `core/startsit/modeSuggest.ts`

Substantial favourite → Floor. Substantial underdog → Ceiling. Close →
Balanced. The user can override; `auto: false` distinguishes "we defaulted" from
"we chose".

**The circularity guard is structural.** `suggestMode` accepts market points per
player and nothing else — there is no field on its input a mode-weighted score
could travel through, so the loop cannot be written by accident. Below 60% of
starting slots priced on either side, the answer is Balanced with the reason
stated.

## Opponent exploitation — `core/startsit/correlation.ts`

Two of the opponent's likely starters in one game is exposure. Ceiling pays a
little for being in that game; Floor pays a little for being out of it; Balanced
takes no view, because the value of correlation depends entirely on whether you
are raising or lowering the variance of the margin.

Bounded at 0.35 points, offered only inside a 0.6-point gap, and silent when the
better player would have won anyway.

## Role-specific schedule — `core/schedule/roleStrength.ts`

The existing matchup read, applied forward over three to five weeks, under the
same role bucket and through the same `assessMatchup`. A bye is counted
separately and excluded from the mean; an unrated opponent is counted as
unrated, not as neutral; nothing rated means `unknown` rather than `neutral`.

## Multi-week value — `core/value/multiWeek.ts`

`thisWeek` is the Start/Sit score, unchanged. `nextFourPerWeek` carries it
forward through four bounded, inspectable components: the role-specific
schedule, the role trend, the expected-points gap, and the starter who is coming
back. The bye never touches the per-week value — it reduces `weeksAvailable`,
and the total falls out of the multiplication.

**Weather is deliberately absent.** A forecast is worth about seven days; a
four-week valuation that moved on a fifteen-day forecast would be inventing
precision, and the payload says so rather than silently omitting it.

## Contingency lineups and the replacement tree — `core/startsit/contingency.ts`

Plan A is the recommended lineup. Plan B is him out with the news arriving early.
Plan C is him out at his own kickoff, with the early window already locked.

B and C are separate calls to `recommendLineup` — the second with the clock
moved forward — so slot legality, FLEX rules, the Out gate and locked starters
all come from the optimiser rather than from a second implementation of the same
rules.

A waiver pivot is reported separately, labelled, measured against the *late*
plan, and never folded into a plan's points. Trees are built only where the risk
is material: a genuinely questionable starter, an infeasible slot, or a late
loss worth three points or more.

## Fragility and optionality — `core/startsit/fragility.ts`, `optionality.ts`

Fragility scores the roster's shape out of 100: a questionable starter with no
cover in time, a position with nothing behind it, a shared bye still ahead, a
single viable QB or TE, a lineup with no late window. It returns findings a
person can act on (`Fragile at TE`, `Need late-game insurance`) and
`projectionEffect: 0`.

Optionality scores a bench player's flexibility — eligible slots, how late he
plays, whether his role is settled, whether he covers a thin position. It has
**no `points` field**, which is the guard: this is roster-management value and
must never become a reason to start somebody.

## Streaming — `core/startsit/streaming.ts`

For QB, TE and DEF in leagues that start one. Replacement level is the median of
the top three genuinely available options in *this* league, scored through the
same engine — not a published baseline, because a twelve-team wire and a
fourteen-team wire are different facts. Inside 2.5 points of that, the spot is
streamable rather than worth holding. It never recommends dropping anybody.

---

## Grading itself — `core/grading/`

### The ledger — `model.ts`

Every recommendation is recorded before the games with the model version that
produced it, the components behind it, and each source's own `observedAt`.
`lookaheadViolations()` returns every place a record contains information from
after `decidedAt`; the steady state is an empty array, and the tests assert it.

### Counterfactual grading — `counterfactual.ts`

Two verdicts, kept apart. The **outcome** is who scored more. The **process** is
whether the call was defensible on pregame information, judged by opportunity
rather than by points:

| The alternative… | …and he | Verdict |
|---|---|---|
| got more opportunity | outscored the pick | `process_miss` |
| got less opportunity | outscored the pick | `sound_but_unlucky` |
| got more opportunity | lost anyway | `lucky` |
| got less opportunity | lost | `sound_and_right` |

Anything inside three points is `too_close_to_judge`, before the second axis is
consulted at all.

### The weekly report — `report.ts`

Four registers, never merged: observed evidence, counterfactual reasoning,
suggested bounded changes, and actual model changes — the last of which is
always empty, because a model change is a code change with a version bump.

Below twenty graded decisions the report describes the week and suggests nothing
about the model. Suggestions are capped at a 15% relative weight change, are
only ever *reductions*, and carry `applied: false` and
`requires: 'code_change_and_version_bump'`.

---

## The contract — `core/contracts/channel3.ts`

One versioned envelope (`CHANNEL3_CONTRACT_VERSION`, plus the `MODEL_VERSION`
that produced any scored field) over every output above.

- absence is `null`, never a zero;
- confidence and freshness travel inside the payload;
- beneficiary graphs are team-level, and each carries the unrostered
  `pivot` — a name, a sentence and a confidence, and nothing that acts;
- `validateChannel3Payload()` returns every problem in plain language — a wrong
  version, an unknown confidence level, a `NaN` anywhere in the tree, a source
  marked missing that carries an observation time, a self-grade claiming it
  applied something.

`tests/channel3.contract.test.ts` builds two payloads end to end from the real
modules — one fully connected, one with nothing connected — and validates both.

---

## What is not built

- **No UI.** Every output is exposed through the contract and nothing is drawn.
  Team, Waivers, Start/Sit and Setup are untouched, deliberately: the brief asks
  for reusable outputs rather than screens, and the parallel UI work stays
  mergeable.
- **No persistence.** The grading ledger is a type and a set of pure functions;
  no migration, repository or endpoint writes one yet.
- **No red-zone data**, so the expected-points model is opportunity-shaped and
  says so.
