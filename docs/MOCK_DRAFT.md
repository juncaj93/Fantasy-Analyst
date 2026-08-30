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

### The slots are the league's, and it was checked rather than assumed

Reported after a rehearsal: that this sheet did not follow the league's roster
settings — a one-quarterback league drawing two quarterback slots. It does
follow them, and the check is recorded because "it looked wrong" deserves a
measurement rather than a reassurance.

There is one source. The mock's board is built by `buildDraftBoard` over
substituted picks, and `rosterProgress` there comes from
`buildRosterShape(league.rosterPositions)` — the league's own `roster_positions`
as Sleeper published them. `mockSources.ts` substitutes `listPicks` and
`getDraft` and nothing else, so the league, and therefore the shape, is read
exactly as the live board reads it. There is no second shape on this path and
no default to fall back to.

`tests/mock.board.test.ts` holds it from both ends: the rehearsal's slots and
the real board's slots are asked for at the same moment and both are checked
against `roster_positions` rather than against each other, so a shared wrong
answer could not pass. Confirmed in the browser too, against a pre-draft league
shaped `QB/RB/RB/WR/WR/WR/FLEX/FLEX`: the Draft page's strip read
`0/1 QB · 1/2 RB · 1/3 WR · 2/2 FLX · 1/7 BN` and this sheet drew the same five
rows.

What the report *did* find is real and lives in the engine rather than here: a
position whose starting slots are full was still collecting the full positional
scarcity premium, so quarterbacks stayed near the top of a rehearsal after the
one quarterback slot was filled. See `docs/DRAFT_CONTRIBUTION_MAP.md`, "A
position you have finished with speaks more quietly".

## Narrowing the board

The rehearsal draws the Draft page's own position chips: `SegmentedControl` over
`orderFilterChips`, the same control in the same order over the same
league-derived set, so a league with no defence slot draws no `DEF` chip in a
rehearsal either.

**It narrows through the route, not through the list.** The chip travels as
`position` on the mock board request — the same parameter the live board sends —
and `buildDraftBoard` does the cut. So the filtered rehearsal *is* the filtered
Draft page, which is also how `#222` is inherited rather than re-implemented: a
tier is built from the pool the unfiltered board is built from, filtered or not.

Two things about it are particular to a rehearsal:

- **There is no ★ chip.** A star is "remind me later" and there is no later
  here — the reader is the one picking, now, which is why the star's slot on
  these rows carries the `+` that takes the player. A chip filtering to a list
  nobody can add to from this screen would be a control with no way to satisfy
  it.
- **A tap on a chip does not itself make a request.** It moves the chip away
  from `applied`, and an effect closes the gap once the phase is `ready` — which
  is to say, once nothing is in flight. That is what stops a chip tapped while a
  pick is travelling from bumping the generation counter and discarding the
  pick's answer. This screen's history is lost picks; a filter is not worth
  another one.

The chip rides on every request, the `take` included, so a rehearsal can be run
inside one position. A reset opens the next run on the whole board.

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

## When the trip fails

Reported from a real rehearsal: `Couldn't save that yet` over a mock, coming and
going while the draft went on progressing — a pick that did nothing until it was
tapped again, sometimes twice.

The banner is `mock-error`, and only a `POST /mock/board` that does not come
back as JSON can draw it. The route is not what fails: the same request answered
200 across twenty-two complete mock drafts over the real router and a real
database, on a uniform pool and a production-shaped one. Nothing else in the app
can draw it over a rehearsal either — the layer covers the viewport at the top
of the stack, and the app's only recurring POST (`/sync`) is parked while a mock
is open. What failed was the trip.

So the request is **retried**, twice, at 300ms and 600ms, and only while the
client's own `retryable` says the failure was transport — a dropped connection,
a 5xx, a 408, a 429. A refusal is never retried, which is what keeps the 409
that ends a rehearsal arriving immediately.

