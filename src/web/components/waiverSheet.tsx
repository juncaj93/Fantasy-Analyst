/**
 * A waiver move, tapped: the comparison and nothing else (Alex, 22 October
 * 2026: "pick up this player over that player, the one reason why, and when he
 * taps, the direct comparison of the numbers").
 *
 * - Header: his photo, name, pill and logo, and Compare's X.
 * - The card's chips: the status or bid, then the drop.
 * - This week: Compare's own cards and score table, from `/api/startsit/compare`,
 *   the same request and the same numbers as the Compare screen.
 * - Next week and 3 weeks: each player's figure for the window weeks, the
 *   numbers the waiver planner valued them on (`tiers.weekFigures`), with the
 *   current week's row taken from the Compare answer so the two views agree.
 * - An open spot: the empty slot is the other column, at nothing a week.
 * - The drop options, only when a drop is needed: name, pill, season points.
 *
 * Who he is compared with and which period opens are `web/waiverCard.ts`.
 * Nothing here adds, drops or bids.
 */

import { useEffect, useRef, useState } from 'react';
import { api, type StartSitComparison } from '../api.ts';
import { weekPointsOf } from '../../core/startsit/weekPoints.ts';
import type { TierWeekFigure, WaiverTiersView } from '../../core/waivers/tierPlan.ts';
import { PlayerSheetTitle, PositionPill } from './common.tsx';
import { Sheet, SegmentedControl } from './native.tsx';
import { ScoreTable, shortName, Verdict } from './compareSheet.tsx';
import { currentWeekOf, surname, type SheetPeriod, type WaiverSheetModel } from '../waiverCard.ts';
import { SLEEPER_NUM_CLASS, SLEEPER_SPOKEN, weekIsSleeper } from '../sleeperFallback.ts';

type Figures = NonNullable<WaiverTiersView['weekFigures']>;

const PERIODS: { id: SheetPeriod; label: string }[] = [
  { id: 'this', label: 'This week' },
  { id: 'next', label: 'Next week' },
  { id: 'three', label: '3 weeks' },
];

