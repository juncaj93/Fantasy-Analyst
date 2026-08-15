# League intelligence: what this league does, and what it costs

Everything here is arithmetic over one source: the transaction history Sleeper
publishes for the league you selected, walked back through as many seasons as
the league has. No external FAAB dataset, no scraped depth chart, no private
endpoint.

Every estimate obeys the same four rules the rest of the app obeys — bounded,
explainable, decomposed, honest about not knowing — plus one more that only
applies here:

> **A manager profile is a modifier, never a verdict.** Nothing about a person
> may produce a recommendation on its own, and the largest effect any profile
> can have on a price is ±25%.

---

## What Sleeper actually publishes

Checked against a live public league before any of this was written
(`scripts/probe-sleeper-transactions.mjs`; a real ten-team 2025 league):

```
GET /league/<id>/transactions/<week>
week  1       113  {"waiver/complete":20,"waiver/failed":16,"free_agent/complete":72,"trade/complete":5}
week  2        13  {"waiver/complete":4,"waiver/failed":8,"free_agent/complete":1}
week  3        16  {"waiver/failed":9,"waiver/complete":6,"free_agent/complete":1}

priced claims 63 (30 winning)
winning bids  [0 ×20, 1, 1, 2, 3, 3, 4, 6, 18, 21, 25]
```

Four facts came out of that, and each one shaped a table or a rule:

**Failed claims are returned, with their bids.** Sixteen of the thirty-six
waiver claims in week 1 lost. Those losing bids are the only published evidence
of what the *rest* of the league was willing to pay, so they are stored and
labelled rather than filtered out. A model trained on winners alone learns that
every player costs exactly what the winner paid.

**A missing bid is not a zero bid.** `settings.waiver_bid` is present on waivers
and absent on free-agent adds. `?? 0` would fold seventy-two free adds into the
price distribution as $0 claims and drag every estimate to a dollar. See
`readWaiverBid` in `core/league/transactions.ts`, and the test that pins it.

**Remaining FAAB is a subtraction, and both halves can be missing.** Rosters
report `settings.waiver_budget_used`; the league reports
`settings.waiver_budget`. Remaining stays `null` when either is absent rather
than defaulting to a full wallet — a manager who looks rich when he is broke is
the one error that would make the app talk you into overbidding.

**There is no FAAB recommendation endpoint.** The league settings do carry a
`faab_suggestions` flag (0/1), which is what prompted the question. It toggles a
feature inside Sleeper's own app. No documented endpoint returns a suggested
bid, and nothing here goes looking for an undocumented one. The estimates below
are built from the league's own history instead.

---

## The season chain

A league that has run for four years is four Sleeper league ids, linked by
`previous_league_id`. `LeagueHistoryService` walks that chain (bounded to four
seasons and guarded against a league that points at itself), and stores it in
`league_lineage` with **each season's own budget**, because a $40 bid means
something different in a $100 league and a $200 one.

Managers are joined across seasons by **Sleeper user id**, never by roster id.
Roster ids are seats, and the seats get reshuffled; joining on them would
attribute one manager's record to another. `league_managers` records who sat
where, per season.

---

## Manager profiles — `core/league/managers.ts`

Ten tendencies, each with the sample it rests on and a threshold below which it
reports `unknown` rather than a number:

| Tendency | Threshold | Built from |
| --- | --- | --- |
| FAAB aggression | 4 bids | bid ÷ that season's budget |
| Top bid | 4 bids | the largest single share observed |
| Bid share by position | 3 bids at the position | position of the primary add |
| Claim win rate | 4 bids | complete ÷ (complete + failed) |
| Waiver churn | 4 active weeks | adds per week with any activity |
| Trades per season | 2 trades | completed trades ÷ seasons |
| Files the trade | 2 trades | `creator` matches their user id |
| QB/TE spend | 4 won bids | dollars, not claims |
| Rookie lean | 4 adds with experience known | `years_exp ≤ 1` |
| RB depth | 8 roster slots | share of the current roster at RB |

