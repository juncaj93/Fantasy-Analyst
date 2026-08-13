# Status

## Milestone 1 — foundation (done)

| # | Priority | State |
|---|---|---|
| 1 | Canonical player model | Done — strict matching ladder, aliases, ambiguity → review |
| 2 | Sleeper player sync | Done |
| 3 | League connection + selection | Done |
| 4 | League scoring/settings persistence | Done — derived from Sleeper, not hardcoded |
| 5 | Draft-state model + sync | Done — picks, snake maths, poll backoff |
| 6 | Underdog ADP snapshot import | Done — frozen, hash-idempotent, unresolved rows kept |
| 7 | Evidence/tally schema | Done — ledger is truth, cache derived |
| 8 | Deterministic classification engine | Done — editable rules, negation, mixed, confidence |
| 9 | Newsletter ingestion fixtures | Done |
| 10 | Review data model + UI | Done |
| 11 | Vegas provider interface | Done |
| 12 | Mock Vegas adapter | Done, and the default |
| 13 | Initial Draft Room | Done — full component breakdown |
| 14 | Player Intelligence screen | Done |
| 15 | Automated tests | Done |

## Milestone 2 — merge-ready, non-developer setup, automatic newsletter (done)

**Production hazard fixed.** With Workers Static Assets, the asset router
answers before the Worker; combined with the single-page-application fallback,
every `/api/*` request would have returned `index.html` and the API would never
have run. `wrangler.toml` now sets `run_worker_first = ["/api/*"]`.

**Setup screen.** A fifth tab shows the five areas (Sleeper, League, ADP,
Newsletter, Vegas) with ✅ / ⚠️ / ○ status, a one-line summary and the next
action in plain language. Every setup task that used to require a command or a
hand-written request is now a form on the phone. A test asserts the setup copy
contains no developer vocabulary.

**Newsletter by dedicated address.** The production path is
`fantasy-news@<your-domain>` → Cloudflare Email Routing → the Worker `email()`
handler. No Gmail integration, no personal-inbox access, no manual forwarding.
The address comes from `NEWSLETTER_ADDRESS` (or an in-app override), and the
expected sender is typed into Settings.

**Inbound safety.** Every message is logged with its outcome. Unexpected senders
are quarantined — recorded and visible, never parsed. Oversized bodies are
rejected. Failures are recorded in plain language and change nothing. `email()`
never throws, so mail is never bounced.

**Deduplication hardened.** A quarantined or failed message no longer
fingerprint-blocks a later legitimate delivery of the same newsletter; only a
previously *processed* body does.

**Coverage report.** Each processed newsletter records how many player sentences
produced a signal, how many matched no rule (with examples) and which name-like
words are missing from the player dictionary — the raw material for improving
the rules without an LLM.

**Review upgrades.** Every item shows a plain-language reason. New actions:
reassign to the right player via a search box, and a third tab listing already
applied items so automatic decisions stay inspectable and reversible.

## Verification

```
npm run typecheck             clean
npm test                      384 passed (14 files)
npm run e2e:chromium          100 passed at 390x844, 375x812, 360x800
npm run build                 clean
npx wrangler deploy --dry-run bundles; DB, ASSETS and vars all resolve
```

Secrets scan: no keys, tokens, database files or `.dev.vars` are committed.
`wrangler.toml` contains placeholders and comments only.

## Milestone 3 — deployed (done)

Live at **https://fantasy-analyst.juncaj93.workers.dev**, deployed by GitHub
Actions rather than by hand.

- Pushing to `main` runs the tests, finds or creates the D1 database, applies
  migrations, deploys, stores the passphrase, and verifies the live site.
- On first deploy it also loads the NFL player list (3,303 players) so the app
  is usable immediately. That step is skipped once the list exists.
- Verified against the running site: home page 200, database read 200,
  unauthenticated write correctly refused with 401, login 200, player sync 200.
- Reads are public. Writes require the passphrase.

Deploy-time issue found and fixed: Cloudflare rejects `0` as a cron day-of-week
(`invalid cron string: 0 15 * * 0`), which failed the trigger update after the
Worker had already uploaded. Day names are used now.

## Milestone 4 — season mode and verified facts (done)

**Whole-roster lineup.** Team now opens with the best legal lineup for the
league's actual slots, the changes needed to reach it, and the points each
change is worth. It is recommendation-only: there is no control anywhere that
edits a lineup, and an e2e test asserts that.

