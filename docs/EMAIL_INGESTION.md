# Automatic newsletter ingestion

The pipeline is built for automatic delivery, not copy/paste. What is missing is
only the transport — the parser, classifier, persistence, idempotency and review
workflow are complete and tested.

## What already works

```
EmailMessage ──► qualifies() ──► processNewsletter() ──► evidence + review queue
```

- `EmailSource` (`src/core/newsletter/source.ts`) is the transport interface.
  `FixtureEmailSource` (pull) and `ManualEmailSource` (push) implement it today.
- `toEmailMessage()` normalises any provider payload into the shared shape.
- `parseRawEmail()` (`src/worker/index.ts`) extracts the HTML or plain-text part
  from a raw MIME message, handling quoted-printable and base64 bodies.
- `NewsletterService.ingest()` qualifies the sender, skips duplicates by message
  id *and* by content fingerprint, stores evidence, refreshes the signal cache
  and routes ambiguity to review.
- `POST /api/newsletter/ingest` accepts a message over HTTP.

## Step 1 (required): configure your newsletter sender

Qualification is deliberately strict — unrelated mail is never processed. The
default config points at a placeholder domain, so **nothing qualifies until you
change it**.

```bash
curl -X POST https://<your-worker>/api/newsletter/sources \
  -H 'content-type: application/json' \
  -b 'fa_session=<your session cookie>' \
  -d '{"sources":[{
        "id":"ff-newsletter",
        "label":"FF Newsletter",
        "fromPatterns":["newsletter@yourprovider.com"],
        "subjectPatterns":["week \\d+","waiver","start.?sit"],
        "enabled":true
      }]}'
```

`fromPatterns` are case-insensitive substrings of the From header (a bare domain
such as `@yourprovider.com` works). `subjectPatterns` are regex sources; an
empty list means "any subject from this sender qualifies".

## Step 2: pick a delivery transport

### Option A — Cloudflare Email Routing (recommended; push, no polling)

The worker already exports an `email()` handler.

1. Add your domain to Cloudflare and enable **Email Routing**.
2. Create an address, e.g. `ff@yourdomain.com`.
3. Route it to this Worker (Email Routing → Routes → *Send to a Worker*).
4. Add to `wrangler.toml`:

   ```toml
   [[send_email]]
   name = "FF_INBOX"
   ```

   (only needed if you later want the worker to *send* mail; receiving needs no
   binding — just the route.)
5. Forward your newsletter to `ff@yourdomain.com` with a filter in your existing
   mailbox, or subscribe with that address directly.
6. Redeploy: `npx wrangler deploy`.

Unqualified mail is ignored silently rather than rejected, so a bad filter never
bounces mail back to the sender.

### Option B — Gmail API poller (pull)

Nothing in the app blocks this; it needs a `GmailEmailSource implements
EmailSource` and OAuth credentials.

1. Create a Google Cloud project, enable the Gmail API, create an OAuth client.
2. Obtain a refresh token for your account with the
   `https://www.googleapis.com/auth/gmail.readonly` scope.
3. Store `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` and `GMAIL_REFRESH_TOKEN` as
   worker secrets.
4. Implement `fetchNew({ since, limit })` to exchange the refresh token for an
   access token, call `users.messages.list` with a query such as
   `from:newsletter@yourprovider.com after:<since>`, fetch each message and map
   it through `toEmailMessage()`.
5. Call it from `scheduled()`:

   ```ts
   await new NewsletterService(env.DB).ingestFromSource(new GmailEmailSource(env));
   ```
6. Add a cron trigger (e.g. `0 */6 * * *`).

The service already tracks the last processed timestamp
(`NewsletterRepo.lastProcessedAt`) and passes it as `since`, so a poller only
fetches new mail.

### Option C — inbound webhook (SendGrid / Postmark / Mailgun)

Point the provider's inbound-parse webhook at `POST /api/newsletter/ingest` with
`{ messageId, from, subject, date, html, text }`. Add a shared-secret header
check to the route before exposing it publicly — it currently requires the
normal session cookie.

## Idempotency guarantees

Reprocessing is always safe:

- a message already recorded by `message_id` **or** by content fingerprint is
  skipped entirely;
- evidence inserts are `ON CONFLICT DO NOTHING` on a dedupe key derived from
  (message id, player, normalized excerpt, rule id);
- rows carrying a `user_override` are never modified by reprocessing.

`NewsletterService.reprocess()` exists to re-run an updated rule set over an old
message: it inserts only genuinely new items and leaves your corrections intact.

## Tuning the rules

`src/core/newsletter/rules.ts` is data. Add a phrase family by appending an
object with `id`, `category`, `polarity`, `magnitude`, `pattern` and an optional
deterministic `template`. Set `enabled: false` to retire a rule without breaking
the historical `rule_id` on stored evidence.

Set `selfNegating: true` when a pattern already encodes its own negation
("did not practice"), otherwise the negation scanner would flip it twice.

After changing rules, re-run `npm test` — the classification suite covers
positive, negative, negation, mixed and confidence behaviour.
