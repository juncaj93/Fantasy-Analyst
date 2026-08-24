# League intelligence: the fields the waiver board left open

This is a narrow document on purpose. The league's transaction history, its
manager profiles and its FAAB pricing all have canonical homes already —
`core/faab/{bids,budget,strategy}.ts`, `core/managers/{draftProfile,tradeProfile}.ts`,
`server/repos/transactions.ts`, `server/services/leagueStrategyService.ts`. None
of it is reimplemented here.

What this pass owns is the one part those modules declare and still do not
fill. Multi-week value had no supplier when this was written and now has one —
`core/value/multiWeek.ts`, via `waiverMultiWeekFor` — so it is no longer here:

```ts
// core/waivers/board.ts
export interface WaiverLeagueIntel {
  faab?: { … } | null;        // core/faab
  multiWeek?: { … } | null;   // core/value/multiWeek
  competition?: { … } | null; // ← this pass
  leagueRank?: number | null;
}
```

with a note on the interface saying exactly how to read an empty one:
*present-and-null is a pass that ran and found nothing; absent is a deployment
without the pass.* Competition shipped absent and stayed that way.

---

## Competition — `core/league/competition.ts`

`core/faab/strategy.ts` takes an input called `rivalsWithNeed`, documented as
"rosters that plausibly want him and can pay". The caller in `app.ts` supplied
every funded rival in the league, and said why:

> A blunt count on purpose: every other funded roster in the league. A finer one
> would need each rival's lineup scored against each candidate, which is twelve
> times the work for a number that feeds a 0–1 demand input.

That reasoning is correct about scoring and incorrect about the alternative.
Whether a roster **needs** a running back does not require scoring anybody: it
is a count of the healthy backs it holds against the back slots it has to fill.
One pass over rosters already in memory, no optimisation, no extra query.

So the count is now per position:

| Level | Meaning |
| --- | --- |
| `urgent` | healthy bodies at the position < dedicated starting slots |
| `thin` | exactly enough, and a flex slot could take another |
| `covered` | spare |

Availability is read through `normalizeDesignation` and `isRuledOut` from
`core/injury/model.ts` rather than against a list of status strings kept here,
so "ruled out" means one thing across the app.

Flex is eligibility, not a required slot. A team with two backs, two receivers
and one flex does not *need* a third back — it can *use* one, and collapsing
those makes every team in the league look desperate for everything.

**Affordability filters the bidder list, never the need count.** A team with an
urgent hole and $2 left is not a bidder; counting them as one is how a tool tells
you to spend $30 beating somebody who cannot spend $3. So the card can say *four
teams need one, three of them cannot afford the going rate*, which is two facts
rather than one number.

**An unknown budget keeps a manager in the list.** "Cannot be ruled out" is not
"cannot afford it", and a rival whose settings failed to sync must not silently
vanish from the people about to outbid you.

The bands speak the board's own vocabulary, and the level and the label are
produced together so a card can never show a label that disagrees with the level
it sorted on:

```
0 bidders   low       Nobody else needs him
1           low       Low competition
2–3         medium    Likely 2–3 bidders
4+          high      High pressure
```

The same count goes back into `rivalsWithNeed`, capped at 4 as before, falling
back to the league-wide figure when positional needs were not supplied.

---

## Named rivals — `core/league/bidders.ts`

Competition says *how many*. This says **which of them, and roughly how much**.

The card keeps one line: `Low competition · 3 likely bidders · Joe, Ryan +1`.
The expanded sheet lists them, one line each:

```
Joe · likely $17–22 · $41 left · needs RB2 · bids above the room
```

### The double-counting rule

The expected market price already exists and is computed by
`core/faab/strategy.ts`. Manager tendency reaches it through exactly one path —
`rivalsWithNeed`, a *count* normalised against the funded field. It carries no
magnitude: no manager's spending habit moves the market price, and nothing here
changes that.

So a named estimate is a **decomposition of the aggregate, never an addition to
it**. The market range is an input here and never an output; `expected`,
`recommended` and `doNotExceed` are untouched, and a test asserts the priced
output is identical with the named pass fed and starved. A manager's tendency
multiplies *his own* estimate and nothing else.

