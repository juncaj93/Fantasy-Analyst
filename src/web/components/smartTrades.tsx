/**
 * Smart Bilateral Trades, on a phone.
 *
 * A trade idea is four facts and one tap: what you give, what you get, what it
 * does for your lineup, and — only when the history actually supports one — a
 * word about the manager. Everything else is behind the sheet.
 *
 * The restraint is the design. §17 asks for "a small number of sharp ideas" and
 * names what it must not become: giant cards, duplicated information, a
 * permanent manager-history dashboard. Each collapsed idea is two lines and a
 * sentence, so five of them fit above the fold on a 375-point phone alongside
 * the board they sit over — and a reader who wants the whole case gets it in
 * the sheet grammar every other detail in this app already uses, which is also
 * what keeps the gesture arbitration correct.
 *
 * The composite score never appears here. §15 is explicit that the UI must not
 * expose an unexplained magic score, and every number on this screen is either
 * points of weekly lineup or a count of something.
 */

import type { OfferEvaluation } from '../api.ts';
import { DetailLabel } from './common.tsx';
import { ReasonList, withoutRepeats } from './decisions.tsx';
import { Sheet } from './native.tsx';

/**
 * One idea, collapsed.
 *
 * The give/get line leads because it is the thing being decided, and the names
 * are the only bold text on the row. The benefit line is the app's own weekly
 * points on both sides, which is the one number that means the same thing here
 * as it does on the Team screen.
 */
export function SmartTradeRow({ offer, onOpen }: { offer: OfferEvaluation; onOpen: () => void }) {
  const cue = managerCue(offer);

  return (
    <button type="button" className="smart-trade" data-testid="smart-trade-row" onClick={onOpen}>
      <div className="smart-trade-line">
        <span className="smart-trade-side" data-testid="smart-trade-give">
          <span className="smart-trade-label">Give</span>
          {names(offer.give)}
        </span>
        <span className="smart-trade-arrow" aria-hidden="true">
          →
        </span>
        <span className="smart-trade-side" data-testid="smart-trade-get">
          <span className="smart-trade-label">Get</span>
          {names(offer.get)}
        </span>
      </div>

      <div className="smart-trade-meta">
        <span className="smart-trade-gain" data-testid="smart-trade-headline">
          {offer.headline}
        </span>
        <span className="faint smart-trade-partner">{offer.partner.displayName}</span>
      </div>

      {/*
        The single strongest sentence, and the manager cue only when the history
        earned one.

        A reason list on a collapsed row is how a board of five ideas becomes a
        board of one, so exactly one sentence appears here — `reasons` is
        already ordered strongest first by the engine. The manager cue is a
        separate element rather than a sixth reason because it answers a
        different question, and because it must be able to be absent: an
        unmeasured manager prints nothing at all rather than "unknown".
      */}
      <div className="smart-trade-why">
        <span data-testid="smart-trade-reason">{offer.reasons[0] ?? offer.fairness.label}</span>
        {cue ? (
          <span className="smart-trade-cue" data-testid="smart-trade-cue" data-activity={offer.managerFit.activity}>
            {cue}
          </span>
        ) : null}
      </div>
    </button>
  );
}

/**
 * The whole case, in the sheet grammar the rest of the app uses.
 *
 * `Sheet` rather than a pushed page or a bespoke overlay: it is the component
 * that owns the drag-to-dismiss arbitration against pull-to-refresh, and a
 * second thing on this screen that can be flicked away would be a second
 * opinion about which gesture wins. Nothing here is destructive, which is the
 * standing rule for what may live in one.
 */
