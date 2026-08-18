# Two markets, one baseline

The draft board prices a player against **the blend of raw Underdog ADP and
Sleeper ADP**, not against Sleeper alone. This page is what the blend is, what
it is emphatically not, and how the numbers behave when it is measured.

## The weights

| League format | DOG | Sleeper |
| ------------- | --- | ------- |
| ordinary redraft | 60% | 40% |
| best ball | 75% | 25% |

Underdog leads because it is the sharper and faster of the two markets: its ADP
comes from best-ball drafts, which run all year, so it moves on news sooner.
Sleeper never goes away, because it is the market the user's picks actually
happen in.

The format is read from **Sleeper's own league settings** by `detectBestBall`.
It is never inferred from the league's name, from anything the user typed, or
from the date. When Sleeper has not published the flag the detection is not
confident, the ordinary 60/40 blend applies, and the board says so in
`marketFormat.confident` rather than guessing.

## What these percentages are not

They weight **the market-baseline component**, which is one input among a dozen:
the newsletter tally in three windows, tiers and scarcity, roster need, My Guy,
the season betting market, opportunity cost, separation from the alternatives,
NFL-team concentration, and survival to your next pick.

Measured against every weight the engine actually applies:

```
DOG = 60% of the market baseline  ->  14.0% of the weight in play
DOG = 75% of the market baseline  ->  17.5% of the weight in play
```

`scripts/probe-dog-dominance.mjs` prints this and the four measurements below.
Run it with `npx vite-node scripts/probe-dog-dominance.mjs` — it imports the
ranking engine directly, which is what lets it hold everything but one variable
still.

## What the blend actually does to a board

On a 160-player synthetic board whose two markets disagree by up to ±12 picks:

| change | players moved | mean | worst |
| ------ | ------------- | ---- | ----- |
| remove DOG (standard) | 136/160 | 2.15 places | 12 |
| remove DOG (best ball) | 143/160 | 3.24 places | 13 |
| remove Sleeper (standard) | 152/160 | 3.21 places | 8 |
| remove Sleeper (best ball) | 139/160 | 2.06 places | 6 |

Both markets matter. Neither dominates. And the response to a widening
disagreement is smooth rather than cliff-edged — mean displacement climbs 1.5,
3.0, 3.6, 8.0, 12.3 places as the spread goes 4, 8, 16, 32, 64 picks.

The bounded non-market signals still outvote a market disagreement up to about
**16 picks**, and lose beyond 20. That crossover is the engine's pre-existing
design — market value has always been the one component a large ADP gap can
carry alone — and it did not move when DOG took the lead in the blend.

## Rules the code enforces

**Only raw ADP may be called DOG.** Underdog publish staff rankings; aggregators
publish projections and consensus ranks. Every one of those sorts roughly like
ADP and would look entirely plausible in a `DOG` column. `validateRawAdp` reads
the *shape* of the values — a dense run of whole numbers is a ranking, whatever
the column was called — and the import route refuses the file with a 422 rather
than storing it with a caveat, so a rejected fetch leaves the last good snapshot
in place.

**Sleeper is never copied into DOG, and DOG is never copied into Sleeper.** Two
sources, two snapshots, two accessors on the board. The whole value of having
two markets is that they can disagree.

**A stale snapshot is never presented as a fresh one.** Freshness is measured
against the time the *source* says its numbers are effective, falling back to
the fetch time only when the source publishes none — a file served at 14:00
whose numbers are from 03:00 is eleven hours old, and a successful fetch is not
evidence of freshness. Past `DOG_FRESHNESS.staleHours` the column is dropped and
the board says why.

**A missing source renormalises rather than penalises.** A player Underdog has
priced and Sleeper has not is priced: DOG carries the whole baseline, the blend
is marked `singleSource`, and he is not sorted to the tail of the board for a
gap in somebody else's coverage. The absent source is never fabricated.

**One absurd value cannot reorder the board.** When two prices are too far apart
to be two opinions about the same player, the Underdog number is set aside as
suspect and Sleeper carries the baseline alone. The threshold has to clear both
a floor of 40 picks *and* 60% of the deeper of the two prices, because either
test alone is wrong — a fixed threshold fires on ordinary late-round noise, and
a proportional one fires on a believable early-board disagreement.

