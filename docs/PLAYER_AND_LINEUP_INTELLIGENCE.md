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

## One decision number — `core/startsit/decisionPoints.ts`

Added 30 September 2026, after the Team card said `Start RJ Harvey over Mark
Andrews · +2.31` while the Compare sheet for the same two players said start
Andrews, 3.9 against −1.6. Measured on production
(`scripts/probe-banner-vs-compare.mjs`): the card ranked on Rotowire's
published weeks with nothing added (9.53 − 7.22), and the sheet ranked on
`score`, whose 5.4-point gap was almost all market coverage (one of Harvey's
four lines posted, three of Andrews').

Both now rank on `decisionPoints`:

| Market | Number |
| --- | --- |
| Complete | `score`, unchanged |
| Partial, with a published week | Rotowire's week + the same status, news, usage and matchup reads `score` carries (not the partial market sum or its coverage penalty) |
| Partial, nothing published | `score`, as before |
| None | `unpriced`: the sheet prints `score` under its warning; the lineup treats him as unrankable |

`replacement_risk` needs the whole roster, so it orders the lineup but stays
out of the number a suggestion is printed with. Every suggestion therefore
equals the Compare sheet it opens: same winner, same margin
(`tests/startsit.suggestionAgreesWithCompare.test.ts`). The sheet also runs in
the lineup's own mode rather than always Balanced.

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

## Where it plugs in — `core/contracts/integration.ts`

Three modules landed on `main` while this was being written, each with a named
hole in it. This file fills them and does nothing else: every projection targets
a type **imported from the module that owns it**, so a field renamed over there
fails the build here instead of quietly going unfilled.

| Hole | Owner | Filled with |
|---|---|---|
| `advanced` | `startsit/weekCard.ts` | one expected-points line, the reading in its detail |
| `whatWouldChange` | `startsit/weekCard.ts` | the boundary sentences, already written |
| `multiWeek` | `waivers/board.ts` | the four-week verdict, mapped to the board's four levels |
| `fourWeekValue`, `streamingReplacement` | `roster/bench.ts` | the horizon and the measured replacement level |

Two of those are supplied by the server today. The lineup endpoint attaches
expected points to every evaluation with stored usage, and the waiver endpoint
attaches the multi-week level to the players who made the board — the column
`docs/STATUS.md` recorded as having no supplier. Neither changes an ordering,
a score or a screen: both are data arriving in slots that were already drawn.

**The sensitivity pass is affordable because it is rare.** A boundary only
exists for a close call, and closeness is known from scores already computed —
the gap between a starter and the best bench player his slot accepts. That
subtraction gates the bisection, so a roster of comfortable calls pays nothing.

### Two things called optionality

`roster/bench.ts` scores a bench *slot* and labels one component `Optionality`,
meaning **whether the role could still grow**. `startsit/optionality.ts` asks
**how many of the week's futures a player covers** — slot eligibility, kickoff
time, positional scarcity. Both are useful, they are not the same quantity, and
the assessment carries `kind: 'lineup_coverage'` so a consumer holding both
cannot print one under the other's label.

---

## What is not built

- **No UI.** Nothing here draws anything. Two endpoints now fill slots that the
  Weekly and Waivers screens already render, which is the opposite of adding a
  screen: it is why those slots were declared.
- **No persistence.** The grading ledger is a type and a set of pure functions;
  no migration, repository or endpoint writes one yet, so the weekly self-grade
  has no history to run over in production.
- **No red-zone data**, so the expected-points model is opportunity-shaped and
  says so.
- **No future schedule**, so the role-specific outlook has no source in the
  running app and the multi-week value falls back to role trend and the
  expected-points gap. The component that could not be computed reports itself
  unknown rather than contributing a zero.

## Start/Sit round 2 (October 2026): Vegas first, pills, one number

**Principle (settled with Alex):** do not try to be smarter than Vegas. The
market number is the score; everything else is a small capped nudge or text.

**Scoring** (`core/startsit/scoringRules.ts`, engine `startsit@4`, `startsit@5` for the Questionable change):

- Lifetime news, role trend, touchdown dependency, game script, explosive role
  and opportunity are computed and shown as text and add zero points.
  Recent news (30d), opponent by role and the uncertainty penalty stay as
  nudges inside the existing 10% budget. Availability stays a gate outside it:
  Out (and IR, PUP, suspended), a bye and Doubtful move the score as before.
  Since 13 October, Questionable and any other reported status cost nothing
  (`core/injury/startsit.ts`); they show as a warning chip on the Compare card
  and one line on Best move ("McConkey is questionable and may not play"),
  from `core/startsit/availabilityChip.ts`.
- Weather has three states: a real forecast moves only the passing game and
  kickers, only for strong wind or snow; a dome or closed roof is "known,
  unaffected" (fixture list first, `core/nfl/roofs.ts` for a blank roof);
  otherwise "no forecast yet". No forecast feed is connected.
- A prop taken before the latest game line is scaled by how far the team's
  implied total moved, capped at 8% (`staleLine.ts`). On 13 October no game
  qualified: props and lines are stored from the same fetch.
- The line-to-average conversion (`propConversion.ts`: de-vig, lognormal and
  Poisson means, touchdowns as a rate) is built, tested and **off**. The
  backtest below found it raised the average miss.

**Backtest** (`scripts/probe-startsit-round2.mjs`, 13 October 2026, weeks 1-4,
477 fully priced player-weeks, league-scored actual points):

| method | average miss | higher-scored won | close calls (<2 pts) |
| --- | --- | --- | --- |
| before this round | 4.838 | 71.4% | 56.1% |
| shipped rules | 4.840 | 71.4% | 56.3% |
| with the conversion on | 4.896 | 71.4% | 55.8% |

Actual points ran above the bare line by 17% for backs and 8% for receivers,
so lines do read low on average; reading them as averages cut the bias but
not the miss. Production stores only the over price, so two-sided de-vig never
applies to yardage.

**Pills** (`pills.ts`): Explosive, Steady, Wide range, read off the same lines,
at most one, none under an eight-point week. They never change a score. Inside
the 0.6-point close-call band the underdog takes Explosive and the favourite
Steady (`tiebreak.ts`), in the lineup and in Compare.

**Screens:** Team's card is "Best move" in the Matchup row's style and is the
only start/sit advice in the app. Matchup shows no recommendation. Compare is
one screen: a pinned one-line strip of up to four players (it scrolls
sideways, `+ Add` stays at the right), a picker with My roster, Waivers and All
players sorted by this week's number, a side-by-side verdict whose cards keep
two fixed chip slots (pill, availability), and one table straight under it:
Vegas lines, Recent news, Opponent and Score, a dash for a missing value, no
heading and no "no effect" line. Two or three players fit one screen; with four
the cards and the table scroll sideways and the table's labels stay pinned. The picker, Compare, Best move and the waiver tiers all print
`weekPoints()` (`core/startsit/weekPoints.ts`); `tests/startsit.oneNumber.test.ts`
fails if two of them disagree.

### 13 October 2026 follow-up: one number on Team too

- **Cause of the mismatches Alex saw.** Team's lineup rows printed
  `weeklyProjection` (the bare market or Rotowire's week) while Best move,
  Compare and the picker printed `decisionPoints` (the same base plus the
  capped news, opponent and uncertainty nudges). Not a cache. The rows now read
  `weekPointsBeforeStatus` and `rowFigure` applies the availability charge, so
  every surface prints `weekPointsOf`. `tests/startsit.oneNumber.test.ts` covers
  the rows, the "Start X instead" figure, Best move, Compare, the picker and the
  Team waiver line against the Waivers page.
- **Out is a word.** `weekPointsFrom(decision, ruledOut)` returns no number and
  `out: true`; screens print "Out" and Best move says "who is Out". The gate is
  unchanged.
- **No fragments.** A partial market with nothing published has no number
  anywhere (the waiver tiers already refused it). The published store holds one
  total per player, so filling individual stats from Sleeper would need a
  schema change.
- **Compare table.** Base, Recent news, Opponent, Uncertainty, Score, summing on
  screen (`src/web/compareTable.ts`). Base is the full Vegas number or Sleeper's
  week; tapping it lists each priced line and its points in words.
- **Lists** sort strictly by the number, priced and published mixed, with
  nobody's number and Out last.

### 15 October 2026: Vegas lines in Compare, grey Sleeper numbers, no Uncertainty

- **Compare table.** Base, then the lines Vegas posted (Yards = rushing plus
  receiving, or passing for a QB; Catches; TD %), then Recent news, Opponent,
  Score. A group of only QBs gets Pass yds, Pass TD, Rush yds. The lines are
  read, not summed; the number rows still add up to Score. No taps and no
  paragraph. Rows are 34px, so two to four players fit one phone screen with
  nothing scrolling sideways (`e2e/compare-vegas-lines.spec.ts`, all widths).
- **Grey Sleeper numbers.** One rule, `src/web/sleeperFallback.ts`, and one
  label, `SleeperTag`: a number on Sleeper's week (basis `published`) is drawn
  in `--text-faint` with a small "Sleeper" under or beside it. Compare (cards,
  chips, picker, table), Team rows and the "instead" figure, Best move,
  Matchup and the weekly card. A posted line keeps its colour; a missing line,
  or a partial yards total, is grey. Waivers, Trades and Players print no
  per-player Start/Sit number on their face (Waivers' tier sheet shows the
  planner's rate, which the planner owns), so they are unchanged.
- **Uncertainty out of the score (`startsit@6`).** Text only, players and
  defences. Backtest (`scripts/probe-compare-vegas.mjs`, weeks 1 to 5, 673
  fully priced player-weeks, league-scored actual points):

  | | average miss | bias | higher-scored won |
  | --- | --- | --- | --- |
  | `startsit@5`, with it | 4.917 | −0.95 | 71.2% |
  | `startsit@6`, without it | 4.927 | −0.71 | 71.1% |

  +0.010, inside the "no worse than 0.01" rule, so it shipped. The 4.840 of
  13 October was weeks 1 to 4; week 5 raised both. On Alex's roster the
  largest moves were +0.50 (Love, Bijan), +0.45 (Walker), +0.36 (Collins),
  +0.33 (Pickens); Best move did not change.

### 16 October 2026: Compare follow-ups from the phone check

- **Winner rule** (`core/startsit/completeFirst.ts`, inside `compareStartSit`):
  when a comparison mixes complete Vegas markets with Sleeper-only numbers,
  only a complete, healthy player can be the pick. The best Sleeper-only player
  above him is returned as `sleeperOnly` and drawn as a second choice: dashed
  grey outline, a grey number and "Sleeper only" (Alex: that is enough), no
  check and no green. All complete or all Sleeper-only: unchanged. Scores are
  unchanged, so the engine stays `startsit@6`.
- **The Team lineup does not use this rule.** It ranks a Sleeper-only player
  at his number less `BORROWED_RANKING_DISCOUNT` (2 points, `lineup.ts`), so a
  Sleeper-only player more than 2 points ahead can still take a slot and lead
  Best move, while Compare on the same pair would now start the Vegas player.
- **Sheet:** Compare's header is one row: title and week, the list's action
  (+ Add, Hide list, Compare) and an X (`Sheet close="x"`, 44px, "Close").
  Every other sheet keeps Done; the option is there for them.
- **Picker:** no preview of the answer while choosing; 8px between sections;
  the first tab reads "My team".
- **Cards:** photos 60px for two players, 46px for three, 36px for four (above
  the score). Chips: three or four share the row; the number moves under the
  name and the whole chip is the remove target, so nothing is cut off at 360px.

### 16 October 2026, round 2: card polish, one fallback marker, Vegas first on Team

- **Compare cards** are one centred column: name, position pill and team logo
  (`TeamLogo`, abbreviation when the logo is missing), photo (96px for two,
  76px for three, 56px for four), score, and Start at the foot of the pick.
  Rows line up across cards (CSS subgrid). No verdict sentence under the cards.
- **One fallback marker** (`.num-sleeper`, `src/web/sleeperFallback.ts`): a
  number built on Sleeper's week is italic with a 1px dotted underline, the
  treatment Matchup's borrowed figures already had. No "Sleeper" word beside
  any number (Compare cards, chips and picker, Team rows and the "instead"
  figure, the empty-slot figure, Matchup rows, the weekly card); screen readers
  hear "Sleeper projection". The word stays only inside the Best move sentence.
  Compare also greys it; a missing line or a partial yards total is grey but
  not marked.
- **Vegas first on the Team screen** (`lineup@5`, `recommendLineup({ vegasFirst })`,
  turned on by `assembleLineup`): a Sleeper-only player is never started or
  suggested over a healthy, fully priced player and takes a slot only when no
  priced player can. When a Sleeper-only player is starting and a priced one is
  on the bench, Best move names the swap even when the priced number is lower,
  with that reason. The 2-point `BORROWED_RANKING_DISCOUNT` no longer applies on
  Team; the waiver planner, the trade engine and Matchup's decision still use it.