export function WaiverSheet({
  model,
  leagueId,
  figures,
  window,
  onClose,
}: {
  model: WaiverSheetModel;
  leagueId: string;
  /** The tiers' window figures; absent for a board row, which then shows this week only. */
  figures?: Figures | null;
  window?: { weeks: number[]; weights: number[] } | null;
  onClose: () => void;
}) {
  const weekly = figures != null && window != null && figures[model.playerId] != null;
  const [period, setPeriod] = useState<SheetPeriod>(weekly ? model.period : 'this');
  const [comparison, setComparison] = useState<StartSitComparison | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* This week's answer, once: the Compare screen's own request for these two players. */
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !model.partner) return;
    asked.current = true;
    api
      .post<StartSitComparison>('/api/startsit/compare', { leagueId, playerIds: [model.playerId, model.partner.playerId], slot: null })
      .then(setComparison)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [leagueId, model.playerId, model.partner]);

  return (
    <Sheet
      title={<PlayerSheetTitle playerId={model.playerId} name={model.name} position={model.position} team={model.team} />}
      accessibleLabel={model.name}
      onClose={onClose}
      testId="tier-detail"
      close="x"
    >
      <div className="wsheet" data-testid="tier-detail-body" data-player-id={model.playerId} data-partner-id={model.partner?.playerId ?? ''} data-period={period}>
        {model.chips.length > 0 ? (
          <div className="wsheet-chips" data-testid="wsheet-chips">
            {model.chips.map((chip) => (
              <span key={chip.key} className="fixture-chip" data-rating={chip.key === 'free' ? 'neutral' : chip.key === 'injury' ? 'tough' : undefined} data-chip={chip.key}>
                {chip.label}
              </span>
            ))}
          </div>
        ) : null}

        {weekly ? (
          <SegmentedControl
            label="Period"
            testId="wsheet-period"
            compact
            value={period}
            onChange={setPeriod}
            segments={PERIODS.map((p) => ({ id: p.id, label: p.label, testId: `wsheet-period-${p.id}` }))}
          />
        ) : null}

        {error ? (
          <p className="cmp2-notice" role="alert">
            {error}
          </p>
        ) : null}

        {!model.partner ? (
          weekly ? (
            <WeeksTable
              ids={[model.playerId, null]}
              names={[model.name, 'Empty slot']}
              figures={figures!}
              weeks={period === 'this' ? [currentWeekOf(window!)] : period === 'next' ? [currentWeekOf(window!) + 1] : window!.weeks}
              comparison={null}
              total={period === 'three'}
            />
          ) : null
        ) : period === 'this' ? (
          comparison ? (
            <div data-testid="wsheet-compare">
              <Verdict comparison={comparison} pickLabel="Better" faceSize={56} />
              <ScoreTable comparison={comparison} />
            </div>
          ) : (
            <p className="cmp2-empty">Comparing…</p>
          )
        ) : weekly ? (
          <WeeksTable
            ids={[model.playerId, model.partner.playerId]}
            names={[model.name, model.partner.name]}
            figures={figures!}
            weeks={period === 'next' ? [currentWeekOf(window!) + 1] : window!.weeks}
            comparison={comparison}
            total={period === 'three'}
          />
        ) : null}

        {model.drops.length > 0 ? (
          <div className="slot-group wsheet-drops" data-testid="wsheet-drops">
            {model.drops.map((d) => (
              <div key={d.playerId} className="player-row" data-testid="tier-detail-best-drop" data-player-id={d.playerId}>
                <div className="player-row-top">
                  <PositionPill position={d.position} />
                  <span className="player-name">{d.name}</span>
                  {d.points ? <span className="row-value proj proj-out">{d.points}</span> : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

/** One player's figure for a week: the Compare answer for the current week, the planner's for the rest. */
function cellFor(id: string | null, week: number, figures: Figures, comparison: StartSitComparison | null): { text: string; points: number; sleeper: boolean } {
  if (id == null) return { text: '—', points: 0, sleeper: false };
  const f: TierWeekFigure | undefined = figures[id]?.weeks.find((w) => w.week === week);
  if (f?.bye) return { text: 'BYE', points: 0, sleeper: false };
  if (f?.out) return { text: 'Out', points: 0, sleeper: false };
  if (comparison && comparison.week === week) {
    const e = comparison.evaluations.find((x) => x.playerId === id);
    if (e) {
      const p = weekPointsOf(e);
      if (p.out) return { text: 'Out', points: 0, sleeper: false };
      if (p.points != null) return { text: p.points.toFixed(1), points: p.points, sleeper: weekIsSleeper(p) };
    }
  }
  if (f?.points == null) return { text: '—', points: 0, sleeper: false };
  return { text: f.points.toFixed(1), points: f.points, sleeper: f.source === 'sleeper' };
}

/** Week by week, the two players side by side, a total for three weeks, and Better on the higher one. */
function WeeksTable({
  ids,
  names,
  figures,
  weeks,
  comparison,
  total,
}: {
  /** The second is null for an open spot: the empty slot scores nothing. */
  ids: [string, string | null];
  names: [string, string];
  figures: Figures;
  weeks: number[];
  comparison: StartSitComparison | null;
  total: boolean;
}) {
  const cells = weeks.map((week) => ids.map((id) => cellFor(id, week, figures, comparison)));
  const sums = ids.map((_, i) => cells.reduce((s, row) => s + row[i]!.points, 0));
  const better = sums[0]! === sums[1]! ? -1 : sums[0]! > sums[1]! ? 0 : 1;
  const grid = { gridTemplateColumns: 'minmax(0, 1fr) repeat(2, minmax(0, 1fr))' };
  return (
    <section className="cmp2-table" data-testid="wsheet-weeks" aria-label="Week by week">
      <div className="cmp2-rows" role="table">
        <div className="cmp2-tr cmp2-th" role="row" style={grid}>
          <span role="columnheader" className="cmp2-pin">
            <span className="sr-only">Week</span>
          </span>
          {names.map((n, i) => (
            <span role="columnheader" key={i}>
              {ids[i] == null ? n : shortName(n).length > 12 ? surname(n) : shortName(n)}
              {better === i ? (
                <span className="cmp2-better" data-testid="compare-better">
                  {' '}
                  Better
                </span>
              ) : null}
            </span>
          ))}
        </div>
        {weeks.map((week, r) => (
          <div key={week} className="cmp2-tr cmp2-factor" role="row" style={grid} data-testid="wsheet-week" data-week={week}>
            <span role="rowheader" className="cmp2-factor-label cmp2-pin">
              Wk {week}
            </span>
            {cells[r]!.map((c, i) => (
              <span role="cell" key={i} className={c.sleeper ? `cmp2-num ${SLEEPER_NUM_CLASS}` : 'cmp2-num'} data-testid="wsheet-cell" data-points={c.points}>
                {c.text}
                {c.sleeper ? <span className="sr-only">, {SLEEPER_SPOKEN}</span> : null}
              </span>
            ))}
          </div>
        ))}
        {total ? (
          <div className="cmp2-tr cmp2-total" role="row" style={grid} data-testid="wsheet-total">
            <span role="rowheader" className="cmp2-pin">
              Total
            </span>
            {sums.map((s, i) => (
              <span role="cell" key={i} className="cmp2-num" data-testid="wsheet-total-cell" data-points={s}>
                {s.toFixed(1)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
