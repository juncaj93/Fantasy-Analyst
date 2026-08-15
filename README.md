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

**Team** — Sleeper connection, league selection, ADP import, roster, and
start/sit comparison built from Vegas market expectation, news signal,
availability and an uncertainty penalty. It never changes a lineup.

**Players** — searchable intelligence with tallies by window (7d / 21d / season
/ lifetime), category breakdown, cached prop lines and the full evidence
timeline. Every original excerpt is preserved.

**Review** — anything the classifier was not confident about, plus ambiguous
player identities and the items already applied. Accept, change, reassign to the
right player, or ignore. Your corrections are authoritative and survive
reprocessing.

**Setup** — the whole configuration experience in plain language: connect
Sleeper, choose a league, import ADP, see the dedicated newsletter address and
tell the app which sender to trust. No commands, no jargon. Appearance lives
here too: **System** (the default, following the phone), **Light** or **Dark**,
kept on the device and applied before the first paint.

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
- Unknown data is shown as unknown. No value is invented to fill a gap.

## Documentation

| Doc | Contents |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | local dev, deployment, exact manual steps |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | layering, identity ladder, engines |
| [docs/EMAIL_INGESTION.md](docs/EMAIL_INGESTION.md) | wiring automatic newsletter delivery |
| [docs/VEGAS.md](docs/VEGAS.md) | provider abstraction, caching, what to verify |
| [docs/PLAYER_AND_LINEUP_INTELLIGENCE.md](docs/PLAYER_AND_LINEUP_INTELLIGENCE.md) | expected points, injury beneficiaries, contingency lineups, self-grading |
| [docs/IOS_WEB_APP.md](docs/IOS_WEB_APP.md) | installing it on the iPhone Home Screen, and who owns the bottom of the screen |
| [docs/STATUS.md](docs/STATUS.md) | what is built, limitations, what is next |

## Tests

```bash
npm run typecheck
npm test               # 1,783 unit + integration tests
npm run e2e            # WebKit at 390x844, 375x812, 360x800 (100 checks)
npm run e2e:chromium   # same specs, fallback engine
```

The original build brief is preserved verbatim in [docs/brief/](docs/brief/).
