# The waiver claim planner

> **Status (October 2026): tiers.** The Waivers screen and Team's waiver line
> draw three tiers scored by what each move adds to the lineup, with a bid from
> the league's own bidding behaviour. The fixed bars described further down
> (2.5 / 3.0 over a starter, 0.5 / 1.0 over a bench player) still build the
> board that an older cached response draws, and nothing else.

## Tiers (`core/waivers/tiers.ts`)

Every scanned free agent with a number is scored by the change in the best
legal lineup over three weeks, solved exactly by the trade-value solver
(`tradeValue/lineup.ts`), with each player's points a game taken from the
trade-value rate (the Start/Sit decision number, injury counted as missing
weeks, byes from the fixture list):

    gain = Σ week weight × (lineup after − lineup before)
         + change in the insurance credit (Check a trade's depth credit)
         + Alex's preferences (labelled)

Weights: while this week's games are still ahead, this week and next count in
full and the third week at half (`openWeights` 1, 1, 0.5); after the main slate
kicks off the window moves on a week (1, 0.5, 0.5). The drop is inside the
subtraction, so cutting a player who starts in week 3 costs his week-3 points.

| tier | rule (weighted lineup points) |
| --- | --- |
| Do this (≤1) | fills a hole in the first week(s): a starter on bye, Out, or nobody to start; or an upgrade of 4.0+ |
| Worth considering (≤4) | 1.5+: depth before a bye, a backup for a hurt starter, a moderate upgrade; plus one IR stash |
| Watch list (≤6) | 0.4+: better on paper, no move needed now |

Thresholds came from the live board of 8 October 2026 (week 5): the only moves
over 4 were five quarterbacks answering Joe Burrow's week-6 bye (Rodgers 22.3,
Stroud 13.6, Love 11.1, Darnold 11.0, Herbert 10.7); 1.5 to 3 held four
upgrades (Hunter Henry 3.0, Khalil Shakir 2.4, Darren Waller 1.8, Dalton
Schultz 1.7); 1 to 1.5 two (Baker Mayfield, Pat Freiermuth). The reproducible
audit is `probe-waiver-tiers.mjs`, which prints every band.

**One need, one row.** Moves answering the same need (one bye, one injury) are
one row: the best is listed and the rest ride on it as `alternatives`.

**One roster spot is used once.** Each move takes its best drop; a later move
whose best drop is taken uses its next best and both say they compete for the
spot. A drop is never a player worth more over replacement than the add (no
cutting a better player for a short-term bye or injury), and handcuffs and the
market hold are cut only when nothing else can be.

**Dead roster spots.** A bench player is drop-ready when cutting him costs under
0.25 weighted points, he starts in none of the three weeks, and he is no more
than 0.5 a game above a free agent. Unvalued and protected players never are.

