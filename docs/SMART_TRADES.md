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

### Defences are excluded, and it is a rule rather than an accident

> **A DST is never a Smart Trades target or trade asset, and an unfilled DEF
> slot is never a roster need for trade purposes.**

Nobody trades for a defence. A DST is a two-dollar waiver claim in every league
that starts one, it is streamed weekly by anybody paying attention, and an offer
built around one wastes the reader's attention at best.

This app has never surfaced such an offer — but until the DST lane that was an
**accident**. `tradeableFrom` drops any player the engine could not score,
defences were unscorable everywhere, and so a defence was excluded for a reason
that had nothing to do with defences. Making a DST scorable removed the
accident, so the rule it was standing in for is now written down and enforced.

**Two independent gates**, because one of them silently regressing is how this
would fail:

1. `rosterUtility.ts` — `needFor` returns a permanently **`adequate`** need for
   an excluded position, whatever the roster holds. That single answer takes DEF
   out of `hasNeed()`, out of the need multiplier in `upgradeOver`, out of
   `spareness`, and out of every `fills_hole` and `surplus_for_need` rationale.
   The entry is *present and flat* rather than missing, because six call sites
   read `needs.get(position)` and each has its own default for an absent one.
   `adequate` rather than `surplus` for the same reason: `surplus` is an
   argument *for* moving somebody, and the invariant is that a trade has no
   opinion here at all. A spare defence is also not counted as bench depth, so
   `depthChange` cannot move on one.
2. `bilateral.ts` — `tradeableFrom` filters excluded positions explicitly. It
   does not depend on a defence being unpriced, thin, cheap or unwanted. It
   depends on it being a defence.

`tests/trades.dst.test.ts` asserts all of it against a **genuinely scorable**
defence — a real game line, a real league defence table, a non-null score — in
the league shape where the invariant is actually at risk: no defence on the
user's roster, a good one on the partner's, and everything else adequate on
both. A test built on an unscorable DST would pass against no exclusion at all.
It also asserts the other half: every non-DEF position's need is byte-identical
to the same league with the defences removed, so the exclusion cannot distort
what it is not about.

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

## The ladder: what one named player costs

The board answers *who is worth pursuing*. That is discovery, and it stops one
question short of a conversation — nobody opens a trade by naming a player and
saying nothing about the price.

`GET /api/leagues/:id/trades/ladder?playerId=` is the second question, and
`core/trades/ladder.ts` is the model behind it: where to open, the band inside
which the deal is fair to both rosters, and the point past which winning the
argument means losing the trade. It is a **separate request on purpose**. It
runs the lineup optimiser four times — my roster with and without him, his
owner's with and without him — and nobody wants that computed for sixty players
they are not pursuing.

### Where it is drawn

Two places, and both of them are closed until asked:

| surface | reached from | target |
| --- | --- | --- |
| the offer sheet | tapping a trade idea | the single player the offer receives |
| the trade case | tapping a board row, in the market fold | that row's player |

`components/tradeLadder.tsx` owns both, as one self-fetching fold. The request
goes out on the first open and never on a screen's first paint, which is checked
by counting it in `e2e/trade-ladder.spec.ts` rather than assumed.

The fold is absent entirely where a ladder cannot exist: your own player has no
partner to negotiate with, and a free agent is an add rather than a trade — the
endpoint says so itself instead of 404ing, and the screen respects that by not
drawing a control whose answer is already known. An offer whose return is a
*package* also gets none: a ladder prices a named target, and pricing the first
name in a package and calling it the deal would be a fabrication.

### What it may say about the partner, and what it may not

