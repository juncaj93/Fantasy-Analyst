# Round 21: Vegas sources (research, nothing deployed)

Written Thu Nov 12, 2026. All times Eastern. Report only: no provider, key,
secret or fetch code was added. The one production probe
(`scripts/probe-round21.mjs`, Probe run 43215273225, 7:09 AM ET) ran SELECTs only,
read 81,996 rows (day was at 13.1% before it) and made no odds-provider call.
Its output is in `round21-probe.txt` next to this file.

## 1. Today's pipeline, in plain English

- **One provider:** SportsGameOdds, free "Amateur" plan. It bills per game
  ("entity"), not per market: one call for one game returns that game's total,
  spread and every player prop for 1 entity. Limits that matter: 2,500 entities a
  month and 10 requests a minute. Its pricing page says Amateur data updates
  every 10 minutes.
- **What we fetch:** only the games of teams on Alex's roster, his opponent and
  the waiver short list (about 9 to 12 games a week, never the whole slate).
  Markets kept: passing yards and TDs, rushing yards, receptions, receiving
  yards, anytime TD, plus the game total and spread from the same answer.
- **When we look (the "kickoff clock"):** 48, 24, 6, 3, 1.5 and 0.5 hours before
  each game, riding the 5-minute tick. A team's game is only discovered once it
  is inside 48 hours. Alex's own refresh taps add looks on top.
- **What we spend:** 496 of 2,500 entities this billing month (read Wed 8:15 PM).
  About 20%. Sundays cost 34 to 45 entities, a quiet weekday 1 to 5.
- **Implied team points:** game total / 2 minus spread / 2, from the one
  provider's own total and spread (`impliedTeamTotal` in
  `core/startsit/staleLine.ts`).
- **One number per line:** we store the provider's own consensus line
  (`bookOverUnder`). The same answer also carries per-book lines (FanDuel,
  DraftKings, Caesars were seen in the Aug 22 probe), which we currently ignore.
- **Storage:** every look writes a full copy of the game: one `prop_snapshots`
  row plus 50 to 80 `player_props` rows, changed or not.

### Why numbers arrive when they do

**Our schedule, not the provider and not the books.** The probe shows:

- **Every first look already had a game total (66 of 66 games)**, including looks
  made 7 days before kickoff. Books posted totals and spreads long before we
  asked.
- **Thursday games:** our first look is exactly 48 hours out (Tuesday 8:15 PM),
  which is the clock's first checkpoint. Props were already there every time.
- **Sunday games:** median first look 103 hours out (early games) and 117 hours
  (late games), earlier than the clock's 48-hour first look, so those came from Alex's taps and discovery.
- **The provider was never the limit:** no refusals in the last 8 days, and 80%
  of the month's allowance unused.

## 2. Free sources found

Provider sites could not be fetched from this sandbox (their hosts are outside
the network allowlist, and the brief says not to ask for more access). Every
claim below comes from search-engine excerpts of the provider's own pages,
cited by URL. "Unverified" means the excerpt was unclear or came from a
third party. Alex should check those items on the live page before signing up.

| Source | NFL markets on free plan | Books | Free limit | Signup | Terms (storage, private use) | Verified? |
|---|---|---|---|---|---|---|
| **SportsGameOdds** (have it) | Totals, spreads, moneyline, all our player props | FanDuel, DraftKings, BetMGM, Caesars, ESPN BET and others (per-book lines present on free plan in our Aug probe) | 2,500 games/month, 10 requests/min | Done (key `SPORTSGAMEODDS_API_KEY`) | No reselling or bulk redistribution; storage not addressed; private use fine | Limits measured by our own probes (Aug 2026). Per-book lines: measured Aug 22, recheck. |
| **The Odds API** | Totals, spreads, moneyline for the whole slate in one call; player props one game at a time (pass yds, pass TDs, rush yds, anytime TD confirmed; receptions and receiving yards unverified) | DraftKings, FanDuel, BetMGM, Fanatics, BetRivers, Bovada and others (Caesars paid only) | 500 credits/month. Cost = markets x regions. Totals + spreads for every game = 2 credits. Props = about 1 credit per market returned per game | Free account + API key, no card | Storing allowed indefinitely; display allowed; no resale or raw redistribution; no attribution required (terms updated Aug 31, 2026) | Yes from provider page excerpts; per-minute limit unverified |
| **TheRundown** | Totals, spreads, moneyline. **No player props on free** | BetMGM, DraftKings, FanDuel | 20,000 "data points"/day (one price, one market, one book). One page also says 200,000/month cap (unverified). 5-minute delay on free | Free account + API key, no card | Not checked (unverified) | Free limit from provider pricing page excerpt; props exclusion from a comparison page (unverified) |
| **SharpAPI** | Totals, spreads, moneyline; player props on free is unclear (one docs table lists DraftKings only) | DraftKings, FanDuel | 12 requests/min, 60-second delay; one excerpt says 500 credits/month (unverified) | Free account + API key, no card | Must show "Data provided by SharpAPI" next to any odds shown | Mostly unverified |

