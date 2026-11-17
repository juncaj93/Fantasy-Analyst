/**
 * The previews: the rebuilt Trades screens (Round 19, `VITE_PREVIEW=trades`)
 * and the in-season Players tab (Round 24, `VITE_PREVIEW=players`). Built only
 * when the preview workflow asks; the live site never contains it.
 *
 * Players: the same PIN, then the in-season Players tab on the same made-up
 * league, with the light and dark switch. The screen is the real one.
 *
 * A PIN first. Then a calm start: only Trades, on the made-up preview league
 * (the same names every time), with a switch for light and dark and one for a
 * normal week and a quiet week (nothing fully fair, so the closest are shown).
 * The screens are the real ones, the same components the live site will draw.
 */

import { useEffect, useState } from 'react';
import { SegmentedControl } from '../components/native.tsx';
import { TradesScreenV2 } from '../screens/TradesScreenV2.tsx';
import { PlayersSeasonScreen } from '../screens/PlayersSeasonScreen.tsx';
import type { LeagueSummary } from '../api.ts';
import { ExtraLines } from '../components/waiverTiers.tsx';
import { previewLookAhead } from '../../core/waivers/lookAheadPreview.ts';
import { applyAppearance, readAppearance, resolveAppearance, storeAppearance } from '../theme.ts';
import { PinGate, wasUnlocked } from './pin.tsx';

export function PreviewApp({ mode = 'trades' }: { mode?: 'trades' | 'players' | 'waivers' }) {
  const [unlocked, setUnlocked] = useState(wasUnlocked);
  const title = mode === 'players' ? 'Players preview' : mode === 'waivers' ? 'Waivers preview' : 'Trades preview';
  if (!unlocked) return <PinGate title={title} onUnlock={() => setUnlocked(true)} />;
  return mode === 'players' ? <PreviewPlayers /> : mode === 'waivers' ? <PreviewWaivers /> : <PreviewTrades />;
}

function PreviewTrades() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => resolveAppearance(readAppearance()));
  const [week, setWeek] = useState<'normal' | 'quiet'>('normal');
  useEffect(() => {
    applyAppearance(theme);
    storeAppearance(theme);
  }, [theme]);
  return (
    <main className="app-main" data-testid="preview-trades">
      <div className="t2-preview-bar">
        <SegmentedControl<'light' | 'dark'>
          label="Light or dark"
          value={theme}
          onChange={setTheme}
          testId="preview-theme"
          segments={[
            { id: 'light', label: 'Light' },
            { id: 'dark', label: 'Dark' },
          ]}
        />
        <SegmentedControl<'normal' | 'quiet'>
          label="Which week"
          value={week}
          onChange={setWeek}
          testId="preview-week"
          segments={[
            { id: 'normal', label: 'Normal' },
            { id: 'quiet', label: 'Quiet' },
          ]}
        />
      </div>
      <TradesScreenV2 key={week} resetNonce={0} query={week === 'quiet' ? 'week=quiet' : ''} />
    </main>
  );
}

/** The made-up league's summary: its name and its lineup slots, for the position chips. */
const PREVIEW_LEAGUE: LeagueSummary = {
  id: 'preview-league',
  name: 'Preview League',
  season: '2026',
  teams: 4,
  isSelected: true,
  scoringLabel: 'Half PPR',
  notes: [],
  rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
  draftId: null,
};

function PreviewPlayers() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => resolveAppearance(readAppearance()));
  useEffect(() => {
    applyAppearance(theme);
    storeAppearance(theme);
  }, [theme]);
  return (
    <main className="app-main" data-testid="preview-players">
      <div className="t2-preview-bar">
        <SegmentedControl<'light' | 'dark'>
          label="Light or dark"
          value={theme}
          onChange={setTheme}
          testId="preview-theme"
          segments={[
            { id: 'light', label: 'Light' },
            { id: 'dark', label: 'Dark' },
          ]}
        />
      </div>
      <PlayersSeasonScreen leagues={[PREVIEW_LEAGUE]} resetNonce={0} searchBeyond={false} dossier={false} />
    </main>
  );
}

/**
 * Round 26: the Waivers look-ahead lines on the made-up league, drawn by the
 * real section the Waivers screen uses (`ExtraLines`), with the light and
 * dark switch. Computed here from the same functions the server runs.
 */
function PreviewWaivers() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => resolveAppearance(readAppearance()));
  useEffect(() => {
    applyAppearance(theme);
    storeAppearance(theme);
  }, [theme]);
  const [lines] = useState(previewLookAhead);
  return (
    <main className="app-main" data-testid="preview-waivers">
      <div className="t2-preview-bar">
        <SegmentedControl<'light' | 'dark'>
          label="Light or dark"
          value={theme}
          onChange={setTheme}
          testId="preview-theme"
          segments={[
            { id: 'light', label: 'Light' },
            { id: 'dark', label: 'Dark' },
          ]}
        />
      </div>
      <ExtraLines tiers={lines} />
    </main>
  );
}
