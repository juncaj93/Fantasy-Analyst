# Waivers that look ahead (Round 26)

Behind the `WAIVERS_LOOKAHEAD` switch in `wrangler.toml`. "on" since Alex's
go on 13 November 2026 (the backtest alone left it off). Set it to "off" and
deploy to go back. With it off every Waivers line is exactly as
before (`waiver@23`).

## What changes on the Waivers screen

Nothing new to learn. The section under Worth considering that held the stash
and the block now holds up to three lines, titled "Cover, stash and block"
when a cover line is there:

- `Stash: Lars Penhall (Holloway out for the season, gets his targets), bid $1`
- `Add: Rocco Bianchi (covers your Week 12 bye at TE), bid $3`
- `Block: Ivo Brandt (Dermot has no RB this week), bid $3`

Each line has the spot it uses under it (open bench spot, open IR slot, or a
drop-ready player). Never more than three lines: the stash first, then the
covers, then the block.

## A. Opportunity (`core/waivers/opportunity.ts`)

When a starter loses his job for weeks (out for the season, on IR, Out with a
return 3 or more weeks away, or traded away), the next player in line on his club's depth chart gets most of his
work. The open work is the starter's points a game over his last four games.
The backup gets:

- **measured**, when his club has played 2 or more games without the starter:
  the backup's own points a game in those games;
- **inferred** otherwise: his own points a game plus 55 percent of the open
  points (the man after him 25 percent; the shares are the injury module's own,
  `core/injury/beneficiaries.ts`).

He must gain at least 2 points a game, be healthy, and have played in at least
one of his club's last two games. If another teammate has already taken over
the role in the club's games without the starter (the last 4, or all since the
injury if fewer: played at least half, scored 75 percent of the starter bar a
game and 2 more than before), no other backup is offered. Joe Milton was
offered for Jalen Hurts on 13 November while another Eagles quarterback had
likely been starting since Week 6; this rule stops that. A backup who has
already played since the starter went down is judged on those games alone,
never his own number plus a share (Milton started Week 9 with 13.2 and was
read as 22.2; McKee started Weeks 6 to 8). A benching is not read (switched
off 13 November): Sleeper listing a healthy starter second was Mack Hollins
back from injury in Week 9 while DeMario Douglas still scored 12.7. A backup quarterback already scoring like a
starter is skipped (one QB plays). The lead then has to pass the stash bar
(`upsideStash.ts`): at that number he would start in Alex's best season
lineup. It is still a stash: the Round 20 stash bid, $0 or $1, never into the
$20 playoff reserve, and at most one stash line a week.

A trade is read from the daily player sync, which now keeps each depth-charted
player's club and any change for about six weeks (`core/sleeper/playerNotes.ts`,
same settings row, one extra read a day, no new rows). Trades made before this
deploy are not on record.

## B. Look-ahead for Alex (`core/waivers/lookAhead.ts`)

For the next three weeks, a hole is a week where a usual starter cannot play
(bye, an injury the availability table says is not over, Doubtful or Out) and
the bench cannot fill his slot within the 2-point toss-up bar, or a slot nobody
can fill. The best free agent for the hole is offered when he gains 2 points or
more that week. A hole in a later week waits for its own waiver run unless the
wire is thin (fewer than 3 free agents would fill it about as well; review
W12). A hole a Do this or Worth considering move already fills gets no second
pickup. A cover is a pickup, not a stash, so it bids the Round 20 Worth
considering rule (this league's price for the position, capped by what the one
week is worth). Bids come after the Do this claims and the stash, never into
the $20 reserve.

## C. Block, smarter (`core/waivers/block.ts`)

Same rule as before (this week's opponent, a gain of 2 points or more for him,
$1 to $3, a spot Alex is not using), now worded with the opponent's name and
the look-ahead's hole rule: "Matty has no TE this week" for a hole, "Matty is
thin at TE" for a weak starter. It spends only what the lines above leave and
uses only a spot they leave.

## Cost

No new database reads on a Waivers open: everything comes from rows the screen
already reads (season points, Sleeper's depth and injury notes, the fixtures).
The free agents who inherit a role join the scan (slice 7 of
`core/roster/wirePool.ts`), a handful a week, each costing only its own rows in
the batched reads. They stay out of the season pool, so replacement levels do
not move. The daily player sync reads its own notes row once more a day.
`/api/leagues/:id/waivers?cost=1` now reports the rows a load reads.

## Preview

`preview.yml` with mode `waivers`: the three lines on the made-up preview
league, behind the PIN, light and dark, drawn by the real section.

## Files

- `src/core/waivers/opportunity.ts`, `lookAhead.ts`, `lookAheadPreview.ts` (new)
- `src/core/waivers/upsideStash.ts`, `block.ts`, `assemble.ts`, `tierPlan.ts`
- `src/core/roster/wirePool.ts`, `src/core/sleeper/playerNotes.ts`
- `src/server/services/decisionInputs.ts`, `waiverRound2.ts`, `sleeperSync.ts`, `src/server/app.ts`, `src/worker/index.ts`
- `src/web/waiverCard.ts`, `src/web/components/waiverTiers.tsx`, `src/web/preview/PreviewApp.tsx`
- Tests: `tests/waivers.round26.test.ts`, `e2e/waiver-lookahead.spec.ts`
- Backtest: `scripts/round26-backtest.ts`, `docs/backtest/ROUND26_SMART_WAIVERS.md`
