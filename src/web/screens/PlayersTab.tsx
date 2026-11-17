/**
 * The Players tab: the draft-mode screen while a draft is ahead, and the
 * in-season screen (Round 24) once it is over. Draft mode is untouched. The
 * in-season screen is its own chunk, fetched only when it is drawn. The
 * `PLAYERS_INSEASON` switch that kept the draft-era list in season was removed
 * in Round 34.
 */

import { lazy, Suspense } from 'react';
import type { LeagueSummary } from '../api.ts';
import { SkeletonRows } from '../components/native.tsx';
import { PlayersScreen } from './PlayersScreen.tsx';

const PlayersSeasonScreen = lazy(() => import('./PlayersSeasonScreen.tsx').then((m) => ({ default: m.PlayersSeasonScreen })));

export function PlayersTab({ leagues, resetNonce, draftAhead }: { leagues: LeagueSummary[]; resetNonce: number; draftAhead: boolean }) {
  if (draftAhead) return <PlayersScreen leagues={leagues} resetNonce={resetNonce} />;
  return (
    <Suspense fallback={<SkeletonRows rows={8} testId="players-skeleton" />}>
      {/* The UI preview's made-up players have no news or outlook: the card is the in-season part only, as the Players preview drew it. */}
      <PlayersSeasonScreen leagues={leagues} resetNonce={resetNonce} {...(import.meta.env.VITE_PREVIEW === 'ui' ? { dossier: false, searchBeyond: false } : {})} />
    </Suspense>
  );
}
