# UI revamp, part 1 (Round 35)

Behind the `UI_REVAMP` switch (off on the live site). Part 2 does Waivers,
Trades, Players and Setup on the same pieces; the switch flips for all of it
at once after Alex approves.

- Rules: [DESIGN_RULES.md](./DESIGN_RULES.md), taken from the Players card.
- Preview: the "ui" mode of the Preview workflow (PIN 739514): the whole app,
  switch on, on the made-up league, answered in the browser.

## Before and after (iPhone Air width, 420 points)

Each picture: before and after in light, then before and after in dark.

| Screen | Top | Second view | Third view |
| --- | --- | --- | --- |
| Team | [team-top](./shots/team-top.jpg) | [bench open](./shots/team-bench.jpg) | [a player's card](./shots/team-card.jpg) |
| Matchup | [matchup-top](./shots/matchup-top.jpg) | [bench open](./shots/matchup-rows.jpg) | [a player's card](./shots/matchup-card.jpg) |
| Compare | [the list](./shots/compare-picker.jpg) | [two players](./shots/compare-result.jpg) | [three players](./shots/compare-detail.jpg) |

Made with `scripts/ui-screenshots.mjs` against the local made-up league
(`FA_SEED=1 FA_SEED_FULL=1`).

## Speed: time to first useful paint

`scripts/measure-first-paint.mjs`: Chromium on Lighthouse's phone profile
(CPU 4x slower, 150 ms round trip, 1.6 Mbps), files served like Cloudflare
(gzip, ETag), and every server read held for the time production took in
the Round 29 audit (lineup 474 ms, Waivers 1,236 ms, Players board 1,338 ms,
offers 1,285 ms ...). Median of 3 runs. "Useful" is the screen's answer on the
glass: Team's first lineup row, Matchup's score, a Waivers row, a Trades
answer, a Players row, a Compare row. Team is from launch; the rest from the
tap.

| Screen | Before, first launch | Before, later launches | After, first launch | After, later launches |
| --- | --- | --- | --- | --- |
| Team | 2.20 s | 2.09 s | 2.23 s | 1.12 s |
| Matchup | 0.96 s | 0.96 s | 0.97 s | 0.03 s |
| Waivers | 0.04 s | 0.03 s | 0.04 s | 0.02 s |
| Trades | 1.92 s | 1.89 s | 1.47 s | 0.09 s |
| Players | 1.86 s | 1.80 s | 1.65 s | 0.10 s |
| Compare | 0.72 s | 0.70 s | 0.58 s | 0.06 s |

"First launch" is the first time a phone opens the app after the switch goes
on: the switch's answer arrives on that launch, so it starts the old way.
Every launch after that is the right-hand column (after 12 hours away the
kept answers are dropped and Team and Matchup wait for the server again).

What changed: the shell no longer waits for the status read; a launch shows
the last good answer (kept 12 hours, live league only) and the server's
replaces it a round trip later; a finger on a tab starts that tab's read; the
idle moment after the first screen fetches the Trades and Players code;
loading draws rows of the right height. No new server reads: a touched tab's
read is the one the screen would have made, and the screen joins it.

Server-limited (the server's own time, which the phone cannot hide on a
first visit): Players board 1.3 s, Trades offers 1.3 s, Waivers 1.2 s
(already read by Team, so Waivers itself is instant), Matchup 0.4 s, Team's
lineup 0.5 s. Team's later launch is 1.1 s of the phone loading the app
itself (code check and start-up on a slow CPU), not the server.

# UI revamp, part 2 (Round 36)

Waivers, Trades, Players and Setup on Part 1's pieces, behind the same
`UI_REVAMP` switch (still off on the live site). Rules added to
[DESIGN_RULES.md](./DESIGN_RULES.md) under "Part 2".

- Preview: the "ui" mode of the Preview workflow (PIN 739514) now covers every
  screen. Waivers shows the made-up picks in
  `scripts/ui-preview-fixtures.mjs` (Do this, Worth considering, Stash, Cover,
  Block, Watch list, Drop-ready); Trades and the Players board come from the
  made-up preview league (the same names as the Round 19 and Round 24
  previews). Recaptured with `scripts/capture-ui-preview.mjs`.
- Draft mode: while a draft is ahead the app draws today's look whatever the
  switch says (`setDraftSeason` in `web/revamp.ts`), so the Draft board, ADP
  and the draft Players list render exactly as before. The new look starts
  once the draft is done.

## Before and after (iPhone Air width, 420 points)

Each picture: before and after in light, then before and after in dark.

| Screen | Top | Second view | Third view |
| --- | --- | --- | --- |
| Waivers | [the picks](./shots/waivers-top.jpg) | [a pick's comparison](./shots/waivers-sheet.jpg) | [stash, cover, block](./shots/waivers-extra.jpg) |
| Trades | [offers](./shots/trades-offers.jpg) | [an offer's comparison](./shots/trades-sheet.jpg) | [Check this offer](./shots/trades-check.jpg) |
| Players | [the board](./shots/players-board.jpg) | [a player's card](./shots/players-card.jpg) | [trade targets](./shots/players-targets.jpg) |
| Setup | [sections](./shots/setup-top.jpg) | [further down](./shots/setup-more.jpg) | [Data health](./shots/setup-health.jpg) |

Made with `scripts/ui-screenshots-2.mjs` against three local servers (the
seeded league, PREVIEW=trades, PREVIEW=players).

## Speed: time to first useful paint (Part 2 screens)

`scripts/measure-first-paint.mjs` as in Part 1 (phone profile, production read
times), now with Setup and the preview world (`--trades`, `--players`). Median
of 3 runs. Setup's read has no production timing on file, so it is held 600 ms
in both columns. "Useful" for Setup is its first row (before: the Data fold).

| Screen | Before, first launch | Before, later launches | After, first launch | After, later launches |
| --- | --- | --- | --- | --- |
| Waivers | 0.04 s | 0.02 s | 0.03 s | 0.02 s |
| Trades | 1.71 s | 1.70 s | 1.35 s | 0.11 s |
| Players | 1.66 s | 1.63 s | 1.45 s | 0.10 s |
| Setup | 0.84 s | 0.81 s | 0.89 s | 0.08 s |

What Part 2 added: Setup's read and the Trades rosters (Check and Build) are
kept like the other first reads; a finger on the gear starts Setup's read; the
idle moment after the first screen also fetches Setup's code. Trades and
Players use Part 1's kept answers. Waivers is instant either way because Team
already read it. No new server reads.

## Live (Round 36, after Alex's review)

Alex reviewed the whole preview and asked for one change, on Matchup's
Compare list: selecting a player must not move the list, picks show as a
check, and a fixed bottom bar holds Compare (grey until two picks, then
green); the second pick no longer opens the answer by itself. Covered by
`e2e/compare-picker.round36.spec.ts`. Then `UI_REVAMP = "on"` in
wrangler.toml. To turn it off: set it to "off" and deploy. The live smoke
suite (`e2e-production/smoke.spec.ts`) reads the switch from the status read
and checks whichever look is live.
