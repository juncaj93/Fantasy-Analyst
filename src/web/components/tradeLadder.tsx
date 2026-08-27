/**
 * What one player costs, and where to stop.
 *
 * The negotiation surface `docs/STATUS.md` has been calling "built but with no
 * screen" — `core/trades/ladder.ts` and the endpoint over it have been complete,
 * tested and reachable for a while, and nothing drew them. This draws them.
 *
 * It is a fold rather than a section, and that is the whole design:
 *
 *   - **the price is not the question until the reader asks it.** Trades is a
 *     board of who is worth pursuing; what to pay for one named player is the
 *     next question, and printing three numbers and a partner profile under
 *     every row would bury the board the way the market inventory used to.
 *   - **the request is expensive and must be paid for deliberately.** The
 *     endpoint runs the lineup optimiser four times — my roster with and without
 *     him, his owner's with and without him — so it is fetched on the first open
 *     and never on a screen's first paint. A reader who never taps it never pays
 *     for it, which is the same bargain `/api/trades/smart` already strikes.
 *
 * Every number below is the engine's. The labels and the order are this file's,
 * which is the same division of responsibility `TradesScreen` states at the top
 * of itself: the screen decides how much of a phone an answer may take and
 * decides nothing about the answer.
 *
 * Nothing here sends a trade or names a price to anybody. `advisory:
 * 'never auto-sent'` is a field on the response for a reason.
 */

import { useCallback, useState } from 'react';
import {
  api,
  type LadderPartner,
  type TradeLadder,
  type TradeLadderResponse,
} from '../api.ts';
import { DetailLabel, StatusRow } from './common.tsx';
import { ReasonList, withoutRepeats } from './decisions.tsx';
import { Fold, SkeletonRows } from './native.tsx';

/**
 * One rung, as a screen draws it.
 *
 * Three of them, in the order a negotiation actually goes: where to open, the
 * band inside which both rosters gain, and the point past which winning the
 * argument means losing the trade.
 */
export interface LadderRow {
  label: string;
  /** The engine's own number, formatted. Weekly starting-lineup points. */
  value: string;
  note: string;
}

/**
 * The three rungs, from the ladder's own numbers.
 *
 * Derived from `opening`, `fair` and `doNotExceed` rather than from the
 * response's `rungs` array, for one reason: the fair rung carries a *band* and
 * the array flattens it to its lower bound with the upper one written into a
 * sentence. Reading the two numbers back out of prose to draw them would be a
 * screen parsing its own server, and the fields are right there.
 *
 * Empty for a blocked ladder, which is not a ladder with zeroes in it — see
 * `blockedLadder` in core. A caller that gets no rows must print the sentence.
 */
export function ladderRows(ladder: TradeLadder): LadderRow[] {
  if (ladder.blocked) return [];
  return [
    {
      label: 'Open at',
      value: points(ladder.opening),
      note: 'Leaves room to move without reading as an insult.',
    },
    {
      label: 'Fair',
      value: `${number(ladder.fair.low)}–${points(ladder.fair.high)}`,
      note: 'Both rosters gain anywhere inside this band.',
    },
    {
      label: 'Stop at',
      value: points(ladder.doNotExceed),
      note: 'Above this you have paid more than he is worth to you.',
    },
  ];
}

/**
 * What may be said about the manager holding him, and what may not.
 *
 * The rule this whole feature had to be careful about, and the reason it is a
 * function with a test rather than three conditionals in a component. A league
 * whose draft ended last night has no trade history at all, and every manager
 * in it is *unmeasured* rather than *inactive* — the distinction §10 of the
 * brief calls the standing principle, and the one a screen is most likely to
 * collapse by printing "rarely trades" over an empty sample.
 *
 * So: below the profile's own threshold nothing is claimed. `notes` is empty,
 * `headline` is null, and what the reader gets instead is `absence` — one
 * sentence about the *evidence*, which is a fact, rather than about the
 * manager, which would be a guess. Above the threshold the sentences are the
 * profile's own, unedited: `core/managers/tradeProfile.ts` already decides which
 * of them are supportable and already ends them with the sample they rest on,
 * and a second opinion about that here would be a second place to keep honest.
 */
