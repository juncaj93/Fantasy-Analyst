# Manager intelligence: learning a league's history without paying for it

A league with returning managers knows something no market prior can. Not "what
do drafters do with the sixty-first pick" but "what does *this* man do with it";
not "waivers go for about ten dollars" but "the two people who need this back
have both spent thirty on a back before, and one of them still has budget in
November".

Sleeper publishes all of it — every completed draft, every transaction, for
every season a league has ever played. The problem was never access. It was
cost.

---

## The failure this exists to fix

The previous implementation, `LeagueStrategyService.refreshProfiles`, walked the
previous-league chain on **every call**:

| per season | requests |
| --- | --- |
| `GET /league/<id>` | 1 |
| `GET /league/<id>/rosters` | 1 |
| `GET /league/<id>/transactions/<week>` × 18 | 18 |
| `GET /league/<id>/drafts` | 1 |
| `GET /draft/<id>/picks` | ~1 |
| | **~22** |

Three seasons deep, that is about **66 subrequests in one Worker invocation**
against a free plan that allows **50**. It failed in production. And even when
it had not, it would have re-read three seasons of history that can never change
again, every week, for ever.

Neither a paid plan nor a shorter history is the answer. The answer is that a
finished draft and a finished week are **immutable**, so they are worth fetching
exactly once.

---

## Shape

```
                    ┌───────────────────────────────────────────┐
   Sleeper ────────▶│  advance()   bounded, checkpointed, daily  │
                    └───────────────────┬───────────────────────┘
                                        │ writes objective facts
                                        ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  THE LEDGER — raw, immutable, never re-fetched once complete      │
   │  manager_draft_picks · league_transactions · manager_history_*    │
   └───────────────────┬──────────────────────────────────────────────┘
                       │ derive()  — no network, ever
                       ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  PROFILES — keyed by Sleeper user id, versioned, rebuildable      │
   │  manager_intel_profiles · league_intel_baselines                  │
   └──────┬──────────────────┬──────────────────────┬─────────────────┘
          │ draft            │ trade                │ transaction
          ▼                  ▼                      ▼
      Next% only      plausibility /          competition pressure,
      (±5pp)          shape / ordering        expected-cost context,
                      (±5% tiebreak)          urgency  (cost ±25%)
```

The split between the top half and the bottom half is the whole architecture.
Fetching and computing are different jobs on different clocks: a tendency model
can be rewritten, re-tuned or version-bumped and it costs a recomputation rather
than a re-read of four seasons.

---

## The request budget

`core/sleeper/budget.ts`. One budget for the **whole 09:00 invocation** —
`MAX_CRON_SUBREQUESTS = 48`, against a free-plan ceiling of 50 — and the
backfill takes an allowance out of it rather than holding a budget of its own.

That distinction is the repair. The batch was bounded to 24 from the day it was
written and it was never enough, because Cloudflare counts subrequests per
*invocation* and 24 covered one subsystem inside one. The same tick syncs the
player dictionary, last season's statistics, the injury report, per-game usage,
the season market, the schedule, the trending list, the calibration ledger, the
published projections and three nflverse files. Measured against a fixture with
a four-week calibration backlog and an active backfill:

| morning | before | after |
| --- | --- | --- |
| healthy | 47 | 47 |
| Sleeper answering 500 | **60** | 48 |
| player dictionary itself failing | tick abandoned at request 3 | 48 |

Sixty is ten past the ceiling, and the batch's own counter read a comfortable
24/24 throughout.

**Counted at the transport, not at the call.** `SleeperClient` retries a 5xx
twice, so one logical `getTransactions` can be three real subrequests, and a bad
afternoon at Sleeper is exactly when a call-level counter would read comfortably
low while the invocation sailed past the ceiling. The budget therefore wraps
`fetch` itself and refuses *before* the request goes out, which makes the limit
an invariant rather than a measurement — `used` cannot exceed `limit`, so the
test asserting it is asserting something the code cannot violate.

