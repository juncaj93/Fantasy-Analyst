/**
 * The Trades tab: Offers, Build and Check (Round 19). The screens are their
 * own chunk, fetched when the tab is first drawn. The old Trades screens and
 * the `TRADES_SCREENS` switch that chose between them were removed in Round 34.
 */

import { lazy, Suspense } from 'react';
import { SkeletonRows } from '../components/native.tsx';

const TradesScreenV2 = lazy(() => import('./TradesScreenV2.tsx').then((m) => ({ default: m.TradesScreenV2 })));

export function TradesTab({ resetNonce }: { resetNonce: number }) {
  return (
    <Suspense fallback={<SkeletonRows rows={4} testId="trades-skeleton" />}>
      <TradesScreenV2 resetNonce={resetNonce} />
    </Suspense>
  );
}
