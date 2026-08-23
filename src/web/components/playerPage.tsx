/**
 * The player's own page.
 *
 * One destination, reached from anywhere, showing everything the app knows
 * about one player. This is the "one tap deeper" that lets every list in the
 * app stop being a place where long-form content is stored: the Players list no
 * longer unfolds a screen and a half of prose under a row, and Trades no longer
 * prints a case nobody asked for on forty rows at once.
 *
 * The structure is a segmented control over four subviews, and the split is not
 * arbitrary — it is what the two endpoints actually answer:
 *
 *  - **Overview** — the sentence, the body, the shape of the season. What a
 *    reader wants in the two seconds after tapping a name.
 *  - **Outlook** — somebody else's editorial, quoted whole, attributed. It is
 *    the longest thing on the page and it is behind its own tab for exactly
 *    that reason.
 *  - **Market** — what the market says: the draft order, what the news moved,
 *    the cached prop lines.
 *  - **Evidence** — the ledger, entire. Every item, its polarity, its
 *    magnitude, its source, its date and its own words. Nothing is summarised
 *    away here; this tab is the app's promise that a number can always be
 *    walked back to the sentence it came from.
 *
 * Above all four, and above the sheet that has no segments at all, is one band
 * of readings that is identical wherever the card was opened from — see
 * `PlayerMetrics`. That band is what makes Players and Trades one product
 * rather than two: the same figures, in the same order, under the same labels,
 * with the two market columns Players alone can supply in front of them.
 *
 * Nothing on this page computes anything. The tally windows, the categories and
 * the evidence arrive from `/api/players/:id`; the outlook, last season, the
 * preseason projection, the injury and the profile arrive from
 * `/api/players/:id/detail`. Two requests, because the two fail independently
 * and a missing outlook must not cost the reader the ledger — and both are made
 * by `usePlayerRecord` in the frame that opens the card, so the header and the
 * body are never two readings of the same player.
 */

import { useEffect, useMemo, useState } from 'react';
import { api, type EvidenceItem, type MyGuyFlag, type PlayerDetail, type PlayerSignal } from '../api.ts';
import {
  Badge,
  DetailLabel,
  Empty,
  InjuryTag,
  PlayerIdentity,
  PositionBadge,
  SignedValue,
  Stat,
  Unknown,
  formatDate,
} from './common.tsx';
import { ListGroup, ListRow, PushScreen, SegmentedControl, Sheet, SkeletonRows } from './native.tsx';
import {
  InjuryDetail,
  LatestNews,
  NewsletterTakeaway,
  ProfileFlags,
  SeasonOutlook,
  headerStatus,
} from './playerDetail.tsx';

/** The whole of this app's own record of one player. */
export interface PlayerFile {
  player: { id: string; name: string; position: string; team: string; status: string | null; aliases: string[] };
  signal: PlayerSignal;
  evidence: EvidenceItem[];
  props: { market: string; line: number | null; bookCount: number; impliedProbability: number | null }[];
  myGuy?: MyGuyFlag;
}

type Section = 'overview' | 'outlook' | 'market' | 'evidence';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'outlook', label: 'Outlook' },
  { id: 'market', label: 'Market' },
  { id: 'evidence', label: 'Evidence' },
];

/**
 * What the screen that opened this page already knew about the player.
 *
 * Passed in rather than waited for, and that is the whole reason the page feels
 * instant: the name, the club, the position and the availability tag are drawn
 * in the first frame from the row the reader just tapped, and the two requests
 * fill in underneath a header that is already correct. A page that renders a
 * spinner where the name goes is a page that reads as slower than it is.
 */
export interface PlayerSummary {
  id: string;
  name: string;
  position: string | null;
  team?: string | null;
  status?: string | null;
  /** Sleeper's own draft-order ranking, when the caller has it. */
  draftRank?: number | null;
  /** The ranking after this app's own nudge. */
  adjustedRank?: number | null;
  /** Picks the tally moved him. Positive means earlier. */
  movement?: number;
}

