# Fantasy Analyst

A private, mobile-first fantasy football decision tool. It combines Sleeper
league/draft state, a frozen Underdog ADP snapshot, deterministically classified
newsletter intelligence and cached Vegas player props into **explainable** draft
and start/sit recommendations.

No paid AI is used at runtime. Every recommendation is a sum of separate,
inspectable components — never one opaque score.

## Live

**https://fantasy-analyst.juncaj93.workers.dev**

Anyone can read it; changes require the passphrase.

## Deployment

Push to `main` → GitHub Actions tests, migrates and deploys to Cloudflare
Workers, then verifies the live site. See `.github/workflows/deploy.yml`.

Reads are public; every write requires the passphrase. See
[docs/SETUP.md](docs/SETUP.md).

## Quick start

```bash
npm install
npm run dev     # http://127.0.0.1:8787, demo data seeded, passphrase "devpass"
```

Full setup, deployment and first-run steps: **[docs/SETUP.md](docs/SETUP.md)**.

## Stack

React + TypeScript + Vite · Cloudflare Workers + D1 + Wrangler · Vitest ·
Playwright (WebKit at iPhone widths). Runtime dependencies: `react` and
`react-dom`, nothing else.

The repository was empty at the start of this work, so the recommended stack was
adopted rather than migrated.

## What it does

**Draft Room** — ranks available players from live Sleeper draft state on a
best-player-available basis: market value leads, the news tally and your own
♥ My Guy ratings matter, and roster need is a light contextual tiebreaker rather
than a reason to reach. The ★ beside a player is a bookmark — it fills your
queue and the ★ filter, and deliberately changes no ranking. Each card carries
ADP, ADP value, the colour-coded chance he is still there at your next pick —
conditioned on his still being available now, not on his ADP alone — the news
signal, and the season market expectation where one exists. Tap any player for
the conclusion, the four numbers behind it, the strongest reasons and the best
counterpoint; every component score, its weight and its contribution stay one disclosure further in
under **Advanced breakdown**. The header's ↻ force-syncs the latest picks from
Sleeper. It never drafts.

**Draft board** — the ▦ beside the league name opens the room as a board:
rounds down, managers across, the snake running the way it really runs, with
the manager header row and the round column frozen so scrolling never costs you
the context. It opens **compact** — every completed pick is its position in the
position's own colour, which is what makes a receiver run or somebody hoarding
backs visible in one glance — and an expand toggle swaps that for `J. Hurts`,
the position and the club mark, still one cell tall. No score, no ADP, no
value, no Next%: the board is for reading the room, and the analysis is on the
card you came from. It draws the picks the Draft screen already has, so it adds
no polling of its own, and it stays readable as history once the draft is done.

**Team** — the recommended lineup, the bench behind it and the short list of
anybody unrostered worth a move, all built from Vegas market expectation, news
signal, availability and an uncertainty penalty. Balanced, Floor and Ceiling ask
the same question three ways. Tapping one of your players opens his week in a
concise card — the verdict, the role trend, the matchup, the market and the
availability — with the full comparison one tap further on. Pull the screen down
to refresh it. It never changes a lineup.

**Waivers** — in season, where Draft used to be: who is available, how strongly
he is recommended, which slot he fits and what he is worth this week. Expected
cost, likely competition and multi-week value are shown as unknown until the
league-intelligence pass provides them, because a bid we invented would be worse
than an empty field. It never makes a transaction.

Waiver upgrades carry a price: what the room will probably pay, what the player
is worth to *your* roster, and the line past which winning is worse than losing
— three numbers that are frequently far apart, because the most useful thing a
waiver card can say is *he will go for more than he is worth to you*. The budget
comes from the league's own settings and is never assumed; a league that
publishes none, or does not bid at all, is told so instead of being shown an
invented figure. Beside it, what a bid costs you in leverage
(`Bid $24 → $41 remaining · still above 6/9 managers`) and what the rest of
Sleeper is chasing. Nothing here bids, claims, adds or drops: every transaction
in this app happens in Sleeper, by hand, on purpose.

**Players** — searchable intelligence with tallies by window (7d / 21d / season
/ lifetime), category breakdown, cached prop lines and the full evidence
timeline. Every original excerpt is preserved.

