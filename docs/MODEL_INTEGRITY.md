# Model Integrity Audit

An audit of the intelligence layer for silent correctness failures: signals that
are counted twice, scales that do not match, unknowns that quietly become
opinions, and caches that answer a question they were not asked again.

Everything below was measured against the code, not inferred from it. The tests
that keep each finding fixed live in [`tests/audit.integrity.test.ts`](../tests/audit.integrity.test.ts).

---

## Findings

Classified as the brief asks: **P0** truth corruption, **P1** material bias,
**P2** edge instability, **P3** observability.

### P0 — Start/Sit compared two players on incomparable numbers

`buildExpectation` sums the Vegas markets a player *has*. That is the honest
number for one player and a trap for two, because the sum is silently
conditioned on which markets exist.

A receiver priced on receiving yards, receptions and an anytime touchdown
carries about 13 points of market expectation. The same receiver priced on
receiving yards alone carries about 6.5. Nothing about him is different — two of
his lines were not quoted. `compareStartSit` sorted on that total, so the absence
read as six and a half points of inferiority, and the uncertainty penalty took
another point off him for the same reason. A total market blackout was warned
about by name; a *partial* one was not, and partial is the common case.

**Fixed** by [`src/core/startsit/comparability.ts`](../src/core/startsit/comparability.ts).
It does not invent the missing line — there is no honest way to know what a book
would have hung on a player it never quoted. It measures the size of the blind
spot from *the other player's own contributions* for the markets the first
player lacks, and when that blind spot is as large as the margin between them,
the comparison is no longer allowed to be confident and the reader is told why.
The recommendation still stands, because the model has usage, practice and role
information the missing line would not have carried; what it loses is the right
to be sure.

Position-aware on purpose: a receiver has no rushing-yards line and is missing
nothing by not having one.

### P1 — an unpriced season market became a negative opinion

The draft board's `market_expectation` component compared a player's season
baseline against a pool of every other baseline at his position. Same defect,
different surface: baselines built from different market sets are not comparable
numbers. A receiver priced on receiving yards alone implies ~140 points against
a pool of complete baselines implying ~250, so the pool rated him at the bottom
of the position and the component paid him a negative contribution — for markets
that are absent, not low.

Coverage damping was already in place and could not fix this. It scales the
magnitude and leaves the sign, so a partial player got a smaller wrong answer.

**Fixed** in [`marketExpectationScore`](../src/core/vegas/season.ts): the
comparison is restricted to the markets *he* has, against the peers who have at
least all of them, each peer re-totalled over that same set. His receiving yards
are compared with their receiving yards. Below three such peers there is no
honest comparison and the answer is `null` — unknown, which is not zero and is
certainly not negative. For a fully-priced board this is arithmetically
identical to the old behaviour.

### P1 — duplicate book quotes voted twice

`buildConsensus` grouped quotes by player and market and took the median, with
`bookCount: kept.length` — a count of *quotes*, not of books. A provider that
returned the same book twice (a retry that landed, two events covering one game,
an alternate-line row mapping to the same key) pulled the consensus median
toward that book and reported two opinions where there was one.

The second half is the sharper one: Start/Sit charges half a point of
uncertainty when `minBookCount === 1`. Three copies of a single book cleared
that check, so the thinnest possible market was scored as a well-covered one.
`bookCount` and the `books` array — right next to each other on the same record —
could disagree.

**Fixed** by `oneQuotePerBook`, which collapses each book to its own median line
before the consensus runs, and by deriving `bookCount` from the distinct-book
list so the two fields cannot drift. The same fix is applied to
`resolveSeasonMarkets`.

### P2 — `unknown` still moved the ranking

`ComponentScore.unknown` documents a contract: *"True when the underlying data
was missing; contribution is then 0."* It was false. `computeScarcity` returns
its no-data default of `0.3` for a player with no ADP, the engine mapped that
onto the −1..1 scale like a measurement, and spent −0.08 of composite on him —
while the same row of the breakdown told the reader the number was unknown.
Every unpriced player on the board carried it.

Small in isolation. It matters because it is the invariant everything else
rests on: the board's whole claim is that an absence is never spent as
information.

**Fixed** at source (scarcity is scored as unknown for a player with no ADP) and
structurally, via `sealComponents` — one choke point that zeroes both the
contribution and the score of any component flagged unknown. The failure was not
carelessness at one call site; it was that nothing checked.

### P3 — the Next% cache keyed on how many picks, not which