export function SmartTradeSheet({ offer, onClose }: { offer: OfferEvaluation; onClose: () => void }) {
  const reasons = withoutRepeats(offer.reasons);
  const caveats = withoutRepeats(offer.caveats, reasons);

  return (
    <Sheet
      title={`${names(offer.give)} → ${names(offer.get)}`}
      accessibleLabel={`Trade with ${offer.partner.displayName}`}
      onClose={onClose}
      testId="smart-trade-detail"
    >
      <div className="weekly" data-testid="smart-trade-detail-body" data-offer-id={offer.id}>
        <dl className="weekly-lines">
          <div className="weekly-line">
            <dt>Your side</dt>
            <dd>
              {sideLine({
                gives: offer.give,
                gets: offer.get,
                gain: offer.user.starterGain,
                depth: offer.user.depthChange,
              })}
            </dd>
          </div>
          <div className="weekly-line">
            <dt>Their side</dt>
            <dd>
              {sideLine({
                gives: offer.get,
                gets: offer.give,
                gain: offer.counterparty.starterGain,
                depth: offer.counterparty.depthChange,
              })}
            </dd>
          </div>
          <div className="weekly-line">
            <dt>Fairness</dt>
            <dd data-testid="smart-trade-fairness">
              {offer.fairness.label}
              {/*
                The two totals, so the band is checkable rather than asserted.
                The app has no market price for a rostered player, which is why
                the band is words and only the inputs are numbers.
              */}
              <span className="faint">
                {' '}
                · {offer.fairness.outgoing.toFixed(1)} out, {offer.fairness.incoming.toFixed(1)} in
              </span>
            </dd>
          </div>
          <div className="weekly-line">
            <dt>This manager</dt>
            <dd data-testid="smart-trade-manager">
              {offer.managerFit.label}
              {offer.managerFit.evidence.sample > 0 ? (
                <span className="faint">
                  {' '}
                  · {offer.managerFit.evidence.sample} trade{offer.managerFit.evidence.sample === 1 ? '' : 's'} across{' '}
                  {offer.managerFit.evidence.seasonsObserved} season
                  {offer.managerFit.evidence.seasonsObserved === 1 ? '' : 's'}
                </span>
              ) : null}
            </dd>
          </div>
        </dl>

        {/*
          The same reason grammar the rest of the decision surfaces use, and the
          same de-duplication: `withoutRepeats` also drops a caveat that merely
          restates a reason, which is what stops "slight edge to them" appearing
          as both the case and the objection.
        */}
        <DetailLabel>Why it works</DetailLabel>
        <div data-testid="smart-trade-reasons">
          <ReasonList items={reasons} />
        </div>

        {caveats.length > 0 ? (
          <>
            <DetailLabel>{caveats.length === 1 ? 'Caveat' : 'Caveats'}</DetailLabel>
            <div data-testid="smart-trade-caveats">
              <ReasonList muted items={caveats} />
            </div>
          </>
        ) : null}

        {/*
          What the manager reading rests on, said once and quietly.

          Not a dashboard — §17 forbids a permanent one — but a reader who is
          being told "historically trades about twice a season" is owed the
          sample it came from, and a reader being told nothing is owed the fact
          that nothing is known.
        */}
        <div className="faint" style={{ marginTop: 8 }} data-testid="smart-trade-evidence">
          {evidenceLine(offer)}
        </div>
      </div>
    </Sheet>
  );
}

/**
 * The one word about the manager a collapsed row may carry.
 *
 * Absent unless the history is actually saying something. An unmeasured manager
 * produces no cue at all, which is the correct treatment of unknown: a row that
 * printed "Limited history" on every idea in a league nobody has backfilled
 * would be a column of the same three words qualifying nothing.
 */
function managerCue(offer: OfferEvaluation): string | null {
  const fit = offer.managerFit;
  if (fit.activity === 'unknown') return null;
  if (fit.activity === 'effectively_inactive') return 'Rarely trades';
  if (fit.activity === 'low_activity') return 'Trades seldom';
  if (fit.activity === 'active') return 'Trades often';
  return null;
}

/** `Give A and B, gain 3.4 pts, lose 1 bench player`. */
function sideLine(args: {
  gives: { name: string }[];
  gets: { name: string }[];
  gain: number;
  depth: number;
}): string {
  const points = args.gain > 0 ? `+${args.gain.toFixed(1)} pts` : args.gain < 0 ? `${args.gain.toFixed(1)} pts` : 'no change';
  const depth =
    args.depth === 0
      ? ''
      : `, ${args.depth > 0 ? '+' : ''}${args.depth} bench option${Math.abs(args.depth) === 1 ? '' : 's'}`;
  return `${names(args.gets)} in, ${names(args.gives)} out — ${points}${depth}`;
}

function evidenceLine(offer: OfferEvaluation): string {
  const e = offer.managerFit.evidence;
  if (e.sample === 0 && e.seasonsObserved === 0) {
    return 'No league trade history has been read for this manager yet, so the idea rests on roster fit alone.';
  }
  if (!e.historyComplete) {
    return `Based on ${e.sample} trade(s); this league's history is still being read.`;
  }
  return `Based on ${e.sample} trade(s) across ${e.seasonsObserved} fully read season(s).`;
}

function names(players: { name: string }[]): string {
  return players.map((p) => p.name).join(' + ');
}
