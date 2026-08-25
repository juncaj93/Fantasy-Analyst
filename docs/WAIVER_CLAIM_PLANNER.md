# The waiver claim planner

> **Status: built, tested and wired.** The Waivers screen opens on the plan.
> The seam is `core/waivers/claimPlan.ts` — two functions, one call from the
> endpoint — and it is described in [Integration contract](#integration-contract)
> and [What the reader sees](#what-the-reader-sees).

The question this answers, in one sentence:

> Who should I add, what should I bid, who should I drop, and how should I
> structure all of my claims so I end up with the best realistic roster?

The existing Waivers screen answers the first half. It ranks who is available,
what each is worth against the man currently in the slot, and what the FAAB pass
thinks each will cost. What it has never answered is the half that actually
stops people: **who do I drop, and does that change depending on who I am
adding?**

---

## Why a drop ranking is not a list

The obvious implementation is one ranking of your worst players, computed once,
shown next to every add. That ranking exists — it is `core/roster/bench.ts`,
which scores each held player as *a slot* rather than as a player and is what
the Team screen's bench view draws.

It is the wrong answer to a claim, because the preferred drop moves with the
incoming player:

| you are adding | and suddenly |
| --- | --- |
| a running back | your spare running back is expendable, and your cut order at receiver has not moved |
| a strong tight end | your second tight end is the obvious drop — a moment ago he was the only cover at the position |
| a quarterback, in a one-QB league | nothing about your cut order changes at all |
| a quarterback, in superflex | your flex depth genuinely does |
| a bench stash | nobody becomes more expendable, because he replaces nothing |

None of those are rules in the code. They fall out of one function.

---

## One number, and everything else is subtraction

`core/waivers/planner/rosterState.ts` defines **roster utility** — `U`, a
function of a set of player ids:

```
U(roster) = lineupPoints
          + BENCH_OPTION_WEIGHT × Σ (bench option value)
          − BARE_POSITION_COST  × (positions with no spare startable body)
```

Three genuinely different things, not one thing counted three times.

1. **The lineup** is `recommendLineup` — the app's own optimiser, the same one
   the Team screen draws. It is what this Sunday is worth.
2. **The bench, as options.** A lineup total scores a roster holding one tight
   end exactly like a roster holding two, right up until Sunday morning. Each
   bench player is worth what the existing bench model says holding him is
   worth, less whatever would replace him — the wire at his position, or a
   *better* rostered player who can fill the slots he fills. Discounted to
   roughly a third, because a bench spot pays only in the weeks it is called on.
3. **Cover.** A flat charge per position the league must start and the roster
   has no spare body at. This is the only term that sees "you are one hamstring
   from a slot you cannot fill".

Everything else in the folder is two calls to `U` with a minus sign between
them:

```
addValue    = U(roster + add) − U(roster)
dropCost    = U(roster + add) − U(roster + add − drop)
netRosterGain = addValue − dropCost
```

**The add-specificity is not implemented.** It is an accident of subtraction:
`U(roster + TE − oldTE) − U(roster + TE)` and `U(roster + QB − oldTE) −
U(roster + QB)` are subtractions over different sets, so they give different
answers without anybody writing a rule. A hand-written "the incoming player
covers this one" adjustment would be a second model to keep honest; this cannot
disagree with itself.

Two guards are worth knowing about, because both are admissions:

- **Cover flows downwards only.** Let two similar backs cover each other and
  each one's option value is cancelled by the other's, so cutting either appears
  to *improve* the roster. Only a better bench player counts as cover, which
  breaks the cycle and is also the truer statement — a backup insures a starter,
  and the man behind him does not insure *him*.
- **A drop cost is never negative.** Removing a player cannot make a roster
  better. The option term can occasionally say otherwise; the floor guarantees
  the remainder never reaches a recommendation.

---

## The protection boundary

A waiver claim is a small decision and it must not be able to make a large one.
There is no hand-maintained untouchable list. A rostered player is off the table
when:

| reason | meaning |
| --- | --- |
| `in_lineup` | the optimiser starts him **on the roster that already contains the add** |
| `core_value` | removing him costs the lineup ≥ `PROTECTED_LINEUP_COST` (2 pts), or he is a defence |
| `reserve_slot` | he occupies an injured-reserve slot, which is not a bench spot |
| `unscorable` | the engine cannot score him, so no confident cut can be named |

The first is measured **after the add**, and that is load-bearing rather than
fastidious. A starter displaced by the arriving player is no longer in the
lineup and is no longer protected — which is how a straight upgrade claim finds
its drop with no special case, and why a roster of seven players for seven slots
can still make a claim.

---

## Claim structure

Sleeper processes claims in the order they were entered, and a claim whose drop
is already gone does not execute. That is a real mechanism, and exploiting it
produces a plan that looks like a mistake:

```
1. Add A — drop C
2. Add B — drop C
3. Add B — drop D
```

One player claimed twice, one drop spent twice. If claim 1 lands, C is gone,
claim 2 cannot execute, and B is only pursued through claim 3 at the cost of a
second drop. If claim 1 fails, claim 2 is the preferred way to land B and claim
3 never comes up.

The plan is built in two passes:

- **The spine** is the world where everything lands: the best pair on the roster
  as it stands, then the best pair on the roster *after that claim succeeded*,
  and so on. The second spine claim's drop is already different from the first's,
  because the first one spent it.
- **The fallbacks** are the worlds where a spine claim fails. A target whose best
  move needs a drop an earlier claim would consume gets that move inserted
  directly beneath the claim that would consume it.

A move that would execute in *both* worlds is not a fallback — it is a second
acquisition, and it belongs on the spine or nowhere.

Every spine claim below the first must clear the bar **in both worlds**: against
the roster the spine produced, and against the roster as it stands today. Sleeper
does not know a claim was conditional, so a claim that is excellent if the ones
above it land and a bad trade if they do not is a trap.

---

## Target relationships

Nothing labels two players as substitutes. The planner acquires the first, re-runs
`U`, and asks what the second is still worth — one division:

| relation | ratio of incremental to standalone |
| --- | --- |
| `redundant` | ≤ 0.15 |
| `substitute` | ≤ 0.6, or the incremental gain no longer clears the bar |
| `conditional_complement` | still worth having, but only by spending a different, more expensive drop |
| `complement` | worth nearly as much as it was on its own |

The same two receivers are substitutes on a roster that starts two and
complements on a roster that starts three, and no static label gets both right.

---

## Money

**The planner does not price anything.** Bids come whole from
`core/faab/strategy.ts` — the recommendation, the ceiling, the headline, and the
withholding when there is not an honest figure. Two claims for one target carry
the same bid, because two prices on one player would be two opinions about what
he is worth and the difference between them would be a fact about claim ordering
rather than about football.

The budget constraint is deliberately conservative. **Nothing in this repository
establishes what Sleeper does with a set of pending claims that together exceed
the budget** — the FAAB layer is built and tested against constructed
transactions, and a live waiver run has not been watched. So the plan is held to
the one condition safe under every possible semantics:

> No set of claims that could all succeed may total more than the remaining
> budget.

Mutually exclusive claims never both land and never both count, so a fallback is
free — which is what makes the A/B/C/D structure affordable at all. When the
constraint bites, the plan gives up the cheapest *acquisition* (never the primary
claim, never a fallback) and says which one and what it would have cost. Bids
themselves are never altered.

---

## Bounds

| limit | default | what it bounds |
| --- | --- | --- |
| `maxTargets` | 6 | targets looked at, cut **before** any pair arithmetic |
| `maxDropsPerTarget` | 3 | drops turned into pairs per target |
| `maxClaims` | 4 | claims a plan may contain |
| `maxOutcomes` | 6 | branches reported |
| `minNetGain` | 0.5 | roster utility a pair must gain to be recommended |

Worst-case optimiser runs are `2 + maxTargets × (1 + rosterSize) × (maxClaims + 2)`
— loose, because it assumes nothing is shared and almost everything is: states
are memoised on the sorted id set. On the suite's fifteen-player, twelve-target
fixture the measured figure is 193 against a ceiling of 578, and a plan takes a
few milliseconds. The outcome tree is at most `2^maxClaims` walks, deduplicated
by the claims that actually executed.

Lengthening the wire past `maxTargets` does not make the search bigger. There is
a test for that.

---

## Unknown is allowed

The failure mode this guards against is the worst one available to the feature:
a model that treats missing data as zero makes the player the app understands
least — an unpriced rookie, a returning starter with no market — the first name
on every cut list.

- An unscorable roster player is `protected: 'unscorable'` with a **null** cost,
  never a cheap drop.
- If *nothing* on the roster can be scored, `dropAdvice` is `'unavailable'`: the
  claims come back with the add and the bid, no drop, no gain, and no outcome
  tree. Those are all facts about the wire and survive the roster being
  unreadable.
- An empty plan says which kind of empty it is — `net_gain_below_bar` (a quiet
  week) or `no_eligible_drop` (a roster with nothing spare).

---

## Defences

A defence is a waiver claim, frequently the most consequential one of the week,
and it belongs to the **DST planner** — which knows about transaction cost, how
long a streamed defence survives, and what a playoff stash is worth. None of that
is in this folder.

So a defence on the wire is not a generic target, and a defence on the roster is
not a generic drop. Rostered defences still contribute their real points to the
lineup total, because pretending one scores nothing would corrupt every other
number here. The boundary is one line in `index.ts` and one clause in
`protectionFor`, and it is tested against a *scorable* defence in a league that
starts one — an unscorable defence would be excluded for the wrong reason and
would prove nothing.

---

## Integration contract

```ts
import { planWaiverClaims } from '@core/waivers/planner/index.ts';

const plan = planWaiverClaims({
  roster,     // StartSitInput[] — the same array the Team screen builds
  targets,    // { input, bid, boardRank } per waiver-board row
  shape,      // RosterShape, from the league
  profile,    // ScoringProfile, from the league
  reserveIds, // players on an IR slot
  budget: {
    remaining: myBudget(budgetState)?.remaining ?? null,
    usesFaab: budgetState.rule.usesFaab,
  },
  now,
});
```

`targets[].bid` is a structural subset of the `PricedBid` the Waivers screen
already computes — pass the existing object straight through and the planner
reuses the recommendation and the ceiling rather than pricing anything itself.
`boardRank` is the row's position on the existing board; supply it and the target
cut respects the league-intelligence ranking instead of the raw score.

What comes back:

| field | for |
| --- | --- |
| `claims` | the numbered list, already in the order to enter them |
| `outcomes` | the best case / fallback / nothing summary |
| `relationships` | whether two targets are worth chasing at once |
| `dropRanking` | the runner-up drops, for **See Why** |
| `protectedPlayers` | who the plan refuses to cut, and why |
| `dropAdvice` | `'unavailable'` means show the add and say nothing about the drop |
| `maxSimultaneousSpend` | the most any reachable branch would cost |
| `search` | how much work was done, so the bound is provable |

**Every string a reader sees is the integration's to write.** This module emits
`WaiverReasonCode` values and the numbers behind them, and no prose. The codes
are a closed list in `types.ts`; adding one is a deliberate act, which is the
point.

Nothing here transacts. There is no write path in the folder, and the UI tells
the user what to type into Sleeper by hand — which is why the ordering matters,
since entering the same claims in a different order produces a different result.

---

## What the reader sees

The seam is `core/waivers/claimPlan.ts` and it is two functions.
`planWaiversFor` gathers — it rebuilds the board with the same pure function the
screen uses, so the targets the planner ranks are in the order the reader is
looking at, and hands the priced bids through as references rather than copies.
`describeWaiverPlan` turns the reason codes into sentences. Both are called
together by `buildWaiverClaimPlan`, which is the one line `app.ts` and the demo
runtime each add.

The Waivers screen opens on the result:

```
Your waiver plan
1. Add Breakout Back · $24 · Drop Depth Back
2. Add Emerging Receiver · $14 · Drop Depth Back   Only if 1 loses
3. Add Emerging Receiver · $14 · Drop Roster Filler  Only if 2 does not land him
4. Add Streaming Tight End · $4 · Drop Backup Tight End
Enter them in this order — Sleeper runs claims top to bottom …
                                                              [ See why ]
```

Three decisions in that card are worth stating, because each is the answer to a
way the feature could have gone wrong.

**The qualifier is on the card, not behind `See Why`.** A plan naming one target
twice and one drop twice is exactly right and looks exactly like a mistake, and a
reader who cannot see why will delete one of the two lines — which decides
whether they land the player.

**It is an ordered list, and nothing on it is a button.** The numbering is the
instruction, so it is a real `<ol>` marker rather than a printed digit. The only
control is one `See why`, because this card is a list of transactions and there
is no control on it that performs one.

**An empty plan surfaces only when it says something the board does not.** A
quiet week is already `Nothing available beats what you already have` on the
board underneath; `No safe drop for this upgrade` is a different fact and earns
its line.

`See Why` is one sheet with no tabs in it: per claim, why him, why that cut, what
the roster gains, what the lineup gains, the pricing pass's own headline, who
else wants him, and how the claim stands to the ones above it — then the
branches, the substitute and complement readings, who the plan refuses to cut,
and what the wallet allowed. A player's own detail sheet carries one extra line,
`If you claim him → Drop X`, which reaches the targets the plan had no room for.

Nothing says `optimal`, and no branch carries a percentage.

---

## Files

| file | what it owns |
| --- | --- |
| `types.ts` | the contract and the reason codes. No arithmetic. |
| `rosterState.ts` | `U`, the memoised optimiser, pure state transforms |
| `dropCost.ts` | add-specific drop cost, the protection boundary |
| `pairs.ts` | add × drop generation, pruning, ranking |
| `claimPlanner.ts` | the spine, the fallbacks, relationships, the budget trim |
| `outcomes.ts` | the branch enumeration |
| `index.ts` | `planWaiverClaims`, and the contract above |

And one file outside the folder:

| file | what it owns |
| --- | --- |
| `core/waivers/claimPlan.ts` | the gather, and every string a reader sees |

Tests are `tests/waiverPlanner.*.test.ts` — 60 across drop cost, pairs,
contingencies, multiple targets, FAAB, bounds, unknowns and one worked week
pinned end to end — plus `tests/waiverClaimPlan.test.ts` and
`tests/waiverClaimPlan.api.test.ts` for the seam, and `e2e/waiver-plan.spec.ts`
for the card, the sheet and the four phone widths.
