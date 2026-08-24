# Projection v2 — market-anchored usage model

**Phase 1. Nothing in this document is read by a recommendation.** The Team
screen, the Matchup simulation, the Draft board, the trade engine and the
Players ranking do not import `core/projection` or `core/nflverse`, and
`tests/projectionV2.boundary.test.ts` walks the dependency graph transitively to
prove it. Turning Projection v2 on is a code change with a diff somebody has to
read, not a flag somebody can flip.

> Vegas remains the anchor. nflverse adds bounded role/usage context and
> uncertainty.

---

## 1. The arithmetic, in one line

```
points = market components
       + estimates for components no market priced       (A · gap fill)
       + a capped adjustment for information newer
         than the market snapshot                        (C · fresh info)
```

There is no fourth term. Role stability, snap share, opponent quality, pace and
recent production are all present in the output — in the width, in the
confidence, in the reasons — and none of them is in the mean.

## 2. Sources implemented

| Source | Status | What it gives | Cost per check |
|---|---|---|---|
| Weekly player stats | already live (unchanged) | targets, carries, receptions, target share, air-yard share, yards, TDs | conditional GET, one week parsed |
| **Seasonal rosters** | **new** | `gsis_id` ↔ `sleeper_id` ↔ `pfr_id` ↔ `espn_id` | conditional GET, 926KiB |
| **Timestamped depth charts** | **new** | `pos_grp` / `pos_slot` / `pos_rank`, captured to the second | ranged GET of the first 768KiB of a 44MiB file |
| **PFR snap counts** | **new** | offensive snaps and snap share per player-game | conditional GET, 2.4MiB |
| nflfastR play-by-play | **not implemented** | red-zone and goal-line usage, QB scramble split | 98MiB — see §7 |
| ffverse crosswalk | not needed separately | the roster file *is* the deterministic crosswalk | — |
| nflverse current injuries | deliberately excluded | — | the existing injury pipeline is unchanged |
| NGS, participation/routes, FTN, PFR advanced | out of scope for v1 | — | — |

### The roster file is the keystone

It publishes `gsis_id`, `sleeper_id` and `pfr_id` on one row, which settles two
things that had been open:

1. **Sleeper's own GSIS ids are incomplete.** 16.5% of skill-position players on
   the live 2026 roster have no `gsis_id` in Sleeper's dictionary — rookies
   especially, which is exactly the population whose role is changing. The
   bridge `sleeper_id → gsis_id` fills that on an identifier join.
2. **`pfr_id` unlocks the snap counts.** `core/usage/nflverse.ts` recorded the
   earlier decision to reject them: "its only identifier is `pfr_player_id`, an
   id space this app has never seen", and a second fuzzy matcher for a second id
   space is what every brief here has ruled out. That objection was right and it
   is now spent. Measured over the full 2025 season, `pfr_id → gsis_id` resolves
   **6,955 of 6,981 regular-season skill-position snap rows — 99.6%** — with no
   name matching anywhere.

### Depth charts are read by range

The 2026 file is 44MiB, which no Workers invocation can download. It is written
**newest-first** (verified by probing the head, the midpoint and the 90% mark of
the live file) and one capture is ~3,300 rows and ~310KiB. The release asset
answers an explicit `bytes=0-N` range with `206`, returns byte-for-byte the same
`ETag` a `HEAD` does, and still answers `304` when `If-None-Match` is sent *with*
the range. So the ordinary tick costs a round trip and no bytes, and the tick
that isn't costs 768KiB instead of 44MiB.

Suffix ranges (`bytes=-N`) are answered `501 Unsupported client range`, which is
why nothing asks for the end of a file and why the newest-first ordering is what
makes this work at all.

**The guard.** A prefix read cannot tell a complete capture from a truncated one
by looking at the rows, and a truncated one reads as a club having released
everybody the read did not reach. So a capture is reported complete only once the
parser has seen the *next, older* timestamp begin, and it refuses outright if it
ever finds a newer timestamp below an older one.

## 3. Identity coverage

The ladder, and it never widens:

1. the player's own stored `gsis` external id, from Sleeper — `sleeper_direct`;
2. the roster crosswalk keyed on `sleeper_id` — `roster_bridge`;
3. `unresolved`.