export interface PartnerRead {
  /** Whose he is. Null wherever Sleeper has not named the seat. */
  name: string | null;
  /** True only when the sample clears the profile's threshold. */
  confident: boolean;
  /** The one line a screen may lead with, or null when nothing supports one. */
  headline: string | null;
  /** The profile's own supportable sentences. Empty below the threshold. */
  notes: string[];
  /** Why there is no tendency to print. Null when there is one. */
  absence: string | null;
}

export function partnerRead(partner: LadderPartner | null): PartnerRead {
  const name = partner?.ownerName ?? null;
  const cached = partner?.profile ?? null;

  if (!cached) {
    return {
      name,
      confident: false,
      headline: null,
      notes: [],
      absence: 'No trade history has been read for this manager yet, so nothing is claimed about how he deals.',
    };
  }

  const profile = cached.profile;
  /*
   * Both flags, and not either.
   *
   * `cached.confident` is the cache row's copy and `profile.confident` is the
   * profile's own; they are written together and a disagreement between them
   * means something has gone wrong upstream. Requiring both means the failure
   * mode of that disagreement is silence rather than a tendency nobody stands
   * behind.
   */
  if (!cached.confident || !profile.confident) {
    return {
      name,
      confident: false,
      headline: null,
      notes: [],
      absence:
        profile.sample > 0
          ? `${profile.sample} completed trade${profile.sample === 1 ? '' : 's'} on record — too few to describe a tendency.`
          : 'No completed trade is on record for this manager, so nothing is claimed about how he deals.',
    };
  }

  return {
    name,
    confident: true,
    headline: activityHeadline(profile.tradesPerSeason),
    notes: profile.notes,
    absence: null,
  };
}

/**
 * How often he trades, in words, or nothing.
 *
 * Only ever reached with a confident profile, because `tradesPerSeason` is null
 * below the threshold by construction in `buildTradeProfile` — the null branch
 * here is the belt to that braces rather than a second policy.
 */
function activityHeadline(tradesPerSeason: number | null): string | null {
  if (tradesPerSeason == null || tradesPerSeason <= 0) return null;
  if (Math.abs(tradesPerSeason - 1) < 0.05) return 'Trades about once a season.';
  return `Trades about ${number(tradesPerSeason)} times a season.`;
}

/**
 * The price band for one player, behind one tap.
 *
 * Self-fetching, and deliberately: the alternative is every screen that wants a
 * ladder learning when to ask for one, and there is no screen that wants it
 * before the reader has asked. The request happens once — a second open reuses
 * what the first one got, and `api.get` de-duplicates across components on top
 * of that.
 */
export function TradeLadderFold({
  leagueId,
  playerId,
  testId = 'trade-ladder',
}: {
  leagueId: string;
  playerId: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  /*
   * One value rather than three flags.
   *
   * `loading`, `error` and `data` as separate booleans have four combinations
   * that cannot happen and one that silently can — all three falsy, which is
   * both "not asked yet" and "asked and got nothing", the same conflation
   * `offersSettled` exists to avoid on the screen above.
   */
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; view: TradeLadderResponse } | { kind: 'failed' }
  >({ kind: 'idle' });

  const toggle = useCallback(() => {
    const opening = !open;
    setOpen(opening);
    /*
     * Asked once, and only on the way open.
     *
     * Not in an effect keyed on `open`, because an effect would re-run the
     * decision on every re-render of a card the reader has left open, and not
     * inside the state updater either — React may call an updater twice, and a
     * request is not something to fire from a function that has to be pure.
     */
    if (!opening || state.kind !== 'idle') return;
    setState({ kind: 'loading' });
    api
      .get<TradeLadderResponse>(
        `/api/leagues/${encodeURIComponent(leagueId)}/trades/ladder?playerId=${encodeURIComponent(playerId)}`,
      )
      .then((view) => setState({ kind: 'ready', view }))
      .catch(() => setState({ kind: 'failed' }));
  }, [leagueId, playerId, open, state.kind]);

  return (
    <Fold label="What to offer" open={open} onToggle={toggle} testId={testId}>
      <TradeLadderBody state={state} testId={testId} />
    </Fold>
  );
}

