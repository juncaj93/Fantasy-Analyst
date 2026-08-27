# Newsletter ingestion

## The design

The FF Newsletter is subscribed **directly to an address owned by Fantasy
Analyst**. Nothing reads a personal inbox, and there is no forwarding step.

```
FF Newsletter
  -> fantasy-news@<your-domain>          (Cloudflare Email Routing)
  -> Worker email() handler              (src/worker/index.ts)
  -> sender validation + idempotency     (NewsletterService.ingest)
  -> decode, sanitize, de-boilerplate    (core/newsletter/mime.ts + html.ts)
  -> stored, and marked as awaiting a tally
  -> Setup shows a mark; nothing is scored
```

...and then, when you have a minute:

```
Copy for ChatGPT                         (NewsletterService.chatSource)
     the article, plus the rules the answer will be held to
  -> your weekly ChatGPT thread
  -> Paste AI tally                      (core/newsletter/aiTally.ts)
  -> names resolved against Sleeper      (core/identity)
  -> preview: exactly what would change  (previewAiTally — writes nothing)
  -> you approve
  -> evidence ledger, once               (applyAiTally)
  -> derived player tallies              (player_signal_cache)
  -> review queue for a name that did not resolve
```

The copied block carries the job as well as the material: the exact protocol to
answer in, the four scores the importer accepts, one row per player for this
issue only, omit the players whose signals cancel, a reason in football words —
because that reason is what a player's card shows — and full names, because the
identity ladder resolves a name to one player or to nobody and never guesses.
Every one of those is a rule the importer already enforces or already assumes;
sending them with the article is what makes a fresh chat thread, or a different
phone, produce an answer the app can actually read.

**Arrival scores nothing.** Reading editorial analysis and judging what it means
for a player's value is a semantic question, and the honest ways to answer it are
a paid model at runtime or a person. This app has ruled out the first, so the
judgment lives in a conversation you already have — and every deterministic part
of the job around it stays in the app.

The sentence-level classifier (`core/newsletter/classify.ts` + `rules.ts`) still
runs on arrival, and its verdicts are **discarded**. What is kept from it is the
coverage report: whether the body decoded into readable text, how much of it
there is, and which name-like spans the player dictionary does not know. Those
are facts about the *delivery*. None of them is an opinion about a player.

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
6. **Stored, and marked `awaiting`** — the durable state on
   `newsletter_messages.tally_state` that puts the attention dot on Setup and
   draws the two workflow controls under the Newsletter row. Mail nobody could
   tally — quarantined, oversized, or with no readable body — is
   `not_applicable` and asks for nothing.
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

## Exactly once

There is one authoritative scoring path — an approved ChatGPT tally — and three
independent guards on it, because a double count is silent, permanent, and lands
in the ledger every recommendation in this app reads.

- **Delivery.** A message id already seen (in any outcome) returns `duplicate`.
  Content already processed returns `duplicate`.
- **The application claim.** `newsletter_tally_applications` holds one row per
  (newsletter, exact tally). The insert *is* the decision, so a double tap, a
  reload, or a retry after a timeout cannot both conclude they are first — the
  loser writes nothing and answers with what the winner did. A pair is a replay
  only while it is the newest application on record: pasting tally A, then a
  corrected B, then A again is three real decisions, and the third is a revision
  back to A rather than a repeat of it.
- **The row keys.** Evidence rows are inserted `ON CONFLICT DO NOTHING` on a
  dedupe key derived from (message id, player, score, normalised reason), so
  even a revised tally that repeats a row adds nothing for it.

**An approved tally is the reading of its whole issue.** Applying one retires
whatever the classifier wrote for that newsletter — for every player, not only
the ones the tally names, because the protocol says to omit players whose
signals cancel and so silence about a player is a verdict rather than an
absence of one. Nothing is deleted: `ignored` stops a row counting while it
stays in the ledger with a note saying why, reversible from Review like any
other item. A row the user has ruled on is never touched, and a row the tally
scores the *other* way stops counting and waits for a person rather than being
counted or discarded by default.

Migration `0034_newsletter_awaits_a_tally.sql` does the same reconciliation
once, for issues that arrived before this existed and are still awaiting a
tally. It is scoped by provenance — classifier rows only, never
`ai-tally-import` or `tally-backfill`, never a row with an override or any
history in `user_reviews` — and re-running its two `UPDATE`s changes nothing.

**Reprocessing is gone.** `NewsletterService.reprocess()` and its preview
endpoint were the last live path by which the classifier could put a score in a
player's tally, and one authoritative path means one. The decoding repair they
also carried happens on the way *out* now: `chatSource` runs `recoverBody` over
the stored email every time it is copied, so an issue kept with an undecoded
MIME body still hands ChatGPT clean readable text — and since arrival writes no
evidence, there is no longer a row derived from garbage for a repair to retire.

## Coverage reporting

Every processed newsletter stores a small report, shown in the app under
**Setup → Newsletter → Recent emails**:

- how many sentences were extracted at all
- whether the body needed decoding repairs before it could be read
- sentences that mentioned one of your players
- name-like words that are not in the player dictionary

All four are facts about the *delivery*: did the email decode, and is there text
in it to hand over. The classifier's own counts — how many sentences produced a
signal, how many matched no rule — are still computed and are no longer shown,
because they were a report card on the football in an issue, produced by a path
that no longer scores anything.

## Tuning the rules

**Nothing live reads these any more.** The rule dictionary and the classifier
around it are kept because they explain every row in the ledger that predates
the tally workflow, and because the coverage report still uses the extractor
they sit behind. Editing a rule changes no player's tally.

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
