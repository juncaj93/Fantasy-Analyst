# Vegas props

## Current state

`VEGAS_PROVIDER = "sportsgameodds"`. `SportsGameOddsProvider` is implemented and
tested **against the live API's real payloads**, captured by
`scripts/probe-sportsgameodds.mjs` and `scripts/probe-vegas-integrity.mjs`
running through the Probe workflow.

`MockVegasProvider` remains the default for anything with no key: it produces
stable, deterministic, obviously-synthetic lines and never touches the network,
so development and tests cost no quota.

### What was actually keeping this on mock

Two things, and neither was the provider's coverage:

1. **The Worker never had the key.** The repository secret existed — the probes
   authenticated with it — but `deploy.yml` published only `APP_PASSPHRASE`, so
   the Worker's `SPORTSGAMEODDS_API_KEY` was always undefined. Flipping the var
   alone would have produced a provider that reported itself unconfigured. The
   Deploy workflow now publishes it, on the same principle as the passphrase.
2. **Roster teams were being sent in the wrong vocabulary.** `rosterTeams()`
   collects Sleeper's codes (`SF`) and handed them straight to the provider's
   `teamID` filter, which only answers to its own (`SAN_FRANCISCO_49ERS_NFL`).
   Measured on 22 August 2026: `teamID=SF` returns `200` with an empty list;
   `teamID=SAN_FRANCISCO_49ERS_NFL` returns the fixtures. Every discovery
   request would have been billed an entity and answered with nothing, and
   every screen above would have shown what a bye week shows. `PROVIDER_TEAM_IDS`
   in the adapter now translates, from the provider's own `/v2/teams` rather
   than from a naming rule — thirty-one codes are identical and the Rams are
   not (`LAR` here, `LA` there).

`OddsApiProvider` (The Odds API) is implemented and tested against recorded
payload shapes, and remains the fallback. It is **not enabled**, because the
free tier's terms and NFL player-prop coverage could not be verified from this
environment — outbound requests to the vendor's domain are blocked by the
network egress policy here.

## What the live SportsGameOdds API actually returns

Established by probe, not by documentation. Each of these is a way an adapter
written from the docs would have failed silently:

- **Kickoff is `status.startsAt`.** There is no top-level `startTime`.
- **`event.players` is a directory** keyed by player id (`TONY_POLLARD_1_NFL`),
  carrying the full name the identity matcher needs.
- **Odds are an object keyed by an odd id** of the form
  `{statID}-{statEntityID}-{periodID}-{betTypeID}-{sideID}`, e.g.
  `rushing_yards-TONY_POLLARD_1_NFL-game-ou-over`. The same five fields are
  also present on the quote itself.
- **The line is `bookOverUnder` and the price is `bookOdds`**, both strings.
  `fairOverUnder` / `fairOdds` are the provider's own de-vigged view.
- **`byBookmaker` was empty on the free plan, and is not any more.** The August
  2026 probe of regular-season fixtures returned named books — `fanduel`,
  `draftkings`, `caesars` — on many quotes. The adapter still reports one book,
  deliberately: `bookOverUnder` is the provider's own consensus, so calling it
  one understates how many opinions stand behind a line, which is the safe
  direction. Reading the per-book spread would change what `bookCount` and
  `consensusMethod` mean and is its own piece of work.
- **An unfiltered `leagueID=NFL` query answers with novelty events** — the first
  probe came back with Puppy Bowl XX and "sex of the winning touchdown scorer".
  Real games are `type=match`.

Market identifiers confirmed present on a live NFL event: `passing_yards`,
`rushing_yards`, `receiving_yards`. The event sampled was preseason and carried
no receptions or touchdown markets; those identifiers follow the same naming
scheme and are mapped, and a market that never appears simply produces no
quotes rather than an error.

## Season-long markets: the provider does not have them

The draft wants season totals — "1,085 receiving yards, 84 receptions" — rather
than Sunday's line. SportsGameOdds does not publish any. Established by probe,
not by assumption, on 14 August 2026:

- **`type` accepts only `match`, `prop` and `tournament`.** Anything else is a
  400 with that message.
- **`prop` and `tournament` are both empty for the NFL**, over the whole year,
  with and without `oddsAvailable`.
- **Every NFL event is a single game**, including everything dated past the end
  of the regular season.
- **The market catalogue settles it.** `/v2/markets?leagueID=NFL` returns 148
  active markets across periods `game`, `1h`, `2h`, `1q`–`4q` and `reg`. Not one
  season period, and nothing season-shaped in any market name.

