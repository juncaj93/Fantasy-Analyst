# Demo Mode

A deterministic, read-only view of the real product across states that are hard
to reach on demand — draft night, a Tuesday waiver run, an injury eight minutes
before kickoff, a rollover in March, an outage.

It is two things at once: a preview tool, and audit infrastructure. The second
is the one that shapes every decision below. A demo that showed *approximately*
what the app does would be worse than no demo, because an audit would then be
auditing the demo.

**Settings → Demo Mode**, or `?demo=<scenario-id>` on any URL.

---

## 1. Architecture: substitution, not simulation

Demo Mode is a **data-source substitution layer**. There is no second app.

```
      live                                 demo
  ─────────────                        ─────────────
  D1 + Sleeper + Vegas                 versioned fixture modules
        │                                    │
        ▼                                    ▼
  repositories  ────────┐          ┌──── fixture sources
                        ▼          ▼
                 the same interfaces
                 DraftBoardSources · MatchupSources · DstPlanSources
                 StartSitInput[] · TradeCandidate[] · SleeperTransaction[]
                        │
                        ▼
                 the same engines
                 buildDraftBoard · buildMatchupResponse · recommendLineup
                 recommendWaiverUpgrades · priceWaiverUpgrades
                 waiverLeagueIntel · waiverMultiWeekFor · weeklyIntelligence
                 buildWaiverClaimPlan · assembleDstPlan · planDst
                 buildTransactionProfiles · buildTradeTendencies
                 evaluateBench · compareStartSit · rankTrades
                 findBilateralTrades · orderPlayers · resolveLifecycle
                        │
                        ▼
                 the same React screens
```

There is exactly one Draft screen, one Team screen, one Matchup screen, one
waiver card, one player sheet and one scoring engine in this repository. Demo Mode renders them. If a
production screen changes, the demo inherits the change, because there is
nothing to keep in step.

The substitution happens at **one seam**: `request()` in `src/web/api.ts`. Every
screen in the app talks to the server through `api.get` / `api.post`, both of
which go through that function, so redirecting it is the whole of the feature.
No screen knows a demo exists, no component takes a `demo` prop, and a screen
written next year inherits the behaviour for free.

### What had to change in production code

Five things, all of them "one implementation instead of two":

| Change | Why |
|---|---|
| `core/draft/boardBuilder.ts` — the board assembly moved out of `server/services/draftBoard.ts` and is driven by a `DraftBoardSources` interface | So the demo runs the *same* board builder. `DraftBoardService` keeps its exact public API; every existing caller and test is untouched. |
| `core/matchup/build.ts` — the matchup assembly moved out of `server/services/matchupService.ts` and is driven by a `MatchupSources` interface | Same reason, same shape. The service keeps the D1 reads, the Sleeper client, the per-database forecast cache and the calibration ledger, and satisfies the interface. Its exports and tests are untouched. The ledger is no longer part of that interface — see §4 — and is reached only from the worker's scheduled handler. |
| `core/waivers/pricing.ts`, `core/waivers/intel.ts`, `core/roster/held.ts`, `core/roster/freeAgents.ts`, `core/trades/ladderInputs.ts` — assembly helpers moved out of `server/app.ts` | So a rehearsed bid and a live one are the same arithmetic, and a rehearsed waiver card carries the same competition and multi-week columns. Moved verbatim. |
| `core/dst/assemble.ts` — the defence-plan assembly moved out of `server/services/dstPlanService.ts` and is driven by a `DstPlanSources` interface; `core/league/planning.ts` gained `readFinalWeek` and `playoffContextFor` | So a streamed defence in a demo was chosen by the code that would choose one for a real league. The service keeps `buildDstPlan(db, request)` and does the three D1 reads; the demo answers the same three questions from the slate. |
| `POST /api/demo/enter` · `exit` · `GET status`, and a write-refusing middleware | The second half of the mutation guard — see §3. |

Demo-only UI is limited to the indicator bar and the Settings picker.

---

## 2. Time injection

The app already had a clock convention, and it is a good one: everything
time-dependent takes an injected `now` — `resolveInjury(observations, now)`,
`freshnessOf(observedAt, now)`, `input.now` on the start/sit engine. Nothing
reaches for `Date.now()` behind a caller's back.