**And redirects are counted too.** Every nflverse file is a GitHub release
asset, and `github.com/nflverse/nflverse-data/releases/download/...` answers 302
with a signed `release-assets.githubusercontent.com` URL that `fetch` follows
itself — before the conditional validator is considered, so a 304 costs two as
well. Seven nflverse-family reads on this tick are fourteen subrequests, not
seven, which is most of the headroom this budget exists to protect. Those
transports are charged `REDIRECTING_FETCH_COST`; Sleeper does not redirect and
is charged one.

**The backfill is last, and takes what is left.** Everything above it feeds a
surface somebody is looking at today; this feeds a signal measured in seasons.
Its allowance is `min(24, budget.remaining)` — the full batch on a healthy
morning, eight on a bad one — and zero means skipped, not failed. Running out
mid-backfill is the expected steady state of the first few days:
`BudgetExhaustedError` is caught, the checkpoint stays where it was, and
tomorrow's run picks up the same unit.

One log line per tick says what it cost:

```
cron 09:00 subrequests 47/48 (ceiling 50, 1 unspent); manager intelligence: allowance 24, used 24 (allowance bound)
```

`tests/cron.subrequestBudget.test.ts` drives the real `scheduled()` handler over
a real database and asserts the total, that the budget's count *equals* the wire
count (which is what proves no path fetches unmetered), and that the backfill
yields before any feed above it does.

---

## How far back history goes

`MAX_HISTORY_SEASONS = 4` in `core/managers/backfillPlan.ts`: the newest four
seasons, **counting the current season as the first**, rolling forward with it.

The number comes from the weighting rather than from taste. Trade and
transaction profiles weight a season at `SEASON_DECAY ** age` with
`SEASON_DECAY = 0.6`, so the four in policy carry 1, 0.6, 0.36 and 0.216 — and a
fifth would arrive at 0.13, an eighth of a vote, in exchange for a season's
worth of drafts and eighteen transaction weeks. A league founded in 2016 is ten
chain links and a fortnight of daily batches deep for signal in that range.

The filter is applied once, to the season list, so no dataset is exempt: a
season outside the window yields no identity read, no draft index, no picks and
no transaction week. It governs **fetching only** — seasons already in the
ledger stay there and stay readable, and there are no exceptions by league name
or age.

`MAX_CHAIN_DEPTH = 20` stays, and is not a duplicate of this. It is a cycle
guard, and the argument that the policy stops the walk rests on each chain link
being a year older than the last — which is exactly what a cycle in Sleeper's
data does not do.

---

## Work units, and why they are one request each

`core/managers/backfillPlan.ts` is pure: state in, an ordered list out.

| unit | request | produces |
| --- | --- | --- |
| `discover` | `GET /league/<id>` | the season, its status, the previous-league link |
| `identity` | `GET /league/<id>/rosters` | that season's roster id → Sleeper user id |
| `draft-index` | `GET /league/<id>/drafts` | which drafts exist and which finished |
| `draft-picks` | `GET /draft/<id>/picks` | one completed draft's picks |
| `transactions` | `GET /league/<id>/transactions/<wk>` | one week |

Every unit is sized so that finishing it is worth checkpointing and abandoning it
costs at most one request. There is no unit that spends three and is useless
after two.

**Priority.** Two rules decide the order:

1. **Draft history first, across every season, before any transaction week.**
   Two requests buys a whole season's draft, and draft tendencies are the one
   consumer that must not wait for a backfill measured in days.
2. **Then newest history before oldest.** Current season, most recent completed,
   then back. A partial backfill should describe the league as it is now.

Identity always precedes the facts it identifies: a season's picks and
transactions are roster-shaped, and a roster id is meaningless without that
season's own roster map.

---

## Identity

**A manager is a Sleeper user id. Never a roster id.**

In the league this was built against, roster 4 was Anthonyberardo in 2024,
Tupaz11 in 2025, and a manager who had never drafted here at all in 2026. Keying
history on the slot handed the newcomer a confident thirty-two-pick profile
assembled from two strangers.

So identity is resolved **at ingest**, against the roster map of *the season the
event happened in*, and the resolved user id is what gets stored. A resolution
that fails stores null, and every derivation skips a null rather than guessing.
Unknown stays unknown.

The rebuild also repairs this for the roster-keyed profile cache the existing
screens read: `ledgerTradeEvents` re-keys historical trades to the roster each
manager holds *today*, so a manager who moved seats keeps his trades and a seat
that changed hands does not pass any along.