Before the guard, an Underdog price of 1.0 against a Sleeper price of 188
blended to 75.8 and moved that player from 120th on the board to 41st. After it,
he moves one place. The brief's own example of a real disagreement — Sleeper 70,
Underdog 52 — still blends to 59.2, untouched.

**Disagreement is context, never a second bonus.** The blend has already paid for
the eighteen picks between Sleeper's 70 and Underdog's 52; `marketDisagreement`
reports the gap for a card to show, and nothing in the ranking counts it twice.

## What the blend does not reach

`Val` is unchanged. It has always meant "how far past **Sleeper's** ADP this
pick is" — what a player is worth in the room being drafted — and quietly
turning it into a DOG-versus-Sleeper composite would change what a number on
screen means without changing its label. The blended baseline is reported
separately, on the market-value component's own breakdown and in `marketBlend`.

Positional scarcity, the tier ladders and the survival model also still read
Sleeper's own number. The blend reaches `marketValueComponent` and nothing else.

## The card

`Score 88 · ADP 7.8 · DOG 6.2 · Val -4.8 · Next 0%` — five numbers on a line
that was fitted to exactly four.

The card's own priority order, written down before DOG existed, is **gaps first,
then the chip, then type, and nothing ever drops a metric**. That order is what
the fifth number is paid for out of. On a board carrying DOG the tier-cliff
warning uses its short spelling (`Cliff · 2` rather than `Tier cliff · 2 left`)
at phone widths, the metric gaps close up, and the type shrinks a little — with
its **line-height pinned**, which is the part that is easy to get wrong: the row
is as tall as the taller of the metrics line and the chip, so letting the type
shrink freely makes every warned card a pixel taller than its neighbours and the
board loses the rhythm a reader scans down.

The flag goes on the **list**, not on the rows that happen to have a DOG value.
Styling only those rows is the obvious version and it gives the board two card
heights, one for players Underdog has priced and one for players it has not.

A board with no Underdog snapshot is untouched and renders exactly as it did
before any of this existed.

## Sorting

The board offers three orderings — `Score` (default), `ADP` (Sleeper ascending)
and `DOG` (raw Underdog ascending) — and switching between them is a pure
permutation of the rows the client already has. `sortBoard` returns the caller's
own objects by reference and has no way to write to one, so a Score, a `Val`, a
`Next%`, a tier, a tally, a queue flag and a My Guy rating are all provably
unchanged by a sort. Missing values go to the bottom in every mode; the other
market is never substituted for a blank.

Tier dividers are drawn only under `Score`, for the same reason they are off on
a mixed-position board: a divider claims that everything above it is one tier,
which is only true of a sequence the tier model itself produced.

## Getting DOG in

Nothing fetches Underdog at request time. A live draft must never wait on a
third party, so the path is the same one Sleeper ADP already follows: fetch in
CI, import a frozen snapshot.

### The sources, which need no configuration

Both are published pages and the script knows where they are:

| | |
| --- | --- |
| primary | `https://www.bestballteambuilder.com/underdog-best-ball-average-draft-position` |
| fallback | `https://www.4for4.com/underdog/adp` |

Run **Actions → Refresh Underdog ADP**. It also runs daily at 12:00 UTC, an
hour after the Sleeper refresh. Tick **dry run** on a manual run to see what
each source returns without importing anything.

### Reading a board off a page

The primary publishes its Big Board as an ordinary HTML table —
`Player | Position | Team | Round | Overall | ADP | …` — and three of those
columns sort exactly like ADP without being it. The column is therefore chosen
by what its heading *means*, never by position: `ADP`, `Underdog ADP`, `UD ADP`
and `Average Draft Position` name one; `Overall`, `Round`, `Rank`, `Tier` and
any projection are refused by name before the values are even read.

`Overall` is the one that would do real damage. It is a dense 1..500 run, so a
board imported from it looks entirely plausible and is a ranking — which is why
the shape check runs afterwards regardless of how convincing the heading was.

