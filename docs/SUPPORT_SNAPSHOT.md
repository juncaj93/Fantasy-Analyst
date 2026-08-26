# Support Snapshot: reproducing a recommendation instead of guessing at it

A recommendation is wrong once. It is wrong on a Tuesday, on somebody's phone,
against live Sleeper state, a market snapshot fetched that morning and a
newsletter ledger nobody else has — and by the time anybody looks, none of that
exists. The report becomes archaeology and the fix becomes a guess.

A **support snapshot** is that state, frozen and sendable: the inputs exactly as
the engine read them, the output exactly as it produced them, and the clock it
was standing at. Handed to an agent it replays deterministically, with no
network, through the real engine.

Phase 1 covers **Draft**. The foundation is surface-independent and the
extension contract for the in-season lanes is at the bottom of this file.

---

## For the user: one tap

**Setup → This app → Copy Draft support snapshot.**

It copies a JSON file to the clipboard, or saves it if the clipboard refuses —
the row says which, and how big it was. Send it to ChatGPT or Claude with the
question in plain English: *why is Junculator recommending this?*

Nothing is uploaded. There is no support backend, no telemetry, no dashboard and
no background collection: the file goes where you send it and nowhere else. If
no draft is loaded the row says so rather than handing you a file that looks
like a bug report and contains nothing.

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

| outcome | means | do this |
|---|---|---|
| `schema_unsupported` | this build cannot read the file | the app is newer or older than the checkout — match the revision in `release.gitSha` |
| `data_mismatch` | malformed, or carrying a field a snapshot must never contain | do not "clean" it; ask for a fresh capture |
| `engine_version_mismatch` | the reasoning has moved since capture | expected after a deliberate calibration change; a difference is not yet a regression |
| `freshness_difference` | every ranking term matched, only the market's age read differently | the clock was not pinned; a replay bug, not a product one |
| `output_difference` | same engine, different board | **this is the interesting one** |
| `reproduced` | every term held | the file is a faithful description of the case; the bug is in what the board *says*, not in reproducing it |

### Step 2 — classify the report

Replaying tells you whether you are holding the case. It does not tell you what
is wrong with it. Read, in this order:

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
   ★; `signals` is the newsletter tally; `adp.values` is the market; `injuryStates`
   is availability.

That maps onto the categories worth separating: **stale or missing data**
(freshness, an empty market, an absent projection), **mapping** (a player who
resolved to the wrong id, or to none), **configuration** (scoring, roster shape,
a pinned ADP snapshot), **calibration** (the numbers are all correct and the
answer is still disliked — a weights conversation, with a real board in front of
it), **UI refresh or persistence** (the file is right and the screen was not),
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

### Step 4 — the test ladder

Fast path first. Never a one-worker multi-hour sweep, and never a skipped gate.

```bash
npx vitest run tests/support.snapshot.test.ts tests/support.redaction.test.ts   # 1. schema, capture, redaction
npx vitest run tests/support.fixtures.test.ts                                   # 2. the committed cases
npx vitest run tests/draft.myGuy.test.ts tests/draft.test.ts tests/draftPool.test.ts  # 3. affected Draft domain
npx playwright test --project=webkit-iphone-390 e2e/draft-card.spec.ts          # 4. one representative width
npx playwright test --project=webkit-small-360 --project=webkit-iphone-430      # 5. only if layout changed
# 6. the authoritative sharded CI, on the exact head — see .github/workflows/ci.yml
# 7. production smoke after deploy — see docs/RELEASE.md
```

### Step 5 — release

Unchanged from [docs/RELEASE.md](RELEASE.md): exact-head CI green across every
sharded browser job, current with main, merge, main CI green, Deploy from the CI
handoff, `/api/health` reports the SHA, Smoke asserts it. If propagation lags,
let the gate fail rather than certify stale production. Retry the same SHA. No
empty commits, no loosened revision checks. Roll back to a known-good SHA with
`rollback.yml`.

---

## How it works

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
6. degraded flags and the freshness states behind them.

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

## Phase 2: the in-season lanes

Everything above is surface-independent — schema identity, the release and
engine versions, the fixed clock, redaction and aliasing, the replay harness,
the fixture converter, the CLI and this runbook. The Draft-specific part is
entirely inside `decision`, and `decision.kind` is already the union of all six
surfaces.

Adding a lane is three things and no new format:

1. **a payload type** in `schema.ts` beside `DraftBoardPayload`, with the same
   four sections: `request`, `context`, `freshness`, `inputs`, `output`;
2. **a recorder** over that surface's own sources interface, in the shape of
   `recordDraftBoardSources`;
3. **a replay adapter** that rebuilds those sources from the recorded reads and
   calls the surface's real assembly function — never a reimplementation of it.

The pattern only works where a surface receives its facts through an interface,
which is how the rest of the app is already built. What each lane would capture:

**Team / lineup** (`lineup`) — `StartSitInput[]` as the engine reads them:
starters and bench with slots, this app's own projections and the components
behind them, availability states, locked games, the scoring profile, the
Start/Sit reasons and mode (Balanced / Floor / Ceiling), and source freshness.
Output is the recommended lineup, the bench verdict and every reason.

**Matchup / Best Move** (`matchup`) — `MatchupSources`: both lineups and slots,
Sleeper's settled points (truth, never re-simulated), the distribution inputs
per starter, which games are over, availability, the simulation seed and count,
and freshness. Output is the projected final, the win probability, the insight
card in force and the Best Move with its win-probability delta.

**Waivers** (`waiver-plan`) — roster utility inputs, the bounded wire candidate
pool, the pricing pass's observed bid distribution, FAAB budgets from the
league's own settings (never assumed), manager pressure and competition counts,
and the exact add/drop pairs with their contingency structure. Output is the
ordered claim plan and the whole *See why* argument.

**DST** (`dst-plan`) — the rostered defence, available defences, opponent and
schedule, the market anchor and its fallback, the activation window and the
outlook. Output is stream / hold / stash with reasons.

**Smart Trades** (`trade-offer`) — both rosters, the candidate offers, objective
value per side, manager fit with the sample behind it, the bounded history
influence, and the capability check. Output is the ranked offers, their verdicts
and reasons.

**Players** — not a lane of its own. Player signal and tally state are captured
where they are needed to explain *another* recommendation, which is what
`inputs.signals` already does for Draft.

Two rules that carry over unchanged. Bound every unbounded read and count what
was dropped — do not let a distillation pass silently as a match. And alias
identities rather than deleting them wherever the engine follows them, which for
the in-season lanes means the same manager chain plus roster ids.

---

## Files

| file | what it is |
|---|---|
| [`src/core/support/schema.ts`](../src/core/support/schema.ts) | the schema, `decision.kind`, and what every field is for |
| [`src/core/support/redaction.ts`](../src/core/support/redaction.ts) | the forbidden fields, the scanner, the alias allocator |
| [`src/core/support/draftSnapshot.ts`](../src/core/support/draftSnapshot.ts) | the recording proxy and the distillation |
| [`src/core/support/replay.ts`](../src/core/support/replay.ts) | snapshot → sources → the real board → the contract |
| [`src/core/support/fixture.ts`](../src/core/support/fixture.ts) | canonical JSON, and where a fixture lives |
| [`scripts/support-fixture.ts`](../scripts/support-fixture.ts) | the CLI |
| [`src/core/draft/version.ts`](../src/core/draft/version.ts) | `DRAFT_ENGINE_VERSION`, and when to bump it |
| `tests/support.*.test.ts` | round trip, redaction, the route, the committed fixtures |
