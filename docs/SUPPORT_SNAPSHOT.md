# Support Snapshot: reproducing a recommendation instead of guessing at it

A recommendation is wrong once. It is wrong on a Tuesday, on somebody's phone,
against live Sleeper state, a market snapshot fetched that morning and a
newsletter ledger nobody else has — and by the time anybody looks, none of that
exists. The report becomes archaeology and the fix becomes a guess.

A **support snapshot** is that state, frozen and sendable: the inputs exactly as
the engine read them, the output exactly as it produced them, and the clock it
was standing at. Handed to an agent it replays deterministically, with no
network, through the real engine.

All six decisions are covered: the **Draft** board, your **lineup**, the
**matchup** and its Best Move, the **waiver** claim plan, the **defence**, and a
**Smart Trade** offer.

---

## For the user: one tap

**Setup → This app → Copy support snapshot.**

Above it, one line saying what is about to be captured:

> **Current context** · Waivers
> **Copy support snapshot**

The app remembers which recommendation you were last looking at, so the button
captures the thing you are complaining about without your having to say which it
is. Tap the context row to change it — for a cold start straight into Settings,
where there is nothing to infer from, or when you have moved on since the thing
you meant to report.

It copies a JSON file to the clipboard, or saves it if the clipboard refuses —
the row says which, and how big it was. Send it to ChatGPT or Claude with the
question in plain English: *why is Junculator recommending this?*

Nothing is uploaded. There is no support backend, no telemetry, no dashboard and
no background collection: the file goes where you send it and nowhere else. If
there is nothing to capture — no draft loaded, no matchup this week, no defence
in this league's slots — the row says so rather than handing you a file that
looks like a bug report and contains nothing.

**What is in it, and what is not.** Player ids, your scoring and roster shape,
the picks made, the market numbers used, your own ♥ and ★ marks, every component
of every score at the top of the board, and the reasons on the cards. Not: your
Sleeper username or anybody else's, cookies, session tokens, provider keys, your
passphrase, email addresses, or newsletter text. Managers appear as `manager-1`,
`Manager 1`; your league is `league-1` and your draft is `draft-1`, because a
Sleeper league id is enough on its own to look every manager in it up. The rules
are written into every snapshot under `redaction.rules`, so the file itself
tells you what was taken out of it.

---

## For an agent: the runbook

```bash
# 1. Replay it. No network, no database, no provider.
npm run support:fixture -- path/to/snapshot.json

# 2. Once you have a fix, turn the real case into a regression test.
npm run support:fixture -- path/to/snapshot.json --write my-guy-not-moving
npx vitest run tests/support.fixtures.test.ts
```

### Step 1 — replay, and read the outcome word

The command prints one of six, and they are checked in this order:

The command reads any of the six and says which it is holding, so there is
nothing to select and nothing to configure:

```
  outcome        reproduced
  Reproduced: the same 3 claims, in the same order, with the same bids and drops
  over the same 50-player wire — week 7.

  decision       Waivers (waiver-plan)
  engine         waiver@1+dst@1+lineup@1+startsit@1 (unchanged)
```

| outcome | means | do this |
|---|---|---|
| `schema_unsupported` | this build cannot read the file, or the decision in it | the app is newer or older than the checkout — match the revision in `release.gitSha` |
| `data_mismatch` | malformed, or carrying a field a snapshot must never contain | do not "clean" it; ask for a fresh capture |
| `engine_version_mismatch` | the reasoning has moved since capture | expected after a deliberate calibration change; a difference is not yet a regression |
| `freshness_difference` | every ranking term matched, only the market's age read differently | the clock was not pinned; a replay bug, not a product one |
| `output_difference` | same engine, different board | **this is the interesting one** |
| `reproduced` | every term held | the file is a faithful description of the case; the bug is in what the board *says*, not in reproducing it |

### Step 2 — classify the report

Replaying tells you whether you are holding the case. It does not tell you what
is wrong with it. Read, in this order.

The order is the same for all six, and the first two are where most reports end:
**`decision.warnings`** is what the engine already knew was wrong about itself,
and **`decision.freshness`** is how old, how thin and how borrowed its inputs
were. Then **`decision.context`** to confirm you are looking at the right league
and the right week, then the output, then the input the output came from.