**The current season outranks the record when they disagree.** With enough bids
in both, and a gap of at least a fifth of a budget between them, this season is
used alone and `contradictsHistory` is set so the explanation can say so.
Managers change how they play, and a profile that cannot notice gets the season
after a strategy change exactly wrong.

**The threshold counts observations, not weighted copies.** Recency weighting
repeats this season's bids in the array the mean is taken over. Testing the
*weighted* array's length against the threshold would let three bids clear a
threshold of four — which is how a sample-size rule quietly stops existing. That
bug was written, and `tests/league.managers.test.ts` caught it.

---

## Expected FAAB cost — `core/league/faab.ts`

An empirical quantile lookup against the league's own winning bids, moved by
demand and bounded by real wallets. Output is always a range:

```
$8–12 expected
```

**Why quantiles.** The distribution above is `[0 ×20, 1, 1, 2, 3, 3, 4, 6, 18,
21, 25]`. Its mean is a number nobody bid; a regression on eleven points is a
straight line through noise. A quantile is always a price somebody in this
league actually paid.

**Demand** (0–1, `demandOf`) is player value ×0.55, plus needy teams ×0.25, plus
small terms for positional scarcity, starting this week and a role growing on
merit — and one negative term: a player who only has the job because somebody
is hurt is marked *down*, not up.

**Recency** is applied by repetition: this season's bids appear more often in
the array the quantile is taken over. Weights are 3 / 1.5 / 0.75.

**The wallet ceiling.** You cannot be outbid above what the deepest rival can
still spend. A league that has spent down to $3 cannot produce a $20 winning
bid, and the cap is reported as one of the named drivers.

**No history, no price.** Below six priced claims, or with no budget on record,
the estimate is `known: false` and says which. There is no fallback default,
because a made-up number with a plausible shape is the worst kind.

---

## Waiver competition — `core/league/competition.ts`

Competition is a property of the other eleven rosters, not of the player. For
the position in question:

1. count the teams whose *healthy* bodies do not cover their starting slots
   (`urgent`), or cover them with nothing spare (`thin`);
2. drop the ones who cannot afford the bottom of the expected range — but only
   when both a price and a wallet are actually known, because unknown means
   "cannot be ruled out", not "cannot afford it";
3. label what is left, with the brief's exact strings:

```
Low competition      0–1 likely bidders
Likely 2–3 bidders   2–3
High pressure        4+
```

Needs are counted honestly; only the *bidder list* is filtered by money, so the
card can say "four teams need one, three of them are broke".

---

## The waiver board — `core/league/waiverBoard.ts`

Six dimensions per row, each separately readable: `Priority`, `This week`,
`Next 4`, `Need fit`, `Expected cost`, `Competition`. Priority exists because a
list has to be in some order, and it is published as a list of named parts that
sum to it — a row can always be read as "third because he starts for me this
week and costs $4", never as "third".

**Horizon** answers *what is this add for*, which changes the advice completely:

| Horizon | Means |
| --- | --- |
| `direct_starter` | starts for you now and holds up |
| `multi_week_hold` | worth a roster spot for a month |
| `temporary_beneficiary` | has the job while somebody is hurt |
| `emergency_streamer` | this Sunday only |
| `stash` | upside, no immediate use |

An injury beneficiary is classified as one *even when he would start for you*,
because the return date is the fact that prices him — unless the absence has no
end in sight, in which case it is a job rather than a loan.

**Streaming** (`QB`, `TE`, `DEF`, `K`) is judged against the *actual pool* in
this league: if three or more free agents grade within 1.5 points of him, the
answer is to stream the position rather than bid against the league for one of
five interchangeable players.

---

## Bilateral trades — `core/league/tradeFit.ts`

Three scores, kept apart: **value to user**, **value to partner**, and
**plausibility**. Collapsing them into one grade is what makes trade tools
useless — the reader cannot tell a deal that helps them a lot and helps the
partner slightly from one that is even and pointless.

A deal is only listed when *both* sides gain. That is possible at all because
incoming players are worth more when they fill a hole (×1.35 urgent, ×1.15 thin)
and outgoing players cost less when they were the fourth of something (×0.7) —
a raw value subtraction can only ever produce zero-sum deals nobody makes.