Each expanded card opens with a **newsletter takeaway**: one sentence saying why
the tally reads the way it does. It is chosen from evidence the ledger already
holds, never composed — and it changes no number, because the sentence it quotes
has already been counted once by the tally it is explaining.

**Review** — anything the classifier was not confident about, plus ambiguous
player identities and the items already applied. Accept, change, reassign to the
right player, or ignore. Your corrections are authoritative and survive
reprocessing.

**Setup** — the whole configuration experience in plain language: connect
Sleeper, choose a league, import ADP, see the dedicated newsletter address and
tell the app which sender to trust. No commands, no jargon. Appearance lives
here too: **System** (the default, following the phone), **Light** or **Dark**,
kept on the device and applied before the first paint.

## League intelligence

Two fields on every waiver row that would otherwise read as unknown. **Who else
wants him** is the rivals whose healthy bodies at the position do not cover
their starting slots, filtered by what they can still spend — so a card can say
*four teams need one, three of them are broke* rather than counting eleven
funded rivals as eleven bidders. The same count feeds the bid model, which asks
for exactly that number. **How long he is worth holding** separates a player
standing in for somebody hurt from a player who has the job.

Beyond the board: bilateral **trade fits** — deals scored separately for what
you gain, what the partner gains and whether that manager plausibly says yes,
because a deal that is fair and implausible is a deal nobody sends. **Bye and
playoff planning**, which stays silent until a bye actually leaves a slot short
and gives December schedules no weight at all until the season says the team is
heading there. And a **decision feed** that reports something only when a
recommendation actually moved — never when a refresh found the same numbers.

Nothing here submits a transaction; every request it makes to Sleeper is a read.
See [docs/LEAGUE_INTELLIGENCE.md](docs/LEAGUE_INTELLIGENCE.md).

## Newsletter, automatically

The FF Newsletter is subscribed directly to an address owned by the app
(`fantasy-news@<your-domain>`), delivered by Cloudflare Email Routing straight
into the Worker. No personal inbox is ever accessed and nothing is forwarded by
hand. Mail from any other sender is quarantined, never parsed.

See [docs/SETUP.md](docs/SETUP.md) part A5 for the one-time email setup.

## Principles enforced in code

- Sleeper is the source of truth for league, roster, draft and scoring facts.
- Canonical player identity is resolved by a strict ladder; ambiguity goes to
  review and is never guessed.
- The evidence ledger keeps every news item; tallies are derived from it.
- Ambiguous or mixed newsletter classifications never auto-apply.
- Vegas access is behind a provider abstraction, cached aggressively, and
  degrades to the last snapshot marked stale.
- Unknown data is shown as unknown. No value is invented to fill a gap. A
  waiver budget the league does not publish stays unpublished.
- The app advises and never acts. There is no pick, lineup, waiver, bid or trade
  that this app can make.
- Market attention is attention, not quality. What the rest of Sleeper is adding
  prices a bid and raises a question; it never moves a projection.
- A tendency needs a sample. Manager and room profiles say how many trades or
  drafts they rest on, and say nothing at all below the threshold.

## Documentation

| Doc | Contents |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | local dev, deployment, exact manual steps |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | layering, identity ladder, engines |
| [docs/EMAIL_INGESTION.md](docs/EMAIL_INGESTION.md) | wiring automatic newsletter delivery |
| [docs/VEGAS.md](docs/VEGAS.md) | provider abstraction, caching, what to verify |
| [docs/LEAGUE_INTELLIGENCE.md](docs/LEAGUE_INTELLIGENCE.md) | manager profiles, expected FAAB cost, waiver competition, trade fit |
| [docs/IOS_WEB_APP.md](docs/IOS_WEB_APP.md) | installing it on the iPhone Home Screen, and who owns the bottom of the screen |
| [docs/BUDGETS.md](docs/BUDGETS.md) | page-weight and free-tier budgets, and what enforces them |
| [docs/STATUS.md](docs/STATUS.md) | what is built, limitations, what is next |

## Tests

```bash
npm run typecheck
npm test               # unit + integration tests
npm run perf:budget    # gzipped page weight against perf-budgets.json
npm run e2e            # WebKit at 430x932, 390x844, 375x812, 360x800
npm run e2e:chromium   # same specs, fallback engine
```

The original build brief is preserved verbatim in [docs/brief/](docs/brief/).