For a Draft board that reads:

1. **`decision.warnings`** — what the board already knew was wrong about itself.
   A degraded market or an unidentified roster explains a lot of reports before
   any component is read.
2. **`decision.freshness`** — `dog.reason` says in words why the Underdog column
   is or is not there, `adpSnapshot` says which draft order was in force, and
   `marketSource` says who priced the season markets and when. A large fraction
   of "this looks wrong" is a freshness story.
3. **`decision.context`** — the league, the pick, the round, the roster. Confirm
   you are looking at the moment being complained about.
4. **`decision.output.rows`** — every component, its weight, and what it
   actually contributed. This is where a wrong recommendation becomes a wrong
   *number*, and then a wrong input.
5. **`decision.inputs`** — the number's source. `flags` is the user's own ♥ and
   ★; `signals` is the newsletter tally; `adp.values` is the market;
   `injuryStates` is availability; `managerTendencies` is what the managers
   ahead have done in previous seasons.

Each row also carries `nextPick` — what the market alone said about his
survival, what historical manager behaviour moved it by, and the drivers found.
That is the place to start when a `Next%` is the complaint, because it is the
only per-player evidence that a manager prior applied at all.

And for the five in-season decisions:

| read this | when the complaint is |
|---|---|
| `freshness.priced` | a projection is blank, or a player is ranked below somebody obviously worse — he has no market, and the file says so rather than scoring him zero |
| `freshness.injury` | an availability call. `unknown` is nobody having published anything, which is not the same as healthy |
| `freshness.withoutGame` | a whole slate reading oddly — the fixture list has not been ingested |
| `freshness.borrowedProjections` | a number under a name that is not this app's. Rotowire's, by way of Sleeper, shown because no market priced him |
| `freshness.degraded` (matchup) | a confident-looking Hold. A degraded forecast offers nothing and must never read as one that considered the alternatives |
| `freshness.anchors` (defence) | *why is it telling me to stream him.* `line` is a priced game, `form` is the opponent's season average standing in, `unknown` is a week the planner refused to value |
| `freshness.faab`, `freshness.managerProfiles` | a bid. A league with no published bids prices from a prior and says the confidence is `none` |
| `freshness.history.measured` (trades) | an offer's manager fit. `false` means the ledger was never read, and every count beside it is meaningless |
| `inputs.startSit` / `inputs.roster` | anything about one player. Every field the engine had about him is there — the props, the previous props, the tally, the injury state, the usage weeks, the game, home or away |
| `output.claimPlan.claims[].why` | a claim. Each line is one sentence of the argument, in the order the plan makes it |
| `output.forecast.decision.note` | a Hold. It says *which* hold: everything locked, nobody legal for the slot, or nothing better |

That maps onto the categories worth separating: **stale or missing data**
(freshness, an empty market, an absent projection), **mapping** (a player who
resolved to the wrong id, or to none), **configuration** (scoring, roster shape,
a pinned ADP snapshot), **calibration** (the numbers are all correct and the
answer is still disliked — a weights conversation, with a real decision in front
of it), **UI refresh or persistence** (the file is right and the screen was not),
and **a bug**.

### Step 3 — fix it, then pin it

Make the fix as small as the evidence supports. Then:

```bash
npm run support:fixture -- snapshot.json --write <short-name>
```

It replays first and refuses to write a fixture from a snapshot that did not
reproduce — a regression fixture whose expected output this code never produced
is a test that asserts a guess. `tests/support.fixtures.test.ts` reads the whole
`tests/fixtures/support/` directory, so there is no test to edit and nothing to
register.

**Commit a fixture when its inputs cannot be regenerated** — a snapshot somebody
sent in, of a league and a moment that exist nowhere else. That is worth several
hundred kilobytes of JSON in git, because the data is otherwise gone. A snapshot
captured from a *demo scenario* is not: `buildDraftScenario` is deterministic and
its fixtures are already committed, so the file would be byte-for-byte
regenerable from code in the same repository, and its only non-duplicated
content would be an assertion that the engine produced that board on the day it
was written. This repository pins invariants rather than outputs — see
`audit.draftScore.test.ts` — so the directory starts empty and the converter is
tested against a fixture written to a temporary directory instead.

