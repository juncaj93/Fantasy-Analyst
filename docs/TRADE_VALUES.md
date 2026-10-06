# Trade values: what a trade does to each team's lineup

A trade is judged on one question per side: **how many more points does this
team's best lineup score from now to the end of the league's playoffs?** Then the
two answers are compared. Everything is computed from data the app already has.
Nothing is bought, copied or scraped, and nothing is stored.

It answers two different questions with the same math:

1. **Alex asking about his own idea:** does this help me?
2. **The three-person panel (Alex, Ron, Natey) reviewing a deal between any two
   teams:** is this lopsided?

It lives on the Trades screen under **Check a trade**. It is a recommendation
only. It never proposes, makes or answers a trade, and the card says so.

## Why not KeepTradeCut, and why not FantasyCalc

KeepTradeCut's terms forbid automated collection and forbid using its values in
other tools (checked 5 October 2026), so none of its data is used in any form.
Its values are also crowd-voted and lean dynasty, which is a poor fit for an
in-season redraft league. FantasyCalc was left out of this round because its
terms and Half PPR support are unverified. `core/tradeValue/rate.ts` takes
projections as a plain number per player, so a second source could be offered
later as one more rung of the ladder below without touching the rest.

## What the screen showed before this

Trades had two things: a discovery board (whose newsletter tally is moving) and
**Smart Bilateral Trades**, the offers the app finds for Alex
(`docs/SMART_TRADES.md`). Both value a player by this week's Start/Sit score. The
audit found, and `SMART_TRADES.md` already listed as known limitations:

- no rest-of-season value, no bye or playoff weighting;
- need measured against other rosters, not against the free-agent pool;
- no draft picks;
- the trade deadline not read;
- nothing that checks a trade you bring, or a trade between two other teams.

Nothing already valued a player *for a trade over the rest of the season*. The
existing board is unchanged. This adds a tool beside it.

## The league, as Sleeper publishes it

Read on 6 October 2026 for Tony's Pizza Fantasy:

| Setting | Value |
| --- | --- |
| Teams | 10 |
| Starting slots | QB, 2 RB, 3 WR, **TE**, 2 FLEX (RB/WR/TE), DEF = 10 |
| Bench / injured reserve | 6 / 2 |
| Scoring | Half PPR, 6 pt passing TD, DEF scored on this league's own table |
| Fantasy playoffs | 6 teams, one week per round, **weeks 15 to 17** |
| Trade deadline | **after week 11** |
| Draft picks traded | no (`pick_trading` is 0 this season; it was 1 in 2024 and 2025) |
| FAAB traded | yes, three of this season's trades moved FAAB |

The brief's slot line left out the TE slot. The model reads the slots from
`roster_positions`, not from a description of them.

## The model

### The unit

Projected points over the rest of the fantasy season, **above what a free agent
would give the same lineup**. From week 5 that is thirteen weeks: 5 to 17.

The horizon comes from the league's own settings (`weeks.ts`): the first playoff
week, how many teams make it, and whether a round is one week or two. Every week
counts the same. Only six of ten teams play weeks 15 to 17 and nobody knows which
six in October, so no week is weighted up or down.

### Per-player rate: reuse Start/Sit, add nothing

A player's points per game is the number Start/Sit decides lineups on
(`decisionPoints`): the complete Vegas week where there is one, Sleeper's
published week where the market is not complete, plus the engine's own capped
nudges (news, usage, matchup and the rest), held to **10% of the base**, with
news at most 3%.

This round adds **no news weighting of its own**. The 7-day and 30-day research
tally reaches a trade value only through the engine's existing capped news line,
so projections are about 90% of a value and soft factors stay a small nudge. A
test fails if the model code reads the tally.

One thing is taken out: Start/Sit's availability charge. That charge answers
"this Sunday". Over a season an injury is counted as missing weeks instead
(below), and leaving the charge in would count it twice.

The ladder, strongest first (`rate.ts`):

| Basis | Used when |
| --- | --- |
| Vegas week | the market is complete |
| Sleeper projection | the market is not complete; labelled wherever it is the base |
| Season line | this week's number is not a read of him (bye, ruled out, nothing priced): the market's season totals divided by 17 |
| None | nothing trustworthy |

A partial market, for example one book posting one of four lines, is **never** a
rung. It is a fraction of a week. A player with no basis is **never valued at
zero**: a trade that moves him gets no verdict and says why.

### Byes and injuries

