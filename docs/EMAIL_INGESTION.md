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
5. **Decoded.** See below — this is a layer in its own right, not a detail.
6. **Processed** through the deterministic pipeline.
7. **Never fatal.** A parse failure is stored with a plain-language message and
   changes nothing. `email()` never throws, so mail is never bounced or retried
   in a loop.

## Decoding (`src/core/newsletter/mime.ts`)

The parser is only as good as the text it is handed, and a decoding fault does
not fail loudly — it produces fragments that quietly match no rule, which reads
in the coverage report as "the rules are bad". So decoding is done to the
standard, once, rather than compensated for downstream:

1. **Headers are unfolded** (RFC 5322) before any of them is read. A header may
   be continued on the next line and `Content-Type` very often is, immediately
   before its `boundary=` parameter.
2. **Multiparts are walked recursively.** `multipart/mixed` wrapping
   `multipart/alternative` is ordinary. Attachments are skipped.
3. **Transfer decoding produces octets.** Quoted-printable and base64 both
   describe bytes, not characters.
4. **The part's own charset decodes those octets.** `=E2=80=9C` is three UTF-8
   octets spelling one `“`; decoding each octet separately yields `â€œ`.
5. **Header values are RFC 2047 decoded**, so an encoded-word subject is stored
   and matched as the text it stands for.
6. **Punctuation is normalized to ASCII** during extraction, matching the HTML
   entity table's existing convention. This is a matching concern, not a
   cosmetic one: `neg.did_not_practice` tests `did ?n[o']?t` and a typographic
   apostrophe in `didn’t` slips straight past it.

> **Why this is spelled out.** One production issue was received, read, and
> turned 209 player sentences into a single signal. `Content-Type:
> multipart/mixed;` was folded before its `boundary=` parameter; the header
> reader saw only the first physical line; with no boundary the entire raw MIME
> payload — part headers, boundary markers, undecoded quoted-printable and both
> alternative parts at once — was handed downstream as the newsletter's plain
> text. Nothing about the rules was wrong.

Bodies are also **repaired on the way in**, so a newsletter stored before this
worked is fixed by re-reading it rather than by a migration: a stored body that
is really raw MIME, undecoded quoted-printable, or UTF-8 that was decoded one
byte at a time is recognised and recovered. A body that was already fine is
returned untouched, and `coverage.repairs` records what had to be done — empty
is the healthy state, and Settings shows a warning when it is not.

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

There is exactly one exception, and it exists to *protect* that guarantee. When
a stored body could not be read and had to be repaired (`coverage.repairs` is
non-empty), insert-only would double count: the rows already stored were derived
from fragments of undecoded text, and the repaired parse describes the same news
in clean prose — a different excerpt, so a different dedupe key. Both would then
sit in the ledger describing one event. So in that case, and only in that case,
the rows this message owns that the repaired parse does not reproduce are
retired to `ignored` — never deleted, and never if the user has ruled on them.
Reprocessing the same message again is then a no-op.

## Coverage reporting

Every processed newsletter stores a small report, shown in the app under
**Setup → Newsletter → Recent emails**:

- how many sentences were extracted at all
- whether the body needed decoding repairs before it could be read
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
