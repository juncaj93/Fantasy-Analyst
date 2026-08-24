# Smart Bilateral Trades

A trade calculator answers "is this fair". A manager wants to know something
harder, and it is three questions rather than one:

> Given my roster, their roster, objective player value, lineup consequences and
> what this manager has historically shown a willingness to do, what trades are
> both **beneficial to me** and **realistically plausible for them**?

This is how the app answers it, what each half is allowed to do, and — mostly —
what each half is not.

---

## The three questions, and why they stay separate

Every surfaced offer passes three conceptual gates, in this order:

1. **Does this help me?** Starting-lineup points, from the app's own optimiser.
2. **Is this defensible for them?** Not "is it even" — whether the other roster
   has a *reason* to accept. A mathematically even deal with no roster logic
   behind it is arithmetic nobody acts on.
3. **Is there evidence this manager may entertain this shape of deal?** Bounded,
   applied last, and unable to change either answer above.

Collapsing them into one grade is exactly what makes trade tools useless: a
reader cannot tell a deal that helps them a lot and helps the partner slightly
from one that is even and pointless, if both arrive as "B+".

So the three travel separately all the way to the screen. Where history says a
manager pays a premium for running backs, **both** truths survive:

> Objective value: slight edge to you.
> Manager fit: above normal, because this manager has historically traded for RB
> help.

---

## Shape

```
   rosters + player pool (D1)          stored trade tendencies (D1)
            │                                     │
            ▼                                     │
   ┌──────────────────────────┐                   │
   │ rosterUtility.ts         │                   │
   │  need / surplus          │                   │
   │  marginal utility        │                   │
   └────────────┬─────────────┘                   │
                │                                 │
                ▼                                 │
   ┌──────────────────────────┐                   │
   │ bilateral.ts             │                   │
   │  generate  (cheap, capped)                   │
   │  screen    ─ value gate  │                   │
   │            ─ user gate   │                   │
   │            ─ partner gate│                   │
   │  ──────────────────────  │                   │
   │  score ◀─────────────────┼── managerFit.ts ◀─┘   capped ±0.08
   │  rank, dedup, surface    │
   └────────────┬─────────────┘
                ▼
        5 offers, each explained
```