`draftStateKey` folded `completed.length` into the fingerprint. That held while
the pick list could only grow. It can do more than that: a Sleeper re-sync
correcting who was taken at pick 41, or a commissioner reversing a mis-pick,
changes a pick without changing the count — and `readRoom` reads every completed
pick, so dispersion, runs and each manager's lean are all functions of the
*content* of that list. The cache would have served the answer computed from the
wrong player.

**Fixed**: the picks themselves are in the key.

---

## Addendum: the Draft Score regression

Reported after the first pass: a live board sorted by `Score` opened with
Trevor Lawrence 93, Jaxson Dart 87, Patrick Mahomes 86 — and then seven players
on 84–85 carrying `ADP —`, `Val —` and `Next —`, three of whom had not taken an
NFL snap in years.

**Three independent faults, each of them necessary.** Removing any one would
have hidden the symptom without fixing the others.

### P0 — a total of zero is a *good* total, and unknown players score zero

`draftScore` is a logistic centred at a total of **−2.5**, and that centre is
correct: market value charges every player the distance between the clock and
his ADP, so almost everybody worth considering carries a negative total. The
consequence nobody had followed through is that **`draftScore(0) = 83`**.

A player no market has priced totals almost exactly zero — market value is
`unknown` and contributes nothing, and so does everything else that needs a
price. So "we know nothing about him" rendered as a confident 83, above every
priced player the draft had not yet reached.

Worse, two components actively *paid* him. `separation` and `opportunity` both
measure a player against the composites of his alternatives, and his near-zero
base beat the negative bases of real players: on a board shaped like a real one,
an unpriced back collected **+0.183 of cost-of-waiting for being nothing but
unknown.**

Fixed: a player with no market baseline is not comparable, so he is excluded
from both components on both sides — as a subject and as an alternative — and
his `score` is `null`. The card shows `—`, exactly as `ADP`, `Val` and `Next`
already did for the same player and the same reason. `total` is kept for
inspection.

### P0 — the client's Score sort reproduced only half the engine's ordering

`rankAvailablePlayers` sorts unpriced players last *first*, then by composite.
`sortBoard('score')` sorted by `total` alone. That second key on its own floats
exactly the players the board knows least about, which is what put them on
screen. It now applies the same unscored-last rule, in every mode.

### P1 — the pool readmitted players nobody can draft

Draft recommendations used to require a price, which capped the board at the
~200 players an ADP file covers. The deep-coverage work removed that — rightly,
because an unpriced current player is exactly who you want in round eleven — and
with it went the only thing keeping retired players out.

**Sleeper cannot answer "is he draftable".** Sampled live in August 2025:

| player | `active` | `team` | `status` | `search_rank` | last played |
|---|---|---|---|---|---|
| Chris Carson | `true` | `null` | `Active` | 200 | 2021 |
| Chase Edmonds | `true` | `null` | `Active` | 253 | 2023 |
| Kareem Hunt | `true` | `null` | `Active` | 242 | 2024 |

Carson retired four years ago; Hunt carried the ball two hundred times last
season. **Sleeper records them identically**, and `search_rank` — which measures
who gets looked up, not who gets picked — ranks the retired player higher. There
is no flag to filter on.

What separates them is that somebody is willing to price Hunt. So the rule in
`draftable.ts` is: **no NFL team *and* no price from either market → not a
recommendation.** Deliberately an `and` of two absences, because either alone is
ordinary — being on a roster is enough by itself, and being priced by either
market is enough by itself, which is what stops this collapsing into "exclude
every free agent".

Worth stating plainly: three of the seven reported names — **Audric Estime (NO),
Brashard Smith (KC) and J.J. McCarthy (MIN)** — are on NFL rosters and entirely
legitimate deep candidates. They were never a pool problem. They were a Score
problem, and they stay on the board.

The accepted cost: a genuinely current free agent that neither market has priced
— someone cut in late August, before signing — drops off the recommendations
until he signs or a market prices him. He remains in Deep Players search.

### P1 — QB inflation, and it is not roster need

Measured per component rather than assumed. On a board shaped like a real one
(twelve QBs in three bands against forty dense backs and receivers), at pick 60:

| position | scarcity | tier cliff | separation | opportunity | **structure** | need |
|---|---|---|---|---|---|---|
| QB | +0.083 | +0.150 | +0.250 | +0.227 | **+0.710** | +0.056 |
| RB | −0.130 | 0 | +0.158 | +0.123 | **+0.151** | +0.006 |
| WR | −0.130 | 0 | +0.115 | +0.124 | **+0.109** | +0.006 |

Market value was saturated at 1.0 for all three, so that half-point gap *was*
the ranking — about fourteen picks of ADP, more than the season market and the
news tally can produce together.

