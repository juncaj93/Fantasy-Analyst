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
 * Nothing on this page computes anything. The tally windows, the categories and
 * the evidence arrive from `/api/players/:id`; the outlook, last season, the
 * injury and the profile arrive from `/api/players/:id/detail`. Two requests,
 * because the two fail independently and a missing outlook must not cost the
 * reader the ledger.
 */

import { useEffect, useMemo, useState } from 'react';
import { api, type EvidenceItem, type MyGuyFlag, type PlayerDetail, type PlayerSignal } from '../api.ts';
import {
  Badge,
  DetailLabel,
  Empty,
  InjuryTag,
  PositionBadge,
  SignedValue,
  Stat,
  Unknown,
  formatDate,
} from './common.tsx';
import { ListGroup, ListRow, PushScreen, SegmentedControl, Sheet, SkeletonRows } from './native.tsx';
import {
  InjuryDetail,
  LastSeasonLine,
  NewsletterTakeaway,
  PreseasonProjectionLine,
  ProfileFlags,
  SeasonOutlook,
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

  return (
    <PushScreen
      title={player.name}
      subtitle={
        <span className="player-page-ident">
          <PositionBadge position={player.position} team={player.team} />
          <InjuryTag status={player.status} />
        </span>
      }
      backLabel={backLabel}
      onBack={onBack}
      {...(trailing === undefined ? {} : { trailing })}
      testId="player-page"
    >
      <PlayerDossier
        player={player}
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
  return (
    <Sheet
      testId="player-sheet"
      onClose={onClose}
      title={
        <span className="sheet-player-title">
          <span className="sheet-player-name">{player.name}</span>
          <span className="player-page-ident">
            <PositionBadge position={player.position} team={player.team} />
            <InjuryTag status={player.status} />
            {trailing}
          </span>
        </span>
      }
    >
      <PlayerDossier
        player={player}
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

/**
 * Everything this app knows about one player, with no opinion about framing.
 *
 * The same four numbers, the same segmented control and the same four subviews,
 * whether they arrive as a sheet rising over the list or as a pushed page. That
 * is the whole reason it is its own component: a player inspected from Players
 * and a player inspected from Trades have to be the same object, and so does a
 * player skimmed in a sheet and a player studied on his own page. Two copies of
 * this is how the app grows two answers to "what do we know about him".
 *
 * It renders no chrome — no bar, no grip, no back control. What wraps it is the
 * caller's business: see `PlayerPage` and `PlayerSheet` directly below.
 */
export function PlayerDossier({
  player,
  context,
  initialSection = 'overview',
  snapshot = false,
  footer,
}: {
  player: PlayerSummary;
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
  const [file, setFile] = useState<PlayerFile | null>(null);
  const [detail, setDetail] = useState<PlayerDetail | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setDetail(null);
    setDetailFailed(false);
    api
      .get<PlayerFile>(`/api/players/${player.id}`)
      .then((res) => {
        if (!cancelled) setFile(res);
      })
      .catch(() => {
        /* the sections that need it say so themselves */
      });
    api
      .get<PlayerDetail>(`/api/players/${player.id}/detail`)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch(() => {
        if (!cancelled) setDetailFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [player.id]);

  /*
   * The page starts at the top on arrival, and on arrival only.
   *
   * Pushing a screen and landing halfway down it is the single most disorienting
   * thing a pushed navigation can do, and it is what happens by default when the
   * list underneath was scrolled. Keyed on the player rather than run once, so
   * moving from one player to another does the same thing.
   */
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
      {/*
        The four numbers a reader came for, above everything else.

        Which four depends on what the screen behind knows. Players hands over
        the market — where Sleeper has him, where this app has him, and the gap
        between the two — and those are the numbers somebody browsing a database
        came for. Trades knows none of that, so a page opened from there would
        have printed three dashes and one reading; it gets the tally in its four
        windows instead, which is what its own rows were already talking about.

        A dash rather than a zero wherever a value is genuinely unknown. That is
        the rule the whole app is built on: a zero is a reading, and an unknown
        is not.
      */}
      <div className="metric-grid" data-testid="player-page-metrics" data-mode={knowsMarket ? 'market' : 'tally'}>
        {knowsMarket ? (
          <>
            <Stat
              label="Rank"
              value={player.adjustedRank == null ? '—' : Math.round(player.adjustedRank)}
              hint="This app's draft order for him, after the research tally"
            />
            <Stat
              label="ADP"
              value={player.draftRank == null ? '—' : player.draftRank}
              hint="Where Sleeper's own draft order puts him"
            />
            <Stat
              label="Moved"
              value={
                player.movement ? (
                  <span className={player.movement > 0 ? 'tally tally-pos' : 'tally tally-neg'}>
                    {player.movement > 0 ? `▲${player.movement}` : `▼${Math.abs(player.movement)}`}
                  </span>
                ) : (
                  '—'
                )
              }
              hint="Picks the research tally moved him, up or down"
            />
            <Stat
              label="Tally"
              value={signal ? <SignedValue net={signal.raw.net} /> : '—'}
              hint="Lifetime research tally across every piece of evidence"
            />
          </>
        ) : (
          <>
            <Stat label="7d" value={signal ? <SignedValue net={signal.last7.net} /> : '—'} hint="Research tally over the last 7 days" />
            <Stat label="21d" value={signal ? <SignedValue net={signal.last30.net} /> : '—'} hint="Research tally over the last 21 days" />
            <Stat label="Season" value={signal ? <SignedValue net={signal.seasonToDate.net} /> : '—'} hint="Research tally this season" />
            <Stat label="Life" value={signal ? <SignedValue net={signal.raw.net} /> : '—'} hint="Lifetime research tally across every piece of evidence" />
          </>
        )}
      </div>

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
        is said about him, what is wrong with him, what is expected, what the
        market thinks, and the ledger underneath. The page keeps its segments,
        because that is the deep read and the ledger there runs long enough that
        a reader looking for the market should not have to scroll past it.
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
        <div className="player-page-body" data-testid="player-page-snapshot">
          <Overview
            detail={detail}
            detailFailed={detailFailed}
            signal={signal}
            position={player.position}
            evidenceCount={file ? file.evidence.length : null}
          />
          {detailFailed ? null : <SeasonOutlook detail={detail} failed={detailFailed} />}
          <Market file={file} player={player} knowsMarket={knowsMarket} />
          <Evidence file={file} quotedEvidenceIds={detail?.newsletterTakeaway?.evidenceItemIds ?? []} limit={2} />
        </div>
      ) : (
      <div className="player-page-body" data-testid={`player-page-${section}`}>
        {section === 'overview' ? (
          <Overview
            detail={detail}
            detailFailed={detailFailed}
            signal={signal}
            position={player.position}
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
  detailFailed,
  signal,
  position,
  evidenceCount,
  onGo,
}: {
  detail: PlayerDetail | null;
  detailFailed: boolean;
  signal: PlayerSignal | null;
  position: string | null;
  /** How many items the ledger holds, once it has been read. */
  evidenceCount: number | null;
  /** Moves to another section. Absent only if a caller wants Overview alone. */
  onGo?: (section: Section) => void;
}) {
  return (
    <>
      <NewsletterTakeaway detail={detail} />
      <LastSeasonLine detail={detail} failed={detailFailed} position={position} />
      <PreseasonProjectionLine detail={detail} />
      <InjuryDetail detail={detail} />
      <ProfileFlags detail={detail} />

      {signal ? (
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