/**
 * The player as a pushed page.
 *
 * The deep read: his own screen, his own place in the back stack, the whole
 * ledger with room to scroll. Reached deliberately — from the sheet's own way
 * in — rather than as the answer to every tap on a name, because pushing a
 * screen to check one number and then hunting for Back is the interaction this
 * app spent a pass getting rid of.
 */
export function PlayerPage({
  player,
  backLabel,
  onBack,
  trailing,
  context,
  initialSection = 'overview',
}: {
  player: PlayerSummary;
  backLabel: string;
  onBack: () => void;
  /** A control belonging to the player rather than to the page — the heart. */
  trailing?: React.ReactNode;
  context?: React.ReactNode;
  initialSection?: Section;
}) {
  /*
   * The page starts at the top on arrival, and on arrival only.
   *
   * Pushing a screen and landing halfway down it is the single most disorienting
   * thing a pushed navigation can do, and it is what happens by default when the
   * list underneath was scrolled. Keyed on the player rather than run once, so
   * moving from one player to another does the same thing.
   */
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [player.id]);

  const record = usePlayerRecord(player.id);

  return (
    <PushScreen
      title={player.name}
      subtitle={
        /*
          The identity grammar every list row uses, in a navigation bar's own
          two-line arrangement: the pill, the club's mark, then the availability
          tag. The name is the title above it because that is what a pushed bar
          is, and the order of everything qualifying it is the row's order.
        */
        <span className="player-page-ident">
          <PositionBadge position={player.position} team={player.team} />
          <InjuryTag status={headerStatus(player.status, record.detail)} />
        </span>
      }
      backLabel={backLabel}
      onBack={onBack}
      {...(trailing === undefined ? {} : { trailing })}
      testId="player-page"
    >
      <PlayerDossier
        player={player}
        record={record}
        {...(context === undefined ? {} : { context })}
        initialSection={initialSection}
      />
    </PushScreen>
  );
}

/**
 * The player as a sheet, which is how a player is normally opened.
 *
 * Tapping a name is a question — *who is this, and why is he here* — and the
 * honest shape of an answer to a question is something that rises over what you
 * were reading and then goes away again. A pushed page answers it by taking the
 * list away and making the reader find their place afterwards.
 *
 * So this is the first stop everywhere, and `PlayerPage` is what the reader
 * asks for when a skim turns into a study. The sheet inherits swipe-down
 * dismissal, the grip, the backdrop and Escape from `Sheet`; the list behind it
 * keeps its scroll, its search and its filters, because it was never unmounted.
 */
export function PlayerSheet({
  player,
  onClose,
  onOpenFull,
  trailing,
  context,
  initialSection = 'overview',
}: {
  player: PlayerSummary;
  onClose: () => void;
  /** Offered only when the caller has a page to push. */
  onOpenFull?: () => void;
  trailing?: React.ReactNode;
  context?: React.ReactNode;
  initialSection?: Section;
}) {
  const record = usePlayerRecord(player.id);

  return (
    <Sheet
      testId="player-sheet"
      onClose={onClose}
      /*
        The name the dialog is announced by, because the one it is headed by is
        a cluster rather than a sentence.

        The title below is JSX — pill, club, name, status — and a sheet can only
        take its accessible name from a title it can read as a string, so this
        card opened as an unnamed modal for anyone listening to it. The player's
        name alone: the pill and the club are on the line the reader lands on,
        and the status is a qualifier that changes between openings of the same
        card. What has opened is a player.
      */
      accessibleLabel={player.name}
      title={
        /*
          The identity grammar, in the order the compact rows already use.

          This line read name-first, with the pill, the club and the status
          clustered after it — the row's own order reversed at exactly the
          moment the reader has committed to one player. The comment under
          `.sheet-player-title` even claimed it was "the same three marks, in
          the same order, as every list row in the app", which is how a
          convention stops being one: it is written down as though it holds
          while the code says otherwise.

          So: position, club, name, and whatever is wrong with him immediately
          to the right of the name it qualifies. `PlayerIdentity` is the same
          `flex: none` cluster the rows draw, so the pill lands on one column
          and the club's mark stays 16px — a qualifier on the name rather than
          the loudest object on the line. The name takes the slack and truncates
          before anything after it is pushed off the sheet.
        */
        <span className="sheet-player-title">
          <PlayerIdentity position={player.position} {...(player.team === undefined ? {} : { team: player.team })} />
          <span className="sheet-player-name">{player.name}</span>
          <InjuryTag status={headerStatus(player.status, record.detail)} />
          {trailing ? <span className="sheet-player-aside">{trailing}</span> : null}
        </span>
      }
    >
      <PlayerDossier
        player={player}
        record={record}
        {...(context === undefined ? {} : { context })}
        initialSection={initialSection}
        snapshot
        {...(onOpenFull === undefined
          ? {}
          : {
              footer: (
                <button type="button" className="link-button" data-testid="player-full-profile" onClick={onOpenFull}>
                  View full profile
                </button>
              ),
            })}
      />
    </Sheet>
  );
}