Re-established on **22 August 2026**, eight days before the draft and with the
regular season on sale, by `scripts/probe-vegas-integrity.mjs` — because "no
season markets in mid-August" and "no season markets ever" are different claims
and only the second one is worth building on:

- the catalogue has grown to **344 markets** and the periods are still
  `game`, `1h`, `1q`, `2h`, `2q`, `3q`, `4q`, `reg`. **No season period, and no
  market whose name is season-shaped**;
- `type=prop` and `type=tournament` are still both empty for the NFL;
- an event dated after the regular season ends is an ordinary `match`;
- across every query, **zero** quotes at a season-length period.

So the growth in the catalogue is more ways to bet on a game, not the first way
to bet on a season. The draft gets no season baseline from this provider, and
Setup says so rather than showing an empty number.

So the app asks, stores what comes back, and shows nothing when nothing does.
`SportsGameOddsProvider.getSeasonPlayerMarkets` returns an empty set carrying
that reason — which is a different fact from a failed request, and is reported
as such in Setup under "Season outlook". `INBOUND_SEASON_MARKETS` and
`SEASON_PERIODS` in the adapter are where a season market would land if one ever
appeared; nothing else would have to change.

`reg` is deliberately **not** treated as a season period: it is regulation time
within a game, and reading it as a season would turn a 28.5-yard line into a
season total.

### What a regular-season game does carry

Worth recording, because this is what the weekly Start/Sit layer will live on.
From a live 10 September fixture:

`passing_yards`, `passing_touchdowns`, `passing_interceptions`, `rushing_yards`,
`receiving_yards`, `receiving_receptions`, `touchdowns` (both `ou` and `yn`),
`firstTouchdown`, `defense_interceptions` — all on named players, all at
`periodID = game`.

