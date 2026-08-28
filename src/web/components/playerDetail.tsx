/**
 * The expanded player, once.
 *
 * Draft and Players had grown byte-identical copies of `SeasonOutlook`,
 * `OutlookBody` and `LastSeasonLine`, each with its own comment explaining that
 * it was the same as the other one. That is how six renderers happen: nobody
 * writes six on purpose, they write a second and then stop noticing. Everything
 * a card says about a player who is not being ranked lives here now, and every
 * screen that opens a player — Draft, Team, Waivers, Trades, Players, and the
 * matchup view when there is one — reads from this module.
 *
 * The rule these components share is the one the whole app is built on: they
 * quote, they never compose. The outlook is the provider's own sentences in the
 * provider's own order, attributed. The newsletter takeaway is a sentence the
 * ledger already contains, chosen rather than written. Where a value is not
 * known, `Unknown` says so instead of a zero.
 */

import { useEffect, useState } from 'react';
import { api, type PlayerDetail } from '../api.ts';
/* What Sleeper says about a player's availability right now. Never a ranking input. */
import { injuryStatusTag } from '../../core/draft/injury.ts';
import { summaryIsIngestionBookkeeping } from '../../core/evidence/provenance.ts';
import { countsTowardTally } from '../../core/evidence/aggregate.ts';
/* Two rows that are one fact reworded, and which of them to show. Selection only. */
import { distinctByFact, isNearDuplicate } from '../../core/evidence/nearDuplicate.ts';
import { DetailLabel, Unknown, formatDate } from './common.tsx';
import { SkeletonRows } from './native.tsx';

/**
 * Last season and this season's outlook, fetched when the card opens.
 *
 * Not part of any list response on purpose. The draft board is what a live
 * draft waits on and it must never wait on a third party; this is asked for
 * after the user has already decided to look at one player, and a failure to
 * answer costs that one section and nothing else.
 */
export function usePlayerDetail(playerId: string): { detail: PlayerDetail | null; failed: boolean } {
  const [detail, setDetail] = useState<PlayerDetail | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setFailed(false);
    api
      .get<PlayerDetail>(`/api/players/${playerId}/detail`)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  return { detail, failed };
}

/** One item of the ledger, as the browser receives it. */
export interface PlayerNewsItem {
  id: string;
  sourceName: string;
  sourceDate: string;
  excerpt: string;
  contextSummary: string | null;
  ruleId?: string | null;
  polarity: string;
  /**
   * The row's review state, which decides whether it is current.
   *
   * Required, because the endpoint always sends it — `EvidenceItem` in
   * `api.ts` declares it on the same payload — and because a card that cannot
   * tell a live row from a superseded one shows both. Leaving it off this
   * projection is exactly how a retracted sentence reached `Latest news`.
   */
  reviewStatus: string;
  userOverride: { polarity?: string; note?: string } | null;
}

/**
 * The newsletter ledger for one player, fetched when a card opens.
 *
 * The same request `usePlayerRecord` makes on the player page and in the sheet,
 * asked for on its own by the one surface that wants the ledger and nothing
 * else around it: Draft's expanded row, which needs {@link LatestNews} under
 * its insight and has no use for the signal windows, the prop table or the
 * heart. No screen runs both hooks, so this is a second caller of an endpoint
 * rather than a second request for it.
 *
 * Like {@link usePlayerDetail} it fetches only once a card is actually open, so
 * a board of forty rows costs nothing until one of them is tapped, and a
 * failure costs this one block rather than the card.
 */
export function usePlayerLedger(playerId: string): PlayerNewsItem[] | null {
  const [items, setItems] = useState<PlayerNewsItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    api
      .get<{ evidence: PlayerNewsItem[] }>(`/api/players/${playerId}`)
      .then((file) => {
        if (!cancelled) setItems(file.evidence);
      })
      .catch(() => {
        /* The section draws its skeleton and then nothing; the card is intact. */
      });
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  return items;
}

/**
 * One sentence saying why the tally reads the way it does.
 *
 * The signed tally communicates direction and magnitude; this says the single
 * most important supported reason behind it. It is an explanation and nothing
 * else — the evidence under it has already been counted once by the tally, and
 * the server sends `scoreDelta: 0` so that "does this move a number" has an
 * answer rather than a promise.
 *
 * Deliberately here, on the expanded card, and deliberately not on the
 * collapsed Draft, Players or Trades rows: a sentence per row is a paragraph
 * per screen, and the row already carries the number this explains.
 *
 * The raw provenance — which evidence rows, from which issue — stays one
 * disclosure further in, under the timeline, rather than crowding the sentence
 * it belongs to.
 */