Plausibility starts at 0.5 and moves on evidence only: trades often (+0.2),
fills their most urgent hole (+0.2), asks for the best player on their roster
(−0.25), no trade history on record (−0.1, reported as *untested rather than
unwilling*).

**Timing** labels come from opportunity and efficiency signals, and all true
calls are returned — including the unflattering one:

- `Buy before usage converts to points`
- `Buy after temporary box-score dip`
- `Sell before schedule turns`
- `Sell before injured starter returns`
- `Avoid buying TD-driven spike`

---

## The decision feed — `core/league/feed.ts`

One rule:

> Surface an item only when something actually changes a decision, a
> recommendation, a confidence tier, a rank materially, an injury contingency or
> a transaction priority.

Both halves are required — magnitude ≥ 0.2 **and** `changesDecision` — so a
player who moved from clearly-start to even-more-clearly-start produces nothing,
and neither does a refresh that found the same numbers.

Filtering happens **before** deduplication, deliberately: merging first would
let three immaterial reports of the same nothing combine into one item that then
looks corroborated. Three sources describing one injury share a `dedupeKey` and
become one event, with the others named as corroboration.

A situation that develops supersedes its own earlier row rather than
duplicating it, and an identical restatement changes nothing at all — which is
what makes reopening the app twice in a minute produce a still feed.

---

## Why did his rank move — `core/league/rankMove.ts`

```
#8 -> #4
+3 role
+2 vegas
-1 matchup
```

Two guarantees:

**The parts reconcile to the actual change.** If the component deltas do not sum
to the change in the total, `reconciles` is false and a residual line names the
unexplained amount. The parts are never quietly rescaled to add up — that
produces a card that always looks right and is sometimes a lie.

**A refresh that changed no input produces no movement.** Every snapshot carries
an FNV-1a hash of the inputs that produced it (canonical JSON, keys sorted), and
`RankDecompositionRepo.capture` refuses to store a snapshot whose hash matches
the last one kept. Without it, opening the app twice would manufacture a
movement story out of nothing.

---

## Bye and playoff planning — `core/league/planning.ts`

Both are defined by their restraint. Byes are reported only inside a four-week
lookahead and only when a slot is genuinely short — a planner that warns in week
1 about a week-9 cluster has told you something you cannot act on, and by week 8
you have stopped reading it.

Playoff weeks arrive on a ramp with two gates: the season must be a third old,
and the team must be plausibly heading there, measured against the share of the
league that qualifies. Before both, the weight is exactly 0, which is what keeps
a December schedule out of an August draft board.

---

## Interfaces

Stable server-side outputs. This workstream owns the payloads, not the layouts.

| Endpoint | For |
| --- | --- |
| `POST /api/leagues/:id/history/sync` | reading the league's transaction history |
| `GET /api/leagues/:id/managers` | manager profiles, wallets, limits |
| `GET /api/leagues/:id/waiver-board` | the Waivers page |
| `GET /api/leagues/:id/trade-fit` | the Trades page |
| `GET /api/leagues/:id/plan` | bye and playoff planning |
| `GET /api/leagues/:id/feed`, `POST .../feed/seen` | What Changed |

---

## What is not connected, and why

Three inputs are missing, and each reports itself rather than being faked:

1. **No four-week outlook.** A rest-of-season projection is the weekly engine's
   contract. `next4` reports `known: false` and contributes nothing to priority.
   The field exists and takes a value the moment one is published.
2. **No bye-week source.** Sleeper's player dictionary has 49 fields and none of
   them is a bye, and this app stores no NFL schedule. `/plan` returns no gaps
   and says which input is missing rather than reporting an all-clear.
3. **No expected-points model.** `Buy before usage converts to points` and `Buy
   after temporary box-score dip` need xFP; the touchdown-dependency and role
   signals the app already has drive the other three timing calls today.

One signal is available and deliberately unused: Sleeper publishes
`depth_chart_order` and `depth_chart_position`. They would sharpen the
injury-beneficiary detector considerably, and they belong to the role layer
rather than to this one — a second opinion about who the starter is, living in
the pricing code, is exactly the kind of duplicated judgement this app avoids.