So Demo Mode does not *install* a clock. It supplies one, to the same
parameters production supplies the real time to (`core/demo/clock.ts`).

- **`Date` is untouched.** No global monkeypatch, so there is nothing to leak.
- **Production is `systemClock`** — what every caller already had, now named.
- **Demo is `fixedClock(scenario.asOf)`** — stopped, not offset, because a
  scenario has to reproduce identically and "how stale is this report" must not
  answer differently a minute later.

That is what makes Tuesday waivers, Sunday pregame, a late kickoff, a completed
week, a playoff week, draft day and a March rollover reachable without touching
device time.

---

## 3. Mutation isolation

While a scenario is active, **nothing but a read may pass**. Stated as a rule
about requests rather than a list of buttons, so it covers endpoints that do not
exist yet, calls made from a console, and any screen that was missed.

Refused twice, independently:

1. **In the browser, below the UI.** `DemoRuntime.request` calls
   `assertAllowedInDemo` and throws `DemoWriteBlockedError` for anything that is
   not a GET. Two exceptions, both named explicitly:
   `POST /api/startsit/compare` (a read that needs a body) and the demo's own
   `enter` / `exit` / `status`.
2. **On the server.** Entering sets a session-scoped `fa_demo=1` cookie. While
   it is present the router refuses **every** write with `403`, *before* the
   passphrase check and regardless of it — an unlocked session is not permission
   to mutate during a demo. A cookie rather than a header because a cookie rides
   on every same-origin request automatically; a header can be forgotten, which
   is the whole failure this prevents.

It is a safety interlock, not a security boundary, and does not pretend to be
one: whoever set the cookie can clear it, and clearing it is exactly what
leaving does.

