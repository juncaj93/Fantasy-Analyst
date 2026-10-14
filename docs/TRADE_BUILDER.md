# Build a trade

On Trades, under the ideas and above Check a trade. Alex marks the players he
would sell, picks a team (or all teams), marks the players he wants, and taps
**Find trades**. The app builds small packages from those marks and shows only
the ones that help **both** lineups. It never sends, proposes or accepts
anything; **Copy pitch** puts a message on the clipboard for Alex to paste into
Sleeper himself.

## Marks

- **Sell**: Alex's own players he would be fine moving. Anyone unmarked is off
  the table, unless he turns on **Also consider unmarked players**, which adds
  his most spare players (the ones whose loss costs his lineup least, at most
  six in all).
- **Elite backs are never offered unless marked**, toggle or not. Elite means:
  a top-12 back league-wide by points a game this season, or a back at 12+ on
  this week's Start/Sit number, or one drafted in round 1 or 2.
- **Want**: players on the team he picked. Mark nobody and the app suggests up
  to four (three per team for All teams): the players who would most improve
  his lineup, those that some 1 for 1 with a Sell mark helps both sides with
  first.
- Marks are kept in this phone's browser storage, per league, with **Clear
  marks**. They do not follow Alex to another device (no schema change; see the
  decision below).

## Packages

Shapes: 1 for 1, 2 for 1, 1 for 2, and 2 for 2 when both lists have four
players or fewer. A one-week pass of the lineup solver on both rosters orders
them; the best ten per team (four per team for All teams) get the full
evaluation.

### Every number is Check a trade's

Each package goes through `evaluateTrade` (`core/tradeValue/evaluate.ts`), the
same season evaluation Check a trade runs: the best legal lineup on each real
roster for every week from now to week 17, byes and injuries counted as missed
weeks, depth credited, Vegas first this week and Sleeper's projection where the
market is not complete. Typing the same deal into Check a trade gives the same
rest-of-season numbers (`tests/trades.builderService.test.ts` asserts it).

### Alex's gain

The weekly lineup change (depth and bye cover included) weighted:

| week | weight |
| --- | --- |
| the week a trade first affects | 3 |
| the two after it | 2 |
| other regular-season weeks | 1 |
| playoff weeks (15 to 17) | 1.5 |

plus his preferences as Check a trade already writes them (no spare QB or TE
unless clearly better, lean RB when value is close). A package that adds a QB
or TE who is not clearly better is not shown. The card shows three plain
numbers: this week, the next three weeks, and the playoff weeks.

### Their gain and their need

The same weighted change on their roster, with no preferences. **A package that
does not help them by at least one weighted point is never shown.** Their need
is read off their own lineup for the next three weeks against their healthy one:

- `their RB2 is Out` (a starter injured);
- `their TE is on bye in week 8` (a starter on a bye);
- `thin at WR` / `thin at flex` (a free agent would start there, or nearly).

The card's why-line is the need the package fills, else who would start for
them.

### Status: Likely, Maybe, Long shot

From Alex's edge in rest-of-season value over a free agent (each side's
players, from the same evaluation), as a share of the larger side:

| edge to Alex | status |
| --- | --- |
| 10% or less, or tilted their way | Likely, when it fills a named need; else Maybe |
| up to 25% | Maybe |
| up to 45% | Long shot |
| past 45% | not shown |

A package that helps them less than a quarter as much as it helps Alex drops
one level. **No percentage is ever shown**: Sleeper does not publish offers that
were turned down or ignored, so willingness is unknown, and every result says
so. Ranked by Alex's gain among packages that are at least Maybe: top 3 for one
team, top 5 for All teams (at most two per team). A team asked about by name
with nothing better shows its Long shots, labelled.

### Roster limits

Counted on the active roster (an IR slot holds no bench spot). When Alex would
receive more players than he sends:

1. an IR-eligible player moves to an open IR slot (he stays on the roster and
   is valued on the weeks he is back);