**Preferences**, labelled on the move: a QB or TE who would sit next week is
charged 1.5 ("you don't carry a spare QB or TE unless he is clearly better");
backs get a 0.25 lean on the order only; defences belong to the DST planner and
are never added or dropped here. A free agent with no usable number (most
often a QB this league's scoring refuses) stays unvalued.

## Bids (`core/waivers/bidModel.ts`, `core/waivers/managerSeeds.ts`)

For each other manager, the chance he bids is his claims per run (this
season's record blended with Alex's seed profile, the seed counting as three
runs) over the targets in a typical run, scaled by how much the player draws
him: last week's fantasy points in this league's scoring (the main pull for a
chaser), Sleeper's trending adds (minor, except for the savvy manager), a
rising role, and a fresh drop of a player the room drafted early or paid for.
His likely bid is his own bids blended with his style's typical bid, read
higher for a player who draws him more. The recommended bid is the smallest
dollar that wins three times in four; the range runs from even odds to nine in
ten (19 in 20 with fewer than 30 claims on record). It is capped at what the
pricing pass says he is worth to this roster, and says so. A free agent outside
the waiver window carries no bid.

Decided by Alex on 8 October 2026: the chaser's points weight stays as it is
and is revisited after two or three more weeks of claims (the backtest found
last week's points barely predict competition here); an IR stash stays paired
with a drop, because Sleeper needs a free roster spot at claim time.

Seeds: RonJonathan (roster 6) savvy; MattyB2317 (roster 10, not MattLee04)
slightly savvy; cheeseking (roster 8) rarely adds; everyone else a last-week
chaser until his own claims say otherwise.

Last week's points come from Sleeper's weekly stats, scored with the league's
settings (checked: 322 of 322 rostered players matched Sleeper's own matchup
points for weeks 3 and 4), stored as one settings row per week
(`sleeper.weekPoints.<season>.<week>`), refreshed by the Waivers refresh and
the three-hourly league read.

**Backtest** (`scripts/waiver-bid-backtest.ts`, run by `probe-waiver-tiers.mjs`):
on this season's 38 awarded claims, using only what was known before each run,
the model's bid would have won 33; it predicted 25 rival bids against 21 real
ones, and its bids total $136 against $134 the winners paid ($76 of it more
than needed). The misses were two $1–2 defence ties, Adonai Mitchell ($3
against $4), and two news-driven backs (Ollie Gordon, Braelon Allen) that only
Sleeper's live trending list would have flagged; it is not historical, so the
backtest runs without it.

---

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
| `early_pick` | the room drafted him inside the top 80, and it is still week 6 or earlier |
| `room_is_adding` | he is in the top 10 of Sleeper's trending adds, so a rival claims him the moment he is cut |

The last two yield when they are all that is left, cheapest first, so a roster
full of early picks or hot names can still make a claim.

The first is measured **after the add**, and that is load-bearing rather than
fastidious. A starter displaced by the arriving player is no longer in the
lineup and is no longer protected — which is how a straight upgrade claim finds
its drop with no special case, and why a roster of seven players for seven slots
can still make a claim.

---

## Positional depth, and the supplementary signals

The board's value-add tier used to measure every free agent against one bar:
the weakest bench player who competes for his slots. In a league with two flex
spots that is one player for every back, receiver and tight end, so on
25 September 2026 four tight ends on the wire each "beat" a questionable back
and all four reached the board of a roster already holding two tight ends.

`core/waivers/depthPolicy.ts` is the fix, as one table and one rule:

| kind | positions | cap |
| --- | --- | --- |
| slot | QB, TE, K, DEF | the league's dedicated slots (+1 per superflex for QB; +1 for DEF from the week before the playoffs) |
| depth | RB, WR | none, with a 0.25-pt lean toward backs on the ordering |

A free agent at a position already at its cap is measured against the weakest
player **at his own position**, at the starter-upgrade bar (2.5 pts plus the
thin-data surcharge), and the board carries at most one such add per position.
The DST planner's playoff stash obeys the same window.

Sleeper's trending adds are a **supplementary** signal: up to 0.75 pts on the
ordering and on the bar, scaled by heat, and only for a player whose projection
already beats the man he is measured against. A surge alone never creates a
recommendation. On the drop side, `room_is_adding` above keeps the top of the
adds list off the cut list.

League rostered percentage is not used. Sleeper's public API does not publish
it, and inside one league every free agent is rostered by nobody, so there is
no local version to compute.

Every factor reaches **See why** through the value add's `basis`: the
projection, which comparison was made and why, the trending read and how far
it moved him, and the lean.

---

## The week's news, as a tie-breaker (`core/waivers/recentForm.ts`)

Neither side of the plan read the 7-day research tally (`signal.last7`, good
news minus bad news from the newsletters) until 1 October 2026. It is now a
**secondary adjustment on the order**, and nothing else:

| side | what the week does |
| --- | --- |
| drop | a rostered player with a bad week moves earlier in the cut order, one with a good week later |
| pickup | a free agent with a good week moves earlier in the claims, one with a bad week later |

The projection stays the primary basis. The week is added to the ordering number
only: never to a projection, a gap or a bar, so the two numbers a card prints
are unchanged and a hot week cannot create a claim the projection does not
support. A handcuff or a market hold stays protected whatever his week says.

Three guards, in the open:

1. **Thin weeks say nothing.** Fewer than 2 counted items in the window is no
   signal.
2. **Small samples shrink toward zero.** Two imaginary neutral items are added to
   the real ones (the bidding profile's rule): 2 items carry half the weight, 10
   carry five sixths. Full weight needs a net of 3, the draft board's saturation.
3. **The month outranks the week.** When the 30-day tally has 3 or more items and
   points the other way, the week is halved.

Then a ceiling of **0.4 pts a side**. The widest possible swing between two
players is 0.8, under the 1.0 a claim has to clear on Sleeper's projection, so
the week can reorder near-ties and cannot turn over a clear gap.

The app says it only when it mattered. The plan is built twice, with and without
the week; a pickup's card gets `Trending up this week` and a drop line gets
`trending down this week` only where the two plans differ. **See why** carries
the arithmetic whenever the week moved a number, including when it did not
change the order.

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
Recommended move                         (the section title, not the card)
Drop Jaylen Wright
1. Add Adonai Mitchell · bid $8–16
   Proj. 9.0 vs 3.5
2. Add Keenan Allen · free agent
   Proj. 7.0 vs 3.5 · #14 most-added on Sleeper today
```

Later the same day the owner cut further: no `for the first one you win`, no
handcuff clause, no `Only if 1 loses` pills (the numbering is the order), no
`(Sleeper projection for both)`, a plain `Free agent` tag on the board, no
`Check the news before claiming` after a drop rank, no DEF `No clear upgrade`
line, and Team's round refresh button in the header.

Four decisions in that card are worth stating, because each is the answer to a
way the feature could have gone wrong.

**The qualifier is on the card.** A plan naming one target twice and one drop
twice is exactly right and looks exactly like a mistake, and a reader who cannot
see why will delete one of the two lines — which decides whether they land the
player.

**It is an ordered list, and nothing on it is a button.** The numbering is the
instruction, so it is a real `<ol>` marker rather than a printed digit. There is
no control on the card at all: it is a list of transactions and nothing on it
performs one. The `See why` button and its sheet were removed on 1 October 2026
at the owner's request ("way too much text"), along with a `Keeping X: reason`
line for every bench player the plan did not cut. Only a handcuff to one of your
own starters gets a clause on the drop line, because he looks like the obvious
cut the plan skipped. The same day the card lost its own title (`Your waiver
plan`) and `Enter in this order`: the section above already says `Recommended
move`, and the numbers are the order. The list below it lost its `Not part of
the plan above` note. The plan still carries its `headline`, `instruction`,
`why`, `outcomes` and `keep` data; nothing draws them on a plan with claims.

**An empty plan surfaces only when it says something the board does not.** A
quiet week is already `Nothing available beats what you already have` on the
board underneath; `No safe drop for this upgrade` is a different fact and earns
its line.

**A free agent carries no bid.** See below. A player's own detail sheet carries
one extra line, `If you claim him → Drop X`, which reaches the targets the plan
had no room for.

## Waiver claim, or free pickup

`core/waivers/clearWindow.ts`, added 1 October 2026. Sleeper's public API has no
per-player "on waivers" flag, so the app computes it from the league settings
(`waiver_type`, `waiver_clear_days`, `waiver_day_of_week`, `daily_waivers`), the
league's completed drops, and each player's kickoff:

- dropped by anyone in the league less than `waiver_clear_days` ago: on waivers;
- his game this week has kicked off: on waivers until the weekly run (midnight
  Pacific at the start of the run day, Monday = 0);
- otherwise: a free agent, an instant add with no bid.

Read off this league's own log: Adonai Mitchell dropped 30 Sep, claimable from
about 2 Oct; Braelon Allen never dropped, yet bid on by four managers on Monday
and Tuesday and awarded at the Wednesday 07:10 UTC run.

A free agent's card says `Free agent: pick up anytime, no FAAB needed` and no
price; in the plan he reads `free agent, no bid needed`, and any claim under the
same drop below him is dropped from the list, because adding him spends the
drop. A player on waivers keeps his price and says the day he clears. A just
dropped player the room rated (drafted inside the starter pool, or a top-ten
Sleeper add) is priced as contested, never as an uncontested dollar. A league
whose settings cannot be read, or that runs daily waivers, gets no state and
keeps every price.

The league's rosters and transactions are re-read every three hours (at :15
past 00, 03, … 21 UTC, on the five-minute tick), so a rival's drop shows up as
`On waivers until …` without a Refresh. See `core/league/waiverReadCadence.ts`.

## Who else needs him

A rival needs a position when a named slot there is empty, when his weakest
named starter there projects under the owner's bar (QB 14, RB/WR/TE 8, DEF 6),
or when one of the FLEX spots that position fills starts somebody under 8.
The count prices the bid and, on a player who costs money, is the card's
reason line (`4 of 9 teams need RB`). See `teamNeedsFor` and `weakFlex` in
`core/league/competition.ts`.

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