---

## What is never fetched twice

- A **completed draft** — `complete = 1` and `picks_ingested > 0` is a one-way
  door.
- A **settled week** — every week of a finished season, and every week strictly
  before the current one in a live season. The week in play is re-read each
  batch, because a waiver run lands between two of them.
- A **resolved chain link** — including one that came back 404, which is
  recorded as `status = 'unavailable'` and ends the walk instead of retrying for
  ever.

Steady state for a three-season league is **two requests a day**: the live
draft's index, and the week still in play. Measured, not estimated —
`tests/managerIntel.backfill.test.ts` asserts it.

---

## Failure and resume

- Objective writes are idempotent. A pick is `(draft_id, pick_no)`; a
  transaction is `(league_id, transaction_id)` with `DO UPDATE`, so a pending
  claim that later completes corrects itself rather than freezing.
- The checkpoint advances **after** the write it vouches for. A crash in between
  repeats one idempotent write.
- `recordFailure` cannot write `cursor` or `completed`. That is why one failed
  week cannot corrupt the weeks around it — not care, construction.
- `completed` is `MAX(old, new)` within a version, so a dataset that has run out
  of work does not un-finish because a later batch looked again.

---

## Shrinkage

Behaviour history is sparse. Every reading is pulled toward the room by
`n / (n + k)` **at the point of measurement**, so the stored number is already
the honest one and no consumer has to remember to discount it.

| domain | k | floor |
| --- | --- | --- |
| draft timing | 1.5 drafts, plus spread ÷ 3 | 12 picks, 1 draft |
| transaction rates | 6 active weeks | 4 weeks and 6 transactions |
| FAAB spending | 4 bids | — (degrades, never cliffs) |
| position-specific | — | 3 adds, below which withheld entirely |
| trades | bands at 1 / 3 / 6 | 0 = unknown |

Everything is expressed **relative to the room**, bounded to ±40%. A league where
the median winning bid is $28 and one where it is $1 are both normal, and a
manager who bids $12 is unremarkable in one and reckless in the other. An
aggressive room must not make all twelve of its managers look individually
aggressive.

A note on two confidences: `confidence` measures the *rate* readings, whose
denominator is active weeks; `spendConfidence` measures the *spending* readings,
whose denominator is bids. They come apart constantly — a manager can be watched
all season and place two claims — and weighting a spending reading by the former
gives his two bids the same say as another manager's forty.

---

## The three contracts

### Draft → `Next%` only

`core/draft/nextpick/managerPrior.ts`, unchanged by this work except in what
feeds it. `MANAGER_PRIOR.gain = 0.4`, per-manager per-position multiplier bounded
to 0.87–1.15, total effect on `Next%` clamped to **±5 percentage points**
(`MANAGER_HISTORY_CEILING`). Measured movement in a real league is around 0.3pp;
the cap is a guard rail placed above observed behaviour, not a target.

It cannot reach `Score`, `ADP`, `DOG`, `PTS`, tier or board order, because none
of those read the demand table it contributes to. `tests/managerTendencies.test.ts`
pins all five byte-identical.

History is also suppressed by *today*: a manager who has taken quarterbacks early
for three years and already holds two this afternoon is not a quarterback risk
this afternoon.

### Trade → plausibility, partner, offer shape

`core/managers/tradeTendencies.ts`. Four outputs and no fifth:

- `plausibility` — `Plausible` / `Possible` / `Thin history` / `Rare trader`;
- `suggestedShape` — one-for-one, package, depth-for-starter;
- `explanation` — one neutral sentence assembled from counts;
- `orderingWeight` — a tiebreak in **[-0.05, 0.05]**.

There is deliberately **no acceptance probability**, and there cannot be:
Sleeper publishes completed trades and not declined offers, so that fraction has
no denominator and never will. The weight is bounded far below the resolution of
a fit score, which is how "behaviour cannot rescue a poor bilateral fit" is
enforced — not as a policy applied downstream, but because the number is too
small to do it.

`rare_trader` and `thin_history` are different claims: no trades in four seasons
is a finding, no trades in a first season is not.