2. otherwise a drop, chosen the waiver planner's way: lowest drop score first
   (`core/waivers/dropScore.ts`), never a protected player (a round 1 to 6 pick,
   a handcuff to an elite back), never a player in his coming-week lineup
   unless he is a dead spot, and never someone better than the best player
   arriving.

No safe drop, no package. The drop's cost is in Alex's numbers.

### Deadline

Read from `settings.trade_deadline`. Past it, the builder says trades are
closed and **Find trades** is off. In the last two weeks the line says how many
are left.

### Manager behaviour

A note only: completed trades this season (by roster) and in earlier seasons
this app has read (mapped through the ledger's roster identities for that
season). It moves no number.

## Compact layout (15 October 2026)

- Rosters are wrapped chips grouped by position: `RB E. Johnson ATL`, an
  injury letter (Q, D, O, IR), and a `Sell` or `Want` tag once marked. A
  16-player roster is 5 rows of chips at 390 px and 6 at 360.
- The build flow (Sell chips, team picker, Want chips, Find trades) fits an
  844 px screen; Find trades sticks above the tab bar.
- Banners are one line, with the rest behind an info button.
- A card: status chip (and `Costs you now` when it loses points this week or
  over the next three), the team, one Give and one Get line, one row of four
  numbers (this week, next 3, playoffs, them), one need phrase.
- The sheet: status and one short reason, a three-row table, at most two
  short reasons, a line when it rests mostly on Sleeper's projection, Copy
  pitch, and `More` for the pitch text, the manager's record, value, habits
  and caveats.
- A package that costs Alex now ranks above one that helps now only when its
  gain is at least 1.5 times as large and 5 points more.
- An elite back's handcuff is never offered unless marked.

## Phone check follow-ups (15 October 2026)

- **Inner padding.** The bodies of Build a trade and Check a trade take the
  header's 12 px inset (the Team cards' padding), so labels, chips, the info
  line, the dropdown, the pill and the buttons line up with the title. The
  market fold's section titles and its closing note take the same inset.
- **Dropdown and pill.** The team dropdown shrinks (112 px minimum, long names
  cut with an ellipsis) so `+ unmarked on` always fits whole. Up to 375 px the
  chips tighten a little so a 16-player roster still wraps to six rows.
- **Then add a QB.** When a package leaves a starting slot with nobody on
  Alex's roster to fill it in some week (Love traded with Burrow on a bye),
  the card carries `Then add a QB` and the sheet names the free agents the
  numbers assume (their average and their names). With no priced free agent
  at that position the package reads Long shot. No scoring changed: the
  numbers already assumed a free agent there.
- **Beta** beside the Build a trade title.

## All teams, one team per request

The screen asks for each team in turn (`sweep=1`), shows `3 of 9 teams`, and
merges the best five (two per team at most) as answers arrive. A team that
fails is said in one line with a Retry for that team alone. No single request
is heavier than one team's.

## Cost

Nothing until the fold is opened. Opening it reads the rosters (the request
Check a trade already uses). **Find trades** is one request: the rates for
Alex's roster and the team asked about (every roster for All teams), three
settings rows the Waivers screen already keeps, this season's transactions,
earlier seasons' completed trades and the ledger identities. Batched reads
only, no per-player query, no Sleeper call. A Trades load is unchanged.

## Endpoint

`GET /api/leagues/:id/trades/build?sell=a,b&want=3:x,y;4:z&team=3|all&unmarked=1`
(`&cost=1` adds statements and rows returned).

## Files

| file | what |
| --- | --- |
| `core/trades/builder.ts` | the engine |
| `core/trades/builderResponse.ts` | wire types and labels, on the render path |
| `server/services/tradeBuilderService.ts` | the reads |
| `web/components/tradeBuilder.tsx` | the fold, cards and sheet |
| `web/tradeMarks.ts` | marks in browser storage |
| `scripts/probe-trades-builder.mjs` | the round's production probe |

## Open decision: marks across devices

Saving marks on the server would need a new table (or a settings row per
league, which is a schema-free but shared, unauthenticated-read surface). Not
built. See the round report for the recommendation.
