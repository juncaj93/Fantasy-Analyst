# League intelligence: the fields the waiver board left open

This is a narrow document on purpose. The league's transaction history, its
manager profiles and its FAAB pricing all have canonical homes already —
`core/faab/{bids,budget,strategy}.ts`, `core/managers/{draftProfile,tradeProfile}.ts`,
`server/repos/transactions.ts`, `server/services/leagueStrategyService.ts`. None
of it is reimplemented here.

What this pass owns is the part those modules declare and do not fill:

```ts
// core/waivers/board.ts
export interface WaiverLeagueIntel {
  faab?: { … } | null;        // filled by core/faab
  competition?: { … } | null; // ← this pass
  multiWeek?: { … } | null;   // ← this pass
  leagueRank?: number | null;
}
```

with a note on the interface saying exactly how to read an empty one:
*present-and-null is a pass that ran and found nothing; absent is a deployment
without the pass.* They shipped absent.

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

## Multi-week value — `core/league/beneficiary.ts`

The board asks how long an add is worth holding. The honest answer is the shelf
life of *the reason he is available*: a back-up with a two-week job and a back-up
with a season are the same player at wildly different prices.

The inference is deliberately narrow, because a wide one would be wrong most of
the time. The absent player must play the **same position for the same club**,
and must be **rostered in this league** — which is the closest available witness
that he was the starter, and is a fact rather than an opinion about a depth chart
the app does not have. Without the second condition, every fourth receiver on a
club with an injured fifth receiver would wear the label and the label would mean
nothing.

| Sleeper status | Reading |
| --- | --- |
| `Out`, `Doubtful` | week-to-week → `streamer`, reassess next week |
| IR, PUP, NFI, suspended | no published return → `multi_week`, he has the job |
| nobody absent, usage series exists | `season_long` |
| nobody absent, no usage series | `unknown` |

That last row is the one worth defending: "season long" inferred from nobody
being hurt is an inference from an absence, and the app does not make those.

---

## Trade fits — `core/league/tradeFit.ts`

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

Timing calls come from opportunity and efficiency signals, and every true call is
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

1. **No four-week outlook.** A rest-of-season projection is the weekly engine's
   contract. The waiver board's `next 4` column stays unknown until one exists.
2. **No bye-week source.** Sleeper's player dictionary has 49 fields and none of
   them is a bye — checked against the live payload — and this app stores no NFL
   schedule. `/plan` returns no gaps and names the missing input rather than
   reporting an all-clear it has not earned.
3. **No expected-points model.** Two of the five timing calls wait on xFP; the
   touchdown-dependency and role signals drive the other three today.

One signal is available and deliberately unused: Sleeper publishes
`depth_chart_order` and `depth_chart_position`. They would sharpen the
beneficiary detector, and they belong to the role layer rather than this one — a
second opinion about who the starter is, living in the pricing code, is the kind
of duplicated judgement this app avoids.
