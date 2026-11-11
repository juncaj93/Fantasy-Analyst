/**
 * One trade offer on the rebuilt Trades screens (Round 19): the pick, one
 * short reason, and a tap for the direct comparison. Used by Offers and by
 * Build a trade, so an offer looks the same wherever it is found.
 */

import type { FoundOffer } from '../../../core/trades/screensWire.ts';
import { Sheet } from '../native.tsx';

export function signed(n: number, digits = 0): string {
  const v = digits === 0 ? Math.round(n) : Math.round(n * 10 ** digits) / 10 ** digits;
  if (v === 0) return '0';
  return v > 0 ? `+${v}` : `−${Math.abs(v)}`;
}

export function edgeText(edgePercent: number): string {
  return `Edge ${signed(edgePercent)}%`;
}

export function names(players: readonly { name: string }[]): string {
  return players.map((p) => p.name).join(' + ');
}

export function OfferCard({ offer, onOpen }: { offer: FoundOffer; onOpen: () => void }) {
  return (
    <button type="button" className="card t2-offer" data-testid="t2-offer" data-kind={offer.kind} onClick={onOpen}>
      <span className="t2-offer-head">
        <span className="t2-label" data-testid="t2-label" data-kind={offer.kind} data-verdict={offer.verdict}>
          {offer.label}
        </span>
        <span className="t2-edge" data-testid="t2-edge">
          {edgeText(offer.edgePercent)}
        </span>
      </span>
      <span className="t2-line" data-testid="t2-give">
        <span className="t2-side">Give</span>
        <span className="t2-names">{names(offer.give)}</span>
      </span>
      <span className="t2-line" data-testid="t2-get">
        <span className="t2-side">Get</span>
        <span className="t2-names">{names(offer.get)}</span>
      </span>
      <span className="t2-numbers" data-testid="t2-numbers">
        <span>This week {signed(offer.you.thisWeek, 1)}</span>
        <span>Season {signed(offer.you.restOfSeason)}</span>
        <span>
          {offer.partner.label} {signed(offer.them.restOfSeason)}
        </span>
      </span>
      <span className="t2-reason" data-testid="t2-reason">
        {offer.reason}
      </span>
    </button>
  );
}

/** Weeks left in the season, as the offer counted them. */
function weeksOf(offer: FoundOffer): number {
  return offer.weeks ?? Math.max(1, ...[...offer.give, ...offer.get].map((p) => p.starts));
}

/** The direct comparison: what each side gets, in numbers, and who gets better where. */
export function OfferSheet({ offer, onClose }: { offer: FoundOffer; onClose: () => void }) {
  return (
    <Sheet title={`Trade with ${offer.partner.label}`} onClose={onClose} testId="t2-offer-sheet">
      <div className="t2-sheet" data-testid="t2-offer-sheet-body">
        <div className="t2-verdict" data-kind={offer.kind} data-verdict={offer.verdict}>
          <span className="t2-verdict-word" data-testid="t2-sheet-label">
            {offer.label}
          </span>
          <span className="t2-verdict-reason">{offer.reason}</span>
        </div>
        <Compare
          rows={[
            ['This week', signed(offer.you.thisWeek, 1), null],
            ['Rest of season', signed(offer.you.restOfSeason), signed(offer.them.restOfSeason)],
            ['Playoffs', signed(offer.you.playoffs), null],
          ]}
          them={offer.partner.label}
        />
        <dl className="t2-facts">
          <div>
            <dt>Edge</dt>
            <dd data-testid="t2-sheet-edge">
              {signed(offer.edgePercent)}% {offer.edgePercent > 0 ? 'your way' : offer.edgePercent < 0 ? 'their way' : ''}
            </dd>
          </div>
          {offer.better.you.length > 0 ? (
            <div>
              <dt>You get better at</dt>
              <dd>{offer.better.you.join(', ')}</dd>
            </div>
          ) : null}
          {offer.better.them.length > 0 ? (
            <div>
              <dt>{offer.partner.label} gets better at</dt>
              <dd>{offer.better.them.join(', ')}</dd>
            </div>
          ) : null}
          {offer.drop ? (
            <div>
              <dt>You cut</dt>
              <dd>{offer.drop}</dd>
            </div>
          ) : null}
          {offer.partner.activity ? (
            <div>
              <dt>{offer.partner.label}</dt>
              <dd>{offer.partner.activity}</dd>
            </div>
          ) : null}
        </dl>
        <Players title="You give" players={offer.give} describe={startsFor(offer.partner.label, weeksOf(offer))} />
        <Players title="You get" players={offer.get} describe={startsFor('you', weeksOf(offer))} />
      </div>
    </Sheet>
  );
}

export function Compare({ rows, them }: { rows: [label: string, you: string, them: string | null][]; them: string }) {
  return (
    <table className="t2-compare" data-testid="t2-compare">
      <thead>
        <tr>
          <th scope="col" />
          <th scope="col">You</th>
          <th scope="col">{them}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, you, theirs]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{you}</td>
            <td>{theirs ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface PlayerLineView {
  playerId: string;
  name: string;
  position: string;
  value: number | null;
  starts: number;
}

/** "Starts 6 of 8 weeks for Dermot", or "Bench for Dermot". */
export function startsFor(who: string, weeks: number) {
  return (p: PlayerLineView) => (p.starts > 0 ? `Starts ${p.starts} of ${weeks} weeks for ${who}` : `Bench for ${who}`);
}

export function Players({ title, players, describe }: { title: string; players: readonly PlayerLineView[]; describe: (p: PlayerLineView) => string }) {
  return (
    <>
      <div className="t2-sub">{title}</div>
      <ul className="t2-players">
        {players.map((p) => (
          <li key={p.playerId}>
            <span className="t2-player-name">
              {p.name} <span className="faint">{p.position}</span>
            </span>
            <span className="faint">{describe(p)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
