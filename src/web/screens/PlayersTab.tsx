/**
 * The Players tab: today's screen, or the in-season one when the site's
 * switch says so (Round 24, `PLAYERS_INSEASON`) and the draft is over. While a
 * draft is ahead it is always today's screen, so draft mode is untouched. The
 * in-season screen is its own chunk, fetched only when it is drawn.
 */

import { lazy, Suspense } from 'react';
import type { LeagueSummary } from '../api.ts';
import { useFeatures } from '../features.ts';
import { SkeletonRows } from '../components/native.tsx';
import { PlayersScreen } from './PlayersScreen.tsx';

const PlayersSeasonScreen = lazy(() => import('./PlayersSeasonScreen.tsx').then((m) => ({ default: m.PlayersSeasonScreen })));

export function PlayersTab({ leagues, resetNonce, draftAhead }: { leagues: LeagueSummary[]; resetNonce: number; draftAhead: boolean }) {
  const { playersInSeason, known } = useFeatures();
  if (!known) return <SkeletonRows rows={8} testId="players-skeleton" />;
  if (!playersInSeason || draftAhead) return <PlayersScreen leagues={leagues} resetNonce={resetNonce} draftAhead={draftAhead} />;
  return (
    <Suspense fallback={<SkeletonRows rows={8} testId="players-skeleton" />}>
      <PlayersSeasonScreen leagues={leagues} resetNonce={resetNonce} />
    </Suspense>
  );
}
