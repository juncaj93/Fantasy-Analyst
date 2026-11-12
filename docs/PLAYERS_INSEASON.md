# Players, in season (Round 24)

Behind the `PLAYERS_INSEASON` switch in `wrangler.toml` ("off" until Alex has
seen the preview and says go). With it off, or while a draft is ahead, the
Players tab is exactly today's draft tool.

## What the tab does with the switch on

- **Sort.** Rest-of-season value by default: expected points in an average
  remaining week, playoff weeks at 1.5 (`perWeekValue` over the shared
  `core/value/restOfSeason.ts` rate, the same value Trades and Waivers use).
  Draft order is one tap away. Every row keeps the pick (`1.04`) and the 7-day
  and 30-day moves.
- **Trade targets.** A player on another team whose addition lifts Alex's best
  lineup (the trade tools' lineup solver, byes and injuries counted) by at least
  1 point a week. One reason: "Starts at TE over Teo Ferreira, +6.6 a week".
  Hidden once the trade deadline has passed.
- **How likely the owner is to deal.** The trade finder's own signals: how often
  he trades (`activity.ts`, through `partnerActivity`), whether he has traded
  with Alex, and whether one of Alex's spare players (not in his best lineup)
  would lift the owner's lineup by at least 1 point a week.
  - Likely: trades often (active, selective, or has traded with Alex) and needs
    one of Alex's players.
  - Maybe: one of the two.
  - Unlikely: neither, or on record as almost never trading.
- **Injured.** Out this week by Team's rule (`weekAvailability.ts`: Doubtful
  counts as Out) or held in an IR slot, with the first later week he is
  expected to play ("Back Wk 13"), from the trade model's availability table.
- **Card.** This week's number (`weekPoints`, computed as Compare's list does),
  the next four weeks with byes marked (later weeks are Sleeper's stored
  projections, so italic with a dotted underline), and the last five games in
  this league's scoring (the same games the season average counts). A trade
  target's card adds the willingness word, the reason, and him against the
  starter he would replace.

## Cost

One request for the tab (`/api/players/season`); sorting, both filters and
search run on the phone over it, so they read nothing. It reuses Check a
trade's preparation of the league and is remembered for ten minutes per Worker,
keyed on who holds whom, so a reopen with the same rosters reads only the
league and its rosters. One small request per card (`/api/players/:id/season`).
Both take `cost=1` to report rows.

## Files

- `src/core/players/inseason.ts`: value, trade targets, willingness, injury, next weeks, last games (pure).
- `src/core/players/seasonPreview.ts`: the preview league (the Round 19 names, three marked hurt).
- `src/server/services/playersSeasonService.ts`: the two routes.
- `src/web/screens/PlayersTab.tsx`: picks today's screen or the in-season one.
- `src/web/screens/PlayersSeasonScreen.tsx`, `src/web/components/players2/`: the screen and card (their own lazy chunk, `players2-*`).
- Preview: `preview.yml` with mode `players`, PIN-gated.
