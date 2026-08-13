# Newsletter ingestion

## The design

The FF Newsletter is subscribed **directly to an address owned by Fantasy
Analyst**. Nothing reads a personal inbox, and there is no forwarding step.

```
FF Newsletter
  -> fantasy-news@<your-domain>          (Cloudflare Email Routing)
  -> Worker email() handler              (src/worker/index.ts)
  -> sender validation + idempotency     (NewsletterService.ingest)
  -> sanitize, de-boilerplate, segment   (core/newsletter/html.ts)
  -> player detection                    (core/newsletter/mentions.ts)
  -> deterministic classification        (core/newsletter/classify.ts + rules.ts)
  -> evidence ledger                     (evidence_items)
  -> derived player tallies              (player_signal_cache)
  -> review queue when uncertain
```

Why a dedicated address rather than Gmail access:

- the app never sees personal mail;
- only intended newsletters reach the parser;
- no OAuth, no tokens, no consent screens;
- filtering is trivial because the mailbox has exactly one purpose;
- the Worker `email()` handler receives it directly, with no polling.

**Gmail/personal-inbox integration is deliberately not implemented.** It is
unnecessary for this workflow.

## What happens to each email

1. **Logged.** Every message is recorded — sender, subject, time, outcome — so
   Settings can always answer "did anything arrive?".
2. **Deduplicated.** The same message id is never handled twice. Identical
   content is skipped only if it was previously *processed*, so a spoofed
   lookalike cannot block the real newsletter.
3. **Validated.** Mail from an unconfigured sender is **quarantined**: recorded,
   visible in the app, never parsed, never counted. Unexpected mail is not
   rejected at the SMTP level, because rejecting bounces the message back and
   looks like a broken subscription.
4. **Size-checked.** Bodies over 2 MB are rejected rather than parsed.
5. **Processed** through the deterministic pipeline.
6. **Never fatal.** A parse failure is stored with a plain-language message and
   changes nothing. `email()` never throws, so mail is never bounced or retried
   in a loop.

## Configuration

Two settings, both editable in the app under **Setup → Newsletter**:

| Setting | Meaning | Where it comes from |
|---|---|---|
| Inbound address | The address to subscribe the newsletter to | `NEWSLETTER_ADDRESS` in `wrangler.toml`, or an in-app override |
| Expected sender | Which sender is allowed to produce evidence | Saved in the app; stored in `settings` |

An optional subject filter can narrow it further. Subject text typed in the app
is escaped and matched literally, so `Week (1)` means those characters, not a
regular expression.

Until an expected sender is saved, **nothing qualifies** — that is intentional.

## Cloudflare Email Routing setup

Step-by-step, dashboard-level instructions live in `docs/SETUP.md`, step A5. In
short: enable Email Routing on the domain, create a custom address, and route it
to the `fantasy-analyst` Worker.

No `send_email` binding is required — the app only receives.

## Idempotency guarantees

- A message id already seen (in any outcome) returns `duplicate`.
- Content already processed returns `duplicate`.
- Evidence rows are inserted `ON CONFLICT DO NOTHING` on a dedupe key derived
  from (message id, player, normalised excerpt, rule id).
- Rows carrying a user override are never modified by reprocessing.

`NewsletterService.reprocess()` re-runs an updated rule set over a stored
message: it inserts only genuinely new items and leaves corrections intact.

## Coverage reporting

Every processed newsletter stores a small report, shown in the app under
**Setup → Newsletter → Recent emails**:

- sentences that mentioned one of your players
- how many produced a signal
- how many matched no rule
- how many had an unclear player
- examples of the sentences no rule matched
- name-like words that are not in the player dictionary

Unmatched content is **not an error** — most sentences in a newsletter carry no
news. The report exists so the rule dictionary can be improved deliberately,
without an LLM.

## Tuning the rules

`src/core/newsletter/rules.ts` is data. Add a phrase family by appending an
object with `id`, `category`, `polarity`, `magnitude`, `pattern` and an optional
deterministic `template`. Set `enabled: false` to retire a rule without breaking
the historical `rule_id` on stored evidence.

Set `selfNegating: true` when a pattern already encodes its own negation
("did not practice"), otherwise the negation scanner would flip it twice.

After changing rules, run `npm test` — the classification suite covers positive,
negative, negation, mixed and confidence behaviour.

## Other delivery routes (not needed, kept working)

- `POST /api/newsletter/ingest` accepts a message directly. Used by tests and
  available as an escape hatch; requires a session.
- `EmailSource` (`core/newsletter/source.ts`) remains the interface for any
  pull-based source, should one ever be wanted.