Backwards, the aggressive manager raises the market price, which raises his own
estimate, which is a number with no evidence under it.

### What a tendency is, and when there isn't one

The **median** bid as a share of budget, not the mean: a manager with nine $1
claims and one $60 splash has a habit of $1 claims, and the mean says $7, which
is a number he has never bid. Failed claims count — a losing bid is evidence
about the bidder even though it cost him nothing.

Below `MIN_BIDS_FOR_TENDENCY` he has a history, not a habit, and his estimate
falls back to the league's own range with the reason on the card. The fallback
**widens** the range rather than shifting it, because being less sure about
somebody is not the same as expecting him to bid more. His own effect is bounded
at ±`MAX_TENDENCY_EFFECT` however extreme the record.

### Three gates on an amount

1. the league must price at all — no market range, no estimate;
2. his own history moves the range, or does not exist and says so;
3. his wallet caps it, because he cannot bid money he does not have.

### When no name is shown

`namesShown: false` is a deliberate output rather than an empty list, so a screen
can tell *nobody is bidding* from *we are not confident enough to say who*. It
fires when nobody has a need, or when no rival can be told apart from any other —
no wallet and no bid history on any of them. A card saying *Joe will bid $17–22*
on two observations is worse than one saying *high pressure*.

The summary count always equals `competition.bidders.length`, because both come
from the same list. `High pressure · 1 likely bidder` is the kind of
self-contradiction that costs a feature its credibility.

---

## After the run — `core/league/waiverRun.ts`

The named card is a forecast; this is the settlement. Who won, at what price,
which losing bids were published, what it cost each wallet — and whether the
rivals this app named actually bid.

Only winning bids count against a wallet. A failed claim carries an amount and
costs nothing, and counting it would have every busy manager looking broke.

**The scorecard is deliberately asymmetric.** Sleeper publishes the user's own
failed claims reliably and other managers' inconsistently, so a rival who does
not appear may have bid unpublished. A positive sighting counts either way; an
absence is `unconfirmed` and only becomes `did_not_appear` when the losing side
is known to be complete. Marking an unpublished bid as a miss would be scoring
this app against a question the source declines to answer.

## Multi-week value — not here

Owned by `core/value/multiWeek.ts` and wired by `waiverMultiWeekFor`. An earlier
version of this workstream carried its own beneficiary detector and shelf-life
classifier; both were deleted when the intelligence layer landed with better
ones. The lesson is worth keeping: two passes filling the same declared field
would have produced a row whose two halves disagreed about the same player.

## Trade fits — `core/league/tradeFit.ts`

> **There are now two answers to "what should I offer whom", and they are not the
> same thing.** This one serves `/api/leagues/:id/trade-fit` and values a player
> by multiplying his score by a need factor. The one the Trades screen shows is
> **Smart Bilateral Trades** (`core/trades/bilateral.ts`), which values a package
> by running the lineup optimiser over both rosters and subtracting, keeps
> objective value and manager behaviour as separate outputs rather than folding
> behaviour into a plausibility score, and is bounded and explained per offer.
> See [`SMART_TRADES.md`](SMART_TRADES.md). This section describes the older
> endpoint, which is unchanged and still reachable.

`core/trades/ladder.ts` prices a negotiation once a deal exists — opening offer,
fair band, walk-away. Nothing chose the deal. This does: it enumerates
one-for-one and two-for-one deals against every partner and scores three things
**separately**.

- **value to user** — what it does for your starting lineup.
- **value to partner** — the same arithmetic from their side, using their roster
  and their holes.
- **plausibility** — whether this manager does deals like this.

Collapsing them into one grade is what makes trade tools useless: the reader
cannot tell a deal that helps them a lot and helps the partner slightly from one
that is even and pointless.