### Step 4 — the test ladder

Fast path first. Never a one-worker multi-hour sweep, and never a skipped gate.

```bash
# 1. the adapters and the schema — the whole lane, and it is seconds
npx vitest run tests/support.snapshot.test.ts tests/support.redaction.test.ts \
  tests/support.lanes.test.ts tests/support.inSeason.test.ts tests/support.isolation.test.ts
npx vitest run tests/support.fixtures.test.ts tests/support.cli.test.ts   # 2. the fixtures and the command
npx vitest run tests/lineup.test.ts tests/waivers.test.ts tests/dst.planner.test.ts  # 3. the affected domain
npx playwright test --project=webkit-iphone-390 e2e/support-snapshot.spec.ts     # 4. one representative width
npx playwright test --project=webkit-small-360 --project=webkit-iphone-430 \
  e2e/support-snapshot.spec.ts                                                   # 5. only if layout changed
# 6. the authoritative sharded CI, on the exact head — see .github/workflows/ci.yml
# 7. production smoke after deploy — see docs/RELEASE.md
```

Never a one-worker multi-hour sweep, and never a skipped gate. Step 1 is the one
that catches almost everything: it captures and replays all five decisions
against a real database and asserts the redaction, the fixed clock and the
absence of writes, and it runs in under ten seconds.

### The loop, in one line

That is the whole lane, and it is meant to be run in an afternoon:

> a questionable decision → **Copy support snapshot** → `npm run support:fixture`
> → read the outcome word, the warnings and the freshness → classify it (source
> data · stale state · mapping · scoring · calibration · engine · UI refresh) →
> a surgical fix → a minimal regression case → the targeted tests above → one
> focused WebKit width → the authoritative sharded CI on the exact head → an
> exact-SHA deploy → `/api/health` reports that SHA → production smoke.

Nothing in it is optional and nothing in it takes hours. The step that used to
take a week — working out what the app was actually looking at — is the file.

### Step 5 — release

Unchanged from [docs/RELEASE.md](RELEASE.md): exact-head CI green across every
sharded browser job, current with main, merge, main CI green, Deploy from the CI
handoff, `/api/health` reports the SHA, Smoke asserts it. If propagation lags,
let the gate fail rather than certify stale production. Retry the same SHA. No
empty commits, no loosened revision checks. Roll back to a known-good SHA with
`rollback.yml`.

---

## How it works — Draft

