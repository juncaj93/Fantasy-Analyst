# Vegas props

## Current state

`VEGAS_PROVIDER = "mock"` is the default. `MockVegasProvider` produces stable,
deterministic, obviously-synthetic lines and never touches the network, so
development and tests cost no quota.

`OddsApiProvider` (The Odds API) is implemented and tested against recorded
payload shapes, but is **not enabled**, because the free tier's terms and NFL
player-prop coverage could not be verified from this environment — outbound
requests to the vendor's domain are blocked by the network egress policy here.

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