There is no name step. `core/identity` has a careful matching ladder for the
places a name is all there is, and every one of those callers sends ambiguity to
review. A projection is not a review queue: a player projected through the wrong
body is not a smaller error than a player with no projection, it is a much larger
and much quieter one.

Measured on the live 2026 roster, at the four carried positions:

| | n | share |
|---|---|---|
| roster rows | 915 | — |
| with `gsis_id` | 915 | 100% |
| with `sleeper_id` | 764 | 83.5% |
| with `pfr_id` | 748 | 81.7% |

## 4. Feature classification (A/B/C/D)

Declared in `core/projection/classification.ts` and **called by the engine** —
`mayMoveMean` refuses any key not registered as A or C, so a feature cannot reach
the mean by being wired in and forgotten.

### A · market-gap filler — may move the mean, for an unpriced component only

`fill.receptions` · `fill.receiving_yards` · `fill.rush_yards` ·
`fill.pass_yards` · `fill.touchdowns`

All five use `core/xfp/model.ts`'s published rates unchanged, including the
depth-of-target adjustment. No second set of constants.

### B · uncertainty modifier — may move the width and the confidence, never the mean

`uncertainty.snap_share_stability` · `uncertainty.target_share_stability` ·
`uncertainty.carry_share_stability` · `uncertainty.sample_size` ·
`uncertainty.market_coverage` · `uncertainty.td_dependence` ·
`uncertainty.freshness` · `uncertainty.identity` · `uncertainty.injury` ·
`uncertainty.historical_injury` · `uncertainty.depth_role`

This is where most usage data belongs and it is the least intuitive part of the
design. Knowing a receiver's role is stable does not say the market is wrong
about him; it says its number has less to go wrong with it.

`uncertainty.depth_role` is asymmetric on purpose. §15 names the case: *never
narrow uncertainty just because a player is listed first on a depth chart.*
Being listed outside the spots his club fields widens; being listed inside them
does nothing.

### C · fresh information — may move the mean, hard-capped

`fresh.role_change`, and it is gated three ways: corroborated beyond the depth
chart, carrying a capture time, and that time after the market snapshot.

### D · market-redundant — may move nothing, ever

`redundant.opponent_rank` · `redundant.game_environment` ·
`redundant.efficiency` · `redundant.production`

## 5. Market anchor and gap fill

The anchor works on `VegasExpectation.contributions` — the per-market breakdown
`core/startsit/expectation.ts` already produces — rather than on its total. That
is structural, not stylistic: §19 asks that only the missing component be
estimated, and no blend of two totals can satisfy that, however carefully it is
weighted, because a blend moves the covered components too.

| Coverage | `basis` | Behaviour |
|---|---|---|
| every expected market priced | `market` | the market's own components, untouched |
| some priced | `market_plus_model` | priced components byte-identical; missing ones estimated and documented |
| none priced | `model` | usage estimate, flagged `modelDerived` |
| none priced and no usable usage | `none` | `points: null` — never a zero |

Anytime-touchdown is filled as a **probability**, not a count: expected scores
per game through `1 − e^−λ`, bounded above by 1 by construction. Handing
`buildExpectation`'s TD slot an expected count would overstate every high-volume
back.

## 6. Fresh-information cap

```
FRESH_INFORMATION_CAP = { points: 1.5, shareOfAnchor: 0.10 }
```

Both bind and the smaller wins. A flat cap alone is wrong because 1.5 points is
7% of a starting quarterback and 37% of a streaming tight end; a proportional cap
alone is wrong because 10% of a 30-point projection is three points of movement
out of a depth chart.

**A depth-only change moves the mean by zero.** Not a little — zero. An nflverse
depth chart is a scrape of a club's published two-deep, and clubs publish those
to satisfy a league requirement rather than to describe how they intend to use
anybody. The live 2026 Arizona chart has a rookie back listed first and James
Conner third. Treating that as evidence the market has mispriced Conner would be
treating a form-filling exercise as information the betting market missed.

Corroboration comes from something that measures behaviour: snap share moving
the same way by at least ten points of share, or a player who was ranked above
him no longer being active on the roster.

## 7. What is not built, and why

**Red-zone and goal-line usage.** Those splits exist only in nflfastR
play-by-play, whose 2025 season file is **98MiB** (`Content-Length:
97,951,481`). A Workers invocation gets 10ms of CPU; the 8.3MiB weekly-stats
file costs 4ms to read one week out of. No ranged read helps, because red-zone
usage is a season-long aggregate rather than a block at one end of the file.

