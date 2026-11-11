/**
 * Build a trade, rebuilt (Round 19): one question, "Who do you want to sell
 * or get?". Type a name, tap the player, and the trade finder answers with
 * its best few deals around him, labelled like every other offer.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.ts';
import type { FoundOffer, ScreensOffers, ScreensTeams } from '../../../core/trades/screensWire.ts';
import { ListGroup, ListRow, SearchField, SkeletonRows } from '../native.tsx';
import { OfferCard } from './offerCard.tsx';

interface Pick {
  playerId: string;
  name: string;
  position: string;
  mine: boolean;
  owner: string;
}

const MAX_RESULTS = 8;

export function BuildTab({
  teams,
  query,
  onOpenOffer,
}: {
  teams: ScreensTeams | null;
  query: string;
  onOpenOffer: (offer: FoundOffer) => void;
}) {
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<Pick | null>(null);
  const [result, setResult] = useState<ScreensOffers | null>(null);
  const [failed, setFailed] = useState(false);

  const everyone = useMemo<Pick[]>(
    () =>
      (teams?.teams ?? []).flatMap((t) =>
        t.players.map((p) => ({ playerId: p.playerId, name: p.name, position: p.position, mine: t.isMine, owner: t.label })),
      ),
    [teams],
  );
  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (q.length < 2) return [];
    return everyone.filter((p) => p.name.toLowerCase().includes(q)).slice(0, MAX_RESULTS);
  }, [everyone, text]);

  useEffect(() => {
    if (!picked) return;
    let live = true;
    setResult(null);
    setFailed(false);
    const key = picked.mine ? `sell=${encodeURIComponent(picked.playerId)}` : `get=${encodeURIComponent(picked.playerId)}`;
    api
      .get<ScreensOffers>(`/api/trades/screens/offers?${key}${query ? `&${query}` : ''}`)
      .then((r) => live && setResult(r))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [picked, query]);

  if (!teams) return <SkeletonRows rows={3} testId="t2-build-loading" />;

  return (
    <div data-testid="t2-build">
      <div className="t2-question">Who do you want to sell or get?</div>
      {picked ? (
        <ListGroup testId="t2-build-picked">
          <ListRow
            label={`${picked.mine ? 'Sell' : 'Get'} ${picked.name}`}
            detail={picked.mine ? `${picked.position} · yours` : `${picked.position} · ${picked.owner}`}
            value={<span className="t2-change">Change</span>}
            onClick={() => {
              setPicked(null);
              setResult(null);
            }}
            testId="t2-build-change"
          />
        </ListGroup>
      ) : (
        <>
          <SearchField value={text} onChange={setText} placeholder="Type a player's name" label="Player to sell or get" testId="t2-build-search" />
          {matches.length > 0 ? (
            <ListGroup testId="t2-build-results">
              {matches.map((p) => (
                <ListRow
                  key={p.playerId}
                  label={p.name}
                  detail={`${p.position} · ${p.mine ? 'yours, to sell' : `${p.owner}, to get`}`}
                  chevron
                  onClick={() => {
                    setPicked(p);
                    setText('');
                  }}
                  testId="t2-build-result"
                />
              ))}
            </ListGroup>
          ) : text.trim().length >= 2 ? (
            <div className="faint t2-empty">Nobody by that name.</div>
          ) : null}
        </>
      )}

      {picked && !result && !failed ? <SkeletonRows rows={2} testId="t2-build-finding" /> : null}
      {failed ? <div className="t2-note">Could not find trades right now. Try again.</div> : null}
      {result ? (
        result.offers.length === 0 ? (
          <div className="faint t2-empty" data-testid="t2-build-none">
            {result.note ?? 'No trade with this player helps both lineups right now.'}
          </div>
        ) : (
          <>
            {result.status === 'close' && result.note ? (
              <div className="t2-note" data-testid="t2-build-close">
                {result.note}
              </div>
            ) : null}
            <div data-testid="t2-build-offers">
              {result.offers.map((o) => (
                <OfferCard key={o.id} offer={o} onOpen={() => onOpenOffer(o)} />
              ))}
            </div>
          </>
        )
      ) : null}
    </div>
  );
}