`smartTradeService.ts` assembles it. **It does not import a Sleeper client**,
which is how "zero added Sleeper requests" is a property rather than a promise —
see [Free-plan safety](#free-plan-safety).

---

## Objective value

Reused, not invented. Value is the comparable start/sit score
`core/startsit/engine.ts` already produces — the same number the ladder is
denominated in and the Team screen draws — so a trade cannot be worth one thing
here and another thing on the screen the reader checks it against.

There is deliberately no second "trade value" currency. A second currency is a
second thing to keep calibrated against fantasy points, and the first one
already is.

### Fairness bands

Compared as a share of the larger side, so the same band means the same thing
for a swap of benches and a swap of stars:

| band | gap | meaning |
| --- | --- | --- |
| `even` | ≤ 10% | roughly even |
| `edge_user` | ≤ 25% | slight edge to you |
| `edge_opponent` | ≤ 25% | slight edge to them |
| `outside_range` | > 25% | **hard stop** |

`outside_range` is the objective sanity boundary. It is evaluated **before any
manager profile is read**, so no history can carry an offer across it — the
property holds by control flow, not by the size of a constant.

Bands rather than a number on purpose: the app has no market price for a
rostered player, and "this trade is 4.2% in your favour" would be a precision
nothing under it supports.

---

## Roster need and surplus

`core/trades/rosterUtility.ts`. The brief's rule is that raw position counts must
not be the primary model, and they are not: the primary model is the lineup.

**Marginal utility** is two runs of the optimiser and a subtraction:

```
starterGain = points(roster − out + in) − points(roster)
```

That one line answers everything a count cannot — whether the acquired player
enters the lineup, who is displaced, whether sending a player opens a worse hole,
whether the outcome is legal — because `recommendLineup` already models slots,
flex eligibility, availability and ruled-out players.

Two things a lineup total is blind to are modelled beside it:

- **Depth**, because two rosters can start the same points and be one hamstring
  apart. Counted as *startable* bench players, not bodies.
- **Need**, because "who starts on Sunday" is not "where is this roster weak
  against the league". Need is measured as a **shortfall against what the other
  rosters in this league start at the same slot rank** — a real replacement
  benchmark that costs nothing extra, since every roster has been evaluated by
  the time it is asked for.

| level | test |
| --- | --- |
| `hole` | fewer startable players than dedicated slots, or ≥ 3 pts below the league's median at a required rank |
| `weak` | ≥ 1.5 pts below that median |
| `surplus` | ≥ 2 startable players beyond what the lineup can use |
| `adequate` | everything else |

A flex slot charges **every** position that can fill it (`FLEX_SLOT_SHARE`), and
those shares do not sum to one. That is intentional: a league with two RB slots
and one RB/WR/TE flex needs a roster able to start two-and-a-bit backs *and*
three-and-a-bit receivers, because the flex has to come from somewhere and which
position fills it is decided weekly.

---

## Candidate generation, and the bounds

Two stages, because the expensive part must run on as little as possible.

**Stage one** enumerates shapes against objective value alone — a sum and a
subtraction per candidate, no optimiser. **Stage two** runs the optimiser twice
per survivor.

| bound | value | what it caps |
| --- | --- | --- |
| `targetsPerPartner` | 6 | their players considered |
| `givePerPartner` | 6 | my players considered |
| `scoredPerPartner` | 12 | candidates reaching the optimiser |
| `offersPerPartner` | 2 | offers kept per partner |
| `offersTotal` | 5 | offers surfaced |
| `maxPackageSize` | 2 | players on one side |

Shapes: **1-for-1**, **2-for-1**, **1-for-2**. Not 2-for-2 — the brief permits it
"only if pruning proves safe" and that was not demonstrated. Not player/pick
packages — the brief permits those "only if pick valuation is already
defensible", and this app has no pick valuation.

Pruning happens for nameable reasons, and every rejection carries one:
`value_gap_outside_range`, `user_benefit_negligible`, `harms_counterparty`,
`no_counterparty_logic`, `opens_hole_for_user`, `opens_hole_for_counterparty`,
`duplicate_package`, `unscorable_player`, `no_plausible_use`, `pruned_by_bound`.

**Nothing is truncated silently.** `pruned_by_bound` is recorded with a count
whenever the cap drops candidates, and the board publishes its own bounds.

### Deduplication is two rules, not one

- *Per partner*: two offers may not share a target player. The same good target
  with a different filler is one idea wearing two hats.
- *Across the board*: a surfaced offer may not share **any** player with a
  better one. "Give Amon-Ra to Dermot" and "give Amon-Ra to Kim" are distinct
  packages against distinct rosters — and a reader has one Amon-Ra, so the second
  is the same decision with a different name on it. This one was found by the
  real-league review, not by a test.

---

## Counterparty defensibility

The central product upgrade. Whether the partner has a *rational roster reason*
to accept, not merely whether the totals match:

| rationale | when |
| --- | --- |
| `fills_hole` | an incoming player **enters their lineup** at a hole position |
| `upgrades_starter` | somebody enters, somebody is displaced, **and the total rises** |
| `surplus_for_need` | outgoing from surplus, incoming to a hole or weak spot |
| `consolidates_depth` | they receive one and send two or more, from real depth |
| `spreads_depth` | they receive two or more and both start |
| `no_worse_hole` | surplus moves without opening a slot |

The two "and" clauses above are load-bearing and were added after the real-league
review: need is measured against a league benchmark, so a position can read as a
hole and still be one the incoming player does not improve. Without them a card
said *"Dermot upgrades a starting slot"* directly above *"their lineup does not
improve"* — a card arguing with itself.

An offer with **no lineup gain and no rationale** is rejected outright.

---

## Manager fit, and its cap

`core/trades/managerFit.ts`, reading the trade tendencies the shipped history
subsystem derives. Four properties are enforced here rather than left to callers.

### 1. The contribution is capped

`MANAGER_FIT_CAP = 0.08` against a composite that runs 0–1 — roughly one band of
a single objective gate, never two. Symmetric, so the feature can demote as well
as promote.

Terms, each a fraction of the cap and each scaled by evidence confidence:

| term | worth |
| --- | --- |
| activity, against the league's own rate | ±0.5 cap |
| offer shape matches his record | +0.2 cap |
| has historically acquired this position | +0.2 cap |
| has historically sent this position | +0.2 cap |
| has dealt with you before | +0.2 cap |
| has never sent two for one, and this asks him to | −0.15 cap |

### 2. Unknown is never inactivity

The standing manager-intelligence principle, and the one that would be invisible
in production because an incomplete backfill and a quiet manager produce
identical empty profiles.

| class | condition |
| --- | --- |
| `active` | ≥ 6 trades and ≥ 1.5 per season |
| `selective` | ≥ 3 trades |
| `low_activity` | 1–2 trades across ≥ 2 **fully read** seasons |
| `effectively_inactive` | 0 trades across ≥ 2 **fully read** seasons |
| `unknown` | everything else — and it contributes **exactly zero** |

"Fully read" is the load-bearing phrase. A season counts only when its
transactions checkpoint is marked complete by the ingestion subsystem, which
never happens for a live season — so the current season contributes to trade
counts and never to observed-season counts, and no manager is called inactive on
the strength of a season still in progress.

Telling these apart needs a cross no single table can do: the ledger's **roster
identities** (which seasons was he in the league) against its **transaction
checkpoints** (which of those were read to the end). `SmartTradeService.history`
does that cross, and it is the only reason it reads those two tables.

An inactive manager lowers rank; he does not hide the best roster fit. The offer
still appears, with *"Strong roster fit, but this manager rarely trades."*

### 3. Small samples cannot move much

Deterministic shrinkage toward the **league's own** rate rather than a constant,
so a low-trading room does not read as twelve inactive managers:

```
rate = leagueRate + (observed − leagueRate) × n / (n + 4)
```

`TRADE_SHRINKAGE_K = 4` is trade-specific and deliberately not the draft
module's constant — a draft is sixteen observations a season and trades are often
zero.

Confidence halves while a league's history is still being read: forty trades out
of an unfinished ingestion is forty trades and an unknown remainder.

One deliberate inversion: a manager with **zero** trades is scored on seasons
rather than sample. Otherwise the strongest finding available — "three complete
seasons, no trades" — would carry the lowest confidence and be scaled to nothing.

### 4. Nothing here is a probability

Sleeper publishes completed trades and not declined offers, so "68% likely to
accept" has no denominator and never will. The output is a bounded weight, a
class, and sentences built from counts.

---

## Ranking

Weights, in the brief's order of importance. They sum to one; manager fit is
added afterwards and clamped.

| term | weight |
| --- | --- |
| user benefit | 0.45 |
| objective fairness | 0.20 |
| counterparty benefit and defensibility | 0.30 |
| package simplicity | 0.05 |
| manager fit | ±0.08 |

**Evidence confidence is not a separate term**, though the brief lists it as a
ranking criterion. It is one — applied where it belongs, scaling the strength of
every behavioural claim inside `managerFitFor`. Counting it again as its own
weight was a defect: it double-counted a measured manager's confidence, and it
punished the wrong party, because an unmeasured manager scores zero and every
offer in a league nobody had backfilled ranked below an identical one in a league
that had been — by up to 0.10, which is *larger than the cap* and the exact
opposite of "unknown stays neutral".

With it gone, manager history reaches the ordering through exactly one channel,
bounded by exactly one constant. `tests/trades.bilateral.test.ts` pins both: an
unmeasured manager produces a byte-identical composite, and no manager reading
moves an offer's score by more than `MANAGER_FIT_CAP` against the same offer read
with no history at all.

Fairness is discounted **one-sidedly**: an edge to the user is not worse than an
even deal — the brief permits seeking one — but paying over the odds is.

Counterparty is half lineup points and half rationale count, which is how "an
even but pointless deal ranks below a smaller one that solves something for
them" becomes arithmetic rather than a policy.

**The composite never reaches the screen.** The UI must not expose an
unexplained magic score, so it is carried in the payload beside its own terms for
the probe and for an auditing human, and the screen prints only points, counts
and sentences.

Ties are broken deterministically all the way down to the offer id, so two
identical requests produce an identical board.

---

## Degradation

| state | behaviour |
| --- | --- |
| no history derived at all | every partner `unknown`, contribution 0, offers ranked on roster fit alone |
| profile exists, seasons unsettled | confidence halved, `uncertain`, "history is still being read" |
| manager not in the ledger | `unknown` — never inactive |
| a player cannot be scored | excluded from packages; never valued at zero |
| roster not identified | a board with a sentence, not an error |
| no good trade exists | says so; no filler |
| no meaningful need | says so, differently |
| the request fails | Trades looks exactly as it did before this shipped |

Nothing on this path throws. A trade suggestion is an enhancement to a screen
that has other things on it, and behavioural intelligence is an enhancement to
*that* — not a dependency.

---

## Free-plan safety

**Zero added Sleeper requests on a Trades page load.** Every input is a stored
row: the league, the rosters, the player pool, the trade tendencies, the ledger's
identities and its checkpoints. The history subsystem's `advance()` walks Sleeper
on a cron; this is the `derive` side of that split reading its output.

`tests/trades.smartService.test.ts` hands the app a Sleeper client that throws on
any request and asserts the call list is empty, so a future change that adds a
fetch to this path fails there rather than in production against the free
ceiling.

Measured on a twelve-team league of fifteen-man rosters: **628 candidates
generated, 132 scored (79% pruned), 7 viable, 3 surfaced, 58ms**.

---

## Diagnostics and review

`GET /api/trades/smart` — the board.
`GET /api/diagnostics/smart-trades` — the same board with every rejection kept.

`scripts/probe-smart-trades.mjs` reads both against a deployment, read-only,
and reports managers evaluated, candidate counts before and after pruning,
fairness, user utility, counterparty utility, manager-fit contribution, evidence,
rejection reasons, added Sleeper requests, latency, and **whether history changed
the ordering** — computed by re-ranking with the manager term subtracted.

Its checks live in `scripts/lib/smartTradeReview.mjs` and are exercised against
real violations in `tests/probe.smartTradeReview.test.ts`, because a gate nobody
has seen fail is a gate nobody knows the shape of.

---

## Known limitations

- **Package fairness is a sum of individual values.** Real trade markets are
  convex — one great player is worth more than two good ones — and a sum is not.
  The 25% band and the lineup gates catch the extremes; a 2-for-1 near the band
  edge is priced more roughly than a 1-for-1.
- **No draft picks.** The app has no pick valuation, so pick packages are not
  generated. Sleeper publishes the picks that moved and the ledger stores them;
  valuing them is a separate lane.
- **No 2-for-2.** Excluded until pruning it can be shown safe.
- **Value is a weekly score, not rest-of-season.** It carries no schedule, bye
  or playoff weighting, so a trade is priced on this week's evidence about both
  players. This is the same limitation every other surface in the app has.
- **Need benchmarks come from rosters, not free agents.** A league where a
  position is scarce on rosters but plentiful on waivers will read as scarcer
  than it is.
- **Incomplete first-season leagues get no behavioural signal at all**, which is
  correct and also means the feature is quiet in exactly the league most likely
  to be new.
- **Automated WebKit does not prove real-finger gesture arbitration**, per the
  standing note in `sheet-vs-pull.spec.ts`. The sheet added here is checked the
  same way and inherits the same caveat.

---

## Connection to the rest of manager intelligence

The roadmap is three lanes off one ledger:

| lane | consumer | state |
| --- | --- | --- |
| draft tendencies | `Next%` | shipped |
| **trade tendencies** | **Smart Bilateral Trades** | **this** |
| transaction/waiver tendencies | Waivers | future — see `MANAGER_INTELLIGENCE.md` |

This lane implements the second only. `Next%` and Waivers are untouched.
