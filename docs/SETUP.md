# Setup

Everything below is the exact manual work required. Nothing here has been done
for you, because it all needs your accounts, secrets or data.

## 1. Local development (no Cloudflare account needed)

```bash
npm install
npm run dev            # builds the server bundle, seeds demo data, serves on :8787
```

Then open http://127.0.0.1:8787 and log in with the dev passphrase `devpass`
(override with `APP_PASSPHRASE=...`).

The local server uses `node:sqlite` instead of D1 and requires Node 22.5+.
It runs the exact same API code the worker runs.

Useful flags:

| Variable | Effect |
|---|---|
| `FA_SEED=1` | load the synthetic demo dataset on boot |
| `FA_DISABLE_AUTH=1` | skip the passphrase gate entirely (local only) |
| `FA_INSECURE_COOKIES=1` | drop the `Secure` cookie flag so plain HTTP works |
| `FA_DB=./local.sqlite` | persist to disk instead of memory |

## 2. Checks

```bash
npm run typecheck
npm test               # 335 unit + integration tests
npm run e2e            # Playwright WebKit at 390 / 375 / 360
npm run e2e:chromium   # same specs on Chromium, for sandboxes without WebKit
```

`npm run e2e` requires the WebKit browser build:

```bash
npx playwright install webkit
```

## 3. Deploying to Cloudflare

### 3.1 Create the D1 database

```bash
npx wrangler d1 create fantasy_analyst
```

Copy the returned `database_id` into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`.

### 3.2 Apply migrations

```bash
npx wrangler d1 migrations apply fantasy_analyst --local    # local preview
npx wrangler d1 migrations apply fantasy_analyst --remote   # production
```

### 3.3 Set secrets

```bash
npx wrangler secret put APP_PASSPHRASE     # your login passphrase
npx wrangler secret put SESSION_SECRET     # 32+ random bytes, e.g. openssl rand -hex 32
# only if you enable a live odds provider:
npx wrangler secret put ODDS_API_KEY
```

The sportsbook key is read server-side only and is never sent to the browser.

### 3.4 Build and deploy

```bash
npm run build          # produces dist/web, which wrangler serves as static assets
npx wrangler deploy
```

Cron triggers are already declared in `wrangler.toml`:

| Cron (UTC) | Job |
|---|---|
| `0 23 * * 6` | Saturday evening Vegas refresh |
| `0 15 * * 0` | Sunday morning Vegas refresh |
| `0 9 * * *` | daily Sleeper player-dictionary sync |

## 4. First-run checklist inside the app

1. **Team tab → Sync players.** Downloads the Sleeper player dictionary
   (~5MB). Do this first: every other feature resolves through it.
2. **Team tab → Connect.** Enter your Sleeper username and season. This imports
   your leagues.
3. **Select a league.** This pulls rosters, scoring settings and drafts, and
   identifies which roster is yours.
4. **Import an Underdog ADP snapshot** (Team tab). Paste a same-day CSV or JSON
   export. Recognised columns include `name`/`player`/`first_name`+`last_name`,
   `adp`/`average_pick`, `rank`, `team`, `position`. The snapshot is frozen once
   imported; re-importing the identical file is a no-op.
5. **Configure your newsletter sender** — see `docs/EMAIL_INGESTION.md`. Until
   you do, ingestion rejects everything, by design.
6. **Review tab.** Resolve anything the classifier was not confident about.

## 5. Choosing a Vegas provider

The app ships with `VEGAS_PROVIDER = "mock"`, which is deterministic, offline
and free. Before switching to a live provider, read `docs/VEGAS.md` — it lists
exactly what to verify first.

## 6. What is deliberately not automated

- **No auto-draft.** The Draft Room ranks and explains; it never picks.
- **No lineup changes.** Start/sit produces a recommendation only.
- There is no endpoint anywhere that writes to Sleeper, and a test asserts it.