**Roster need is not the cause.** Filling the quarterback slot moves the best
quarterback's composite by 0.047, which is one pick of ADP — the calibration in
`DEFAULT_WEIGHTS.need` working exactly as documented. Nor is any single one of
the four components: each was individually bounded and none was wrong.

The cause is that all four answer the same underlying question — *how thin is
this position* — and nothing bounded their sum. Four weights summing to 0.9,
handed in full to whichever position is sparsest.

Fixed with a joint cap (`POSITIONAL_STRUCTURE.cap = 0.5`, about ten picks),
scaled proportionally so the cap decides how loudly the family may speak and
never which member is speaking. The scaling is applied to each component's
**weight**, not to the product, so `score × weight = contribution` stays
checkable on the card — the same convention `need` already follows with its
ramped weight. At pick 60 the QB's structure falls 0.710 → 0.500 and his lead
over the best back narrows by a third; at pick 140 with no quarterback rostered
the family totals 0.445 and the cap does not fire at all, because a quarterback
run there is correct.

### P2 — two latent layout faults the fixture exposed

Neither was caused by this pass; both were invisible because **every player in
the demo seed was priced and had a club**, so no browser test had ever drawn a
row with an unknown value or a missing team on it.

- **An unknown value cost a pixel.** `.faint` carries its own `0.78rem`, which
  is larger than the `0.72rem` of the metrics line it sits in, so a single
  `unknown` grew the line box and the card came out a pixel taller than its
  neighbours — breaking the one-rhythm promise the row is built around. In
  production this fired for any unpriced player's `ADP` long before Score
  existed. Fixed by letting the marker inherit the line's own size; colour is
  what `.faint` is for there.
- **The fallback club mark re-flowed the row.** `TeamLogo` documents that "the
  square width/height here re-flows nothing" and that "there is no state in
  which the reader gets an empty gap". True of the image; not true of the
  `team-code` fallback, which was a bare text span as wide as its string. A free
  agent, or any logo that failed to load, sat in a different-sized box and
  pulled the row out of line. Fixed by giving the fallback the same square.

### P1 — the queue was not the authority on its own order

Reported separately: dragging a player in the ★ queue appeared to work, and the
list then snapped back to the board's ordering.

**The drag was never the problem.** `queueOrder.ts` and `dragReorder.ts` are
both correct, both already tested, and the server already returns the ★ filter
in the reader's stored order. The precedence was wrong, in one expression in the
screen:

```ts
isQueue && sort === 'score' ? queuedRows : sortBoard(queuedRows, sort)
```

A reader whose selected mode was Score saw the queue behave perfectly. A reader
who had been reading the board by ADP or DOG — the mode that has only existed
since the Underdog merge — got `sortBoard` re-ordering their shortlist on every
render, including the one immediately after their drop.

Fixed by moving the precedence out of the component into `orderBoardRows`, which
resolves the three claimants in order: a drag that has not landed yet, then the
stored queue order whenever the queue is on screen, then the selected sort mode
for the ordinary board. The mode is still an input and deliberately unused in
the queue branch — it is *remembered* rather than overridden, so leaving the
queue returns the reader to the board they were reading instead of making them
reselect it.

That it lived inside a React component is why nothing caught it: a precedence
rule there can only be checked by driving a browser, and no browser test opened
the queue with a non-default sort selected. It is now a pure function with the
addendum's thirteen invariants pinned against it, plus a browser suite that
performs the real gesture — including the long press, without which
`pressVerdict` correctly classifies the movement as a scroll and reorders
nothing.

The sort control is dimmed inside the queue (`data-inactive`) and stays visible
and operable. It should not look like it is ordering a list it is not ordering.

**Observed and not fixed:** the drag grip is 22×28 at 390px, against this
project's own documented standard of 44 (`--tap: 44`, design-system rule 5).
There are thirteen pixels of gutter to its left and eight to the ★ beside it, so
reaching 44 means taking the difference from the star or from the row's own
expand target. That is a design trade-off rather than a bug with an obvious fix,
and it is recorded here rather than decided unilaterally.

### P3 — a density guard that measured the wrong thing

The 360px guard asserted "at least eight rows above the toolbar", and counting
rows made it hostage to something it was never written to measure. A card is
58px ordinarily, 75px carrying a tally and 92px carrying a tier warning —
deliberately, because a warning needs the line — so how many clear the bar
depends on *which players are at the top of the demo board*.

The positional-structure cap reordered that board by a few hundredths and moved
one 92px warned card from tenth to seventh. The count went 8 → 7 with **no
space spent anywhere**: measured against `main`, the list starts at the same
129px and every card is the same height, in a different order.

