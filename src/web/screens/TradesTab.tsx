/**
 * The Trades tab: today's screens, or the rebuilt ones when the site's switch
 * says so (Round 19, `TRADES_SCREENS`). The rebuilt screens are their own
 * chunk, fetched only when the switch is on.
 */

import { lazy, Suspense } from 'react';
import { useFeatures } from '../features.ts';
import { SkeletonRows } from '../components/native.tsx';
import { TradesScreen } from './TradesScreen.tsx';

const TradesScreenV2 = lazy(() => import('./TradesScreenV2.tsx').then((m) => ({ default: m.TradesScreenV2 })));

export function TradesTab({ resetNonce }: { resetNonce: number }) {
  const { tradesScreens } = useFeatures();
  if (tradesScreens !== 'new') return <TradesScreen resetNonce={resetNonce} />;
  return (
    <Suspense fallback={<SkeletonRows rows={4} testId="trades-skeleton" />}>
      <TradesScreenV2 resetNonce={resetNonce} />
    </Suspense>
  );
}