## 3. Ruled out

- **Odds-API.io:** new free keys are "paused indefinitely".
- **OddsPapi:** 200 to 250 requests a month, and props are a paid add-on.
- **BallDontLie:** odds and props are on the $39.99 plan.
- **SportsDataIO:** the free trial returns scrambled data, and real odds cost $99/month.
- **API-Sports American Football:** about 100 requests/day (unverified). Props
  and books are unclear, so it is probably game lines only.
- **OpticOdds, OddsJam, OddsBlaze, Unabated:** no free plan (sales contact or paid).
- **ESPN:** odds appear on undocumented endpoints, which breaks the "documented only" rule.
- **Pinnacle:** public API closed in July 2025.
- **Sleeper:** has no odds.

## 4. How often each source could refresh (one NFL week)

Assumptions: the app cares about 12 games a week (today's footprint); the full
slate is 14 to 16 games. A Sunday game is "live" for us from Tuesday, about 120
hours. Speeds tested: **A** every 6 hours (about 20 looks a game), **B** hourly
(about 120 looks), **C** every 6 hours, then every 15 minutes for the last 12
hours (about 66 looks).

| Source, market | A: every 6h | B: hourly | C: 15 min on game day |
|---|---|---|---|
| SportsGameOdds, everything (1 entity per game per look; about 580 a week free, less about 60 for taps) | 240/week, about 1,030/month: **fits** | 1,440/week: **no** | 790/week: **no** |
| The Odds API, totals + spreads (2 credits per whole-slate call; about 115 a week free) | 56/week, about 240/month: **fits** | 336/week: **no** | about 200/week: **no** |
| The Odds API, props (about 6 credits per game per look) | 12 games once = 72 credits, so **one targeted fill a week at most** | no | no |
| TheRundown, totals + spreads (about 100 to 200 points per whole-slate call against 20,000 a day) | about 800/day: **fits** | about 4,800/day: **fits** | about 19,000/day: **just fits** (if the 200,000/month cap is real, hourly is the safe limit) |

Bottom line: **player props can only come in volume from SportsGameOdds.** Game
totals and spreads are cheap everywhere and can refresh hourly through TheRundown.

## 5. When lines really post vs when we saw them

From the probe (66 games, Oct 12 to Nov 16, 495 stored looks) plus published
guides:

- **Game totals and spreads:** posted at least 7 days before kickoff. Books
  reopen the next week's board on Sunday night, and look-ahead lines exist even
  earlier (CBS Sports, 4for4). Our first look always found them.
- **Player props, Sunday games:** looks made 7 days out (Saturday night to Monday
  afternoon of the week before) had **no props in 11 of 11 games**. By Wednesday
  morning every Sunday game had them. So props post roughly **Monday night to
  Wednesday morning**. Caesars' own guide says "a few days before each game",
  filling out in the last 24 to 48 hours.
- **Player props, Thursday games:** already up at our first look (Tuesday 8:15 PM)
  every time, so they post Monday or Tuesday. We are about a day late.
- **Props keep arriving.** A game had about 50 lines at our first look and
  about 70 at the last. New lines show up most 24 to 72 hours out and a few
  even in the last 90 minutes. A player missing on Wednesday often gets a line
  by Saturday. One still missing Saturday night probably never will.
- **How often lines move** (share of prop lines that changed between two looks
  in a row; game totals that moved):

  | Hours out | Prop lines changed | Totals moved |
  |---|---|---|
  | over 96 | 18% | 11% |
  | 72 to 96 | 25% | 39% |
  | 48 to 72 | **34%** | 19% |
  | 24 to 48 | 17% | 11% |
  | 6 to 24 | 10% | 16% |
  | 1.5 to 6 | 11% | 8% |
  | under 1.5 | 9% | 20% |

  Props move most **48 to 96 hours out**, which is exactly when the clock does not
  look. Totals move a little all week and jump again in the last 90 minutes (the
  inactive list).

## 6. Combining design (recommendation only)

**Average by book, not by app.** Every API resells the same few books
(DraftKings, FanDuel, BetMGM, Caesars). DraftKings' 64.5 seen through two APIs
is one opinion, not two. So the "3 numbers" are up to 3 **books**, deduplicated
by book name, from whichever API delivered them most recently.

- **Per number** (each player prop line, game total, spread): take every fresh
  book value.
- **Fresh** means seen within: 12 hours when the game is more than 24 hours out,
  3 hours when it is 2 to 24 hours out, 45 minutes under 2 hours. Older values
  are ignored.
- **Outlier:** with 3 or more books, drop one that is further from the median
  than: total 3.0 points, spread 2.5, yards max(10 yards, 15%), receptions 1.0,
  TD lines 0.5, anytime TD 15 percentage points. Average what is left (one
  decimal).
- **Two books:** average them if they are inside the band above. If not, use the
  one seen most recently.
- **One book:** use it as is.
- **Priced** = at least one fresh book. Requiring two would mark many players
  unpriced who are priced today, so the "8/10 priced" count would get worse, not
  better.
- **No book:** today's minus-1 rule, unchanged.
- **Team points:** combine the total and the spread first, then use today's
  `impliedTeamTotal` on the combined pair. Every screen keeps one function.

**Database writes.** Today every look rewrites the whole game. The probe
counted about 1,060 `player_props` rows a day on average and 3,217 on the
Sunday peak. Each row also updates 4 indexes, so D1 bills about 5 written rows
per line: **about 5,300 a day on average and about 17,000 on Sundays** (this is
the "18,000 a day" from earlier reports).

Proposed: write a game's lines only when the **combined** number changes. The
probe shows about 13% of lines change between looks. Per-book values and their
last-changed time go in the existing `books_json`, `book_count` and
`consensus_method` columns, so **no schema change** is needed. Game lines update
the one `vegas_events` row only on change. A look that changes nothing writes
nothing.

Estimate with 3 books and 10 looks per game (12 games): about 65 lines on the
first look, then about 10 a look, so about 160 rows per game a week, or about
1,900 rows a week. Add hourly game lines for the slate (changes only) and
per-source stamps:

| | Today | Proposed, 3 books |
|---|---|---|
| Average day | about 5,300 | **about 2,000** |
| Sunday peak | about 17,000 | **about 5,500** |
| Share of 100,000 cap (peak) | 17% | **5.5%** |

The catch: screens read "the newest copy of a game" today. Write-on-change
means they must read "the newest value per player and market" instead. That
read change is the biggest build item and must keep reads small (it can use
the existing `(snapshot_id, player_id)` and `(player_id, market)` indexes).

## 7. Recommendation

**Set of 3 (all $0):**

1. **SportsGameOdds (keep):** props, totals and spreads, and start reading the
   per-book lines it already sends (FanDuel, DraftKings, Caesars, BetMGM). This
   gives an average of up to 3 books for every prop **at no extra cost and with
   no new account**.
2. **TheRundown (new, free):** totals and spreads from BetMGM, DraftKings and
   FanDuel for the whole slate, **hourly**. It is a second, independent feed for
   game total and team points, and it covers games our roster-only fetch skips.
3. **The Odds API (new, free, optional):** totals and spreads every 8 hours
   (about 180 credits a month), plus one Friday props fill for players
   SportsGameOdds has no line for (about 60 credits). This is the backup if
   SportsGameOdds has an outage.

**Schedule for SportsGameOdds:** add checkpoints at **120, 96 and 72 hours** (that
is where props post and move most) and discover a team's game 5 days out
instead of 2. Thursday games then get their first look on Saturday or Sunday,
and Sunday games on Tuesday afternoon. 10 looks a game x 12 games is about 120 a
week, about 520 a month plus about 250 for taps: **about 31% of 2,500.**

**Nicer but not free (prices unverified):** The Odds API's paid tier (hourly
props across all books), TheRundown's $49 plan (adds props, no delay),
SharpAPI Hobby $79 (5 books, real time), any SportsGameOdds paid tier (more
entities, faster updates).