The test's own comment says it exists so that "if a later pass spends the space
on padding again, this fails". Both halves of that are now asserted directly —
the chrome above the list, and the depth of the first screen in *ordinary*
cards. Verified by mutation: ten pixels of row padding fails it exactly as
before, and a reordered board no longer does.

### What the blend did not cause

The DOG/Sleeper market blend was audited against §1 of the addendum and is
sound. A missing source renormalises to the one that answered; both missing
returns `unknown` with `adp: null` and zero weights; `null`, `undefined` and
`NaN` cannot coerce into a favourable value; and there is no midpoint default
anywhere in it. The blend **exposed** the Score fault by widening the pool of
players who reach the board — it did not create it.

---

## Areas audited and found sound

Recorded because "we looked and it was fine" is a finding too, and the next pass
should not have to rediscover it.

| Area | Verdict |
|---|---|
| **Circular dependencies** | None. `separation` and `opportunity` read *base composites* fixed before either runs, never board rank, so neither can feed itself. `tiers.ts` is market-only by construction with no parameter through which need, news or survival could reach it. Next% is not an input to the ranking that feeds Next%. |
| **Separation vs opportunity cost** | Not double-counted. `evaluateOpportunity` is handed the separation gap explicitly and subtracts it, so the distance between a player and the field behind him is paid for once. |
| **Opportunity vs scarcity vs tier cliff** | Overlapping populations, deliberately different questions (composite-comparable count, ADP count, ADP spacing), and bounded — the combined opportunity contribution cannot exceed 0.3. |
| **Usage level vs role trend** | The level and slope of one series, and capped as a pair at 2.5 points rather than rebalanced, which keeps both readable in the breakdown. |
| **Game script vs the market's own number** | Capped at 0.7 once a prop line is present, because the line already contains the game total. |
| **Unbounded market value** | Intentional, and correct. Value saturates at +1 because you can only spend the one pick; a reach has no floor so that 160 picks early cannot be outvoted by every other component combined. Pinned by a test. |
| **Weather** | No generic penalty. A dome returns `indoor: true` with zero points and `unknown: false` — the absence of the question, not a mild day. Cold and snow are described and never scored. Wind is role-weighted and capped at 1.4 points. |
| **Monte Carlo determinism** | Seeded from draft state; the same board returns the same number at any simulation count. Back-to-back picks return 1 as a fact about the pick order rather than a simulated estimate. A board too thin to simulate falls back to the ADP model and says so rather than reporting 0% for everybody. |
| **Unpriced players in the simulation** | Simulated so the board is realistic, reported as `null`. A percentage derived from an invented draft position would be an invented percentage. |
| **Survival conditioning** | `S(next)/S(now)`, computed as a difference of logs so the tail does not become 0/0. The last pick of a draft returns `null`, not 100%. |
| **Scoring format propagation** | Half/full/standard PPR, passing-TD value, TE premium and superflex all derive from the Sleeper payload and reach both the season baseline and the weekly expectation. TE premium is applied inside the per-reception rate rather than bolted on afterwards. |
| **Tally integrity** | A row's net score becomes one item of that magnitude, never N fabricated items. Re-importing a document supersedes the rows it replaces via `supersedeStaleImports`, and a row the user has ruled on is never touched. |
| **Idempotency** | Evidence insertion is `ON CONFLICT(dedupe_key) DO NOTHING`; reprocessing the same newsletter yields zero new rows. |
| **Identity** | One ladder, no second matcher, no fuzzy fallback in the Vegas path. A name that does not resolve keeps a null id and goes to review rather than being guessed. |

---

## Automatic anomaly detection

[`src/core/source/anomalies.ts`](../src/core/source/anomalies.ts) is new. Every
other module in this codebase is careful about one source at a time; nothing was
watching the seams, and the seams are where silent corruption lives — each source
is internally consistent and the disagreement exists only in the join.

It detects:

- Sleeper healthy (or questionable) against an nflverse IR/DNP — and correctly
  does **not** treat `unknown` as a conflicting claim, nor "questionable versus
  doubtful" as a contradiction;
- a market still priced for a player who is ruled out, reported once per player;
- games played plus weeks inactive exceeding the weeks a season has run, and any
  games-played figure above 17;
- an ADP move beyond 90 picks between snapshots;
- a snapshot that lost more than 30% of the previous board;
- a source answering about the wrong season or week;
- a provider payload missing an expected column — checked as columns rather than
  as a validator, because a renamed column does not throw, it yields nulls, and
  nulls are indistinguishable from a quiet week;
- one external name mapped to two different canonical players.

