# Mock Draft

A practice draft the owner can run against his real league, any number of times,
before the real draft starts — and, because it is the production Draft screen
over a substituted pick stream, a way to demo or troubleshoot that screen
outside a live draft window.

Design spec: [`docs/brief/10_MOCK_DRAFT.md`](brief/10_MOCK_DRAFT.md).

---

## The one new model: how a bot manager picks

`src/core/draft/mockManager.ts`. Pure, synchronous, handed everything it reads.

Three inputs, and no fourth:

| Input | Weight | Where it comes from |
|---|---|---|
| **Sleeper ADP** | the anchor, by a distance | the same market snapshot the live board ranks against |
| **Manager tendency** | a bounded nudge, sample-gated | `core/managers/managerTendencies.ts`, via `MANAGER_PRIOR` |
| **Randomness** | bounded jitter | a draw from `nextpick/rng.ts`, seeded by the mock's own state |

The market weight is `exp(-i / spread)` over a candidate's index in the best-
available window (`window: 12`, `spread: 3.5`), so the median bot pick lands
within about two of best available and nothing outside the window is reachable.
That weight is then multiplied by the manager's own per-position multiplier and
one candidate is sampled.

**`MANAGER_PRIOR` is imported rather than restated.** "How much more does this
manager want a quarterback right now" is the same question `nextpick/
managerPrior.ts` already answers for the survival model, and a second gain
constant here would mean a manager who is a mild quarterback risk on the live
board is an eager one in a rehearsal of the same draft. `buildDemandPlan` decides
what "he has filled it" means, including the superflex rule, for the same reason.

**Sample gating.** Below `core/managers/`'s own threshold a manager's tendencies
are not `usable`, and this module asks nothing further: he drafts on ADP and
jitter alone, which is what every other engine in this app does when a signal has
nothing to say. `mockManager.test.ts` asserts that a short-sample manager and a
manager with no history at all produce byte-identical drafts.

**No second ranking engine.** Nothing here reads `Score`, the tier ladders,
projections, injuries or any evidence signal. A bot's opinion of a player is the
market's opinion of a player, moved a little by who is picking — so if a mock
disagrees with the board it is disagreeing about *when he goes*, which is the
only thing it is entitled to have a view on.

## A mock is a third source object

`src/core/draft/mockSources.ts` decorates the reader's own `DraftBoardSources`
and answers **exactly one method differently**: `leagues.listPicks(draftId)`
returns the rehearsal's picks instead of Sleeper's, and only for the draft the
mock is for.

Everything else — the player dictionary, the ADP snapshots, the newsletter
evidence, the injury states, the season markets, the ★ queue — is read from live
data, because a rehearsal against fixtures would be a rehearsal of somebody
else's league. Live Sleeper is one implementation of that interface, Demo Mode's
fixtures are a second, and a mock is the third. The board, the grid, the tiers,
`Next%`, the survival model and every screen above them are untouched.

## Where the state lives

**In the reader's browser**, keyed by the Sleeper `draft_id`
(`fa.mock.<draft id>` in `localStorage`), and nowhere else. There is no mock
table and no mock column: the state arrives in the body of a read, is used to
build one board, and is dropped.

That key is the lesson of migration `0029`, where a shortlist keyed by player
alone turned out to be one global list and a finished draft's queue surfaced in
the next league's board. One league's mock cannot be reached from another's, and
deleting one leaves the other exactly as it was.

One active mock per draft, freely resettable — a reset is a new seed rather than
an edit. There is no saved history of past runs; §3 of the brief flags that as a
recommendation rather than an owner decision.

## What ends it

**The first real pick for that `draft_id` deletes the mock outright.** Not
hidden, not flagged — the row is removed. `isVoidedByRealPicks` is the rule,
stated once, and it is applied in two independent places:

- the **Draft screen** deletes the stored state as soon as any board it holds
  reports `picksMade > 0`, whether or not the mock is open;
- the **server** refuses to build a mock board or capture a mock snapshot for a
  draft that is underway, with a `409`, so a client that has not noticed cannot
  carry on regardless.

Neither is a backstop for the other.

## Isolation: refused twice

Demo Mode's mechanism, reused rather than reimplemented. The rule is about
requests, not about buttons: **while a mock draft is running, nothing but a read
may pass.**

- **In the browser** — `assertMockAllows` is called from `request()` in
  `web/api.ts`, the one function `api.get` and `api.post` both go through, before
  any `fetch`. A screen that forgot to disable a control, an endpoint added next
  year and a call typed into a console are all refused.
- **At the server** — an `fa_mock` cookie and a middleware that runs *before* the
  passphrase check, so an unlocked session is not permission to mutate the real
  draft while rehearsing it.

What counts as a read is stated once, in `core/http/readShaped.ts`, and is shared
with Demo Mode's guard — a read-shaped POST added for one is a read-shaped POST
for the other, and the two cannot drift.

The mock's own two routes are POSTs and both are reads:

```
POST /api/drafts/:id/mock/board             # apply an action, return state + board
POST /api/drafts/:id/mock/support-snapshot  # capture, marked as a rehearsal
POST /api/mock/enter | /api/mock/exit       # the marker, and nothing else
GET  /api/mock/status
```

They are POSTs for the same reason `/api/startsit/compare` is one — the request
carries a state that does not fit in a query string — and they write nothing:
the board is built through `DraftBoardSources`, an interface with no write on it,
so that is a property of the type rather than a promise.

While a rehearsal is open the Draft screen's live refresh loop is **parked**
through `isVisible`, the same mechanism a backgrounded tab uses. `POST /sync` is
the one thing in this app that writes on a timer.

## Support snapshots

A mock produces a snapshot through exactly the same capture as a real draft —
the same recorder, the same redaction, the same seal — and it replays through
`npm run support:fixture` just as cleanly.

That is what makes it useful and also what makes it dangerous, so the file says
so. `rehearsal: { kind: 'mock', picksMade, seed }` sits in the **envelope**,
above the decision, where a reader looks first; `support:fixture` prints it
immediately under what kind of decision the file is:

```
  decision       Draft (draft-board)
  REHEARSAL      mock draft — 13 pick(s) in, seed 555. Not a real draft decision.
```

## Navigation

The Draft header's `▦` is now the home for three destinations — **Draft board**,
**Draft order**, **Mock draft** — presented as a sheet. A sheet satisfies the
brief's one hard constraint by construction: it is not drawn until it is opened,
so the header keeps the height it had, and the browser suite measures that the
nav stays under 60px with the menu up.

`Mock draft` is offered only when a rehearsal is possible. Once the real draft
has picked, or while Demo Mode is running, the row is present and disabled with
the reason written on it — a control that vanishes teaches the reader that they
imagined it.

## Tests

| File | What it proves |
|---|---|
| `tests/mockManager.test.ts` | the blend: ADP anchors, history nudges only with a sample, the draw is the only randomness |
| `tests/mockDraft.test.ts` | the snake, turn-taking, determinism, the deletion rule, per-draft scoping |
| `tests/mock.isolation.test.ts` | both refusals, mutation-tested; the seam is structural |
| `tests/mock.board.test.ts` | end to end over the real router: the board is real, the real draft is untouched, the 409, the snapshot round-trip |
| `e2e/mock-draft.spec.ts` | the menu, the nav height, the rehearsal, and that no write leaves the browser while one is open |

## Deliberately not built

- **A history of past mock runs.** One active mock per draft; see §3.
- **A "draft this player" control on the real board.** Unchanged: the tool
  recommends only, and never touches Sleeper.
- **Any change to tally, ingestion, Data Health or the real Draft's ranking.**
  This lane is additive.
