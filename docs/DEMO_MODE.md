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
                 DraftBoardSources · StartSitInput[] · TradeCandidate[]
                        │
                        ▼
                 the same engines
                 buildDraftBoard · recommendLineup · recommendWaiverUpgrades
                 priceWaiverUpgrades · evaluateBench · compareStartSit
                 rankTrades · orderPlayers · resolveLifecycle
                        │
                        ▼
                 the same React screens
```

There is exactly one Draft screen, one Team screen, one waiver card, one player
sheet and one scoring engine in this repository. Demo Mode renders them. If a
production screen changes, the demo inherits the change, because there is
nothing to keep in step.

The substitution happens at **one seam**: `request()` in `src/web/api.ts`. Every
screen in the app talks to the server through `api.get` / `api.post`, both of
which go through that function, so redirecting it is the whole of the feature.
No screen knows a demo exists, no component takes a `demo` prop, and a screen
written next year inherits the behaviour for free.

### What had to change in production code

Three things, all of them "one implementation instead of two":

| Change | Why |
|---|---|
| `core/draft/boardBuilder.ts` — the board assembly moved out of `server/services/draftBoard.ts` and is driven by a `DraftBoardSources` interface | So the demo runs the *same* board builder. `DraftBoardService` keeps its exact public API; every existing caller and test is untouched. |
| `core/waivers/pricing.ts`, `core/roster/held.ts`, `core/roster/freeAgents.ts`, `core/trades/ladderInputs.ts` — assembly helpers moved out of `server/app.ts` | So a rehearsed bid and a live one are the same arithmetic. Moved verbatim. |
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

Twenty-three of twenty-eight are wired. The five Matchup scenarios are declared
and waiting — see §7.

| Group | Scenario | What it is for |
|---|---|---|
| Draft | `draft-early` | Pick 1.09. Every tier intact; two of the top eight already gone above ADP. |
| | `draft-mid` | Pick 6.04, on the clock. A receiver run on the board, a thinning tight-end tier, best-available disagreeing with the biggest hole. |
| | `draft-late` | Round 13, where most of the pool has no ADP and is ranked on what is known. |
| | `draft-complete` | All 168 picks. The board as history. |
| Post-draft | `post-draft-roster` | Nav transition, Team as home, draft provenance, the wire already worth a look. |
| Weekly | `sunday-pregame` | 11:40am, week 6. One genuinely close flex call; Floor and Ceiling disagree. |
| | `late-injury-pivot` | 12:52pm. A starter downgraded, his beneficiary on the wire, one bench player already locked. |
| Waivers | `waivers-tuesday-active` | $37 left, several funded rivals, one obvious add. Expected cost, worth-to-you and do-not-exceed are three different numbers; one estimate is withheld outright for want of a measured role. |
| | `waivers-thin-data` | A priority league that has never published a bid. Upgrades stand; every price says unknown. |
| | `waivers-processed` | Wednesday. The claim landed and the wallet moved. |
| Trades | `trade-window` | Discovery: whose news has moved, who holds them, and which way. |
| Draft | `draft-best-ball` | The same board in a league Sleeper flags as best ball, so Underdog's share of the baseline widens from 60% to 75%. |
| Season | `playoff-week` | Week 15. Thin wire, no byes left, one game to plan for. |
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
window → playoffs → season complete → rollover. No timers and no background
jobs.

### Interesting, not toy

The fixtures deliberately carry: market/ledger disagreement in both directions,
a conflicted tally with a large mixed count, a tight-end tier that runs out, a
back whose role is rising while his touchdowns dry up, a spike week that must
*not* be priced as a settled role, a bye with no market at all, a player nobody
has measured, an injury where Sleeper and the report disagree, and a wire in a
league where one manager has spent $93 of $100.

None of it is a stated conclusion. A fixture writes down what a provider would
have said — a market line, a designation, a target count, a pick, a spend — and
every score, bid, verdict, percentage and sentence is computed from it.

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
| Strong DOG/Sleeper disagreement | `draft-mid`. Underdog has `Emeka Falade` at 12.0 against Sleeper's 41.2 — 29 picks, inside the outlier guard, so it is carried into the blend as information and reported with a leader. |
| Stale DOG | `dog-stale`. Nine days past its effective time, so `dogFreshness` says stale, `dogIsUsable` says no, and the board warns out loud. |
| Missing DOG | `dog-unavailable` for the whole file; `Teo Ferreira` and a generated stretch of the depth pool for a single player Underdog has not priced. |
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

Honesty here matters more than a longer list.

**Matchup** — `matchup-live-close`, `matchup-live-leading`,
`matchup-live-trailing`, `matchup-injury-swing`, `matchup-final`. There is no
Matchup surface in the product: no tab, no route, no live scoring, no
remaining-points distribution. Wiring these would mean Demo Mode inventing the
UI §1 forbids it from inventing, and the audit would then be auditing a screen
no user can reach. They are listed in the picker, greyed, with the reason
printed. `DemoRuntime.forScenario` refuses to run them.

---

## 9. Bundle impact

Demo Mode is fetched only when somebody opens it. Every path to it is a dynamic
import: the runtime and engines, the scenario registry, the picker component,
and each fixture family separately. The render-path cost is the indicator, the
session and the API hook, and nothing else.

| | gzip |
|---|---|
| App JavaScript, without Demo Mode | ~94 kB |
| App JavaScript, with it | 101.0 kB |
| Demo Mode (never on the render path) | 72.3 kB across 8 chunks |

`vite.config.ts` names every demo chunk `assets/demo-*.js`, which is what lets
`perf-budgets.json` exclude them from the render-path budgets *and* cap them
with a budget of their own. Excluding without capping is how a budget stops
meaning anything, so both were done in the same commit.

---

## 10. Testing and the audit hook

```
tests/demo.scenarios.test.ts   every scenario through the real engines
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
- The running scenario carries `aria-current` and the word "Running"; a waiting
  one carries the word "Waiting".
- Every control is at least 44px tall, asserted in e2e.
- The indicator owns the status-bar inset so the navigation bar underneath does
  not reserve the same pixels twice — asserted in e2e, because that specific
  mistake has produced a dead strip in this app before.

---

## 12. Limitations

- **Matchup is declared, not wired** (§8). This is the honest state of the
  product, not an omission.
- **No newsletter excerpts.** The evidence ledger holds publisher text, and
  inventing plausible excerpts would put words in a publisher's mouth on a
  screen whose premise is that every original excerpt is preserved verbatim. The
  tallies are real and computed; the timeline says there is nothing to show, and
  the expanded card's takeaway is `null` rather than templated.
- **Review and newsletter queues are empty** in every scenario, for the same
  reason.
- **No manager tendencies.** A tendency needs a sample, and the live feature
  builds one by walking a league's history. Demo Mode has none to walk, so
  `/api/leagues/:id/managers` returns the same nulls the live app returns for a
  league nobody has run that pass for. Inventing them would be the one thing an
  "interesting" fixture must never become: a demonstration of a claim the
  product cannot make about a real league.
- **`/api/leagues/:id/bench`, `/managers` and `/trades/ladder`** are served by
  the runtime but are not yet consumed by any screen, so no scenario
  demonstrates them visually.
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
