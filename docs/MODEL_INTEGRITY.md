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