It is a detector and not a resolver. It never decides which source is right,
never edits a value and never gates a recommendation — authority rules belong
with the models that own each signal, and a detector that also corrected things
would be a second, invisible one. `summarizeAnomalies` marks a report `material`
only for contradictions and implausible values, so a coverage note stays a
diagnostic: §17 asks that the user's screen stay quiet unless something is worth
interrupting them for.

---

## Asked for, and not applicable

Two sections of the brief had nothing to audit, and saying so is more useful
than a paragraph implying otherwise.

**Historical backtest integrity (lookahead, survivorship, sample coverage).**
There is no backtest in this codebase. Nothing replays a past week, so nothing
can leak a final stat, a post-kickoff injury, a future transaction or a closing
line into a recommendation that predates it. The audit for this section is a
check that the surface does not exist, and it does not. If a backtest is ever
built, this is the section that has to be written first rather than last.

**Probability calibration.** `Next%` is testable for *convergence* — the
simulation is compared across 1,000 / 2,500 / 5,000 runs and re-run under a
different seed to measure its own sampling error — and it is not testable for
*calibration*, because calibration needs outcomes and nothing stores whether the
player the model gave 18% to was actually still there. The honest statement
today is that Next% is a well-behaved estimate of a stated model, not a
frequency-validated probability. Making it calibration-testable means recording
each board state's predictions and the pick that followed; that is a feature,
not a fix, and it is not in this pass.

**Component dominance measurement.** Already instrumented rather than newly
built: `scripts/probe-score-distribution.mjs` reports the observed contribution
range per component against the live board, which is the measurement §4 asks
for. What this pass added is the standing invariant — a test that the
non-market components cannot outvote a large reach even summed at full strength
and pointed the same way.

## What was deliberately not done

The brief is explicit that broad speculative retunes must not merge, and none
did. Nothing in this pass changes a weight. Every fix is one of the shapes the
brief names as preferable: a dedupe (`oneQuotePerBook`), a normalisation
(like-for-like market comparison), a cap or gate (`sealComponents`), and stable
keying (the Next% state key).

Three things were considered and rejected:

- **Imputing a missing prop from position averages.** It would remove the
  symptom and violate the rule the whole app is built on. A player nobody quoted
  is unknown.
- **Scaling a partial baseline up by `1/coverage`.** It assumes the missing
  markets are worth the same per market as the present ones, which is false —
  receiving yards and receiving touchdowns are not interchangeable units.
- **Withholding a Start/Sit recommendation when coverage differs.** The model
  carries usage, practice and role information that the missing line would not
  have carried, so it still has something to say. It says it with lowered
  confidence and a stated reason instead.

## Recency windows: findings from the stale-window correction

Two facts found while correcting the derived signal's recency windows, both
recorded here rather than acted on, because neither is a correctness defect and
each is a product decision of its own.

### The draft board's 7-day news term is inert, and has been

`player_signal_cache` has never had a `recent7_items` column, so `getSignals`
has always reconstructed `last7` with `items: 0`. `newsComponent` treats an item
count of zero as "no evidence" — `unknown: true`, contribution exactly zero — so
`news_7d` has never contributed anything on the draft board, whatever its weight
says. It is live only on `GET /api/players/:id`, which aggregates from the
ledger instead of reading the cache.

`docs/DRAFT_CONTRIBUTION_MAP.md` lists `news_7d` at 0.12. That number is the
weight it would carry if the term were populated, not a contribution the board
has ever made. The map is accurate about intent and misleading about effect.

This was left exactly as it was when the windows were corrected. Populating the
count would switch a scoring term on and reorder the board, which is a decision
about draft scoring rather than about dates, and nothing in the defect being
fixed called for it. Whoever takes it up should decide deliberately whether
seven days of news deserves a vote on a draft pick at all — the module header in
`trades/engine.ts` argues the opposite case for drafting, that a draft is a bet
on a season and the lifetime record is the better evidence — and should expect
the board to move when it lands.

### `refreshAllSignals` has no caller

`EvidenceRepo.refreshAllSignals` rebuilds the cache for every player with
evidence and nothing invokes it, from the app, a script, or a workflow. It is
reachable only from a test.

This stopped being load-bearing when `getSignals` began computing the recency
windows on read: no answer depends on those stored columns any more. But
`recent7_net`, `recent30_net` and `recent30_items` still drift from the moment
they are written, and they are still the only record of what the windows were.
Anything that comes to read them directly — a report, a migration, a probe —
will read something that was true once.

Two ways to settle it, neither urgent: give it a caller (a scheduled rebuild
alongside the other daily refreshes), or stop writing time-relative columns
altogether and let the read path own them entirely. The second is tidier and
the larger change.