The lane the architecture was proved on, and the one every section below is
about. The five in-season lanes reuse all of it and differ in two places; both
are under [The five in-season lanes](#the-five-in-season-lanes).

### The capture is a recording proxy, not an inventory

`buildDraftBoard` is handed its facts rather than fetching them: everything it
knows arrives through `DraftBoardSources`, an interface the server satisfies
with repositories over D1 and Demo Mode satisfies with fixtures. The capture
wraps that interface and records what the board asks for.

That is the whole design, and it buys two properties that a hand-written list of
"the inputs" cannot:

- **completeness is structural.** A source method the board calls is a source
  method the snapshot has. Add a member to `DraftBoardSources` and the compiler
  points at `draftSnapshot.ts` and `replay.ts` until both have been taught about
  it;
- **read-only is a property of the type.** `DraftBoardSources` has no write on
  it. Capture also triggers no refresh — a diagnostic that fetched fresher data
  would be changing the thing being diagnosed.

Replay is the mirror: it rebuilds those sources out of `Map`s and hands them to
`buildDraftBoard`. The same function the server calls and Demo Mode calls.
Nothing is reimplemented, so nothing can drift.

### The one distillation

`players.listAll()` is the Sleeper dictionary — around 2,500 rows, of which the
board scores at most 300. Copying it would be the "entire player dictionary" the
principles rule out, so the capture keeps the players who can reach the answer:

| kept because | how it is found |
|---|---|
| `scored` | the exact candidate list — the board hands it to three sources, so the recorder sees it |
| `simulated` | the next-pick pool, cut with the board's own exported `simulationEligible` and `byMarketThenSearch` |
| `priced` | everybody either market has an ADP for — the simulator counts them and a warning is a count of them |
| `drafted` | everybody already off the board, so a pick resolves to a name |

`inputs.playerCensus` records what was listed, what was kept and why. Exactly
one board-level number the distillation moves — `poolHealth.activeEligible`,
which counts every eligible player in the league — and the replay reports it
under `distillation` with both values rather than letting a smaller pool pass
quietly as a match.

The arguments are bounded too: the top 24 rows plus **every ranked player
carrying a ♥ or a ★**, wherever he finished. That second half matters — a
snapshot is usually taken *because* of a specific player, and the player being
argued about is very often the one that was hearted and did not move. The
*ordering* is complete at any depth, so a reordering is always detectable.

### Redaction: alias what is needed, refuse what is not

Two mechanisms, doing different jobs.

**Aliasing** runs over the output as well as the inputs, and that catch is worth
naming: `nextPickModel.managerHistory` writes managers into sentences —
`slot 4 (juncaj93): RB demand ×1.2 from 3 historical draft(s)` — so a snapshot
that aliased the inputs and copied the output verbatim would have been a
redaction that removed nothing. `displayName` gets the same alias the roster
got, resolved slot → roster → owner so `Manager 3` is one person everywhere in
the file.

**Aliasing** covers identifiers the engine genuinely needs. A Sleeper user id is
not decoration — the board follows slot → roster → owner to attach manager
history to a seat — so each real id becomes a stable `manager-N`, consistently
everywhere it appears, and the chain resolves exactly as it did. The mapping is
one-way and never written into the file: a snapshot listing
`{"manager-3": "467803924117221376"}` would be a redacted file with the
identities put back in an appendix, which is worse than not redacting at all,
because it looks safe.

**The league and draft ids are aliased for the same reason, and it is the part
worth understanding.** A user id is obviously an identity. A league id is not,
and it is worse: `GET /v1/league/<id>/users` is public, needs no key, and
returns every manager's username. A snapshot that replaced eleven user ids and
then printed the league id would have handed all eleven back to anybody who
typed one URL — a redaction-shaped object rather than a redaction. The draft id
publishes both, through `/v1/draft/<id>/picks`. `LeagueRecord.id` *is* the
Sleeper league id in this app, so there is no internal identifier to fall back
on: `league-1` and `draft-1` are the whole answer, and the board — which only
ever compares these against each other — is unchanged.

That has one consequence worth knowing about, and it is under *Determinism*
below: the draft id is hashed into the `Next%` seed, so aliasing it would have
changed the numbers. The seed travels in the file instead.

**Scanning** is the backstop, and it refuses rather than cleans. Cookies,
authorization, headers, tokens, provider keys, passphrases, email addresses,
bearer tokens and newsletter excerpts are forbidden at any depth, and a capture
carrying one throws instead of emitting a partly-redacted file. The scan runs at
capture **and again at replay**, because the copy being replayed is not
necessarily the copy that was emitted.

### The reproduction contract

Every term is compared exactly. No numeric tolerance anywhere.

0. the `Next%` simulation seed, so the samples match by construction;
1. every ranked player id, in order, for the whole board;
2. every recorded component's score, weight, contribution, `unknown` and display
   string;
3. the composite total and the 0–100 score;
4. reasons, counterpoints and warnings, as sets of sentences — same sentences,
   any assembly order, and a changed word is a difference;
5. the favourite's level, normalised score and the contribution it spent;
6. degraded flags and the freshness states behind them;
7. the lines no component score stands behind — `injuryLine`, `tierContext`,
   `marketHeadline`, `preseasonPoints` and the `Next%` model per player.

Term 7 is the one that is easy to leave out. Everything above it is the ranking
or an input to it, so a matching set of components is very strong evidence that
the rest matched too. Those five are not: `injuryStates` reaches the board
through `injuryLine` and nothing else, and no score reads it — so without the
term a snapshot could reproduce every number on the board while silently losing
the availability line under a player's name, which is exactly the kind of
report this feature exists to answer.

Two fields are not in the snapshot at all rather than excluded at comparison:
`nextPickModel.elapsedMs` and `nextPickModel.cached` measure the machine, not
the board, and a field that cannot be compared should not be in a file whose
purpose is comparison.

There is exactly one concession, and it is not numeric: **signed zero**. JSON
cannot express `-0`, so a component that captured `-0` replays as `-0` against a
`0` in the file. They are the same contribution and sort identically.

### Determinism

Nothing on the replay path can reach outside the process. The sources are
`Map`s; the clock is the instant in `capturedAt`, which is what stops a snapshot
replayed a week later quietly becoming a snapshot about a *stale* market; and
the one Monte Carlo in the pipeline — the next-pick simulation — was already
seeded from draft state rather than `Math.random`, because a board polled every
three seconds must not wander. `tests/support.api.test.ts` replays with `fetch`
replaced by something that throws.

**The seed travels, because the draft id does not.** That id is one of the
strings hashed into the seed, which makes it a *model input* and not only an
identifier — so replacing it with an alias drew a different sample and the
replay disagreed with its own capture by a point of survival on a handful of
players. Indistinguishable, from the outside, from a regression. So
`nextPickModel.seed` is reported on every board and carried in every snapshot,
and the replay hands it back. A 32-bit hash of a string the file no longer
contains reproduces the draws without carrying the identity that produced them,
and the replay compares the seed as well as using it — so matching samples are
a consequence rather than a coincidence.

Reporting the seed is worth having on its own. "The same board returns the same
numbers" was a promise; with the seed in the response it is something a reader
can check.

### Two versions, answering different questions

`release.gitSha` is the deployment, from the same plumbing `/api/health`
reports, so a snapshot names a revision that actually shipped. `DRAFT_ENGINE_VERSION`
is the reasoning. A SHA changes on every commit including the ones that change
nothing here; the engine version changes when a board could reorder for
unchanged inputs. That is why a replay after a deliberate calibration change
reports `engine_version_mismatch` rather than looking like a regression. See
[`src/core/draft/version.ts`](../src/core/draft/version.ts) for when to bump it.

---

## The five in-season lanes

Everything above is surface-independent — schema identity, the release and engine
versions, the fixed clock, redaction and aliasing, the replay harness, the
fixture converter, the CLI and this runbook — and adding the five cost no change
to any of it. The schema is still `@1`: an older build handed a `lineup` snapshot
reports `schema_unsupported`, which is the answer that outcome word exists for.

### The seam is different in two ways, and both are on purpose

Draft is one engine reading one interface, so its capture is a **recording
proxy** around `DraftBoardSources`. Two in-season surfaces are shaped the same
way and are captured the same way: **Matchup** wraps `MatchupSources`, and
**Defence** wraps `DstPlanSources`.

The other three are not. The lineup, the wire and the trade search are handed a
`StartSitInput[]` that `server/services/startSitInputs.ts` has already assembled
out of eight repositories — so the seam *is* that value, and `inseason.ts`
captures it whole. That is a stronger completeness guarantee than a proxy's, not
a weaker one: a proxy records the calls a particular request happened to make,
and this records every field, including the ones no component reads today.

Each lane then replays through the same assembly its screen calls —
`assembleLineup`, `buildMatchupResponse`, `assembleWaiverPlan`, `assembleDstPlan`,
`assembleSmartTrades` — which is why those five were extracted out of the routes
and out of Demo Mode's handlers. There is one pipeline per decision and three
callers of it.

| lane | inputs | output |
|---|---|---|
| `lineup` | `StartSitInput[]`, the league's published rules, the current starters, the mode, the published fallback figures | the lineup: slots, starters, bench, undecidable, swaps, totals, confidence, late-swap risks, notes |
| `matchup` | Sleeper's matchup rows, `StartSitInput[]` in the order asked for, NFL state, the previous forecast, the published fallback | the whole response: the forecast, both teams, every slot, the insights, the leverage, the Best Move, the cards |
| `waiver-plan` | roster and wire inputs, the rostered set, the distilled player table, the wallet, the observed bids, the ledger's profiles, and the defence planner's three reads | the board, the priced bids, the defence plan, and the ordered claims with their contingency structure |
| `dst-plan` | the rostered and available defences, the lineup the bench cost is measured against, and the planner's three reads | the plan: stream / hold / stash / wait, the target, the outlook and the bar it had to clear |
| `trade-offer` | every roster, one shared evaluated pool, and what the ledger knows about each manager | the surfaced offers with GIVE, GET, counterparty, value components and fit — and no acceptance probability, because there is not one |

### The output is the engine's own object

The Draft payload hand-writes its output, because a three-hundred-player board
copied whole is a file nobody can paste anywhere. The in-season outputs are small
enough to carry as they are, and carrying them whole buys something a
hand-written list cannot: a flattened output is the fields somebody remembered,
and the field they forgot is not compared at all. That is how the Draft lane
nearly lost `injuryLine`.

So the in-season contract is a **structural walk** — every leaf of the captured
output against the same leaf of the replayed one, exactly, by path, with no
tolerance and the same signed-zero concession. A field added next year is
compared the day it is added.

### `lossless.ts`, which is the price of that

`JSON.stringify` does not round-trip everything, and a value it changes would
compare equal on both sides while carrying nothing — a snapshot that replays a
*different decision* and looks like the right one. So a capture containing one is
refused, and four real ones are hoisted into entry arrays instead:

- `DefenseTendencyIndex`, the opponent table attached to every `StartSitInput`;
- `impliedTotals`, the defence planner's fallback anchor;
- the transaction profiles behind the waiver pressure column;
- the trending map behind a bid.

The fifth was not a `Map` at all. A league's points-allowed table ends at
`to: Infinity`, because the top band is "and above", and `JSON.stringify(Infinity)`
is `null` — so every defence in the league replayed a fraction of a point out,
silently. The payloads now carry the league's own published `scoring_settings`
and `roster_positions` and rebuild the profile, which is what the Draft payload
always did.

### Redaction: alias before the engine speaks

The Draft lane aliases its inputs and scrubs its output, because
`nextPickModel.managerHistory` writes a manager into a sentence. That works for
an identifier and cannot work for a **display name**: this app's own seeded
league has a manager called `You`, and replacing names in prose turned
`You are sending Ike Sandoval` into `Manager 9 are sending Ike Sandoval` — a
redaction corrupting the sentence it was protecting, in a way no boundary rule
fixes, because the collision is the word.

So the in-season adapters alias the rosters, the wallet and the manager profiles
**before the assembly runs**. The engines compose `Manager 3` into their own
sentences and there is nothing left to replace; the scrub that remains handles
identifiers only. Aliasing the profile *bodies* rather than only their map keys
is the other half — both profile types carry their own `userId` and
`displayName`.

One identifier cannot be aliased ahead of the assembly, and it is the same catch
the Draft lane made through the draft id: the **matchup fingerprint** hashes the
league id, and it seeds the simulation. A replay from an aliased fingerprint
draws a different afternoon and disagrees with its own capture by a point of win
probability — indistinguishable, from the outside, from a regression. So
`MatchupForecast.seed` reports the 32-bit number actually drawn with, the
snapshot carries it, and the replay hands it back: the draws reproduce without
the identity that produced them.

### Freshness

Every lane carries the same block, and every field in it is a *count of a state
the inputs are already in* rather than a second measurement — so it cannot
disagree with what the replay compares. Players with a market and without one;
availability as known, unknown and conflicting, with the injury layer's own
freshness buckets; players with no game on the slate; roster spots the player
table could not resolve. Plus what only that lane can see: how many shown
projections are Rotowire's, how many of my starters' games are settled, whether
the forecast is degraded, which anchor each planned defence week got, and whether
the ledger was read at all.

**Unknown is never zero.** A player with no market is counted as unpriced rather
than folded into a mean of zero; a player nobody has published on is `unknown`
rather than healthy; an unrated defence week is left unrated. Each of those is
the difference between "the engine is wrong" and "the engine was right about what
it was given", which is the first fork of every diagnosis.

### Read-only

Every read on a capture path is a read the corresponding screen already makes,
through the same module — `server/services/decisionInputs.ts` live, and
`core/demo/runtime/decisions.ts` in a demo. `tests/support.isolation.test.ts`
watches every statement prepared during a capture of each of the five and asserts
none of them mutates, and snapshots the whole database before and after.

There is exactly one call that leaves the process: Sleeper's matchup scoreboard,
which is the identical request the Matchup screen makes every time it is opened.
Sleeper owns the score and this app never recomputes it, so a snapshot that
invented the scoreboard would be a snapshot of a different game. Nothing is
written or ingested as a result, and the test asserts every other lane reaches
Sleeper not at all.

The matchup capture also answers `cached()` with null and `remember()` with
nothing. A memoised response would record this request's inputs beside an earlier
request's forecast, and writing the recomputation back would let a diagnostic
decide what the next screen load was served.

### Players

Still not a lane of its own. Player signal and tally state are captured where
they explain *another* recommendation, which is what `inputs.signals` does for
Draft and what `StartSitInput.signal` does for all five in-season lanes.

### Demo Mode

The same route, the same adapters, the same gatherers the demo screens read — so
a scenario produces the file the live app produces, and the workflow can be
learned end to end without a league. `gitSha` is `demo`, so a rehearsal cannot be
mistaken for a deployment, and the clock is the scenario's, which is what makes a
demo snapshot replay at all.

---

## Files

| file | what it is |
|---|---|
| [`src/core/support/schema.ts`](../src/core/support/schema.ts) | the envelope, `decision.kind`, and the Draft payload |
| [`src/core/support/payloads.ts`](../src/core/support/payloads.ts) | the five in-season payloads, and why their outputs are the engines' own types |
| [`src/core/support/redaction.ts`](../src/core/support/redaction.ts) | the forbidden fields, the scanner, the alias allocator |
| [`src/core/support/lossless.ts`](../src/core/support/lossless.ts) | what the wire would change, and the refusal |
| [`src/core/support/inseason.ts`](../src/core/support/inseason.ts) | the `StartSitInput[]` seam, the league rules, the hoisted `Map`s |
| [`src/core/support/draftSnapshot.ts`](../src/core/support/draftSnapshot.ts) | the Draft recording proxy and the distillation |
| [`src/core/support/lineupSnapshot.ts`](../src/core/support/lineupSnapshot.ts) | Team / Start-Sit: capture and replay |
| [`src/core/support/matchupSnapshot.ts`](../src/core/support/matchupSnapshot.ts) | Matchup / Best Move: the proxy, the seed, capture and replay |
| [`src/core/support/waiverSnapshot.ts`](../src/core/support/waiverSnapshot.ts) | Waivers: the claim plan, the distillation, capture and replay |
| [`src/core/support/dstSnapshot.ts`](../src/core/support/dstSnapshot.ts) | Defence: the three reads, capture and replay |
| [`src/core/support/tradeSnapshot.ts`](../src/core/support/tradeSnapshot.ts) | Smart Trades: capture and replay |
| [`src/core/support/contract.ts`](../src/core/support/contract.ts) | `readSnapshot`, the structural walk, the six outcome words |
| [`src/core/support/dispatch.ts`](../src/core/support/dispatch.ts) | one snapshot in, one verdict out |
| [`src/core/support/replay.ts`](../src/core/support/replay.ts) | the Draft contract, term by term |
| [`src/core/support/fixture.ts`](../src/core/support/fixture.ts) | canonical JSON, and where a fixture lives |
| [`scripts/support-fixture.ts`](../scripts/support-fixture.ts) | the CLI |
| [`src/core/engineVersion.ts`](../src/core/engineVersion.ts) | how a surface's version is composed from the engines under it |
| [`src/core/draft/version.ts`](../src/core/draft/version.ts) | `DRAFT_ENGINE_VERSION`, and when to bump it |
| [`src/web/supportContext.ts`](../src/web/supportContext.ts) | which decision the reader was looking at |
| `tests/support.*.test.ts` | round trip, redaction, isolation, the routes, the CLI, the committed fixtures |
