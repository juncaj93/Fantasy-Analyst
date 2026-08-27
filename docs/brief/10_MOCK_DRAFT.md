# Brief 10 — Mock Draft + Draft Tools

**Status:** approved design, ready to build.
**Owner decisions captured:** 2026-08-27, in conversation with the acting PM.
**Supersedes:** the three-sentence summary in `01_PM_HANDOFF.md` §13a/13c — this
is the real spec.

---

## 1. What this is

A practice draft the owner can run against his real league, any number of
times, using the same engines and screens as the real Draft — so it can also
double as a way to demo or troubleshoot the Draft experience outside of a live
draft window.

**It is completely isolated from the real league.** Nothing it does may reach
Sleeper, the real draft state, or any store the real board reads.

---

## 2. What the other (computer-controlled) managers do on the clock

This is the one genuinely new modelling decision in this lane. Resolved:

**Always practice against the owner's real league mates**, using their actual
tendencies — not generic opponents.

The pick model for a bot manager blends three inputs:

1. **Sleeper ADP** — the primary anchor and heaviest weight. This is the same
   market data the real Draft screen already uses.
2. **`core/managers/` tendencies** — the existing bounded draft-tendency profile
   built from each manager's real league history (the same data that powers
   Next%). Nudges a manager's picks toward their real patterns (position runs,
   reaches, hoarding) *only* where that manager has enough sample size for the
   module to speak — per the existing "a tendency needs a sample" rule. Below
   threshold, that manager drafts closer to ADP + noise alone, same as any
   other engine output in this app when a signal has nothing to say.
3. **Randomness** — a bounded jitter so mock results aren't deterministic
   replays of each other.

**Do not build a second ranking engine.** This reuses `core/managers/` and
Sleeper ADP as they already exist. The only new code is the blend function that
picks a player for a bot manager's turn, and it should be a `core/` module of
its own (pure, unit-testable, no I/O) — e.g. `core/draft/mockManager.ts` —
following the existing pattern of pure functions handed a `Sources` interface.

---

## 3. Lifecycle and storage

**Scope: per real Sleeper draft (`draft_id`), not global.**

- A mock draft exists for exactly one real `draft_id`.
- **The moment Sleeper shows the first real pick for that `draft_id`, the mock
  for it is deleted outright.** Not hidden, not flagged — gone. This matches
  the phrasing the owner used: "delete it completely until season ends."
- If the owner is in a different league whose draft hasn't started yet, Mock
  Draft is available there independently — it's keyed by that league's own
  `draft_id`, so nothing about one league's mock affects another's.
- **Unlimited re-runs.** No cap on how many times a mock can be run or reset
  before the real draft starts.
- **Recommendation to keep this simple under the time constraint:** one active
  mock state per `draft_id` at a time, freely resettable, rather than saving a
  history of many separate past mock runs. Resetting just re-rolls the board
  from scratch. This is a recommendation, not a decision the owner made — flag
  it back if a saved-history version turns out to be cheap to add.
- Precedent to follow, not repeat the mistake of: `draft_queue` is keyed
  `(draft_id, player_id)` per migration `0029`, specifically because a global
  list keyed by player alone once let a finished shortlist leak into the next
  league's draft. Key mock draft state the same way — by `draft_id` — for the
  same reason.

## 4. Isolation

Nothing a mock draft does may write to, or be reachable from, real league
state. Enforce this the same way Demo Mode already does it: **refused twice —
once in the browser, once at the server.** Do not build a new isolation
mechanism; reuse Demo Mode's write-refusing middleware pattern.

## 5. Support snapshot

**Yes — a mock draft can produce a support snapshot, same as the real Draft.**
This was explicitly requested so Mock Draft can double as a troubleshooting /
demo tool, not just a rehearsal. The snapshot should clearly mark itself as
`mock` in its captured state so a replay is never confused with a real draft
decision. Reuse the existing six-decision capture pattern (`Setup → Copy support
snapshot`) rather than building a parallel capture system.

## 6. Navigation

The existing `▦` control on the Draft header becomes the home for three
destinations: **Draft Board**, **Draft Order**, **Mock Draft**. Exact
presentation (menu, sheet, tabs) is left to the building session's judgement —
the owner has no preference here — with one hard constraint carried over from
the existing browser suite: the Draft header's nav height must stay under 60px
at every tested width. The control cannot grow a second row.

---

## 7. What this builds on (already exists, do not rebuild)

| Existing | Reused for |
|---|---|
| `src/core/draft/boardGrid.ts` | Pure state → rounds → columns → cells transform. Mock hands it different source data, same transform. |
| `src/core/draft/boardBuilder.ts` (`buildDraftBoard`, `DraftBoardSources`) | The board is handed its facts. A mock is a third source object (after live Sleeper and Demo Mode fixtures), not a second engine. |
| `src/web/components/draftBoard.tsx` (`DraftBoardOverlay`) | Draws the grid. Fetches nothing itself — no change needed to make it render mock data. |
| Demo Mode's write-refusing middleware | Isolation pattern — reuse directly, browser + server. |
| `core/draft/nextpick/ownership.ts` | Whose pick is whose in the snake. Import, do not reimplement. |
| `core/managers/` | League-mate tendency profiles, sample-gated. Feeds the new blend function in §2. |

---

## 8. Collision warning — sequence, do not parallelize with the player-card lane

The branch `claude/new-session-rlnbgk` (newsletter insight + mobile scroll
fixes) touches `web/screens/DraftScreen.tsx` for the draft-card restructure.
**This lane also owns `web/screens/DraftScreen.tsx`.** Per the project's
exact-head discipline rule, do not start this lane until that branch is merged
to `main` and confirmed deployed. Starting from a stale head wastes the
twelve-to-fifteen-minute CI gate on a merge conflict.

---

## 9. Definition of done

1. `typecheck`, unit/integration, browser suite at all four widths, perf
   budget, `build`, `wrangler deploy --dry-run` all green.
2. Named tests for: ADP+tendency+randomness blend behaves correctly with and
   without sufficient manager sample size; mock state is deleted the instant a
   real pick appears for that `draft_id`; a second league's mock is unaffected
   by the first's deletion; isolation is refused both in the browser and at
   the server (mutation test each, per the project's standard).
3. Byte cost measured against `perf-budgets.json` — state what it cost, not
   just that it fit.
4. A support snapshot captured from a mock draft round-trips through
   `support:fixture` and is visibly marked as `mock`.
5. Nothing in this lane touches Sleeper write paths, tally, ingestion, Data
   Health, or the real Draft's ranking logic.