**Smart Bilateral Trades reads the same profiles through a second, richer
reading** — `core/trades/managerFit.ts` — which adds the five-way activity
classification §10 of its brief requires, shrinkage toward the league's own rate,
and a contribution capped at **±0.08**. It is a *consumer* of these tendencies,
not a second derivation: nothing there fetches, and nothing there can change what
`buildTradeTendencies` computed. See [`SMART_TRADES.md`](SMART_TRADES.md).

The distinction that reading turns on is one no single table answers — *has this
manager been measured?* — and it is resolved by crossing the ledger's roster
identities against its transaction checkpoints. A season counts as observed only
when its walk is checkpointed complete, which never happens for a live season.

### Transaction → competition, cost context, urgency

`core/waivers/managerPressure.ts`. `MAX_MANAGER_COST_EFFECT = 0.25`,
`MAX_MANAGER_URGENCY_EFFECT = 0.15`, and nothing is claimed at all below two
rivals with usable history.

**The cost context is its own field, beside the price and not inside it.**
`expected`, `recommended` and `doNotExceed` come back byte-identical with the
history on and off, and `tests/managerIntel.boundaries.test.ts` asserts exactly
that. A rival who spends heavily makes a claim expensive and contested; he does
not make the player better, and a model that let the two touch would be claiming
he does.

The factor is a **mean** of the rivals' spending relatives, weighted by bid
sample — not a maximum. One rival who bids big is one rival; the price of winning
is set by the field, and a maximum would let a single manager with an unusual
season price every claim in the league.

Late-season budget conservation is only read in the back half. Everybody has
money in week 2.

---

## Diagnostics

`GET /api/diagnostics/manager-intelligence` — seasons discovered and complete,
the chain link still unresolved, drafts ingested, weeks read/settled/missing,
every checkpoint with its cursor and last error, profile counts and median
samples, outstanding units, and the budget in force.

`scripts/probe-manager-intelligence.mjs` reads it against a deployment and, with
`--advance=N`, posts N bounded batches and prints progress after each — the only
honest way to answer "how many batches does this league need".

Silent staleness is the failure mode all of this exists to prevent: a backfill
that stopped two months ago and a league with genuinely no history produce
identical empty profiles.

---

## Fallback

Missing or partial history is an ordinary state, not an error.

| surface | with no history |
| --- | --- |
| Draft | baseline `Next%`, exactly as before this existed |
| Trades | bilateral fit alone; every partner reads `unknown` and contributes zero |
| Waivers | existing competition and cost logic, pressure reads `unknown` |

Unknown is allowed. Nothing here may fail a decision.

---

## The Waivers lane, which is not built

Preserved here because it is the third contract off this ledger and because the
principle it turns on is the same one that took two attempts to get right in
Trades. **Do not implement it from this section** — it is a roadmap, not a spec.

Future Waivers intelligence must treat **non-action as informative**. Some
managers make zero waiver moves; some are extremely frugal with FAAB; some
participate only occasionally; some are effectively inactive. Those are different
facts about different people, and a model that reads them all as "no data"
throws away the most useful thing the ledger holds about a quiet league.

It should distinguish:

- aggressive managers;
- selective managers who spend heavily when interested;
- active but frugal managers;
- passive managers;
- effectively inactive managers;
- unknown / insufficient history.

From participation propensity, positional interest, FAAB aggressiveness, roster
need, recency and **observed abstention**, it should estimate real competition,
claim and bid likelihood, expected clearing price, a recommended bid range,
urgency, and whether the user can safely wait.

**Unknown must never equal inactive.** The mechanism that makes that true in
Trades — crossing roster identities against completed transaction checkpoints, so
"we have not looked" is representable separately from "we looked and there was
nothing" — is available to Waivers unchanged, and is the part worth reusing.

---

## Non-goals, kept

No paid Cloudflare plan. No truncated history. No repeated fetching of completed
history. No roster id as identity. No fabricated historical ADP — Sleeper
publishes no price with a pick, `reachAvailability` says `no-historical-market`,
and today's ranking is never substituted. No fake trade acceptance rates. No
manager grades or dashboard. No runtime LLM. Additional infrastructure cost: **$0**.