Retrying is safe here in a way it is almost nowhere else in this app, and that
is why it lives at this seam rather than in `api.ts`: the route writes nothing,
and it is a pure function of the state posted to it — the same state and action
produce the same room, because every bot pick is drawn from a generator seeded
by the state and the pick number. A second attempt is not a second pick.

If all three attempts are lost the banner stays, and it now carries **Try
again**, which re-sends the action the reader actually asked for. Without it
their pick is simply gone and the only way back is to find the row again — which
is what the defect felt like from the other side of the screen.

### The ten-second lockout, which that retry caused

Retrying was right. Retrying the way it was first written was not, and the owner
reported the result: after a failure he had to wait "roughly 10+ seconds" before
the app would let him tap another player.

Three things were wrong, and all three were the same mistake — nothing bounded
anything:

  - **no deadline on a request.** `api.ts` has no timeout, deliberately, so a
    request that never answers never fails. Three of those in a row is an
    unbounded wait.
  - **a budget that was not a budget.** The retry loop counted attempts, not
    time.
  - **a tap that could not be heard.** The row returned early whenever a
    request was in the air, so the tap never reached the code that could tell a
    stray double from a person asking again. *That* was the lockout: not a
    cooldown anybody wrote, but a guard with no way out of it.

Now: `MOCK_ATTEMPT_MS` (4s) bounds one attempt, `MOCK_BUDGET_MS` (6s) bounds the
whole thing — and is checked against what the *next* attempt could cost, not
only what the last one did, which is the arithmetic error that let a 5s budget
permit an 8.6s sequence. Past `MOCK_IMPATIENCE_MS` (700ms) a tap cancels what is
in the air and takes its place, so the longest a tap can go unheard is the
length of a double-tap.

Two browser tests hold it: a request that never answers must hand the screen
back inside seven seconds, and a tap during a slow pick must be the pick that
lands. Both are mutation-proven.

### What it turned out to be: an edge 503, above the Worker

The record did its job on the first occurrence after it shipped. Three
consecutive attempts at one pick, all **HTTP 503**, all through the **MIA**
colo, at 2062ms / 518ms / 656ms — rays `a323e35dfb989be2`,
`a323e38b4cbd9be2`, `a323e3906d739be2`.

**No line of this application can produce that**, and the elimination is
structural rather than circumstantial:

  - `src/worker/index.ts` wraps every `/api/*` request in a try/catch that
    answers **JSON 500** — written precisely so nothing escapes to Cloudflare's
    HTML error page. It catches what the router cannot: a binding that will not
    resolve, a failure building the environment, the router itself.
  - `http/router.ts` wraps middleware *and* handler in a second try/catch, also
    **JSON 500**. Its own comment states the rule: every answer to an `/api/`
    request that leaves it is JSON.
  - `wrangler.toml` sets `run_worker_first = ["/api/*"]`, so the static-asset
    router cannot answer the path first.
  - The only two 503s in the codebase are `errorResponse(…, 503)` about a
    missing passphrase — **JSON**, and a JSON error keeps the server's own
    message, so the banner would have read *"This site is read-only…"* rather
    than the generic sentence. They would also fire for every write, forever,
    not three times in three seconds.

So the three named suspects are all excluded by construction: an unhandled
exception is caught twice over and becomes a 500; a D1 lock or timeout is a
throw, so also a 500; a CPU or subrequest limit is Cloudflare's own 1101/1102,
which is **status 500** with an HTML page. **None of them can produce a 503
here.** It was generated above the Worker, at the edge.

And it is not about the request either. The decisive fact is that **the same
bytes succeeded moments later**: the state is posted whole with every attempt,
so a payload-, round- or size-dependent failure would have failed identically on
the retry that worked. Concurrency is excluded too — the screen holds one board
request at a time, and the live sync is parked while a rehearsal is open. The
timing signature says the same thing: a slow first rejection (2s) followed by
two fast ones is load being shed upstream, not work being attempted and failing.