The assignment is exactly optimal, not a greedy slot-fill. Players are admitted
best-first and each admission is tested by an augmenting path; sets of
simultaneously-startable players form a transversal matroid, so greedy
selection is provably the highest-scoring legal lineup. This matters in leagues
that mix `FLEX` (RB/WR/TE) with `REC_FLEX` (WR/TE), where filling slots in order
strands a back on the bench. A test covers exactly that case.

Unknown still means unknown. A player who cannot be scored is listed separately
as undecidable — never silently benched — and no swap is proposed against a
current starter whose score is unknown. The current-lineup total is withheld
entirely when any current starter is unscorable, rather than treating the gap
as zero. Swaps below 0.75 pts are not suggested at all.

**CI fixed.** The `wrangler deploy --dry-run` step ran without `dist/web`
existing, so every run on `main` was red. It builds first now.

**Facts checked instead of guessed.** `.github/workflows/investigate.yml` is a
read-only manual job that answers questions the dev sandbox has no network path
to reach. What it established:

- `juncaj.net` is an active zone on the Cloudflare account, so the newsletter
  address is possible.
- The deploy token is scoped to Workers/D1 and zone listing only. Reading DNS
  or Email Routing returns `Authentication error` (code 10000).
- The Odds API free tier is 500 credits/month, and all six market keys the
  adapter asks for (`player_pass_yds`, `player_pass_tds`, `player_rush_yds`,
  `player_receptions`, `player_reception_yds`, `player_anytime_td`) are current
  in the provider's documentation.

The market set was deliberately left unchanged. `player_rush_tds` and
`player_pass_interceptions` exist and would model rushing quarterbacks better,
but each added market costs credits against a 500/month allowance, so that is a
decision to make with a real key in hand rather than a free accuracy win.

## Milestone 5 — reprocessing, and the defect it exposed (done)

**Reprocessing could not actually run.** `reprocess()` existed, was tested, and
had no caller — because the message log recorded that an email arrived and what
came of it, but never the email. Improving a rule could therefore only ever
affect newsletters that had not arrived yet, which is exactly backwards.
Migration `0003` retains bodies for processed messages so rules can be re-run
over the issues already in the ledger.

Quarantined mail is still logged but deliberately not retained: it came from a
sender the user never named, and keeping it would mean storing whatever a
stranger chose to send.

**Bodies are never republished.** Reads on this site are public and the
newsletter is someone else's work, so `/api/newsletter/messages` strips bodies
and reports only whether one was kept. A test asserts no message payload
carries body content.

**Preview before applying.** Setup can now show what re-running the rules over
one stored newsletter would do: how many items would be added, the resulting
tally change per player, and — the honest part — which stored items the rules
now read *differently* but will be left alone anyway, because reprocessing is
insert-only so a user's correction always survives. That distinction is
reported as `stale` rather than buried in a skip count; tuning rules without
seeing it is guesswork.

## Milestone 6 — the newsletter address is live (done)

`fantasy-news@juncaj.net` → Cloudflare Email Routing → the `fantasy-analyst`
worker. Confirmed against the live account and the deployed app:

```
MX      juncaj.net -> route1/2/3.mx.cloudflare.net
rule    fantasy-news@juncaj.net -> worker fantasy-analyst   (enabled)
app     address: fantasy-news@juncaj.net
        sender set: false        (nothing accepted yet, by design)
        emails received: 0
```

Enabling Email Routing for the first time turned out to be dashboard-only — a
scoped API token can manage routing *rules* but cannot switch the service on.
The setup workflow now treats that step as best-effort and names the dashboard
path instead of reporting a bare authentication error.

**The setup workflow refuses to break existing mail.** Enabling Email Routing
replaces a domain's MX records, so step one aborts if any MX record exists that
is not Cloudflare's own. That interlock is in the workflow, not in anyone's
head, so it still holds if the workflow is re-run against a domain that has
since been given a mailbox.

**A run is not green until mail can actually be delivered.** The first
successful-looking run had created the routing rule with no MX records behind
it — a configuration that looks finished and silently bounces every newsletter.
The final step now verifies Cloudflare MX records exist.

**Accepting a sender no longer requires knowing it in advance.** Nobody knows
their newsletter's from-address offhand. The first issue arrives, is ignored
because no sender is expected yet, and Setup offers its real address for
acceptance in one tap.

