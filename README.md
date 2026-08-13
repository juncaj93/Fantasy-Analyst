# Fantasy Analyst

A private, mobile-first fantasy football decision tool. It combines Sleeper
league/draft state, a frozen Underdog ADP snapshot, deterministically classified
newsletter intelligence and cached Vegas player props into **explainable** draft
and start/sit recommendations.

No paid AI is used at runtime. Every recommendation is a sum of separate,
inspectable components — never one opaque score.

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

**Draft Room** — ranks available players from live Sleeper draft state, showing
ADP, ADP value, survival-to-your-next-pick, news signal, roster need,
positional scarcity and league fit. Tap any player to see every component score,
its weight, its contribution, the reasons and the counterpoints.
It never drafts.

**Team** — Sleeper connection, league selection, ADP import, roster, and
start/sit comparison built from Vegas market expectation, news signal,
availability and an uncertainty penalty. It never changes a lineup.

**Players** — searchable intelligence with tallies by window (7d / 21d / season
/ lifetime), category breakdown, cached prop lines and the full evidence
timeline. Every original excerpt is preserved.

**Review** — anything the classifier was not confident about, plus ambiguous
player identities. Your corrections are authoritative and survive reprocessing.

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
| [docs/STATUS.md](docs/STATUS.md) | what is built, limitations, what is next |

## Tests

```bash
npm run typecheck
npm test               # 335 unit + integration tests
npm run e2e            # WebKit at 390x844, 375x812, 360x800
npm run e2e:chromium   # same specs, fallback engine
```

The original build brief is preserved verbatim in [docs/brief/](docs/brief/).