This is the largest gap in Projection v2 and it is worth being concrete about
what it costs: a goal-line back and a back with the same carries between the
twenties come out of the touchdown fill identically. `core/xfp/model.ts` already
states the same limitation in the app's own voice and this inherits it.

**The QB scramble / designed-rush split** is unavailable for the same reason —
it needs the play's own `qb_scramble` flag. The total is carried and the split is
flagged missing rather than estimated.

## 8. Uncertainty, floor and ceiling

A **mixture**: a bust branch at approximately zero with probability
`bustRate`, and a lognormal for the rest, combined so the mixture's mean is
exactly the projection. Floor, median and ceiling are the 10th, 50th and 90th
percentiles of that mixture, computed exactly rather than sampled.

### How the parameters were arrived at, including two wrong turns

**Attempt one** borrowed `POSITION_VOLATILITY` from
`core/matchup/distribution.ts`. Its nominal 10–90 interval contained the outcome
**43%** of the time across 3,938 player-weeks of 2025. That table is not wrong;
it answers a different question — what is *left* of a game already under way,
truth banked and correlations applied — and a whole week from Tuesday is a
strictly larger unknown.

**Attempt two** widened to the empirical spread of `actual / projected`.
Coverage rose to **69%** and stopped, and the residual was not noise: outcomes
fell below the floor twice as often as above the ceiling — 23.8% under for
receivers against 12.7% over. Widening further did not fix it, which is the
signature of a wrong shape rather than a wrong parameter.

**What was actually wrong.** A lognormal cannot reach zero and a fantasy week
can. Among players projected three points or more in 2025, the share of weeks
scoring under 15% of the projection was **QB 0.9%, RB 7.8%, WR 10.5%, TE 7.8%**
— inactive by kickoff, out in the first quarter, or simply never thrown to. No
continuous unimodal shape puts a tenth of its mass on top of zero. Separating the
bust branch gives the lognormal a job it can do, and the conditional spread it
then needs is close to the original guess: QB 0.42, RB 0.70, WR 0.75, TE 0.74.

The shipped table is those figures divided by the mean widening factor the
B-class modifiers actually apply (0.87–0.90), so a *typical* player comes out at
the measured dispersion rather than 13% below it.

**The consequence, stated rather than tuned away: a receiver's honest tenth
percentile is zero.** More than one receiver week in ten is a bust. A floor that
looked more comfortable would be a floor he falls below one week in nine.

### What is still wrong

A grid search over the same season wanted a base coefficient of variation of
about **1.55** for backs, receivers and tight ends — roughly twice the measured
dispersion, pressed against the top of the search range. That was not adopted.
It would have been absorbing two things that are not width: a lognormal has
thinner tails than real scoring even after the bust branch is removed, and the
anchor itself is biased for some positions (conditional on not busting, tight
ends outscored their projection by 13%). Widening a distribution to cover
somebody else's bias is not calibration.

So the measured numbers are what shipped, and the residual is reported: **the
interval runs a little tight in the upper tail, most visibly at tight end.**

## 9. Confidence

About data quality and coverage, never about the player. `confidenceFor` is
deliberately not handed the projection.

| Contributor | Max |
|---|---|
| market coverage | 40 |
| usage sample size | 25 |
| freshness | 15 |
| identity certainty | 10 |
| role settledness | 10 |
| unsettled availability | −10 |
| each missing expected input | −5 |

`high ≥ 70`, `medium ≥ 45`, otherwise `low`.

## 10. Backtest results — 2025, weeks 6–18, full PPR, 3,938 player-weeks

`scripts/projection-v2-backtest.mjs`. It imports the same `core` modules the
Worker runs.

**What could not be measured.** This app has no betting-market history: props are
cached for the current week, the provider is on the mock adapter by default, and
no vendor publishes free historical player props. "What did the market say about
Chris Olave in week 9 of 2025" is unanswerable, so there is no market-anchor
error figure here and any number claiming to be one would be invented.

What is available is **Rotowire's published weekly projection**, through Sleeper,
for every week of 2025. It is used two ways and labelled differently in each: as
the fallback baseline, which is what it is in the app today, and as a **proxy
anchor** — its component lines fed through the same `buildAnchor` a market's
contributions go through. A proxy anchor is not a market.

