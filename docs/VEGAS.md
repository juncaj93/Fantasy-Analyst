# Vegas props

## Current state

`VEGAS_PROVIDER = "mock"` is the default. `MockVegasProvider` produces stable,
deterministic, obviously-synthetic lines and never touches the network, so
development and tests cost no quota.

`SportsGameOddsProvider` is implemented and tested **against the live API's
real payloads**, captured by `scripts/probe-sportsgameodds.mjs` running through
the Probe workflow. It is not enabled yet — see "Enabling SportsGameOdds"
below for the one config change and the one thing still worth checking.

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
- **`byBookmaker` is empty on the free plan.** A quote is one consensus number,
  so the adapter reports a single book rather than dressing it up as agreement
  between several.
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

## Enabling SportsGameOdds

The repository secret `SPORTSGAMEODDS_API_KEY` already exists and is valid —
the probe authenticated with it. To turn the provider on:

1. Make the key available to the Worker:
   ```bash
   npx wrangler secret put SPORTSGAMEODDS_API_KEY
   ```
2. Set `VEGAS_PROVIDER = "sportsgameodds"` in `wrangler.toml` and redeploy.

The first of those checks is now done: regular-season games do carry
`receiving_receptions` and `touchdowns` under the identifiers in
`INBOUND_MARKETS`.

**The quota one is not, and it is the reason the provider is still off.** A
regular-season event carries on the order of 200 odds objects, and a full
Sunday slate is sixteen of them — roughly 3,200 objects for one refresh,
against a free plan of 2,500 a month. Two scheduled refreshes a week would
spend the month's allowance in the first weekend. Before flipping
`VEGAS_PROVIDER`, the refresh has to stop fetching the whole slate: fetch only
the events the user's own players are in, on demand, and let the cache serve
everything else. The cache layer, not the adapter, decides when a fetch is
allowed, so that is where the change goes.

Season-long markets cost nothing to leave on: there are none to fetch, the
result is cached for a day, and the two requests it makes are small.

## Verify before enabling a live provider

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

## Enabling

```bash
npx wrangler secret put ODDS_API_KEY
```

Set `VEGAS_PROVIDER = "the-odds-api"` in `wrangler.toml` and redeploy.

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

## Caching and quota protection

`getPropsWithCache` is the only path that may call a provider.

- **TTL**: 360 minutes normally, 90 minutes within 6 hours of kickoff.
- **Manual refresh**: allowed only after a 15-minute cooldown per event, and the
  HTTP endpoint is additionally rate limited to 4 refreshes per 15 minutes.
- **Scheduled cadence**: Saturday 23:00 UTC and Sunday 15:00 UTC.
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