export function NewsletterTakeaway({ detail }: { detail: PlayerDetail | null }) {
  const takeaway = detail?.newsletterTakeaway;
  if (!takeaway) return null;
  /*
   * Who said it, and how many of them — kept, and no longer printed.
   *
   * It used to run as ` — Demo FF Newsletter` after the sentence, on every card
   * that had one. This app has exactly one newsletter, so it was the same four
   * words under every player: a name that never varies qualifies nothing, and
   * `LatestNews` two blocks down already withholds a source for that exact
   * reason. What it cost was the end of the one line the section exists for.
   *
   * Nothing is lost. It is on the element's title for a pointer and in the
   * accessible text for a screen reader, `data-corroboration` still carries the
   * count, and the rows it was chosen from are in the evidence timeline with
   * their own sources beside them — which is the surface that exists to answer
   * "where did this come from".
   */
  const provenance =
    `From ${takeaway.sourceName}` +
    (takeaway.corroboration > 1 ? `, and ${takeaway.corroboration - 1} more saying the same thing` : '');
  return (
    <>
      <DetailLabel>Insight</DetailLabel>
      <div
        className="takeaway"
        data-testid="newsletter-takeaway"
        data-corroboration={takeaway.corroboration}
        title={provenance}
      >
        {takeaway.text}
        <span className="sr-only"> ({provenance})</span>
      </div>
    </>
  );
}

/**
 * A body or an age worth a second thought, and nothing when there is not one.
 *
 * Almost always renders nothing, which is the intent. The measurements only
 * appear when a physical flag fired — the server sends them as null otherwise —
 * because a height on every card is a height the reader starts weighing, and
 * this app has no evidence that tall receivers are better receivers.
 *
 * Contextual by construction: every flag carries `weight: 'context'` and the
 * block carries `scoreDelta: 0`. Nothing here is a penalty, and the card says
 * so by never putting a number beside it.
 */
export function ProfileFlags({ detail }: { detail: PlayerDetail | null }) {
  const profile = detail?.profile;
  if (!profile || profile.flags.length === 0) return null;
  const measurements =
    profile.showMeasurements && (profile.heightInches != null || profile.weightPounds != null)
      ? [
          profile.heightInches != null ? formatHeight(profile.heightInches) : null,
          profile.weightPounds != null ? `${profile.weightPounds} lb` : null,
        ]
          .filter((p): p is string => p != null)
          .join(' · ')
      : null;

  return (
    <>
      <DetailLabel>Worth noting</DetailLabel>
      <div className="muted" data-testid="profile-flags">
        {profile.flags.map((flag) => (
          <div key={flag.key} data-testid="profile-flag" data-kind={flag.kind}>
            {flag.text}
          </div>
        ))}
        {measurements ? <div className="faint">{measurements}</div> : null}
      </div>
    </>
  );
}

/** `5'11"` from 71. Inches are how it is stored; feet are how it is read. */
function formatHeight(inches: number): string {
  return `${Math.floor(inches / 12)}'${inches % 12}"`;
}

/**
 * `2026 outlook` — the heading over the provider's paragraph.
 *
 * The season and one word. It was the provider's own title, which reads `2026
 * Season Outlook` and spent a third of the line on a noun the paragraph under
 * it already is. The title is not lost and was never a quotation the reader
 * needed: the attribution that *is* a quotation — `— Rotowire, via Sleeper` —
 * still runs inside the paragraph, and the whole title is still on the payload.
 *
 * Built from the season rather than trimmed out of the title, because trimming
 * a provider's words is how a heading starts saying something the provider did
 * not. When there is no outlook to head, the season the app would have looked
 * for is the honest label for the absence.
 */
function outlookHeading(detail: PlayerDetail | null): string {
  const season = detail?.outlook?.season;
  return season ? `${season} outlook` : 'Season outlook';
}

/**
 * What is expected of him this season, in the words of whoever wrote it.
 *
 * Sleeper serves this through a public endpoint, and it is editorial writing
 * rather than anything Sleeper or this app generated — so it carries its
 * author. Two or three sentences: the full text runs past a thousand
 * characters, and a wall of prose in a live draft is scrolled past rather than
 * read, taking whatever is under it off the screen.
 */