## 8. What Alex would do (only if he approves)

- Create a free account at **therundown.io** and copy the API key into a GitHub
  repository secret named **`THERUNDOWN_API_KEY`**.
- Optional: create a free account at **the-odds-api.com** and add secret
  **`ODDS_API_KEY`** (the app already knows this name).
- On each provider's live pricing page, check the items marked unverified above
  (TheRundown monthly cap and whether totals cost per side, The Odds API
  receptions market keys).
- No card on any of them. Do not start a free trial of a paid plan.

## 9. Build order if approved

1. **Earlier looks** on SportsGameOdds (checkpoints at 120, 96 and 72 hours,
   discovery 5 days out). No new account. It fixes "late" on its own.
2. **Per-book reading and combining** (median and outlier rules above), plus
   write-on-change. This should cut today's odds writes by about 60%.
3. **TheRundown** game lines hourly, combined by book.
4. **The Odds API** (optional) game lines every 8 hours plus the Friday props
   fill.

Each step is one PR with tests and its own budget check. Recheck per-book
lines on the free plan with one SportsGameOdds probe (1 entity) before step 2.

## Sources

- SportsGameOdds: [pricing](https://sportsgameodds.com/pricing), [rate limits](https://sportsgameodds.com/docs/info/rate-limiting), [FAQ](https://sportsgameodds.com/docs/faq), [player props](https://sportsgameodds.com/player-props-odds-api), [terms](https://sportsgameodds.com/terms), plus our own measurements in `docs/VEGAS.md`
- The Odds API: [home](https://the-odds-api.com/), [v4 guide](https://the-odds-api.com/liveapi/guides/v4/), [NFL](https://the-odds-api.com/sports/nfl-odds.html), [markets](https://the-odds-api.com/sports-odds-data/betting-markets.html), [bookmakers](https://the-odds-api.com/sports-odds-data/bookmaker-apis.html), [update intervals](https://the-odds-api.com/sports-odds-data/update-intervals.html), [terms](https://the-odds-api.com/terms-and-conditions.html), [oddsapiR docs](https://stat.ethz.ch/CRAN/web/packages/oddsapiR/refman/oddsapiR.html)
- TheRundown: [pricing](https://therundown.io/pricing/api), [FAQ](https://docs.therundown.io/faq), [rate limits](https://docs.therundown.io/rate-limits), [vs SharpAPI](https://therundown.io/compare/sharpapi), [plan change note](https://pricingsaas.com/companies/therundown/diffs/2026W36)
- SharpAPI: [pricing](https://sharpapi.io/pricing), [free comparison](https://sharpapi.io/compare/free-sports-odds-api), [terms](https://sharpapi.io/terms), [NFL](https://sharpapi.io/nfl-api)
- Ruled out: [Odds-API.io free](https://odds-api.io/pricing/free), [OddsPapi blog](https://oddspapi.io/blog/the-odds-api-free-tier-limits), [BallDontLie NFL](https://nfl.balldontlie.io/), [SportsDataIO](https://sportsdata.io/developers), [API-Sports](https://api-sports.io), [Pinnacle](https://github.com/pinnacleapi/pinnacleapi-documentation)
- Line timing: [Caesars props guide](https://www.caesars.com/sportsbook-and-casino/betting-guide/nfl-prop-bets), [Rotowire](https://commish.rotowire.com/betting/nfl/player-props.php), [CBS look-ahead](https://www.cbssports.com/nfl/news/nfl-week-2-lookahead-lines-early-best-bets-plus-what-week-1-line-movement-can-tell-us-about-week-2-picks), [4for4](https://www.4for4.com/node/163609)