/** The two requests behind an expanded player, and what they answer with. */
export interface PlayerRecord {
  file: PlayerFile | null;
  detail: PlayerDetail | null;
  detailFailed: boolean;
}

/**
 * Everything about one player, asked for once.
 *
 * Lifted out of the dossier because the header needs it too: Trades opens a
 * player it knows a trade verdict about and no availability designation, so the
 * pill beside the name has to come from the detail payload — see
 * {@link headerStatus} — and a header that fetched separately from the body
 * would be two requests for one card and two chances to disagree.
 *
 * Two requests rather than one, and that has not changed: the ledger and the
 * outlook fail independently, and a third party the network could not reach
 * must never cost the reader the evidence.
 */
export function usePlayerRecord(playerId: string): PlayerRecord {
  const [file, setFile] = useState<PlayerFile | null>(null);
  const [detail, setDetail] = useState<PlayerDetail | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setDetail(null);
    setDetailFailed(false);
    api
      .get<PlayerFile>(`/api/players/${playerId}`)
      .then((res) => {
        if (!cancelled) setFile(res);
      })
      .catch(() => {
        /* the sections that need it say so themselves */
      });
    api
      .get<PlayerDetail>(`/api/players/${playerId}/detail`)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch(() => {
        if (!cancelled) setDetailFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  return { file, detail, detailFailed };
}

/**
 * The band across the top of every expanded player, on both screens.
 *
 * Six readings, in one order, wherever the card was opened from — and two more
 * in front of them on a screen that deals in the draft market. That fixed order
 * is the whole point: a reader who learns where the preseason number sits on
 * Players must not have to learn again on Trades, and the two screens had drifted
 * into printing four different things each.
 *
 * What is here is what the product intent asks for in the two seconds after a
 * tap — how the research reads lately, what the market expected of him before
 * the season, and what he actually did last year — and it is here *instead of*
 * the four blocks that used to say the same things further down the card: a
 * `News by window` grid repeating windows the band already carries, a `2025`
 * heading over a line of two numbers, and a preseason line of its own.
 *
 * Two windows rather than four. `Season` and `Lifetime` are one reading apart
 * early in a year and the band is not the ledger; the full four-window
 * breakdown, with its item counts and its pending-review note, is one tap in on
 * the pushed page where it always was.
 *
 * `Moved` went the same way and for the reason the compact row already
 * established: it is `ADP` minus `Rank`, and both are printed either side of
 * where it used to sit — a subtraction the reader can watch being done is not a
 * third reading.
 *
 * A dash where a value is genuinely unknown, and no cell at all where the app
 * has never been told anything: a player no snapshot covered has no `PTS` cell,
 * because a dash under a label is a promise that the number exists somewhere.
 * Nothing here is ever a zero standing in for an absence.
 */
function PlayerMetrics({
  player,
  signal,
  detail,
  knowsMarket,
}: {
  player: PlayerSummary;
  signal: PlayerSignal | null;
  detail: PlayerDetail | null;
  /** False when the screen behind never had a draft order to hand over. */
  knowsMarket: boolean;
}) {
  const projection = detail?.preseasonProjection ?? null;
  const last = detail?.lastSeason ?? null;
  const net = (n: number) => (n > 0 ? `+${n}` : `${n}`);

  return (
    <div className="metric-grid" data-testid="player-page-metrics" data-mode={knowsMarket ? 'market' : 'tally'}>
      {knowsMarket ? (
        <>
          <Stat
            label="Rank"
            value={player.adjustedRank == null ? '—' : Math.round(player.adjustedRank)}
            hint="This app's draft order for him, after the research tally"
            spoken={`This app's draft rank: ${player.adjustedRank == null ? 'unknown' : Math.round(player.adjustedRank)}`}
          />
          <Stat
            label="ADP"
            value={player.draftRank == null ? '—' : player.draftRank}
            hint="Where Sleeper's own draft order puts him"
            spoken={`Sleeper draft rank: ${player.draftRank ?? 'unknown'}`}
          />
        </>
      ) : null}

      <Stat
        label="7d"
        value={signal ? <SignedValue net={signal.last7.net} /> : '—'}
        hint="Research tally over the last 7 days"
        spoken={`Research tally over the last 7 days: ${signal ? net(signal.last7.net) : 'unknown'}`}
      />
      <Stat
        label="21d"
        value={signal ? <SignedValue net={signal.last30.net} /> : '—'}
        hint="Research tally over the last 21 days"
        spoken={`Research tally over the last 21 days: ${signal ? net(signal.last30.net) : 'unknown'}`}
      />
      <Stat
        label="Life"
        value={signal ? <SignedValue net={signal.raw.net} /> : '—'}
        hint="Lifetime research tally across every piece of evidence"
        spoken={`Lifetime research tally: ${signal ? net(signal.raw.net) : 'unknown'}`}
      />

      {/*
        `PTS`, and everywhere it is not three letters it says what it is.

        The label is an abbreviation because a metric cell on a 360px phone is
        an abbreviation or it is nothing. Everything else about the cell exists
        so that the abbreviation cannot be read as a live number: the capture
        date sits under the figure, the tooltip and the accessible name both
        open with the word *preseason*, and neither ever says "projected to
        score" in the present tense. In week nine this is history, and a card
        that let it read as a current expectation would be the most expensive
        kind of wrong — plausible.
      */}
      {projection ? (
        <Stat
          label="PTS"
          testId="metric-preseason-pts"
          value={Math.round(projection.points)}
          note={formatDate(projection.capturedAt)}
          hint={`Preseason market projection: ${Math.round(projection.points)} — captured ${projection.label}, scored as ${projection.scoringLabel}`}
          spoken={`Preseason market-derived projected season fantasy points: ${Math.round(
            projection.points,
          )}, captured ${projection.label}, scored as ${projection.scoringLabel}`}
        />
      ) : null}

      {/*
        Last season, promoted out of the `2025` block it used to have to itself.

        The two cells are drawn together or not at all, because they answer one
        question. No stored row means the statistics have never been ingested
        for him — the section stays away rather than implying an empty season —
        and a stored row with nothing in it means he did not appear, which is a
        dash. Sleeper will happily report an unplayed rookie as the 1,240th
        receiver; that is his place in a directory, not a finish.
      */}
      {last ? (
        <>
          <Stat
            label={`${last.season} GP`}
            testId="metric-last-season-gp"
            value={last.gamesPlayed ?? '—'}
            hint={`Games played in ${last.season}`}
            spoken={`${last.season} games played: ${last.gamesPlayed ?? 'unknown'}`}
          />
          <Stat
            label={`${last.season} rank`}
            testId="metric-last-season-rank"
            value={last.positionRank ?? '—'}
            hint={`${last.season} finish, ${last.scoring}`}
            spoken={`${last.season} ${last.scoring} finish: ${last.positionRank ?? 'unknown'}`}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * Everything this app knows about one player, with no opinion about framing.
 *
 * The same band, the same sections and the same order, whether they arrive as a
 * sheet rising over the list or as a pushed page, and whether the reader came
 * from Players or from Trades. That is the whole reason it is its own
 * component: a player inspected from Players and a player inspected from Trades
 * have to be the same object, and so does a player skimmed in a sheet and a
 * player studied on his own page. Two copies of this is how the app grows two
 * answers to "what do we know about him".
 *
 * It renders no chrome — no bar, no grip, no back control. What wraps it is the
 * caller's business: see `PlayerPage` and `PlayerSheet` directly above.
 */
export function PlayerDossier({
  player,
  record,
  context,
  initialSection = 'overview',
  snapshot = false,
  footer,
}: {
  player: PlayerSummary;
  /** The two answers, fetched by the caller so its header can read them too. */
  record: PlayerRecord;
  /**
   * Why this reader is here, from the screen that sent them.
   *
   * Trades puts its case in this slot, so a player opened from Trades opens on
   * the trade case and is still the same page with the same tabs underneath.
   * That is what makes a player one object across the app rather than six.
   */
  context?: React.ReactNode;
  initialSection?: Section;
  /**
   * Stack every section instead of putting them behind a segmented control.
   *
   * What a sheet does. See the note where it is read.
   */
  snapshot?: boolean;
  /** A way further in, when the caller has one to offer. */
  footer?: React.ReactNode;
}) {
  const [section, setSection] = useState<Section>(initialSection);
  const { file, detail, detailFailed } = record;

  const signal = file?.signal ?? null;
  /*
   * Whether the screen behind this one deals in the draft market at all.
   *
   * `undefined` and `null` are deliberately different answers: `null` is
   * "Sleeper does not rank him", which is a fact worth a dash, and `undefined`
   * is "the screen that sent you here has no opinion about draft order", which
   * is not about this player and must not be printed as though it were.
   */
  const knowsMarket = player.draftRank !== undefined || player.adjustedRank !== undefined;

  return (
    <>
      <PlayerMetrics player={player} signal={signal} detail={detail} knowsMarket={knowsMarket} />

      {context ? (
        <div className="player-page-context" data-testid="player-page-context">
          {context}
        </div>
      ) : null}

      {/*
        One scroll in a sheet; four segments on a page.

        A sheet is a glance — the reader tapped a name and wants to know who he
        is — and asking them to choose a tab first is asking a question before
        answering one. So everything is stacked in the order it is wanted: what
        is said about him, what is wrong with him, what is expected, and the
        latest football underneath. The page keeps its segments, because that is
        the deep read and the ledger there runs long enough that a reader
        looking for the market should not have to scroll past it.
      */}
      {snapshot ? null : (
        <div className="control-row">
          <SegmentedControl
            label="Player sections"
            value={section}
            onChange={setSection}
            segments={SECTIONS}
            testId="player-page-sections"
            compact
          />
        </div>
      )}

      {snapshot ? (
        /*
          The expanded card, and what is deliberately not on it.

          Three blocks left in this pass and none of them lost a fact. `Draft
          market` printed Sleeper's rank, this app's rank and the movement
          between them — the first two are in the band four lines up and the
          third is their difference. `Categories` restated the tally by
          category, which is the tally. `Vegas props` is a cached book line and
          has no business under a heading a reader opened to find out about the
          player: what the market expected of him is now `PTS`, said in the
          band, in words that cannot be mistaken for a live number.

          All three are one tap in, unchanged, under Market on his own page —
          along with every window and the whole ledger. Nothing was deleted;
          the card stopped being the place it all had to fit.
        */
        <div className="player-page-body" data-testid="player-page-snapshot">
          <Overview detail={detail} signal={signal} compact />
          {detailFailed ? null : <SeasonOutlook detail={detail} failed={detailFailed} />}
          <LatestNews
            items={file ? file.evidence : null}
            quotedEvidenceIds={detail?.newsletterTakeaway?.evidenceItemIds ?? []}
            limit={2}
          />
        </div>
      ) : (
      <div className="player-page-body" data-testid={`player-page-${section}`}>
        {section === 'overview' ? (
          <Overview
            detail={detail}
            signal={signal}
            evidenceCount={file ? file.evidence.length : null}
            onGo={setSection}
          />
        ) : null}
        {/*
          The outlook tab, and what it says when there is no outlook.

          `SeasonOutlook` renders nothing at all when the lookup failed, which
          was the right answer inside a card with five other blocks around it and
          is the wrong one here: a tab a reader chose and that draws a blank
          reads as broken rather than as empty. The provider is a third party and
          is allowed to be unavailable; saying so is the honest version.
        */}
        {section === 'outlook' ? (
          detailFailed ? (
            <Empty>
              His outlook could not be read just now. It is published by a third party through Sleeper, so this is
              usually temporary — everything else on this page is unaffected.
            </Empty>
          ) : (
            <SeasonOutlook detail={detail} failed={detailFailed} />
          )
        ) : null}
        {section === 'market' ? <Market file={file} player={player} knowsMarket={knowsMarket} /> : null}
        {section === 'evidence' ? (
          <Evidence file={file} quotedEvidenceIds={detail?.newsletterTakeaway?.evidenceItemIds ?? []} />
        ) : null}
      </div>
      )}

      {footer}
    </>
  );
}

/** The two-second answer: what is said about him, and what is wrong with him. */
function Overview({
  detail,
  signal,
  evidenceCount,
  compact = false,
  onGo,
}: {
  detail: PlayerDetail | null;
  signal: PlayerSignal | null;
  /** How many items the ledger holds, once it has been read. */
  evidenceCount?: number | null;
  /**
   * Say only what the band above has not already said.
   *
   * What the expanded card takes. `News by window` is four tally windows under
   * a heading, and three of the four are now cells in the band at the top of
   * the same card — a grid that repeats the row above it is not a second
   * reading, it is the card disagreeing with itself about where a number
   * lives. The whole breakdown, with the item counts behind each window and the
   * note about anything still waiting for review, is on the pushed page, which
   * is the surface that exists for exactly that.
   */
  compact?: boolean;
  /** Moves to another section. Absent only if a caller wants Overview alone. */
  onGo?: (section: Section) => void;
}) {
  return (
    <>
      <NewsletterTakeaway detail={detail} />
      {/*
        The designation is beside the name now, so this says only what a pill
        two or three characters wide cannot: the body part, the practice week,
        where it came from, and any disagreement between sources. See
        `InjuryDetail`, which draws nothing at all when the line adds nothing.
      */}
      <InjuryDetail detail={detail} headerCarriesStatus />
      <ProfileFlags detail={detail} />

      {compact ? null : signal ? (
        <>
          <DetailLabel>News by window</DetailLabel>
          <div className="window-row" data-testid="player-page-windows">
            {(
              [
                ['7d', signal.last7],
                ['21d', signal.last30],
                ['Season', signal.seasonToDate],
                ['Lifetime', signal.raw],
              ] as const
            ).map(([label, w]) => (
              <div className="window-cell" key={label} title={`${w.positive} positive, ${w.negative} negative, ${w.items} item(s)`}>
                <div className="window-label">{label}</div>
                <div className="window-value">
                  <SignedValue net={w.net} />
                </div>
                {/*
                  How many items are behind the number, in brackets and on the
                  same line. A `+1` from one item and a `+1` from nine are not
                  the same reading, and a cell that took a second line to say so
                  wrapped the row on a 360px phone.
                */}
                <div className="faint">({w.items})</div>
              </div>
            ))}
          </div>
          {signal.pendingCount > 0 ? (
            <div className="hint hint-caution">
              {signal.pendingCount} news item{signal.pendingCount === 1 ? '' : 's'} still waiting for your review, so
              {signal.pendingCount === 1 ? ' it is' : ' they are'} not counted yet.
            </div>
          ) : null}
        </>
      ) : (
        <SkeletonRows rows={2} testId="player-page-overview-skeleton" />
      )}

      {/*
        Where the rest of him is, as a grouped list.

        Overview is short for a player nobody has written much about, and a
        pushed page that ends two thirds of the way up the screen reads as one
        that failed to load rather than one that has said everything it knows.
        This is the honest ending: three rows naming what is behind the other
        three segments, with the count where there is one, in the same grammar
        every settings screen on the platform uses. It invents no content — it
        says where the content is.
      */}
      {onGo ? (
        <ListGroup header="More on him" testId="player-page-more">
          <ListRow label="Season outlook" detail="What is expected of him, in his provider's words" chevron onClick={() => onGo('outlook')} testId="player-page-go-outlook" />
          <ListRow label="Market" detail="Draft order, movement and cached prop lines" chevron onClick={() => onGo('market')} testId="player-page-go-market" />
          <ListRow
            label="Evidence"
            detail="Every item behind the tally, with its own words"
            {...(evidenceCount == null ? {} : { value: evidenceCount })}
            chevron
            onClick={() => onGo('evidence')}
            testId="player-page-go-evidence"
          />
        </ListGroup>
      ) : null}
    </>
  );
}

/** Where the market has him, and what it is paying for him to do. */
function Market({
  file,
  player,
  knowsMarket,
}: {
  file: PlayerFile | null;
  player: PlayerSummary;
  /** False when the screen behind never had a draft order to hand over. */
  knowsMarket: boolean;
}) {
  if (!file) return <SkeletonRows rows={3} testId="player-page-market-skeleton" />;
  const { props, signal } = file;
  return (
    <>
      {knowsMarket ? (
        <>
          <DetailLabel>Draft market</DetailLabel>
          <div className="season-line" data-testid="player-page-adp">
            <span className="metric">
              Sleeper{' '}
              {player.draftRank == null ? <Unknown what="Sleeper draft rank" /> : <strong>{player.draftRank}</strong>}
            </span>
            <span className="metric">
              Here{' '}
              {player.adjustedRank == null ? (
                <Unknown what="adjusted rank" />
              ) : (
                <strong>{Math.round(player.adjustedRank)}</strong>
              )}
            </span>
            {player.movement ? (
              <Badge tone={player.movement > 0 ? 'pos' : 'neg'}>
                {player.movement > 0 ? `▲ ${player.movement}` : `▼ ${Math.abs(player.movement)}`}
              </Badge>
            ) : null}
          </div>
        </>
      ) : null}

      {Object.keys(signal.categoryBreakdown).length > 0 ? (
        <>
          <DetailLabel>Categories</DetailLabel>
          <div className="badge-row" style={{ marginTop: 0 }}>
            {Object.entries(signal.categoryBreakdown).map(([cat, v]) => (
              <Badge key={cat} tone={v.positive > v.negative ? 'pos' : v.negative > v.positive ? 'neg' : 'neutral'}>
                {cat}: +{v.positive} / −{v.negative}
              </Badge>
            ))}
          </div>
        </>
      ) : null}

      <DetailLabel>Vegas props</DetailLabel>
      {props.length === 0 ? (
        <div className="muted">
          Prop data unavailable for him. <Unknown what="Vegas expectation" />
        </div>
      ) : (
        <table className="compact">
          <thead>
            <tr>
              <th>Market</th>
              <th>Line</th>
              <th>Books</th>
            </tr>
          </thead>
          <tbody>
            {props.map((p) => (
              <tr key={p.market}>
                <td>{p.market}</td>
                <td>
                  {p.line != null
                    ? p.line
                    : p.impliedProbability != null
                      ? `${Math.round(p.impliedProbability * 100)}%`
                      : '—'}
                </td>
                <td>{p.bookCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/**
 * The ledger, entire and in order.
 *
 * Chronological, newest first, with a filter across polarity for a player who
 * has been written about fifty times. The filter narrows what is *shown* and
 * changes no tally anywhere: the counts beside each chip are printed from the
 * same list, so a reader can always see what they are not looking at.
 */
function Evidence({
  file,
  quotedEvidenceIds,
  limit,
}: {
  file: PlayerFile | null;
  quotedEvidenceIds: string[];
  /**
   * How many items a snapshot shows before it stops.
   *
   * The sheet is a glance and the ledger is not: a player with forty news items
   * would turn a snapshot into the thing the snapshot exists instead of. The
   * newest few are the ones that change a decision; the rest are a tap away on
   * the page, which says so rather than truncating in silence.
   */
  limit?: number;
}) {
  const [lens, setLens] = useState<'all' | 'positive' | 'negative'>('all');
  const quoted = useMemo(() => new Set(quotedEvidenceIds), [quotedEvidenceIds]);

  if (!file) return <SkeletonRows rows={5} testId="player-page-evidence-skeleton" />;
  const items = file.evidence;
  const effective = (e: EvidenceItem) => e.userOverride?.polarity ?? e.polarity;
  const all = lens === 'all' ? items : items.filter((e) => effective(e) === lens);
  const shown = limit == null ? all : all.slice(0, limit);
  const withheld = all.length - shown.length;

  return (
    <>
      {limit == null ? (
      <div className="control-row">
        <SegmentedControl
          label="Filter evidence"
          value={lens}
          onChange={setLens}
          compact
          testId="evidence-lens"
          segments={[
            { id: 'all', label: `All ${items.length}` },
            { id: 'positive', label: `+ ${items.filter((e) => effective(e) === 'positive').length}` },
            { id: 'negative', label: `− ${items.filter((e) => effective(e) === 'negative').length}` },
          ]}
        />
      </div>
      ) : null}
      <div className="detail-label" data-testid="evidence-heading">
        {limit == null ? `Evidence timeline (${shown.length})` : 'Latest news'}
      </div>
      {items.length === 0 ? (
        <Empty>No evidence recorded for him yet.</Empty>
      ) : shown.length === 0 ? (
        <div className="muted">Nothing in this window. The other {items.length} item(s) are under “All”.</div>
      ) : (
        shown.map((e) => <EvidenceRow key={e.id} item={e} quoted={quoted.has(e.id)} />)
      )}
      {/*
        What was left out, counted rather than hidden. A snapshot that quietly
        showed two of forty items would be a snapshot the reader could not trust.
      */}
      {withheld > 0 ? (
        <div className="faint" data-testid="evidence-withheld">
          {withheld} older item{withheld === 1 ? '' : 's'} on his full profile.
        </div>
      ) : null}
    </>
  );
}

/**
 * One piece of evidence, with its own words.
 *
 * Moved here from the Players screen rather than rewritten: the excerpt, the
 * source, the rule and the confidence are the app's provenance guarantee and
 * losing any of them to a visual pass would be losing the point of the app.
 */
export function EvidenceRow({ item, quoted = false }: { item: EvidenceItem; quoted?: boolean }) {
  const effective = item.userOverride?.polarity ?? item.polarity;
  const cls = effective === 'positive' ? 'pos' : effective === 'negative' ? 'neg' : effective === 'mixed' ? 'mixed' : '';
  const glyph = effective === 'positive' ? '▲' : effective === 'negative' ? '▼' : effective === 'mixed' ? '◆' : '–';
  return (
    <div className={`evidence ${cls}`} data-testid="evidence-item">
      <div className="evidence-meta">
        <span>
          {glyph} {effective}
          {item.userOverride ? ' (yours)' : ''}
        </span>
        {quoted ? <span data-testid="evidence-quoted">quoted above</span> : null}
        <span>mag {item.userOverride?.magnitude ?? item.magnitude}</span>
        <span>{item.category ?? 'uncategorised'}</span>
        <span>{formatDate(item.sourceDate)}</span>
        <span>{item.reviewStatus}</span>
      </div>
      {item.contextSummary ? <div className="evidence-excerpt">{item.contextSummary}</div> : null}
      <div className="faint" data-testid="evidence-excerpt">
        “{item.excerpt}”
      </div>
      <div className="evidence-meta">
        <span>{item.sourceName}</span>
        {item.ruleId ? <span>rule: {item.ruleId}</span> : null}
        <span>confidence: {item.confidence}</span>
      </div>
    </div>
  );
}
