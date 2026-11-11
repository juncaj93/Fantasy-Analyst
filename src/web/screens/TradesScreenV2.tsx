/**
 * Trades, rebuilt (Round 19, behind the `TRADES_SCREENS` switch).
 *
 * One screen, three tabs, less on screen: Offers (the trade finder's best
 * three, or the closest few labelled), Build (one question: who do you want
 * to sell or get?) and Check (pick both sides, get one line). Every offer
 * shows the pick and one short reason; a tap opens the direct comparison.
 * No info buttons and no help text.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { FoundOffer, ScreensOffers, ScreensTeams } from '../../core/trades/screensWire.ts';
import { NavBar, PullToRefresh, SegmentedControl, SkeletonRows } from '../components/native.tsx';
import { OfferCard, OfferSheet } from '../components/trades2/offerCard.tsx';
import { BuildTab } from '../components/trades2/buildTab.tsx';
import { CheckTab } from '../components/trades2/checkTab.tsx';
import { unwindOne } from '../tabReset.ts';
import '../components/trades2/trades2.css';

type TradesTabId = 'offers' | 'build' | 'check';

export function TradesScreenV2({ resetNonce, query = '' }: { resetNonce: number; query?: string }) {
  const [tab, setTab] = useState<TradesTabId>('offers');
  const [offers, setOffers] = useState<ScreensOffers | null>(null);
  const [offersFailed, setOffersFailed] = useState(false);
  const [teams, setTeams] = useState<ScreensTeams | null>(null);
  const [open, setOpen] = useState<FoundOffer | null>(null);
  const suffix = query ? `?${query}` : '';

  useEffect(() => {
    if (resetNonce === 0) return;
    unwindOne([
      { when: open != null, undo: () => setOpen(null) },
      { when: tab !== 'offers', undo: () => setTab('offers') },
    ]);
  }, [resetNonce]);

  const load = useCallback(async () => {
    setOffersFailed(false);
    try {
      setOffers(await api.get<ScreensOffers>(`/api/trades/screens/offers${suffix}`, { onFresh: setOffers }));
    } catch {
      setOffersFailed(true);
    }
  }, [suffix]);

  useEffect(() => {
    setOffers(null);
    void load();
  }, [load]);

  /* The rosters, the first time Build or Check is opened. */
  useEffect(() => {
    if (tab === 'offers' || teams) return;
    let live = true;
    api
      .get<ScreensTeams>(`/api/trades/screens/teams${suffix}`)
      .then((t) => live && setTeams(t))
      .catch(() => live && setTeams({ league: null, teams: [], reason: 'Could not read the rosters right now.' }));
    return () => {
      live = false;
    };
  }, [tab, teams, suffix]);

  const deadline = offers?.deadline;
  const subtitle =
    deadline?.week != null
      ? deadline.weeksLeft != null && deadline.weeksLeft <= 0
        ? 'Trades are closed'
        : `Trades close after week ${deadline.week}`
      : (offers?.league?.name ?? '');

  return (
    <PullToRefresh onRefresh={load} label="Trades" testId="t2-pull">
      <NavBar testId="t2-nav" title="Trades" subtitle={subtitle} />
      <div className="t2-tabs">
        <SegmentedControl<TradesTabId>
          label="Trades"
          value={tab}
          onChange={setTab}
          testId="t2-tabs"
          segments={[
            { id: 'offers', label: 'Offers', testId: 't2-tab-offers' },
            { id: 'build', label: 'Build', testId: 't2-tab-build' },
            { id: 'check', label: 'Check', testId: 't2-tab-check' },
          ]}
        />
      </div>

      {tab === 'offers' ? (
        <div data-testid="t2-offers">
          {!offers && !offersFailed ? <SkeletonRows rows={3} testId="t2-offers-loading" /> : null}
          {offersFailed ? <div className="t2-note">Could not find trades right now. Pull down to try again.</div> : null}
          {offers && offers.offers.length === 0 ? (
            <div className="faint t2-empty" data-testid="t2-offers-none">
              {offers.note ?? 'No trade helps both lineups right now.'}
            </div>
          ) : null}
          {offers && offers.offers.length > 0 ? (
            <>
              {offers.status === 'close' && offers.note ? (
                <div className="t2-note" data-testid="t2-offers-close">
                  {offers.note}
                </div>
              ) : null}
              {offers.offers.map((o) => (
                <OfferCard key={o.id} offer={o} onOpen={() => setOpen(o)} />
              ))}
            </>
          ) : null}
        </div>
      ) : null}
      {tab === 'build' ? <BuildTab teams={teams} query={query} onOpenOffer={setOpen} /> : null}
      {tab === 'check' ? <CheckTab teams={teams} query={query} /> : null}

      {open ? <OfferSheet offer={open} onClose={() => setOpen(null)} /> : null}
    </PullToRefresh>
  );
}