The page's own **Last updated** date becomes `snapshotAt`. It resolves to
midnight UTC, which errs towards calling a board *older* than it is — the safe
direction for a freshness check. A page that publishes no date reports none
rather than borrowing the fetch time.

JSON still works. The parser sniffs the payload, so the source moving between a
page and an endpoint is something this survives rather than something that
silently empties the column.

**What it refuses.** A page with no table carrying both a player column and an
ADP column throws, listing every header it did find. So does an empty React
shell that renders its board in the browser, and so does an ADP column that
holds no numbers. The failure this is written against is not a crash — it is a
redesign, after which a parser that shrugs and takes the nearest table would
fill `DOG` from something that is not Underdog's ADP, with nothing on screen
able to say so.

On the 4for4 fallback the Underdog-named column is preferred as ever. A lone
`ADP` column there is accepted **only** when the page itself names Underdog,
and never when a second ADP column is present — with two, the unnamed one could
be their consensus, which is precisely the substitution this feature exists to
prevent. The CSV export keeps the strict rule: a file has no page context to
vouch for it, so the column must be named.

### Checking a candidate URL

`--dry-run` reports whether the payload parsed, which column was read, how fresh
it is and how many players it carries — and writes nothing:

```bash
npx vite-node scripts/fetch-underdog-adp.mjs --primary <url> --dry-run
```

### Overrides, for the day a site moves its board

| Setting | Kind | Purpose |
| ------- | ---- | ------- |
| `UNDERDOG_ADP_URL` | repo **variable** | replaces the primary |
| `FOUR4_UNDERDOG_ADP_URL` | repo **variable** | replaces the fallback |
| `UNDERDOG_ADP_HEADERS` | repo **secret** | JSON headers for the primary |
| `FOUR4_UNDERDOG_ADP_HEADERS` | repo **secret** | JSON headers for the fallback |

### Authentication, which is not currently needed

The header secrets are expected to stay unset. Do not configure one
pre-emptively: a source that wants credentials says so as an HTTP 401 or 403 in
the workflow log, which the script reports as an authentication problem rather
than leaving you to debug the URL.

If that day comes, headers go in as JSON, from a secret, never the repository:

```
UNDERDOG_ADP_HEADERS = {"cookie":"session=…"}
```

Two things worth deciding deliberately rather than discovering:

**A session cookie is a credential with a short life.** It will expire, the
workflow will start reporting 401, and DOG will age out and drop — visibly, with
a reason, which is the designed behaviour but still a thing somebody has to go
and fix. A long-lived API token is much better where one is available.

**Automated access may not be allowed.** Check a source's terms before pointing
a daily job at it. A subscription that permits personal use does not necessarily
permit a scheduled scrape, and a hard bot check will defeat the fetch regardless.

### The manual route, which needs no URL and no credentials

If a source cannot or should not be fetched by a script, export the board from a
browser you are already signed in to and hand the file over:

```bash
npx vite-node scripts/fetch-underdog-adp.mjs \
  --primary-file ~/Downloads/underdog-board.json \
  --out dog.json --meta dog.meta.json
```

Then POST `dog.json` to `/api/adp/import` with `source: "underdog"` and the
provider, `snapshotAt` and `fetchedAt` from the sidecar.

Nothing downstream can tell the difference: the same parser, the same raw-ADP
validation, the same freshness rules, the same provenance. It costs a manual
step per refresh and it is the right answer when the alternative is storing
somebody's session cookie in CI.

### When a fetch fails

The script exits with a distinct code for each failure, because the right
response to each is different:

| exit | meaning | what to do |
| ---- | ------- | ---------- |
| 1 | neither source reachable | retry later; keep the old snapshot |
| 2 | a source served something that is not raw ADP | alert; do **not** import |
| 3 | every source is too old | keep the old snapshot |

It will never fall back to Sleeper ADP, to Underdog rankings, or to an
aggregator's own consensus column. A missing DOG is a missing DOG: the board
renormalises onto Sleeper alone, marks the baseline single-source, and says why.