export function SeasonOutlook({
  detail,
  failed,
  heading = true,
  whole,
}: {
  detail: PlayerDetail | null;
  failed: boolean;
  /**
   * Draw the provider's own title above the paragraph.
   *
   * On by default. Draft's compact card turns it off, because a heading over
   * two clamped lines is a third of the card spent naming prose that already
   * names itself — the attribution inside it reads `— Rotowire, via Sleeper`.
   * The title comes back with everything else when the card is opened in full.
   */
  heading?: boolean;
  /**
   * Whether the full text is showing, when the caller owns that decision.
   *
   * Players and the player page let the outlook run its own "read the rest"
   * control, because the outlook is most of what those screens are. Draft's
   * expanded row has one control for the whole card — see `DraftPlayerDetail` —
   * and a second one inside the paragraph it governs would be two answers to
   * the same question. Passing this hands the decision up and suppresses the
   * inner control; leaving it undefined keeps the old, self-governing outlook.
   */
  whole?: boolean;
}) {
  if (failed) return null;
  if (!detail) {
    return (
      <>
        {heading ? <DetailLabel>{outlookHeading(detail)}</DetailLabel> : null}
        <div className="muted" data-testid="outlook-pending">
          Looking it up…
        </div>
      </>
    );
  }
  if (!detail.outlook) {
    return (
      <>
        {heading ? <DetailLabel>{outlookHeading(detail)}</DetailLabel> : null}
        <div className="muted" data-testid="outlook-none">
          {detail.outlookNote ?? 'No outlook published for him.'}
        </div>
      </>
    );
  }
  return <OutlookBody outlook={detail.outlook} heading={heading} governed={whole} />;
}

function OutlookBody({
  outlook,
  heading,
  governed,
}: {
  outlook: NonNullable<PlayerDetail['outlook']>;
  heading: boolean;
  governed: boolean | undefined;
}) {
  const [own, setOwn] = useState(false);
  const whole = governed ?? own;
  const attribution = outlook.source ? <span className="outlook-source"> — {outlook.source}, via Sleeper</span> : null;

  return (
    <>
      {heading ? <DetailLabel>{`${outlook.season} outlook`}</DetailLabel> : null}
      <div
        className="outlook"
        data-testid="outlook"
        data-summarised={outlook.summarised ? 'yes' : 'no'}
        data-whole={whole ? 'yes' : 'no'}
      >
        {whole ? outlook.fullText : outlook.text}
        {attribution}
      </div>
      {governed === undefined && outlook.summarised ? (
        <button
          type="button"
          className="link-button"
          data-testid="outlook-toggle"
          onClick={(e) => {
            // The row underneath is a toggle; expanding the text is not
            // "collapse this player".
            e.stopPropagation();
            setOwn((v) => !v);
          }}
        >
          {whole ? 'Short version' : 'Full outlook'}
        </button>
      ) : null}
    </>
  );
}

/**
 * `Market - 247 Pts · 16 GP · WR7 half-PPR`.
 *
 * One band rather than two lines. What the market expected of him before the
 * season and what he actually did in the last one are three short readings, and
 * three short readings that each took a row of their own were spending two
 * lines of a card on one line of facts. They wrap together now and the card is
 * shorter for it.
 *
 * The year is the first token of the readings it labels rather than a heading
 * over them, on every screen that draws this. It used to be a heading on the
 * wider cards, which cost a row to say one word — and once the market reading
 * joined the band the heading was also *wrong*: `2025` standing over
 * `Market - 247 Pts` would file a projection for the season about to be played
 * under the season already behind it. Inline, the year labels the two readings
 * that follow it and nothing else.
 *
 * Nothing here is guessed. A player who did not appear last season has no games
 * and no finish, and gets a dash: Sleeper will happily report him as the
 * 1,240th receiver, which looks like a result and is really his place in a
 * directory. A player no snapshot named has no market reading at all, and the
 * band is drawn without one.
 */