A bye removes one week and nothing else (read from the stored fixture list; if
the list has a gap the bye is "unknown" and no week is removed, which lowers the
card's confidence).

Sleeper gives a designation and never a return date, so injuries are stated
assumptions in one table (`availability.ts`):

| Designation | Counted as |
| --- | --- |
| Questionable | plays 80% this week |
| Doubtful | plays 25% this week |
| Out | out this week, half out next |
| IR, PUP, suspended | out four weeks, then 85% (IR only) |
| In an IR slot | at least "Out" |

Nothing predicts a future injury and nobody is marked injury-prone.

### Replacement level, from this league's free agents

The mean of the best three priced free agents at a position (healthy, not on a
bye). The mean of three, not the single best, because the best free agent by one
week's number is partly one good matchup. It is built from the same shortlist the
waiver scan uses (ten per position, by Sleeper's rank), and then ranked by this
model's own rate.

### Each side's number: the best lineup, week by week

For every remaining week, build the best legal lineup from the roster **plus
replacement-level free agents**, each player's points scaled by whether he plays
that week. Sum the weeks. Do it again with the trade made. Subtract.
(`lineup.ts` solves each week exactly, including FLEX and crossing flex slots.)

That is why:

- a third quarterback adds nothing (he never starts);
- a receiver upgrade is worth a lot to a team whose third receiver is weak;
- losing a starter costs the gap to a free agent, not an empty slot;
- a bye costs one week, and only what the replacement does not cover.

A **depth credit** adds a small amount for bench players better than a free
agent: the best three bench players each earn 10% of their edge over replacement
per week they sit. A trade that leaves a roster over its limit cuts the least
valuable player, and the card says who.

### Alex's preferences: his side only, labeled, capped

Applied after the lineup number, as named line items he can see and subtract:

| Preference | Effect |
| --- | --- |
| No spare QB or TE | no depth credit for one (shown as a negative line if it changed anything) |
| No second DEF before the playoffs | same, until week 14 (prepping for week 15) |
| Second QB or TE not clearly better | a flat 1.0 point charge unless he improves his starter by 6 points over the season |
| Leans RB-heavy when value is close | 3% of the RB value he gains minus the RB value he gives |

All together they are capped at 10% of the value moving, never less than 1.5
points, so on a big deal they stay small. Rivals get **none** of them: the same
lineup math with no opinion about how a manager likes to build a roster.

### The verdict and the close-call band

The verdict compares the two sides: **side A's change minus side B's change**.
Both numbers are always shown, so a deal where Dermot gains 41 and Alex loses 41
reads "82 pts apart" with both figures beside it. The headline says so itself:
"Favors Dermot by about 82 pts over the rest of the season (you −41, Dermot +41)".
That gap is the honest head-to-head difference and also twice what either team
experiences in a swap, so the larger number never appears without the two that
make it.

Each result carries its working: every player's base number, the capped nudges
added to it, his bye and injury weeks, which weeks he starts, and each side's
lineup week by week, so a total can be checked against the weeks it came from.
The probe prints all of it, and a check fails if the weeks do not add up to the
total.

The close-call band is the wider of 4 points or 12% of the larger package, in
points over the rest of the season. Projections have a noise floor and that
noise grows with the size of what moves. A gap inside the band is **"Close
call"** and never a winner. Beyond it, up to 2.5 bands, it "leans"; further, it
"favors".

### Thin data

Confidence drops, and the card says why, when: a player is valued on the season
line (low), on Sleeper's projection (medium), his bye is unknown (medium),
replacement level rests on fewer than three free agents (medium), or one of a
team's Sleeper starters has no projection so its gain may be overstated (medium).
No verdict at all when a moved player has no basis, or a position has no priced
free agent to measure against. When the gap is about the market (a partial week,
a bye, no season line) the sentence ends "Betting lines fill in through the week,
so check again Thursday or later." It does not say that about an injury.

### Draft picks and FAAB

This league does not trade picks this season, and the card says so. In a league
that does, a pick in a deal is **not valued**, and the card says that too. Waiver
money that moves in a trade (it did in this season's three trades) is **not
valued**, always stated. Neither is silently invented.

## Where it lives

| File | What |
| --- | --- |
| `core/tradeValue/weeks.ts` | horizon, deadline, byes |
| `core/tradeValue/availability.ts` | bye and injury weeks |
| `core/tradeValue/rate.ts` | per-game rate, basis ladder |
| `core/tradeValue/lineup.ts` | exact weekly lineup solver |
| `core/tradeValue/evaluate.ts` | replacement, sides, preferences, verdict |
| `server/services/tradeValueService.ts` | gathers one batch of inputs |
| `web/components/tradeCheck.tsx` | the Trades screen section |
| `scripts/probe-trade-values.mjs` | the live check |

Endpoints (all GET, public like every read here):

- `/api/leagues/:id/trades/check/teams`: the rosters, for the pickers.
- `/api/leagues/:id/trades/check?a=&b=&give=&get=`: the check.
  `give` is what team `a` gives up, `get` what team `b` gives up.
- `/api/diagnostics/trade-values`: past league trades replayed.

Add `&cost=1` to any of them to include statements run and rows returned.

## What it costs the database

Nothing is stored, and no schema changes. One request reads, in batched
statements with no per-player queries:

- the league and rosters;
- **only** the two rosters' players and a free-agent shortlist (about 70 players),
  not every rostered player in the league;
- Sleeper's published week by player key, not the whole stored week;
- season lines only for players whose own week is not a read of them;
- the fixture list for the clubs involved, for byes.

`tests/tradeValue.service.test.ts` asserts that no statement runs more than
twice and that rows returned stay under a stated bound, and that the published
week is only ever read by key. The probe reports the measured figure from the
live Worker. It counts rows *returned*, which is a lower bound on rows *read*; the
player dictionary is served from an hour-long memo.

The request never calls Sleeper.

## Checking it against reality

`/api/diagnostics/trade-values` replays the league's own completed trades.
A trade from this season is replayed against both rosters as they stand with the
deal reversed, when every player is still where the trade put him. Anything older,
or a deal whose players have since moved, is reported as each side's bundle valued
today. It is run today on today's data. It looks for absurd outputs. It does not
test whether the model predicts the future.

`scripts/probe-trade-values.mjs` runs the replay and a handful of trades built
from the real rosters, each asked from both teams' chairs (the answer must not
depend on which team is written first), and runs the checks in
`scripts/lib/tradeValueReview.mjs`.

## What the first live run found (6 October 2026)

The probe was run against production the hour it deployed, on a Tuesday. It
passed its own checks (nothing absurd, every answer identical from both teams'
chairs) and still found four things, all fixed in the follow-up:

- **A wrong roster limit.** Sleeper lists this league's two injured-reserve
  slots in `settings.reserve_slots` and not in `roster_positions`, so the limit
  came out two short and a 17-man roster looked over its limit on a one-for-one
  swap, producing a false "would cut" line and a small false charge. The limit
  now comes from the league's settings, and only a trade that makes a roster
  bigger can force a cut.
- **A caution about nothing.** "Your lineup includes a quarterback with no
  projection" was printed on swaps of receivers. It now appears only when the
  trade can reach that starter's slot, directly or through a flex slot.
- **The cost reading was inflated.** The cost meter wrapped the database, and
  the player list is remembered on the database object, so every metered
  request skipped the memory and reported the cost of a cold start. The meter now
  shares the real database's memory and names the statements that returned the
  most rows.
- **A doubled word** in the refusal sentence.

It also showed how often the model says "no number" on a Tuesday: three of six
example trades had no verdict. The reasons are real and none was guessed past:

- Tuesday is when the books have posted the least. A quarterback with only some
  of his lines up is a partial market, and Sleeper's published week is not quoted
  for quarterbacks in a league that pays six points for a passing touchdown, so
  there is nothing to fall back to.
- A player on a bye this week has no game to price, and the market's season line
  is stored for few players.

So the card is sharpest from Thursday on, when the week's lines are complete.
That is a property of the inputs, not of the model, and it is why a trade with an
unpriced player gets a sentence and not a number.

## Known limitations

- **A rate is one week's number carried forward.** It is not regressed toward a
  season-long rate except as a fallback. A player on a hot matchup week is a
  little overvalued and one on a hard week a little undervalued; the matchup
  nudges are capped at a few percent.
- **No return dates.** Injury weeks are assumptions, not forecasts.
- **Every playoff week counts the same,** though only six teams play them.
- **Replacement level uses a shortlist** ordered by Sleeper's rank. A hot waiver
  add outside the top ten at his position would be missed.
- **No picks, no FAAB** (stated on the card).
- **Two-week playoff rounds** (`playoff_round_type` 1 or 2) follow Sleeper's own
  labels and are the least tested path.
- **Not a market price.** It says what a trade does to lineups, not what other
  managers would pay.