### Error against what actually happened

| Regime | MAE | RMSE | vs Rotowire |
|---|---|---|---|
| every component priced | 4.27 | 5.96 | −0.08 |
| receptions line missing (filled from usage) | 4.26 | 5.98 | −0.09 |
| yards only (receptions + TD filled) | 4.25 | 6.01 | −0.10 |
| **nothing priced — usage model alone** | **4.54** | 6.36 | +0.20 |
| Rotowire (the app's fallback) | 4.35 | 6.01 | 0.00 |
| trailing 3-game average | 4.84 | 6.81 | +0.49 |

### Does a full anchor survive v2 untouched?

**0 of 3,938 player-weeks moved at all.** The fresh-information gate needs a
market timestamp, which no historical props snapshot exists to supply, so it
cannot open in this backtest — the structural claim is proven separately by
`tests/projectionV2.model.test.ts`.

### Calibration, full coverage

| Confidence | n | below floor | inside | above ceiling | scaled error |
|---|---|---|---|---|---|
| high | 3,486 | 9.4% | 76.1% | 14.5% | 0.68 |
| medium | 452 | 2.4% | 73.0% | 24.6% | 0.94 |

Nominal is 10 / 80 / 10. `scaled error` is `|v2 − actual| ÷ projection`: raw MAE
is scale-dependent, and a high-confidence player is usually a high-volume one, so
comparing raw MAE across tiers compares workloads rather than models.

**Confidence correlates with scaled error in both regimes** — 0.68 against 0.94
with full coverage, 0.69 against 0.85 with none.

By position, full coverage: QB 14.7 / 76.1 / 9.3, RB 15.9 / 69.5 / 14.7,
WR 0.1 / 85.9 / 14.1, TE 13.3 / 63.5 / 23.1.

### Largest disagreements

Every one of the ten largest gaps in the no-market regime is a **backup
quarterback pressed into a start** — Tanner McKee threw 40 passes in week 18
after 0, 3 and 0 in his prior appearances. The usage model correctly has almost
nothing to go on and correctly marks all ten `low` confidence. This is the
honest limit of a usage model without a market, not a defect in it.

## 11. Failure behaviour

Every nflverse input is optional. With the crosswalk, the snaps and the depth
charts all absent — the true state of the world in August, when
`snap_counts_2026.csv` is a 404 — Projection v2 returns exactly the market
expectation, with the confidence lowered and the reason recorded. **Market-only
is a valid answer, not a degraded one.** With no market and no usage it returns
`null`, never zero.

## 12. Storage and cadence

Migration `0030`. Three tables plus the source-health trio the injury and usage
pipelines already have the shape of.

- `nflverse_identity` — one row per player per season, ~900 rows.
- `player_snap_weeks` — one row per player per game.
- `depth_chart_entries` — **the two newest captures only**. The published file
  holds 554,216 rows for 2025; change detection compares now against last, and a
  chart from October is not evidence about this week.

Cadence: all three on the existing daily 09:00 UTC cron, after the player
dictionary and after the usage refresh, roster first because the snap join reads
the crosswalk it writes. Shared daily write ceiling of 6,000 rows, its own
budget table so neither this nor the usage pipeline can spend the other's
allowance.

## 13. Diagnostics

- `GET /api/diagnostics/projection-v2` — the side-by-side report. Public read,
  writes nothing, and says `authoritative: false` in its own payload.
- `GET /api/diagnostics/nflverse` — what the three feeds hold and how fresh.
- `POST /api/nflverse/refresh` — on-demand ingest. A write, so it needs the
  passphrase.

## 14. Open items before any rollout

1. **One real season with the props feed enabled.** Whether betting markets are
   sharper than Rotowire is the question this backtest structurally cannot
   answer, and it is the question the whole design rests on.
2. **A second season of calibration.** Every constant in §8 is fitted on 2025
   alone. §22 says not to overfit to one season and this is the corresponding
   risk.
3. **The upper tail**, most visibly at tight end.
4. **Red-zone usage**, if a path to it inside the CPU budget is ever found.
5. **The fresh-information path has never fired against a real market
   timestamp.** It is unit-tested in both directions and has no field evidence.