export function LastSeasonLine({
  detail,
  failed,
  position,
  market = true,
}: {
  detail: PlayerDetail | null;
  failed: boolean;
  position: string | null;
  /**
   * Whether to lead the band with the preseason market reading.
   *
   * On everywhere the surface has not already said it. Draft turns it off: its
   * compact row prints `PTS` two lines up — the same figure, from the same
   * snapshot — so the band underneath was the card answering a question it had
   * just answered, in a place budgeted in rows. The number is not withheld from
   * anybody, it is withheld from being said twice; every other surface that
   * draws this band has no `PTS` of its own and keeps it.
   */
  market?: boolean;
}) {
  if (failed || !detail) return null;
  const season = detail.lastSeason?.season;
  const games = detail.lastSeason?.gamesPlayed;
  const rank = detail.lastSeason?.positionRank;
  const projection = market ? (detail.preseasonProjection ?? null) : null;
  if (!season && !projection) return null;
  return (
    <div className="season-line" data-testid="last-season">
      <MarketPointsMetric projection={projection} />
      {!season ? null : (
        <>
          <span className="metric season-year">{season}</span>
          <span className="metric">
            {games == null ? (
              <>
                GP <Unknown what={`${season} games played`} />
              </>
            ) : (
              <>
                <strong>{games}</strong> GP
              </>
            )}
          </span>
          <span className="metric" title={detail.lastSeason?.scoring}>
            {rank == null ? (
              <>
                {(position ?? '').toUpperCase() || 'Position'} rank <Unknown what={`${season} half-PPR finish`} />
              </>
            ) : (
              <>
                <strong>{rank}</strong> half-PPR
              </>
            )}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * `Market - 247 Pts` — what a market-derived model expected of his season.
 *
 * Four words and a number, and every one of the four is doing a job. `Market`
 * says whose opinion it is; the figure is the opinion; `Pts` says what the
 * figure counts. What is deliberately *not* printed is the provenance line that
 * used to follow it — the source, the capture date and the league's scoring
 * profile, spelled out as `StartWho · Aug 22 · Half PPR, 6pt pass TD`. Four
 * facts about a pipeline, on a card a reader opened to find out about a player,
 * costing a row of a card that is budgeted in rows.
 *
 * **None of it is lost, and none of it is softened.** The whole sentence is on
 * the element's title for a pointer, and in the accessible text for a screen
 * reader, and it still opens with the word *preseason* — because that is the
 * one thing about this number a reader must not get wrong. In week nine it is
 * history. A card that let it read as a live weekly line would be the most
 * expensive kind of wrong: plausible.
 *
 * Absent rather than blank when nothing covers him, so a card costs no height
 * for a player no snapshot named.
 */
function MarketPointsMetric({
  projection,
}: {
  projection: { points: number; label: string; scoringLabel: string } | null;
}) {
  if (!projection) return null;
  const provenance = `Preseason market-derived season projection — captured from ${projection.label}, scored as ${projection.scoringLabel}`;
  return (
    <span className="metric" data-testid="preseason-projection" title={provenance}>
      Market - <strong>{Math.round(projection.points)}</strong> Pts
      <span className="sr-only"> ({provenance})</span>
    </span>
  );
}

/**
 * What he came back from, and what is wrong with him now.
 *
 * Two different facts under two different headings, because a player returning
 * from an ACL and a player with a sore hamstring on Friday are not the same
 * situation and must not read as one. Disagreement between sources is shown
 * rather than averaged away: two sources saying different things is a real
 * state of the world, and the reader is the one who should decide about it.
 */
export function InjuryDetail({
  detail,
  headerCarriesStatus = false,
}: {
  detail: PlayerDetail | null;
  /**
   * Whether the designation is already on the card, beside the name.
   *
   * Off by default, which is every caller that has no pill: Draft's expanded
   * row and the Team/Matchup view both print the designation here or nowhere.
   *
   * On, the block loses its heading and its restatement of the label — the pill
   * two lines up already says `OUT`, and a section titled `Out` whose body
   * reads `Out` is the card saying one word three times. What survives is the
   * part the pill cannot carry: the body part, the practice week, the
   * provenance, and a disagreement between sources, which is a real state of
   * the world and is never averaged away. When the line adds nothing beyond the
   * designation, nothing is drawn at all.
   */
  headerCarriesStatus?: boolean;
}) {
  if (!detail) return null;
  const current = detail.injury;
  /*
   * What the pill cannot carry, rebuilt from the fields rather than trimmed off
   * the line.
   *
   * `injuryLine` composes `Q · hamstring · limited → full`, and its first token
   * is the designation — the very thing sitting beside the name two lines up.
   * Cutting the string apart to remove it would be this file guessing at
   * another module's formatting; the parts are on the payload, so they are read
   * from there. What is left is the body part and the practice week, and when
   * neither is known there is nothing here to say and nothing is drawn.
   */
  const beyondThePill = [
    current?.bodyPart ? current.bodyPart.toLowerCase() : null,
    current?.practice ?? null,
  ].filter((part): part is string => part != null && part !== '');

  return (
    <>
      {detail.injuryContext ? (
        <>
          <DetailLabel>Injury context</DetailLabel>
          <div className="muted" data-testid="injury-context">
            {detail.injuryContext}
          </div>
        </>
      ) : null}

      {headerCarriesStatus ? (
        current && (beyondThePill.length > 0 || current.conflict) ? (
          <div className="muted player-detail-injury" data-testid="injury-current">
            {beyondThePill.join(' · ')}
            {beyondThePill.length > 0 && current.provenance ? (
              <span className="faint"> — {current.provenance}</span>
            ) : null}
            {current.conflict ? (
              <div data-testid="injury-conflict">Sources disagree — {current.conflict}</div>
            ) : null}
          </div>
        ) : null
      ) : detail.injury ? (
        <>
          <DetailLabel>{detail.injury.label}</DetailLabel>
          <div className="muted" data-testid="injury-current">
            {detail.injury.line ?? detail.injury.label}
            {detail.injury.provenance ? <span className="faint"> — {detail.injury.provenance}</span> : null}
          </div>
          {detail.injury.conflict ? (
            <div className="muted" data-testid="injury-conflict">
              Sources disagree — {detail.injury.conflict}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * The availability designation the header pill should carry, from either source.
 *
 * Two screens open the same expanded player and know different things about
 * him. Players hands over Sleeper's own `status` from the row the reader
 * tapped, which is why the pill is correct in the first frame. Trades hands
 * over a suggestion, which carries a trade-shaped injury *category* and no
 * designation at all — so before this, the identical player showed `OUT` on one
 * surface and nothing on the other, which is the drift the shared card exists
 * to stop.
 *
 * The detail payload both surfaces already fetch carries the reconciled
 * designation, so it is the fallback: the row's own status wins while it says
 * something, and `Active` — which Sleeper sends constantly and which is not a
 * status worth a badge — falls through to it rather than suppressing it.
 *
 * Nothing here invents a status. Both inputs are read by `injuryStatusTag`,
 * which knows one closed vocabulary and returns nothing for anything else.
 */
export function headerStatus(
  rowStatus: string | null | undefined,
  detail: PlayerDetail | null,
): string | null {
  if (injuryStatusTag(rowStatus)) return rowStatus ?? null;
  return detail?.injury?.designation ?? null;
}

/**
 * The sentence one piece of evidence offers, and never a sentence it does not.
 *
 * The same ladder `sentenceOf` walks in `core/evidence/takeaway.ts` — the
 * user's own correction note, then the stored summary, then the excerpt — for
 * the same reason: those are the three places the ledger holds words somebody
 * actually wrote about this player, and anything else would be this file making
 * a claim up. It is written out here rather than imported because the wire type
 * the browser receives is a projection of the ledger row and carries none of
 * the storage fields that function's signature requires. The one thing it does
 * import is the provenance test below, because a second copy of *that* is how
 * the two surfaces start disagreeing about what a reader is shown.
 *
 * A backfilled tally row's stored summary is bookkeeping — "Carried over from a
 * running tally covering several earlier issues (net +11)" — so it is skipped
 * and the row's own drivers are quoted instead. That is a presentation
 * decision, not a data one: the summary is untouched in the ledger and is still
 * printed in the evidence timeline, which is the surface that exists to explain
 * how something got in.
 *
 * The excerpt is quoted rather than paraphrased and is never cut to fit:
 * trimming a sentence is the cheapest way to change what it says.
 */
export function newsSentence(item: {
  excerpt: string;
  contextSummary: string | null;
  ruleId?: string | null;
  userOverride: { note?: string } | null;
}): { text: string; quoted: boolean } {
  const note = item.userOverride?.note?.trim();
  if (note) return { text: tidy(note), quoted: false };
  const summary = summaryIsIngestionBookkeeping(item.ruleId) ? null : item.contextSummary?.trim();
  if (summary) return { text: tidy(summary), quoted: false };
  return { text: tidy(item.excerpt ?? ''), quoted: true };
}

function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Which of the ledger's lines `Latest news` actually shows.
 *
 * Separated from the component that draws them because it is the whole of the
 * decision and none of the drawing: what is left out, why, and how much of the
 * ledger is not on screen. A rule about *which facts a reader is shown* is
 * worth asserting directly rather than through a rendered tree.
 *
 * Four exclusions, in order, and every one of them is a display choice over a
 * ledger that still holds everything:
 *
 *   0. rows that are no longer in force — superseded, rejected, ignored;
 *   1. the rows the takeaway above was built from, by id;
 *   2. a row saying the takeaway's fact in different words — the same
 *      repetition the id check exists to prevent, one rewording deeper;
 *   3. rows that repeat *each other*, collapsed to the most recent telling.
 *
 * **The first exclusion is the one this section was missing.** Re-importing a
 * revised tally retires each old row rather than deleting it: it keeps its
 * date, stops counting, and stays on the provenance timeline where the history
 * belongs. `Latest news` did not ask, so a card printed the retired sentence
 * and its replacement as two separate pieces of news, four lines apart — the
 * pre-rewrite `R1-R3 breakout/coverage dominance…` sitting directly under the
 * plain-English sentence that replaced it. Recency cannot catch this: both rows
 * carry the same source date, so the retired one is exactly as recent as the
 * row that superseded it. Only its review state tells them apart, which is why
 * {@link PlayerNewsItem} now carries one.
 *
 * Nothing is deleted and nothing moves: the retired row is still in the ledger,
 * still on the Evidence timeline with its own status beside it, and still in
 * Review. It is simply not news any more.
 *
 * `withheld` is counted against everything the section could have drawn rather
 * than against the deduplicated list, because a suppressed rewording is always
 * the older of its pair and really is on his full profile. Retired rows are not
 * in that count: they are not rows this section chose to hold back, they are
 * rows it can no longer say. The reader is told how many rows are not on
 * screen; they are never quietly dropped from a count.
 */
export function selectLatestNews(
  items: PlayerNewsItem[],
  opts: { quotedEvidenceIds: string[]; quotedText?: string | null; limit: number },
): { shown: PlayerNewsItem[]; withheld: number; varies: boolean } {
  const quoted = new Set(opts.quotedEvidenceIds);
  const said = opts.quotedText?.trim();
  const live = items.filter((item) => countsTowardTally(item.reviewStatus));
  const rest = live.filter(
    (item) => !quoted.has(item.id) && !(said ? isNearDuplicate(said, newsSentence(item).text) : false),
  );
  const distinct = distinctByFact(rest, (item) => ({
    text: newsSentence(item).text,
    sourceDate: item.sourceDate,
  }));
  const shown = distinct.slice(0, opts.limit);
  return {
    shown,
    withheld: rest.length - shown.length,
    // One name on every line is not provenance, it is a repeated word. Measured
    // across the whole ledger rather than the two on screen, so the answer does
    // not change as the list is scrolled or the limit is raised.
    varies: new Set(distinct.map((i) => i.sourceName)).size > 1,
  };
}

/** How a polarity reads when it is not being read as a colour. */
const POLARITY_WORD: Record<string, string> = {
  positive: 'Positive',
  negative: 'Negative',
  mixed: 'Mixed',
  neutral: 'Neutral',
};

/**
 * The latest football, in the words the ledger already holds.
 *
 * This is the expanded card's news section, and it replaced a row of the
 * evidence console: `▲ positive · mag 13 · uncategorised · Aug 12 ·
 * auto_applied`, the excerpt, then `demo newsletter · rule: role-change ·
 * confidence: high`. Every one of those tokens is real and every one of them is
 * about the *classifier* rather than about the player — a reader who opened a
 * card to find out what happened to him was being shown how the tally was
 * computed instead.
 *
 * So the takeaway leads and the machinery goes. What is left is the sentence,
 * when it happened, and a mark saying which way it cuts. Nothing is summarised,
 * shortened or strengthened on the way — see {@link newsSentence} — and nothing
 * is deleted from the ledger: the whole console, `mag` and `ruleId` and review
 * status included, is one tap further in under Evidence, which is where the
 * app's provenance promise actually lives.
 *
 * The source is printed only when it varies. On this surface it is very often
 * one newsletter repeated down the list, and a name that is the same on every
 * line qualifies nothing while costing every line the room to say something.
 *
 * **What the takeaway has already said is not said again here.** The takeaway
 * is chosen from this same ledger, so on the common card — one applied item,
 * lifted to the top — `Latest news` was the takeaway a second time with a date
 * under it, four lines apart and word for word. It was marked rather than
 * dropped, which named the duplication without removing it. The item is not
 * deleted from anything: it is still counted in the tally, still on the
 * player's own page, and still in the Evidence timeline where it is marked
 * `quoted above` — that surface exists to show the whole ledger and is the one
 * place the repetition is the point.
 *
 * **And nor is the same fact said twice in different words.** Matching on the
 * item id only catches the row quoted above; it does not catch two rows that
 * are one fact reworded, which is how Bijan Robinson's card came to spend both
 * its lines on "elite receiving efficiency/target rate" and 2,298 scrimmage
 * yards, once as `paired with an NFL-leading` and once as `and led the NFL
 * with`. Selection now runs {@link distinctByFact} over the list and keeps the
 * most recent telling of each distinct fact. It is a display decision and only
 * that: nothing is deleted, nothing is merged into a new sentence, the
 * suppressed row is still counted by the tally and still printed whole on his
 * Evidence timeline, and two genuinely different things from the same day
 * still take two lines — see `core/evidence/nearDuplicate.ts` for where that
 * line is drawn and why.
 */
export function LatestNews({
  items,
  quotedEvidenceIds,
  quotedText,
  limit,
}: {
  /** The whole ledger for this player, or null while it is being read. */
  items: PlayerNewsItem[] | null;
  /** Items the takeaway above already quoted, and which this must not repeat. */
  quotedEvidenceIds: string[];
  /**
   * The sentence the takeaway above printed, when the caller renders one.
   *
   * The id list catches the exact rows it was built from; this catches a
   * *different* row saying the takeaway's fact in different words, which is the
   * same repetition one layer down. Optional, because a surface that prints no
   * takeaway has nothing for this list to avoid repeating.
   */
  quotedText?: string | null;
  /** How many of the newest to show before saying how many are left. */
  limit: number;
}) {
  if (items == null) return <SkeletonRows rows={2} testId="player-news-skeleton" />;
  const { shown, withheld, varies } = selectLatestNews(items, { quotedEvidenceIds, quotedText, limit });
  /*
   * An empty ledger draws nothing at all, heading included — and so does one
   * whose every item is already the takeaway above.
   *
   * A card is a set of answers, and `Latest news / nothing yet` is a heading
   * spending a line to report that a heading was not needed. Plenty of players
   * have never been written about — that is the ordinary case in August, not a
   * state worth announcing.
   */
  if (shown.length === 0) return null;

  return (
    <>
      <div className="detail-label" data-testid="evidence-heading">
        Latest news
      </div>
      {shown.map((item) => {
        const polarity = item.userOverride?.polarity ?? item.polarity;
        const word = POLARITY_WORD[polarity] ?? 'Neutral';
        const tone = polarity === 'positive' ? 'pos' : polarity === 'negative' ? 'neg' : polarity === 'mixed' ? 'mixed' : '';
        const glyph = polarity === 'positive' ? '▲' : polarity === 'negative' ? '▼' : polarity === 'mixed' ? '◆' : '–';
        const sentence = newsSentence(item);
        return (
          <div
            key={item.id}
            className={`evidence player-news ${tone}`}
            data-testid="evidence-item"
            data-polarity={polarity}
          >
            <div className="player-news-text">
              {/*
                A glyph rather than a colour, and the word beside it for
                anyone not looking at either. The same arrangement
                `CompactTally` uses where a line has no room for `▲ +6 pos`:
                the mark survives greyscale, and the reading survives having
                no screen at all.
              */}
              <span className="player-news-mark" aria-hidden="true">
                {glyph}
              </span>
              <span className="sr-only">{word} news: </span>
              {sentence.quoted ? <span data-testid="evidence-excerpt">“{sentence.text}”</span> : sentence.text}
            </div>
            {/*
              No `quoted above` marker here any more, because nothing on this
              list is quoted above: the takeaway's own items were filtered out
              before the slice. The marker still exists on the Evidence
              timeline, which shows every item and therefore does have to say
              which one was lifted.
            */}
            <div className="player-news-when">
              {formatDate(item.sourceDate)}
              {varies ? ` · ${item.sourceName}` : ''}
            </div>
          </div>
        );
      })}
      {withheld > 0 ? (
        <div className="faint" data-testid="evidence-withheld">
          {withheld} older item{withheld === 1 ? '' : 's'} on his full profile.
        </div>
      ) : null}
    </>
  );
}