Both sides must gain or the idea is not listed. That is possible at all because
an incoming player is worth more to a roster with a hole (×1.35 urgent, ×1.15
thin) and an outgoing one costs less from a roster with four of him (×0.7) — a
raw value subtraction can only ever produce zero-sum deals nobody makes.

Plausibility reads the canonical `ManagerTradeProfile`, checking `confident`
before anything else on it, so it cannot disagree with the Trades ladder about
whether somebody trades. A manager with no record is marked *untested rather
than unwilling*, which is the honest version of the same caution.

Timing calls come from opportunity and efficiency signals — expected points via
`assessXfp`, off the usage weeks the route already loads — and every true call is
returned including the unflattering one:

`Buy before usage converts to points` · `Buy after temporary box-score dip` ·
`Sell before schedule turns` · `Sell before injured starter returns` ·
`Avoid buying TD-driven spike`

---

## Planning — `core/league/planning.ts`

Both halves are defined by their restraint.

Byes are reported only inside a four-week lookahead and only when a slot is
genuinely short. A planner that warns in week 1 about a week-9 cluster has told
you something you cannot act on, and by week 8 you have stopped reading it.

Playoff weeks arrive on a ramp with two gates and need both: the season must be a
third old, and the record must put the team plausibly in the race, measured
against the share of the league that qualifies. Before both, the weight is
exactly 0 — which is what keeps a December schedule out of an August board.

---

## The decision feed — `core/league/feed.ts`

> Surface an item only when something actually changes a decision, a
> recommendation, a confidence tier, a rank materially, an injury contingency or
> a transaction priority.

Both halves are required — magnitude ≥ 0.2 **and** `changesDecision` — so a
player who moved from clearly-start to even-more-clearly-start produces nothing,
and neither does a refresh that found the same numbers.

Filtering happens **before** deduplication, deliberately: merging first would let
three immaterial reports of the same nothing combine into one item that then
looks corroborated. Three sources describing one injury share a `dedupeKey` and
become one event, the others named as corroboration.

---

## Why did his rank move — `core/league/rankMove.ts`

```
#8 -> #4
+3 role
+2 vegas
-1 matchup
```

**The parts reconcile to the actual change.** When the component deltas do not
sum to the change in the total, `reconciles` is false and a residual line names
the unexplained amount. The parts are never quietly rescaled to add up — that
produces a card that always looks right and is sometimes a lie.

**A refresh that changed no input produces no movement.** Every snapshot carries
an FNV-1a hash of the inputs (canonical JSON, keys sorted), and
`RankDecompositionRepo.capture` refuses to store a snapshot whose hash matches
the last one kept, so there is nothing for the next read to compare against.

---

## Interfaces

| Endpoint | For |
| --- | --- |
| `GET /api/leagues/:id/waivers` | the Waivers page — `competition` and `multiWeek` on every candidate |
| `GET /api/leagues/:id/trade-fit` | deals worth proposing |
| `GET /api/leagues/:id/plan` | bye and playoff planning |
| `GET /api/leagues/:id/feed`, `POST .../feed/seen` | What Changed |

Transaction sync, manager profiles and FAAB pricing are reached through the
routes that already own them: `POST /api/leagues/:id/strategy/refresh`,
`POST /api/leagues/:id/managers/refresh`, `GET /api/leagues/:id/managers`.

---

## What is not connected, and why

1. **No bye-week source.** Sleeper's player dictionary has 49 fields and none of
   them is a bye — checked against the live payload — and this app stores no NFL
   schedule. `/plan` returns no gaps and names the missing input rather than
   reporting an all-clear it has not earned. The intelligence layer takes a
   `byeWeek` input for the same reason and has no supplier for it either.
2. **`Sell before schedule turns` has no schedule.** The other four timing calls
   rest on signals that exist; this one waits on the same missing input as the
   bye planner, and produces nothing rather than guessing.

One signal is available and deliberately unused here: Sleeper publishes
`depth_chart_order` and `depth_chart_position`. They belong to the role layer,
which is where `core/injury/beneficiaries.ts` now lives — a second opinion about
who the starter is, living in the pricing code, is the kind of duplicated
judgement this app avoids.
