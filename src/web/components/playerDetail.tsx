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
import { DetailLabel, Unknown } from './common.tsx';

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
  return (
    <>
      <DetailLabel>Newsletter takeaway</DetailLabel>
      <div className="takeaway" data-testid="newsletter-takeaway" data-corroboration={takeaway.corroboration}>
        {takeaway.text}
        <span className="faint">
          {' '}
          — {takeaway.sourceName}
          {takeaway.corroboration > 1 ? `, and ${takeaway.corroboration - 1} more` : ''}
        </span>
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
        {heading ? <DetailLabel>Season outlook</DetailLabel> : null}
        <div className="muted" data-testid="outlook-pending">
          Looking it up…
        </div>
      </>
    );
  }
  if (!detail.outlook) {
    return (
      <>
        {heading ? <DetailLabel>Season outlook</DetailLabel> : null}
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
      {heading ? <DetailLabel>{outlook.title}</DetailLabel> : null}
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
          {whole ? 'Show the short version' : 'Read the full outlook'}
        </button>
      ) : null}
    </>
  );
}

/**
 * `16 GP · WR7 half-PPR`.
 *
 * Two numbers, one line, and neither is guessed. A player who did not appear
 * last season has no games and no finish, and gets a dash: Sleeper will happily
 * report him as the 1,240th receiver, which looks like a result and is really
 * his place in a directory.
 */
export function LastSeasonLine({
  detail,
  failed,
  position,
  compact = false,
}: {
  detail: PlayerDetail | null;
  failed: boolean;
  position: string | null;
  /**
   * Put the season on the line instead of above it.
   *
   * `2025` as a heading over two numbers costs a whole row of the card to say
   * one word. On Draft, where the expanded row is budgeted in single lines, the
   * year is just the first token of the line it labels.
   */
  compact?: boolean;
}) {
  if (failed || !detail) return null;
  const season = detail.lastSeason?.season;
  const games = detail.lastSeason?.gamesPlayed;
  const rank = detail.lastSeason?.positionRank;
  if (!season) return null;
  return (
    <>
      {compact ? null : <DetailLabel>{season}</DetailLabel>}
      <div className="season-line" data-testid="last-season">
        {compact ? <span className="metric season-year">{season}</span> : null}
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
      </div>
    </>
  );
}

/**
 * `Preseason PTS 292 · StartWho · Aug 22`.
 *
 * Historical, and said so in words rather than left to the reader to infer. The
 * date and the scoring travel with the number for one reason: in week nine a
 * bare `PTS 292` reads as what the market expects of him now, and it is not —
 * it is what a model expected of him in August. The weekly market owns the
 * present tense.
 *
 * Absent rather than blank when nothing covers him, so a card costs no height
 * for a player no snapshot named.
 */
export function PreseasonProjectionLine({
  detail,
}: {
  detail: { preseasonProjection?: { points: number; label: string; scoringLabel: string } | null } | null;
}) {
  const projection = detail?.preseasonProjection;
  if (!projection) return null;
  return (
    <div className="season-line" data-testid="preseason-projection">
      <span className="metric">
        Preseason <strong>{Math.round(projection.points)}</strong> PTS
      </span>
      <span className="metric detail-quiet" title={`Captured from ${projection.label}, scored as ${projection.scoringLabel}`}>
        {projection.label} · {projection.scoringLabel}
      </span>
    </div>
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
export function InjuryDetail({ detail }: { detail: PlayerDetail | null }) {
  if (!detail) return null;
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

      {detail.injury ? (
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
