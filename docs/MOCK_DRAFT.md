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
and answers **two named methods differently**, both scoped to the draft the mock
is for:

- `leagues.listPicks(draftId)` returns the rehearsal's picks instead of
  Sleeper's;
- `leagues.getDraft(draftId)` returns the same draft with the rehearsal's
  seating, which is byte-identical to the real one unless a seat was chosen.

The second arrived with the seat chooser and is the same fact as the first seen
from the other side: the picks say who drafted where, and `slot_to_roster_id` is
what the board reads to draw them there. Substituting one without the other put
the reader on the clock at seat 7 and went on drawing them in their real chair.
`tests/mock.isolation.test.ts` asserts there are exactly two.

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

## Where you sit

A rehearsal begins at a **setup step**, not in a running draft. The one thing it
asks is the seat: the turn at seat 1 and the round-turn at seat 12 are different
drafts to practise, and a mock you could only run from your own chair was
rehearsing one of them. Any seat, or a random draw; starting without choosing
takes the seat the league actually gave you, which is what every mock did before
the step existed.

Choosing a seat is a **swap**, not a relabelling — the reader takes the chosen
chair and its manager takes theirs — so the room still holds every manager the
league has, each of them once, and the draft order still names a real person in
every seat. The state carries it as an optional `slot`, so a rehearsal stored by
an older build stays readable and runs from the real seat.

Reset returns to the setup step rather than starting immediately, because that
is where the seat lives and there is nowhere else to change it.

## Your own team

`Team`, in the rehearsal's header, draws what you have built into the slots the
league scores — the empty starting slot being the most useful line on it. The
allocation is `fillSlotRows` over the board's own `rosterProgress`, the same
rows the header strip counts, so the sheet and `0/1 QB · 2/3 WR` cannot
disagree.

The real Team screen was not reusable and the check is worth recording: it draws
the lineup Sleeper *stores*, and a draft has no such thing — nobody sets a
lineup while drafting, and inventing one would commit a decision the reader has
not made. What was reusable is the allocation `core/draft/liveRoster.ts` already
does for the draft header.

One documented divergence: `rosterProgress` caps its bench count at the
configured bench so the strip never reads `9/6 BN`; the team sheet draws every
player regardless, because a pick vanishing off your own roster is worse than a
row with more names than spaces.

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

The Draft header's menu control is the home for three destinations — **Draft
board**, **Draft order**, **Mock draft** — presented as a compact popover
anchored under the button.

It began as a bottom sheet, which cost no new CSS and reused the grouped-list
grammar. The first real rehearsal said what a screenshot could not: half the
screen covered to offer three words is the wrong *shape* for the content. Both
presentations satisfy the brief's one hard constraint the same way — nothing
drawn until a tap cannot add height to a header — so this was picking a better
control for the constraint rather than reopening it. The browser suite measures
both halves now: the nav stays under 60px with the menu up, **and** the menu
stays under 40% of the viewport.

The glyph changed with it, from a board grid to a chevron. An icon that draws
its destination promises to go there, which was honest while the button opened
the board and became a lie the moment it started opening a choice of three.

The **Draft order** screen stripes its rows and paints the reader's own seat —
reported from a real draft as "I can't find myself", when twelve identical rows
marked the owner's with the word "You" at the end of a line in a list where
every line ends in numbers.

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
| `tests/liveRoster.test.ts` | `fillSlotRows`: the team sheet cannot disagree with the header strip |
| `e2e/mock-draft.spec.ts` | the menu's shape and the nav height, the setup step and the seat, the team sheet, the draft order's striping, the double-tap guard, and that no write leaves the browser while one is open |

## Deliberately not built

- **A history of past mock runs.** One active mock per draft; see §3.
- **A "draft this player" control on the real board.** Unchanged: the tool
  recommends only, and never touches Sleeper.
- **Any change to tally, ingestion, Data Health or the real Draft's ranking.**
  This lane is additive.
