# Vegas Props Provider Abstraction

## Goal

Use free or free-tier NFL player prop data without coupling the entire app to one vendor.

## Requirements

Create a provider interface resembling:

- getUpcomingNFLGames()
- getPlayerProps(eventId)
- normalizeMarket()
- getQuotaStatus() if supported

## Initial provider candidates

At implementation time, verify current free-tier terms and actual NFL prop coverage before committing.

Potential candidates previously identified:

- The Odds API
- SharpAPI or comparable free-tier odds service

Do not assume a pricing tier or endpoint remains unchanged.

## Normalized markets

Use internal names:

- pass_yards
- pass_tds
- rush_yards
- receptions
- receiving_yards
- anytime_td

Provider adapters convert external naming into these values.

## Caching

Persist fetched snapshots.

Do not refetch unchanged games unnecessarily.

Suggested:

- Saturday evening refresh
- Sunday morning refresh
- manual refresh with cooldown

## Quota protection

Track:

- last request time
- requests used if provider exposes it
- failed calls
- cached fallback

If quota is exhausted, keep serving the latest cached snapshot and mark it stale.

## Data quality

Store:

- provider
- sportsbook
- line
- price
- fetched_at
- game_start

Never silently merge contradictory lines without retaining source values.

## Secrets

API key server-side only.