**The mitigation is therefore the right one, and is left alone.** The whole
sequence took 4.1s against a 6s budget, so the bounding behaved exactly as
designed; 503 is already retryable, so all three attempts were made. What the
retry could not do is outrun a colo event lasting seconds — its 300ms and 600ms
backoffs all landed inside the same bad window — and widening them is precisely
the lockout this lane just removed. The correct outer retry is the human one:
**Try again**, paced by a person's reaction time, which is what recovered it.

One thing to know before asking for more: those ray ids cannot be looked up
after the fact. `wrangler tail` streams live only, and nothing here has Logpush.
Even with it, a request rejected at the edge never reached the Worker, so a
Worker log would have nothing to show — the evidence would have to come from
Cloudflare's own HTTP request logs.

### What is recorded when it fails

`apiResponse.ts` reports every failure to `console.warn`, which on an iPhone is
a place nobody can look — which is why the first report of this took a day of
inference to narrow and still could not name a cause. So the screen keeps its
own record: per lost attempt, how long it took, the status, whether it was a
timeout, and **Cloudflare's `cf-ray`**, which is what makes an edge failure
findable at all.

The last three are printed under the banner. All of them ride along with
`Copy support snapshot`, as `lostAttempts` beside the server's own capture —
beside rather than inside, because they are facts about trips the server never
saw, which is by definition true of the requests that did not arrive.

## The rehearsal's list is the Draft screen's list

The rows are `RecommendationRow` — the live screen's own component, imported
from `DraftScreen.tsx` rather than reimplemented — with the same expansion, the
same Insight, news and outlook card, the same score bands and level-score runs
from `withTierDividers`.

It was a simplified compact row with three numbers on it, and that was the
mistake: a reader practising on it was practising against a board they would not
be looking at on the day, which is the one thing this feature exists not to do.

Two differences, both deliberate:

  - **Tier dividers are off**, exactly as they are on the live screen's mixed
    board. A divider claims the market's next tier starts here, and a list with
    every position in it has no single position for that boundary to be about.
  - **The star's slot carries a `+`.** A star is "remind me later" and there is
    no later in a rehearsal — the reader is the one picking, now — so the slot
    takes the player instead. Same size, same position, same slot; see
    `PickControl`. The queue control is not rendered at all, because a mock
    cannot write to the queue and a control that would be refused twice is not
    a control.

`RecommendationRow` is exported rather than extracted into a module of its own,
and that is a judgement call rather than the end state: it reaches a dozen
helpers inside a 2,700-line file, and moving them on the morning of a real draft
would have risked the screen the owner actually needed working. The export is
what makes the reuse real today; the extraction is worth doing next.

## Tests

| File | What it proves |
|---|---|
| `tests/mockManager.test.ts` | the blend: ADP anchors, history nudges only with a sample, the draw is the only randomness |
| `tests/mockDraft.test.ts` | the snake, turn-taking, determinism, the deletion rule, per-draft scoping |
| `tests/mock.isolation.test.ts` | both refusals, mutation-tested; the seam is structural |
| `tests/mock.board.test.ts` | end to end over the real router: the board is real, the real draft is untouched, the 409, the snapshot round-trip |
| `tests/liveRoster.test.ts` | `fillSlotRows`: the team sheet cannot disagree with the header strip |
| `tests/mock.board.test.ts` | also: the rehearsal's roster slots are the league's own and the real board's, and the position chips narrow without moving a score or a tier |
| `tests/draft.filledPosition.test.ts` | the structure ceiling for a position that can no longer reach the lineup |
| `e2e/mock-draft.spec.ts` | the menu's shape and the nav height, the setup step and the seat, the team sheet, the position chips, the draft order's striping, the double-tap guard, the retry and the recovery, and that no write leaves the browser while one is open |

## Deliberately not built

- **A history of past mock runs.** One active mock per draft; see §3.
- **A "draft this player" control on the real board.** Unchanged: the tool
  recommends only, and never touches Sleeper.
- **Any change to tally, ingestion, Data Health or the real Draft's ranking.**
  This lane is additive.