The rule of [§2 above](#2-unknown-is-never-inactivity), in the form a UI is
likeliest to break it. `partnerRead` in `tradeLadder.tsx` is the gate, and it is
a pure function with a test for exactly that reason:

- **the name is a fact** and is printed whenever Sleeper has named the seat.
  Never a stand-in like `Roster 4`;
- **below `MIN_TRADE_SAMPLE` nothing is claimed.** No headline, no notes. What
  the reader gets instead is one sentence about the *evidence* — no profile has
  been built, or no completed trade is on record, or the count is too thin —
  which is a fact rather than a read;
- **above it the sentences are the profile's own**, unedited.
  `core/managers/tradeProfile.ts` already decides which are supportable and
  already ends them with the sample they rest on; a second opinion here would be
  a second thing to keep honest.

This is the case a league is in **on the night its draft ends**, which is when
the feature has to be correct rather than merely available: rosters are set, the
ladder prices perfectly well, and there is not one completed trade in the room.
Every manager is unmeasured rather than inactive, and the card says so.

The engine applies the same rule to its own reasons. `buildLadder` widens the
opening discount only for a partner whose negotiation style is *known*, and
`prefersConsolidation` is false until the profile is confident — so a thin
sample changes no number, not just no sentence.

### Units

Weekly starting-lineup points, from the same optimiser the Team screen draws and
the same one the offers above are scored in. There is no separate trade currency
to keep in step with anything, and the card names the unit rather than printing
bare figures — §15's rule about unexplained numbers applies to a price band as
much as to a composite.

Nothing on this surface sends a trade, opens a chat, or names a price to anybody
but the reader. `advisory: 'never auto-sent'` is a field on the response.

---

## Activation: nothing switches this on

There is no Smart Trades activation step, and that is a design decision rather
than an omission. Two mechanisms that already existed compose into it:

1. **`SleeperSyncService.adoptCompletedDraftRosters`** re-reads a league's
   rosters the moment a draft is seen complete. It is written as a *state check*
   — "is the draft complete and does no roster hold a player?" — rather than as
   an edge, so a Sleeper outage during the one poll that saw the transition does
   not strand the app: the next sync re-offers the repair.
2. **`SmartTradeService` reads `listRosters` on every request.** It holds no
   cache and has no enabled flag.

So the sequence is:

| when | what happens | who triggers it |
| --- | --- | --- |
| pre-draft | Sleeper reports empty squads; the board says so, naming the draft | — |
| last pick lands | the Draft screen's poll sees `complete`, adoption re-syncs the league, `replaceRosters` writes the real squads | the draft poll |
| next Trades read | populated rosters → offers | the reader opening Trades |
| a trade or waiver later | `syncLeague` replaces the rows wholesale | league select / Team refresh |

`replaceRosters` is a delete-and-insert, so **every** roster change — draft,
trade, waiver, add/drop — arrives the same way. There is nothing incremental to
keep in step and nothing to invalidate.

**No new cron, no polling loop, and no read-path fetch.** Adding a sync to the
Trades read would have been the obvious way to guarantee freshness and would
have cost the zero-Sleeper-request property; the sync lifecycle already owns
that job.

`tests/trades.lifecycle.test.ts` drives this end to end through the sync paths
alone — a league is synced, a draft is polled, the draft finishes, a roster
changes — and **no Smart Trades method is called except a read of the board**.

---

## Formats that cannot trade

Asked before anything else, because the answer is free and permanent.
`core/trades/capability.ts`:

| basis | source | effect |
| --- | --- | --- |
| `best_ball` | `detectBestBall` on Sleeper's own settings | hard stop |
| `trades_disabled` | `settings.disable_trades` | hard stop |

Best ball is the stronger case: there is no weekly lineup decision at all, so
the marginal-utility model has nothing to measure — "does this player enter your
lineup" has no answer in a format with no lineup.

The distinction this exists to preserve is *why* a screen is empty. "Your draft
has not happened yet" resolves itself on a date; "this format has no trading"
never does, and reporting the first when the second is true tells somebody to
come back for a feature their league will never have.

**An unstated flag is not a block.** `detectBestBall` answers `confident: false`
for a league Sleeper has described neither way, and that falls through to
tradeable — the overwhelmingly common league carries no flag and does trade.

---

## Degradation

| state | behaviour |
| --- | --- |
| pre-draft, rosters empty | says so, naming the draft; resolves itself when the draft completes |
| best ball / trades disabled | says so, naming the format; permanent |
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
- **The trade deadline is not read.** A league past its deadline can still be
  offered trades. `settings.trade_deadline` is a week number and the check needs
  a clock `tradeCapabilityOf` deliberately does not take; it belongs with the
  capability gate when it is added.
- **Activation depends on some sync running.** A reader who opens Trades as
  their very first action after a draft, having opened nothing else, sees the
  pre-draft state until any sync runs. The draft poll normally beats them to it;
  the alternative was a fetch on the read path, which costs the zero-request
  property.

---

## Connection to the rest of manager intelligence

The roadmap is three lanes off one ledger:

| lane | consumer | state |
| --- | --- | --- |
| draft tendencies | `Next%` | shipped |
| **trade tendencies** | **Smart Bilateral Trades** | **this** |
| transaction/waiver tendencies | Waivers | future — see `MANAGER_INTELLIGENCE.md` |

This lane implements the second only. `Next%` and Waivers are untouched.