function TradeLadderBody({
  state,
  testId,
}: {
  state: { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; view: TradeLadderResponse } | { kind: 'failed' };
  testId: string;
}) {
  if (state.kind === 'idle' || state.kind === 'loading') {
    return <SkeletonRows rows={3} testId={`${testId}-skeleton`} />;
  }
  /*
   * A failure says one sentence and stops.
   *
   * §18's rule for behavioural intelligence — an enhancement, not a dependency —
   * with the one adjustment a fold requires: the reader tapped a control and is
   * owed an answer to the tap, so silence here would read as a broken control
   * rather than as restraint. It is still one quiet line and never an error
   * block, and nothing else on the card is affected.
   */
  if (state.kind === 'failed') {
    return (
      <StatusRow tone="info" data-testid={`${testId}-error`}>
        Could not price this trade just now.
      </StatusRow>
    );
  }

  const view = state.view;

  if (!view.found) {
    return (
      <StatusRow tone="info" data-testid={`${testId}-absent`}>
        {view.reason}
      </StatusRow>
    );
  }

  const rows = ladderRows(view.ladder);
  const partner = partnerRead(view.partner);
  const reasons = withoutRepeats(view.ladder.reasons);
  /*
   * The consolidation's objections, minus anything the ladder already said.
   *
   * The same de-duplication every other decision surface in this app applies,
   * and for the same reason: two engines reading one roster can independently
   * arrive at "you are thin at that position", and hearing it twice in one card
   * reads as two findings rather than one.
   */
  const counterpoints = withoutRepeats(view.consolidation?.counterpoints ?? [], reasons);

  return (
    /* `-detail` rather than `-body`: `Fold` already owns `${testId}-body`. */
    <div data-testid={`${testId}-detail`} data-player={view.target.playerId}>
      {rows.length === 0 ? (
        <StatusRow tone="info" data-testid={`${testId}-blocked`}>
          {view.ladder.blocked}
        </StatusRow>
      ) : (
        <>
          <dl className="weekly-lines" data-testid={`${testId}-rungs`}>
            {rows.map((row) => (
              <div className="weekly-line" key={row.label}>
                <dt>{row.label}</dt>
                <dd>
                  {row.value} <span className="faint">· {row.note}</span>
                </dd>
              </div>
            ))}
          </dl>
          {/*
            What the numbers are, said once.

            Weekly starting-lineup points — the same currency the Team screen
            prints and the same one the bilateral offers are scored in. §15
            forbids an unexplained magic score, and a column of bare figures on
            a negotiation card is exactly that unless the unit is named.
          */}
          <div className="faint" style={{ marginTop: 6 }} data-testid={`${testId}-unit`}>
            Weekly starting-lineup points, on the same scale as the Team screen. Advisory only — nothing here is ever
            sent.
          </div>
        </>
      )}

      {reasons.length > 0 ? (
        <>
          <DetailLabel>Why</DetailLabel>
          <div data-testid={`${testId}-reasons`}>
            <ReasonList items={reasons} />
          </div>
        </>
      ) : null}

      {/*
        Who to ask, and what this league's history supports saying about him.

        The name is a fact and is printed whenever Sleeper has it. Everything
        under it is gated on the sample — see `partnerRead`, which is where that
        rule is enforced and tested.
      */}
      <DetailLabel>This manager</DetailLabel>
      <div data-testid={`${testId}-partner`}>
        <div>{partner.name ?? 'Held by another roster in this league.'}</div>
        {partner.confident ? (
          <div data-testid={`${testId}-manager`} data-sample="confident">
            {partner.headline ? <div>{partner.headline}</div> : null}
            <ReasonList muted items={partner.notes} />
          </div>
        ) : (
          <div className="faint" data-testid={`${testId}-manager-absent`}>
            {partner.absence}
          </div>
        )}
      </div>

      {/*
        And whether turning depth into one better player suits this roster at
        all — a different question from what he costs, and one the ladder
        cannot answer. Absent whenever the roster had nothing to package.
      */}
      {view.consolidation ? (
        <>
          <DetailLabel>Two for one</DetailLabel>
          <div data-testid={`${testId}-consolidation`} data-verdict={view.consolidation.verdict}>
            <div>{view.consolidation.headline}</div>
            <ReasonList muted items={counterpoints} />
          </div>
        </>
      ) : null}
    </div>
  );
}

/** `18.4 pts`. */
function points(value: number): string {
  return `${number(value)} pts`;
}

/** One decimal, and no trailing `.0` on a whole number. */
function number(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}