Proven in `tests/demo.isolation.test.ts` (every `router.post` path, scraped from
`app.ts` so tomorrow's endpoint is covered on the day it lands),
`tests/demo.server.test.ts` (the same against the real router, real middleware
and a real database, with a valid session attached), and `e2e/demo.spec.ts`
(a hand-written `fetch` from the page, straight past the UI and the API client).

## 4. No contamination of live truth

- Fixtures are **versioned modules in source**, expanded into memory when a
  scenario is selected and dropped on exit.
- `src/core/demo/**` imports nothing from `src/server/**`, no provider client,
  and contains no `fetch`, no `localStorage`, no `indexedDB`. Asserted
  structurally.
- No production module imports a demo fixture. Also asserted structurally.
- `DraftBoardSources` has no write method on it, so there is nothing to call.
- `MatchupSources` has none either, and used to have one. `record` — the
  calibration ledger, because a probability model nobody grades is worth nothing
  — was satisfied in a demo by a recorder that returned immediately. That was
  enough for this document and not enough in practice: the same seam was wired
  to a real ledger on the request path, so a browser carrying `fa_demo=1` and
  opening the Matchup screen wrote rows to the **live** calibration table. The
  method-based write guard saw a `GET` and waved it through. That is the final
  audit's F-01.

  The ledger is now a separate argument to `buildMatchupResponse`, and the demo
  passes three arguments. A demo write is a thing the runtime has no way to
  express rather than a thing it declines to do. Asserted structurally: the
  interface declares no write member, and the demo's bag carries no recorder.
  The endpoint's purity is asserted separately, in
  `tests/matchup.readPurity.test.ts`, including for a request carrying the demo
  cookie.

Two things are written to the browser, and only these:

| What | Where | Why |
|---|---|---|
| The selected scenario id | `localStorage['fa.demo.scenario']` | So a reload during a demo does not drop into live mode with a demo-looking screen on it. |
| One cached draft board, for `offline-draft` only | the production offline cache, keyed `demo-draft-2026` | The scenario demonstrates a *production* behaviour — falling back to the pre-tunnel capture — and that needs a real capture. The key cannot collide with a real Sleeper draft id, and it is deleted on exit. |

Nothing else. No ADP, no injuries, no picks, no transactions, no tendencies, no
grades, no market snapshots.

---

## 5. Determinism

Every scenario reproduces identically for the same `FIXTURE_VERSION`.

This is not a formality. The draft board runs a 5,000-iteration Monte Carlo for
`Next%` — and it passes because that simulation is already seeded from the draft
state (`core/draft/nextpick/rng.ts`; `Math.random` is called nowhere in this
repository) and because the scenario's clock is fixed.

Asserted by comparing whole payloads across separate runtimes, with two fields
excluded: `nextPickModel.elapsedMs` and `nextPickModel.cached`. Both describe
*how* an answer was produced rather than what it is, neither is on screen, and
every probability is compared exactly.

---

## 6. The scenarios

All twenty-eight are wired. Nothing in the picker is greyed out.

| Group | Scenario | What it is for |
|---|---|---|
| Draft | `draft-early` | Pick 1.09. Every tier intact; two of the top eight already gone above ADP. |
| | `draft-mid` | Pick 6.04, on the clock. A receiver run on the board, a thinning tight-end tier, best-available disagreeing with the biggest hole. |
| | `draft-late` | Round 13, where most of the pool has no ADP and is ranked on what is known. |
| | `draft-complete` | All 168 picks. The board as history. |
| Post-draft | `post-draft-roster` | Nav transition, Team as home, draft provenance, the wire already worth a look. |
| Weekly | `sunday-pregame` | 11:40am, week 6. One genuinely close flex call; Floor and Ceiling disagree — **and a pregame matchup**, forecasting a week nothing has happened in, whose best move is `Hold your lineup`. |
| | `late-injury-pivot` | 12:52pm. A starter downgraded eight minutes before the one o'clock kickoffs; the London game is over and his replacement on the wire does not play until the afternoon. |
| Waivers | `waivers-tuesday-active` | $55 left, several funded rivals, one obvious add and a defence worth streaming. Expected cost, worth-to-you and do-not-exceed are three different numbers; the plan is three claims over two players; the rivals are named from the league's own ledger. |
| | `waivers-thin-data` | A priority league that has never published a bid. Upgrades stand; every price says unknown. |
| | `waivers-processed` | Wednesday. The claim landed and the wallet moved. |
| Matchup | `matchup-live-close` | Sunday 5:20pm, week 6. Three games finished, three running, two to come — and the two projected finals under a point apart. |
| | `matchup-live-leading` | The same afternoon gone the reader's way. The card is about which of the opponent's remaining names can still take it. |
| | `matchup-live-trailing` | The mirror. How much is needed, from whom, to get back to a real chance. |
| | `matchup-injury-swing` | A starter ruled out of the night game while his slot is still changeable, and the swap priced in win probability. |
| | `matchup-final` | Monday morning. Lost by a point and a half: what decided it, and which bench player would have won it. |
| Trades | `trade-window` | Discovery: whose news has moved, who holds them, and which way. |
| Draft | `draft-best-ball` | The same board in a league Sleeper flags as best ball, so Underdog's share of the baseline widens from 60% to 75%. |
| Season | `playoff-week` | Week 15. Thin wire, one game to plan for, and a defence held because the wire's best has a bye coming. |
| | `season-complete` | Nothing left to decide, said plainly. |
| | `rollover-new-season` | March. Last season's league is finished and Sleeper has moved on — which is the gap `resolveSeasonPhase` reads. |
| | `provider-waiting` | July. The new league exists; half the sources have not published for it. |
| Degraded | `offline-draft` | The board request fails and the screen renders the pre-tunnel capture with its age. |
| | `sleeper-adp-unavailable` | No ranking has ever been imported. The board still ranks and warns it is a poor substitute. |
| | `injury-source-stale` | Four days without a report: designations stand, the practice detail does not. |
| | `partial-provider-outage` | No market and a stale usage file. Two of the four numbers are unknown; the recommendation is still made, with confidence lowered. |
| | `dog-unavailable` | No Underdog file has ever been imported. The column is absent rather than blank, and Sleeper carries the whole baseline. |
| | `dog-aging` | Three days old: past the freshness window, inside the trust window. DOG is used, and prints its age. |
| | `dog-stale` | Nine days old. DOG is withheld, the baseline falls back to Sleeper alone, and the board says why. |

**Progression** (§11) is explicit only: `previous` / `next` buttons walking
draft → post-draft → Sunday → late pivot → Tuesday waivers → processed → trade
window → playoffs → season complete → rollover, and separately walking the
matchup Sunday from close to final. No timers and no background jobs.

### Interesting, not toy

The fixtures deliberately carry: market/ledger disagreement in both directions,
a conflicted tally with a large mixed count, a tight-end tier that runs out, a
back whose role is rising while his touchdowns dry up, a spike week that must
*not* be priced as a settled role, a bye with no market at all, a player nobody
has measured, an injury where Sleeper and the report disagree, a wire in a
league where one manager has spent $93 of $100, a defence that is worth starting
one week and worth replacing the next, and a room whose managers claim at
visibly different rates and for visibly different positions.

None of it is a stated conclusion. A fixture writes down what a provider would
have said — a market line, a designation, a target count, a pick, a spend, a
transaction — and every score, bid, verdict, percentage and sentence is computed
from it.

### One slate, one league, one season

Three things are stated once and read everywhere, and each of them replaced a
pair of tables that could disagree:

| Stated once in | What reads it |
|---|---|
| `fixtures/slate.ts` — who plays whom, when each window kicks off, who is at home, what the book made of it | every week spec, every defence projection, the matchup scoreboard, and the schedule the DST outlook walks three weeks forward |
| `fixtures/ledger.ts` — the season's transactions in Sleeper's own shape | the price summary, each roster's remaining budget, the named rivals on a waiver row, the pressure column, and the trade partner's own record |
| `fixtures/world.ts` — the league shape, the cast and the defences | every roster, every board and every lineup |

Week six used to be written down twice — once by the lineup scenarios and once
by the matchup ones — with different opponents, different kickoffs and a tight
end on a bye in one telling and playing in the other. The money was written down
twice too: a spend table and a price summary with nothing connecting them, so a
demo could show a room that had spent $500 between them while claiming a typical
winning bid of $2. Neither is possible now.

The league starts a **`DEF`**, which is what makes the defence half of the
product reachable at all: sixteen defences, twelve rostered and four on the
wire, with the reader's own unit a comfortable home favourite in week six and a
touchdown-and-a-half underdog in Kansas City in week seven. `Stream PHI over
DEN` on the Tuesday and `No clear upgrade` on the Sunday are two readings of
that schedule by `core/dst/planner.ts`, not two fixtures.

---

## 7. The Underdog market

DOG landed, so the §13 seams became real coverage. Every state below is stated
as **provenance on a snapshot** — what a provider served and when — and the
verdict is `resolveDog` and `blendMarketBaseline` reaching a conclusion, never a
fixture asserting one.

| §13 asks for | Where it is, and what decides it |
|---|---|
| Sleeper ADP | Every draft scenario. The platform snapshot, unchanged. |
| DOG | `draft-*`. A `raw_adp` Underdog snapshot six hours old, so the column lights and carries its share. |
| Strong DOG/Sleeper disagreement | `draft-mid`. Underdog has `Rashad Bellinger` at 12.0 against Sleeper's 41.2 — 29 picks, inside the outlier guard, so it is carried into the blend as information and reported with a leader. |
| Stale DOG | `dog-stale`. Nine days past its effective time, so `dogFreshness` says stale, `dogIsUsable` says no, and the board warns out loud. |
| Missing DOG | `dog-unavailable` for the whole file; `Isaiah Coker` and a generated stretch of the depth pool for a single player Underdog has not priced. |
| Missing Sleeper | A stretch of the depth pool past the end of the Sleeper file that Underdog still ranks — `singleSource`, weights `{dog: 1, sleeper: 0}`. |

And what §13 asks to *verify*:

- **Score / ADP / DOG sorting** — the board's own sort, over a fixture where the
  three orders genuinely differ.
- **60/40 and 75/25** — asserted on the same player in `draft-mid` and
  `draft-best-ball`. The best-ball weighting is `detectBestBall` reading
  `best_ball: 1` off Sleeper's league settings; the demo states the setting, not
  the blend.
- **No source relabelling** — a DOG price is Underdog's own number or absent.
  With no Underdog file, no recommendation carries a `dogAdp` and no blend lists
  `dog` as a source.
- **Provenance and freshness** — `dogState` carries provider, source type,
  effective time, fetch time, freshness, age and match count, and its `reason`
  distinguishes the four ways DOG can be absent.
- **No demo market snapshot writes** — structural: `src/core/demo/**` has no
  write path at all (§4).

One case is worth naming on its own. `p076` carries an Underdog price of 2.4
against a Sleeper 119.2. Nobody thinks the hundred-and-nineteenth player off the
board is the second, and blending that at 60/40 would price him around 48 with
complete confidence — so `isImplausibleDisagreement` sets the Underdog number
aside, the blend falls to Sleeper alone, and `suspectDog` says it was set aside
rather than absent. He was chosen because he is still available in the sixth
round, which is the only way a reader ever sees the guard work.

---

## 8. What is declared and not wired

Nothing. Every scenario in the registry is backed by a production surface, and
`tests/demo.scenarios.test.ts` asserts that the awaiting list is empty.

The mechanism is still there and still armed. `DemoScenario.awaiting` names a
surface and a reason; the picker greys such a scenario and prints the reason,
and `DemoRuntime.forScenario` refuses to run it. The five Matchup scenarios used
it between the day this feature landed and the day the Matchup screen did, which
is exactly what it is for: §18 forbids the merge from pretending missing
functionality exists, and a greyed row that says why is worth more to an audit
than a scenario quietly missing from the list.

---

## 9. Bundle impact

Demo Mode is fetched only when somebody opens it. Every path to it is a dynamic
import: the runtime and engines, the scenario registry, the picker component,
and each fixture family separately. The render-path cost is the indicator, the
session and the API hook, and nothing else.

| | gzip |
|---|---|
| App JavaScript | 127.5 kB, against a 140 kB budget |
| Everything the browser must fetch to render | 143.4 kB, against 160 kB |
| Demo Mode (never on the render path) | 135.6 kB across 9 chunks, against 150 kB |

`vite.config.ts` names every demo chunk `assets/demo-*.js`, which is what lets
`perf-budgets.json` exclude them from the render-path budgets *and* cap them
with a budget of their own. Excluding without capping is how a budget stops
meaning anything, so both were done in the same commit.

### The edge that has to stay cut

A demo that runs a production engine can put that engine on the render path
without anybody choosing to, and it happened once here — worth writing down,
because the next lane to wire an engine into Demo Mode will meet it again.

`core/waivers/board.ts` is on the render path and imported `weekRange` from
`core/dst/planner.ts`. One line of formatting, and free: the bundler kept the
function and tree-shook the rest of the planner. Then the demo began running
`planDst` for real — so the planner was retained in full, and a module reachable
from the entry belongs to the entry. The defence model, its outlook and the
whole start/sit engine behind them moved into the chunk every page load fetches:
**25 kB gzip, to print `Weeks 15–17`.**

`weekRange` now lives in `core/dst/weeks.ts`, which imports nothing. The rule
that falls out of it is worth keeping: **a render-path module may take types
from an engine, but a runtime import is an edge, and an edge is a dependency
tree.** The app-JavaScript number above is what it was before the demo ran the
planner at all.

---

## 10. Testing and the audit hook

```
tests/demo.scenarios.test.ts   every scenario through the real engines
tests/demo.showcase.test.ts    the demonstrations themselves: the waiver
                               contingency, the defence decision, the best move,
                               a bilateral offer, a focused player, DOG and PTS
tests/demo.isolation.test.ts   mutation refusal, structural isolation, determinism
tests/demo.server.test.ts      the server boundary, against a real database
e2e/demo.spec.ts               enter → choose → navigate → assert → exit → verify live
```

The audit hook is `?demo=<scenario-id>`, applied before the first render so no
live data is fetched or flashed. It is ungated, and safe to be: entering Demo
Mode is entering a read-only view of fixtures, so the worst a stray link can do
is show somebody a clearly-labelled demo with an exit button on it.

```ts
await page.goto('/?demo=waivers-tuesday-active');
await expect(page.getByTestId('demo-bar')).toBeVisible();
// …navigate and assert against the production screens…
await page.getByTestId('demo-exit').click();
```

The e2e specs run at 430, 390, 375 and 360, on WebKit in CI.

---

## 11. Accessibility

- The DEMO state is conveyed by the word `DEMO`, the scenario's name and its
  clock as a real `<time>` — never by colour alone.
- The indicator is `role="status"` with `aria-live="polite"`.
- The running scenario carries `aria-current` and the word "Running". A scenario
  whose surface has not landed carries the word "Waiting" and the reason; no
  scenario is in that state today, and the markup stays because the next
  declared-but-unbuilt surface will need it.
- Every control is at least 44px tall, asserted in e2e.
- The indicator owns the status-bar inset so the navigation bar underneath does
  not reserve the same pixels twice — asserted in e2e, because that specific
  mistake has produced a dead strip in this app before.

---

## 12. Limitations

- **Two in-season scenarios still carry no matchup.** `sunday-pregame` now has
  one — the pregame phase the five matchup scenarios did not cover — but
  `late-injury-pivot` and the week-seven waiver scenarios do not: Sleeper has
  published no row for them, which the screen reports honestly. Giving the
  waiver week one would mean pricing the opponent's whole roster in a week whose
  whole subject is the wire.
- **No newsletter excerpts.** The evidence ledger holds publisher text, and
  inventing plausible excerpts would put words in a publisher's mouth on a
  screen whose premise is that every original excerpt is preserved verbatim. The
  tallies are real and computed; the timeline says there is nothing to show, and
  the expanded card's takeaway is `null` rather than templated.
- **Review and newsletter queues are empty** in every scenario, for the same
  reason — and the overview's `pendingEvidence` and `pendingIdentity` are `0` to
  match. They have to be: Review's row in Settings prints the sum of those two
  as a sentence and the Setup destination carries a dot when it is above zero,
  so a borrowed count would be a scenario saying "2 items need attention" above
  a queue with nothing in it. The unresolved names a messy scenario does model
  are a different ledger and are shown where they belong, on **Help my scores**.
- **No portrait, ever.** A fixture player id is not a Sleeper player id, so
  `playerHeadshotUrl` returns null for every one of them and the focused view
  draws its deterministic initials instead. That is the intended state and not a
  gap to be closed: the alternative is either two hundred requests to
  `sleepercdn` that can only 404, or a bundled photo pack. The shared header,
  its sizing and its fallback are all exercised; the photograph is the one thing
  a demo cannot show. Asserted in `tests/demo.showcase.test.ts` and in
  `e2e/demo.spec.ts`, which watches for a request to `sleepercdn` and fails if
  one is made.
- **Manager tendencies are read from two seasons and no more.** They used to be
  absent entirely, on the ground that a tendency needs a sample and Demo Mode
  had no history to walk. It has one now — `fixtures/ledger.ts` — and the
  distinction that matters held: the fixture states *transactions*, and
  `buildTransactionProfiles`, `buildTradeTendencies` and `readManagerTendencies`
  state the tendencies. Two seasons is a real sample and a thin one, which is
  why several readings on screen say so out loud rather than rounding up.
- **`/api/leagues/:id/trades/ladder`** is now both served and drawn. The runtime
  route calls `buildLadderFor` and `buildLadder` — the same two functions the
  deployed handler calls — over the scenario's own rosters, and the Trades
  screen reaches it from a fold on the offer sheet and on a board row's trade
  case. `partner.profile` is null there, deliberately and for the same reason
  `/managers` answers `trade: null`: that field is the roster-keyed cached
  profile a nightly backfill writes, a demo runs no backfill, and inventing one
  would put a tendency on a manager nobody has measured. So the scenario shows
  the thin-sample branch of the card, which is an honest demonstration rather
  than a missing one.
- **`/api/leagues/:id/bench`** is served by the runtime but is not yet consumed
  by any screen, so no scenario demonstrates it visually. `/managers` is served
  with real profiles now, and is likewise not on a screen.
- **Demo fixtures are one league**: 12-team, half-PPR, 1QB, single flex. A
  superflex or best-ball scenario would need a second world; the format is
  already declared per scenario, so adding one is a fixture, not a change here.
- **A queue-filtered draft board scores differently from the full one.** Found
  while asserting that the ★ moves no ranking — it does not, but `?queued=1`
  narrows the *candidate pool*, and the tier-cliff and positional-scarcity
  components are computed over that pool. This is production behaviour and this
  workstream did not change it; `tests/demo.scenarios.test.ts` therefore proves
  the star's neutrality by building the same board twice with and without the
  flags, rather than by comparing a filtered board to an unfiltered one. See
  STATUS.md, known limitation 13.