## Milestone 7 — proven with real mail, and a privacy leak it exposed (done)

A real email was delivered to `fantasy-news@juncaj.net` and the whole chain
worked first time:

```
emails received: 1
last received:   from <owner's personal address> (quarantined)
detail:          "Ignored: this address only accepts your configured
                  newsletter sender."
```

Cloudflare accepted the mail, invoked the worker's `email()` handler, the
service logged it and refused to parse it because no sender has been accepted
yet. That is the designed behaviour, and it is now observed rather than assumed.

**The leak it exposed.** Reads on this site are public because fantasy data is
not sensitive. A sender's email address is not fantasy data — it is ordinarily
the owner's own personal address — and the inbound log published it. Addresses
are now masked (`a***@gmail.com`) for anyone without a session and shown in full
once unlocked, which is also the only state in which the sender can be accepted.

Masking the structured `fromAddress` alone was not enough: the plain-language
explanation quotes the sender too ("Unexpected sender ..."), so the address
escaped through the reason string. Redaction runs by pattern over the free-text
fields as well, which also covers wording added later. A test asserts no public
payload carries the raw address.

## Milestone 8 — the sender a bulk mailer actually uses (done)

The first real subscription exposed a bug that would have looked like the
newsletter simply never arriving. The app matched subscriptions against the
**SMTP envelope sender**, and bulk senders put a per-message bounce address
there:

```
bounce+93e88f.63af5d-fantasy-news=juncaj.net@mg-d0.substack.com
         ^^^^^^^^^^^^^ unique to one send
```

Saving that would have matched exactly one issue and then silently stopped —
indistinguishable from the subscription breaking.

- The worker now identifies a newsletter by its visible `From:` header, which
  is stable, and records the envelope address alongside it.
- A subscription matches against **either** address, so someone who copied the
  bounce address out of the log is not silently left with nothing.
- Saving an address that looks like a bounce (`bounce+`, `msprvs`, `prvs`, or a
  `+`/`=` encoded local part) is refused with an explanation and a workable
  alternative, rather than accepted and quietly useless.
- `From:` values arrive as `Display Name <a@b.com>`; the display name is never
  matched against.
- A domain pattern covers that domain's **subdomains**. `@substack.com` has to
  accept `...@mg-d0.substack.com`, because that is where the mail actually comes
  from — a plain substring test rejected exactly the mail the user meant to
  accept. The dot is required, so `@substack.com` still does not match
  `@notsubstack.com`.

## Known limitations

1. **The Odds API adapter is verified but still disabled.** The free tier and
   every market key are confirmed current. What remains unverified is the live
   response shape and actual NFL prop coverage, which needs an API key. Vegas
   shows as "not connected" by design and no quota has been consumed.
2. **No real newsletter has been parsed yet.** Delivery is proven end to end,
   but only with a test email, which was correctly ignored. Rule quality
   against a real issue is still unknown until one arrives.
3. **Rule magnitudes are still conservative** (mostly 1). Expect tuning once
   real newsletters have run through the coverage report.
4. **Draft weights are untuned defaults.**
5. **Survival probability is a heuristic**, labelled as an estimate.
6. **Rate limiting is per-isolate**, not distributed — fine for one user.
7. **Draft polling is client-driven** via the Live toggle.
8. **The browser suite shares one dev server across all three viewports.** Run
   repeatedly against a reused server, accumulated review-queue state can make
   `can reassign an item to the right player` fail; it passes on a fresh server,
   which is what CI uses. Worth isolating per project if it ever fails in CI.

Closed since the last report: **WebKit now runs and passes in CI.** The
"iPhone WebKit smoke tests" job is green on GitHub, so the specs have executed
on the real Safari engine, not only on Chromium locally.

## Recommended next work

1. **After the first real newsletters arrive**, read the coverage report and add
   the missing phrase families. This is the single highest-value improvement to
   tally quality.
2. **Verify and enable a live Vegas provider**, then confirm the cache keeps a
   full NFL Sunday inside the free tier.
3. **Draft-weight tuning UI**, so the market-value vs personal-signal balance is
   adjustable without a deploy.
4. **Tier visualisation on the draft board** — the scarcity component already
   computes tier gaps.
5. **Re-reading everything at once**, rather than one newsletter at a time.
   Worth doing only once real issues have accumulated.