The catalogue also offers **`fantasyScore`** ("Player Fantasy Score
Over/Under", active on 172 events), which is a market on a player's fantasy
points directly. It is not wired up: the book's scoring is not this league's
scoring, so it would need treating as its own signal rather than as a
projection. It is the most promising thing to add to the weekly layer.

## What the free plan actually charges for

Measured against the live account on 14 August 2026, by reading
`/v2/account/usage`, making one request, and reading it again
(`scripts/probe-sgo-quota.mjs`, `probe-sgo-quota-scale.mjs`,
`probe-sgo-team-filter.mjs`). Not read off a pricing page, and not inferred
from response size.

**The unit is an "entity", and an entity is one event returned.**

| Query | Events back | Odds objects back | Cost |
|---|---|---|---|
| `/events?leagueID=NFL&type=match&limit=1` | 1 | 194 | **1 entity** |
| `/events?eventID=…` | 1 | 194 | **1 entity** |
| `/events?…&limit=5` | 5 | 342 | **5 entities** |
| `/events?…&limit=10` | 10 | 594 | **10 entities** |
| `/events?eventID=…&oddIDs=<one player market>` | 1 | 1 | **1 entity** |
| `/events?…&teamID=NOT_A_REAL_TEAM_NFL` | 0 | 0 | **1 entity** |
| `/account/usage` | — | — | **0** |

So the payload is free and the row is not. Filtering by market (`oddIDs` is
honoured, and narrows a 194-object answer to one) saves bandwidth, worker CPU
and database rows — it does not save quota. Asking for fewer *events* is the
only thing that does.

**The account (tier `amateur`):**

| Window | Requests | Entities |
|---|---|---|
| per second | unlimited | unlimited |
| per minute | **10** | unlimited |
| per hour | 50,000 | 250,000 |
| per day | 500,000 | 3,000,000 |
| per month | unlimited | **2,500** |

Two limits bind: 2,500 entities a month, and ten requests a minute. Everything
else is unreachable.

Other answers, for the record: an empty or failed response still costs one
entity; `teamID` filtering is honoured server-side (verified with a real team
id *and* a nonsense one, because a silently-ignored filter would return the
whole slate and charge for it); `bookmakerID` and `includeAltLine` were
accepted but changed nothing on the free plan, where `byBookmaker` is empty and
one quote is the provider's own consensus; and `/account/usage` moves neither
counter, so the app can check its own spending before every call for nothing.

### What that corrected

This document previously said a Sunday slate was "roughly 3,200 objects
against a free plan of 2,500 a month". That was counting odds objects, and the
plan does not count odds objects. A sixteen-game Sunday is **sixteen entities**.

The real risk was somewhere else entirely: the season-market probe ran daily
with `limit=25` on two requests, so up to **50 entities a day — 1,500 a
month**, 60% of the allowance, for markets this provider does not publish. It
is now `limit=1` on both (2 entities), skipped once the draft is complete, and
counted like everything else.

## The fetch strategy

Roster first, never the slate.

1. **Discovery, at most once every 72 hours.** One request per team the roster
   spans, filtered by `teamID` and bounded to the next eight days. Eight teams
   cost eight entities however many games the league is playing. The answer
   carries the odds too — there is no schedule-only request — so this *is* the
   week's first fetch, and what it learns is stored in `vegas_events` so the
   next refresh does not pay to find the same games again.
2. **Targeted refreshes afterwards.** `buildFetchPlan` starts from the players
   whose week is still undecided, maps them to events, deduplicates (two
   rostered players in one game is one fetch), drops games that have kicked off,
   drops players whose lines are still fresh, and sorts what is left by
   priority.
3. **The budget decides how much of that plan runs**, and it is told before the
   first request, not after the last.

Markets are whitelisted at the adapter: passing yards/TDs, rushing yards,
receptions, receiving yards, anytime TD, full-game over/unders only. Alternate
lines, quarter props, first-touchdown and defensive props are dropped. One
book, because the free plan publishes one — the provider's own consensus,
reported as a single book rather than dressed up as agreement.

### What a month costs

| | Entities |
|---|---|
| Weekly discovery (8 roster teams) | 9 |
| Two scheduled refreshes (8 games each) | 16 |
| Near-kickoff top-ups for close calls | 3 |
| **Per week** | **28** |
| Season markets (2 per run, daily, until the draft ends) | 60 |
| **Per month (5 weeks)** | **200 of 2,500 — 8%** |

`simulateMonth` in `src/core/vegas/plan.ts` computes this, and
`tests/vegas.budget.test.ts` fails if the shipped strategy stops fitting.

## The budget

`src/core/vegas/budget.ts` holds every threshold. The month's usage is read
from the provider (free, authoritative — it also sees spending from a probe or
another deployment sharing the key) and from the app's own ledger
(`vegas_usage`, `vegas_usage_log`), and the **larger of the two** is believed,
because that is the only combination that cannot under-report.

| State | At | Behaviour |
|---|---|---|
| healthy | < 50% | normal targeted refreshes |
| caution | ≥ 50% | low-priority refreshes stop |
| conservation | ≥ 70% | only close or uncertain decisions |
| hard stop | ≥ 85% | the reserve: close game-day decisions only |
| exhausted | 100% | no provider call of any kind |

A refusal is never an error. The last stored lines keep serving, marked stale,
and Start/Sit lowers its confidence rather than showing a zero. No Vegas data
beats accidental paid usage.

Manual refresh goes through the same gate — plus a 15-minute per-event cooldown
and a 4-per-15-minutes rate limit — so a thumb on a button cannot spend the
month. Nothing in the UI calls a provider: opening Draft, Team, Start/Sit or a
player card reads the database.

`GET /api/vegas/budget` reports where the month went, by source, with the plan
the next refresh would run. Setup shows the same numbers in words.

## How SportsGameOdds is enabled

`VEGAS_PROVIDER = "sportsgameodds"` in `wrangler.toml`, and the Deploy workflow
publishes the repository secret `SPORTSGAMEODDS_API_KEY` to the Worker. Both are
needed; neither requires a terminal.

A deployment with the var set and the key missing is a real state and is now a
*named* one: the provider reports itself unconfigured, Setup says the key is
missing, and nothing is fetched or invented in the meantime.

The hold before this was that the strategy had never met a real slate — "the
whole strategy rests on mapping Sleeper's team abbreviations onto this
provider's team ids, on kickoff times being right". That turned out to be the
right thing to worry about: the abbreviation mapping **was** wrong, and it is
the defect described under "What was actually keeping this on mock". The
mapping is now taken from the provider's own team list and covered by a test
that fails if any of the 32 clubs stops resolving.

What is still only checked against preseason and early-season payloads is the
plan's staleness arithmetic over a live Sunday. The blast radius is bounded by
a budget that stops at 85%, and a refusal is never an error: the last stored
lines keep serving, marked stale.

### Player matching, measured

From the same 22 August probe, using the app's own `PlayerIndex` and
`resolvePlayer` against the Sleeper dictionary rather than a re-implementation:
91 provider names across four regular-season fixtures, **82 matched (90%), 1
ambiguous, 8 unmatched**. All eight unmatched are kickers, which
`EXCLUDED_POSITIONS` deliberately keeps out of the dictionary — so among
positions the app actually ranks the rate is **82 of 83**. The one ambiguous
name was Cameron Ward. Nothing unresolved is dropped silently: a quote whose
name does not resolve is stored with a null player id so it can be audited.

`docs/STATUS.md` carries the same summary; this file is where the numbers live.

## The fallback: The Odds API

Only worth evaluating if SportsGameOdds stops fitting — it currently fits with
92% of the allowance to spare, so there is no reason to run two providers.
Nothing here has been measured against the live vendor: outbound requests to
its domain are blocked by this environment's egress policy, and its free-tier
terms and credit model must be verified the same way SportsGameOdds' were
(a probe through the Probe workflow, reading usage before and after) before
anything is built on them.

Do this yourself before switching:

1. **Free tier still exists** and what the monthly request allowance is.
2. **NFL player props are included in the free tier.** On The Odds API, player
   props are served per-event via `/v4/sports/{sport}/events/{eventId}/odds`,
   and each event costs at least one request — a 16-game Sunday is 16+ requests
   per refresh. Confirm this fits the allowance.
3. **Market keys are current.** The adapter maps:

   | Internal | The Odds API |
   |---|---|
   | `pass_yards` | `player_pass_yds` |
   | `pass_tds` | `player_pass_tds` |
   | `rush_yards` | `player_rush_yds` |
   | `receptions` | `player_receptions` |
   | `receiving_yards` | `player_reception_yds` |
   | `anytime_td` | `player_anytime_td` |

   If a key has changed, edit `OUTBOUND_MARKETS` in
   `src/core/vegas/oddsApiProvider.ts` and the alias table in
   `src/core/vegas/normalize.ts`. Unknown markets are dropped, never guessed, so
   a stale key degrades to "no data" rather than to wrong data.

### Enabling it

```bash
npx wrangler secret put ODDS_API_KEY
```

Set `VEGAS_PROVIDER = "the-odds-api"` in `wrangler.toml` and redeploy. The
budget guard is provider-agnostic and would still apply — but its unit is this
provider's entity, so `BUDGET.monthlyEntities` and the cost model in
`getPropsForTeams` would both need re-measuring first.

## Adding a different vendor

Implement `VegasProvider` (`src/core/vegas/types.ts`):

```ts
interface VegasProvider {
  readonly name: string;
  isConfigured(): boolean;
  getUpcomingNFLGames(opts?): Promise<VegasGame[]>;
  getPlayerProps(eventId, markets?): Promise<RawPropSet>;
  getQuotaStatus?(): QuotaStatus | null;
}
```

Map the vendor's market names into the internal vocabulary inside the adapter.
Nothing outside `src/core/vegas/` may reference a vendor field name, so no other
code changes.

## Caching

`getPropsWithCache` is the only path that may fetch one event's lines, and
`VegasRefreshService` is the only thing that calls it. Quota policy is above;
this is the freshness policy.

- **TTL**: 360 minutes normally, 90 minutes within 6 hours of kickoff.
- **Manual refresh**: allowed only after a 15-minute cooldown per event, and the
  HTTP endpoint is additionally rate limited to 4 refreshes per 15 minutes.
- **Scheduled cadence**: Saturday 23:00 UTC and Sunday 15:00 UTC, and each run
  fetches only the roster's own games — never the slate.
- **Failure**: on quota exhaustion, auth failure or a network error, the last
  cached snapshot is returned with `stale: true` and the reason attached. It
  never throws and never fabricates a line.
- **Nothing cached and the fetch failed**: `origin: 'unavailable'` with a null
  snapshot. Downstream, that surfaces as "unknown" in the UI and lowers the
  start/sit confidence — it never becomes a zero that looks like a projection.

Every fetched payload is persisted in `prop_snapshots.raw_json`, and per-book
quotes are retained on the consensus row (`books_json`, `book_count`,
`consensus_method`) so contradictory lines are never silently merged.

## Consensus method

Per (player, market): drop books whose line deviates more than 25% from the
median, then take the median of what remains. Binary markets (anytime TD) are
de-vigged across the two sides; with only one side priced, the raw implied
probability is used and is an overestimate — treat it as approximate.
