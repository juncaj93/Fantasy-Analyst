/**
 * Compare, rebuilt in October 2026 to fit on one phone screen.
 *
 * What it replaced: a picker under the answer, so changing who was compared
 * meant scrolling down, deselecting, and watching the screen shift; and a
 * "How the score is built" section that was one long stacked list per player.
 *
 * Now, top to bottom:
 *
 *  1. **A pinned strip** of the chosen players (at most three), each with an X,
 *     and `+ Add`. It never scrolls away.
 *  2. **The verdict**: the players side by side with their score, their pill
 *     and the winner, and one line saying why.
 *  3. **One table** for how the score is built: a row per factor that moved
 *     anybody, a column per player. A tap on a row shows the engine's own
 *     sentence for each player. Factors that moved nobody collapse into one
 *     "No effect" line.
 *  4. **The picker**, when open: My roster, Waivers or All players, sorted by
 *     this week's number, highest first. A tap adds, a second tap removes, and
 *     the list stays open for quick swaps.
 *
 * Every number on it is the one `weekPoints` produces on the server: the same
 * figure the Team screen's Best move card and the waiver tiers print. Nothing
 * here computes a score.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type PillReading, type StartSitComparison, type StartSitEvaluation } from '../api.ts';
import { PositionPill } from './common.tsx';
import { SearchField, SegmentedControl, Sheet } from './native.tsx';
import { CheckIcon } from './icons.tsx';
import { buildRosterShape, startablePositions } from '../../core/sleeper/rosterShape.ts';
import { orderFilterChips } from '../../core/sleeper/eligibility.ts';
import type { WeekPoints } from '../../core/startsit/weekPoints.ts';
import { weekPointsFrom } from '../../core/startsit/weekPoints.ts';

/** Three columns is what a 360px phone can read. Matched by the server. */
export const MAX_COMPARE = 3;

type PoolTab = 'mine' | 'waivers' | 'all';

interface PoolRow {
  id: string;
  name: string;
  position: string;
  team: string;
  status: string | null;
  owner: 'mine' | 'rostered' | 'available';
  ownerName: string | null;
  starter: boolean | null;
  ruledOut: boolean;
  week: WeekPoints;
  pill: PillReading | null;
}

const TABS: { id: PoolTab; label: string }[] = [
  { id: 'mine', label: 'My roster' },
  { id: 'waivers', label: 'Waivers' },
  { id: 'all', label: 'All players' },
];

const ALL = 'ALL';

/** `12.4`, or a dash for nobody's number. */
export function pts(points: number | null | undefined): string {
  return points == null ? '–' : points.toFixed(1);
}

export function PillChip({ pill, testId = 'pill' }: { pill: PillReading | null | undefined; testId?: string }) {
  if (!pill) return null;
  return (
    <span className={`pill-chip pill-chip-${pill.pill}`} data-testid={testId} data-pill={pill.pill} title={pill.reason}>
      {pill.label}
    </span>
  );
}

export function CompareSheet({
  leagueId,
  rosterPositions,
  slot,
  seed,
  nameOf,
  mode,
  posture,
  onClose,
}: {
  leagueId: string;
  rosterPositions: string[];
  /** The slot this was opened from, or null from the header. */
  slot: string | null;
  seed: string[];
  nameOf: (id: string) => string;
  mode: string | null;
  /** Underdog or favourite this week, for the pill tie-break on close calls. */
  posture: 'underdog' | 'favourite' | null;
  onClose: () => void;
}) {
  const [ids, setIds] = useState<string[]>(() => [...new Set(seed)].slice(0, MAX_COMPARE));
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(seed.map((id) => [id, nameOf(id)])));
  const [pickerOpen, setPickerOpen] = useState(() => new Set(seed).size < 2);
  const [tab, setTab] = useState<PoolTab>('mine');
  const [position, setPosition] = useState<string>(ALL);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<PoolRow[] | null>(null);
  const [comparison, setComparison] = useState<StartSitComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /* Position chips: every position this league starts, then FLX, then DEF. */
  const segments = useMemo(() => {
    const startable = startablePositions(buildRosterShape(rosterPositions));
    return [ALL, ...orderFilterChips(startable)];
  }, [rosterPositions]);

  /* The list. Debounced so typing is one request, not one per letter. */
  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      try {
        const q = new URLSearchParams({ tab, position, q: query, ...(mode ? { mode } : {}) });
        const res = await api.get<{ rows: PoolRow[] }>(`/api/leagues/${leagueId}/compare-pool?${q.toString()}`);
        if (!cancelled) setRows(res.rows);
      } catch {
        if (!cancelled) setRows([]);
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [leagueId, tab, position, query, mode]);

  /* The comparison, as soon as two are chosen. The latest request wins. */
  const request = useRef(0);
  useEffect(() => {
    if (ids.length < 2) {
      setComparison(null);
      return;
    }
    const mine = ++request.current;
    setBusy(true);
    setError(null);
    api
      .post<StartSitComparison>('/api/startsit/compare', {
        leagueId,
        playerIds: ids,
        slot,
        ...(mode ? { mode } : {}),
        ...(posture ? { posture } : {}),
      })
      .then((res) => {
        if (request.current === mine) setComparison(res);
      })
      .catch((err: unknown) => {
        if (request.current === mine) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (request.current === mine) setBusy(false);
      });
  }, [ids, leagueId, slot, mode, posture]);

  const toggle = (row: PoolRow) => {
    setNotice(null);
    if (ids.includes(row.id)) {
      setIds((current) => current.filter((id) => id !== row.id));
      return;
    }
    if (ids.length >= MAX_COMPARE) {
      setNotice(`Up to ${MAX_COMPARE} players at once. Remove one to add another.`);
      return;
    }
    setNames((n) => ({ ...n, [row.id]: row.name }));
    setIds((current) => [...current, row.id]);
  };

  const remove = (id: string) => {
    setNotice(null);
    setIds((current) => current.filter((x) => x !== id));
  };

  /* Each chip's number: the list's when it has him, the comparison's otherwise. Same function either way. */
  const pointsOf = (id: string): number | null => {
    const fromRow = rows?.find((r) => r.id === id)?.week.points;
    if (fromRow !== undefined) return fromRow;
    const evaluation = comparison?.evaluations.find((e) => e.playerId === id);
    return evaluation ? weekPointsFrom(evaluation.decision).points : null;
  };

  const subtitle = [comparison?.week != null ? `Week ${comparison.week}` : null, slot ? `${slot} slot` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <Sheet
      title={
        <span className="cmp-title">
          <span className="cmp-title-main">Compare</span>
          {subtitle ? <span className="cmp-title-sub">{subtitle}</span> : null}
        </span>
      }
      accessibleLabel="Compare players"
      className="sheet-compare"
      onClose={onClose}
      testId="compare-sheet"
    >
      {/* 1. The strip: pinned to the top of the sheet's scroll. */}
      <div className="cmp2-strip" data-testid="compare-strip">
        <ul className="cmp2-chips" aria-label="Players being compared">
          {ids.map((id) => (
            <li key={id} className="cmp2-chip" data-testid="compare-chosen" data-player-id={id}>
              <span className="cmp2-chip-name">{shortName(names[id] ?? id)}</span>
              <span className="cmp2-chip-pts">{pts(pointsOf(id))}</span>
              <button
                type="button"
                className="cmp2-chip-x"
                aria-label={`Remove ${names[id] ?? id} from the comparison`}
                data-testid="compare-remove"
                onClick={() => remove(id)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="cmp2-add"
          data-testid="compare-add"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((open) => !open)}
        >
          {pickerOpen ? (ids.length >= 2 ? 'See comparison' : 'Hide list') : '+ Add'}
        </button>
      </div>

      {notice ? (
        <p className="cmp2-notice" role="status" data-testid="compare-notice">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="cmp2-notice" role="alert">
          {error}
        </p>
      ) : null}

      {pickerOpen ? (
        <Picker
          tab={tab}
          onTab={setTab}
          position={position}
          onPosition={setPosition}
          segments={segments}
          query={query}
          onQuery={setQuery}
          rows={rows}
          chosen={ids}
          onToggle={toggle}
          verdict={comparison && ids.length >= 2 ? verdictLine(comparison) : null}
          onSeeComparison={() => setPickerOpen(false)}
        />
      ) : ids.length < 2 ? (
        <p className="cmp2-empty" data-testid="compare-empty">
          Add {ids.length === 0 ? 'two players' : 'one more player'} to compare.
        </p>
      ) : comparison ? (
        <div aria-busy={busy} className={busy ? 'cmp-busy' : undefined}>
          <Verdict comparison={comparison} />
          <ScoreTable comparison={comparison} />
        </div>
      ) : (
        <p className="cmp2-empty">Comparing…</p>
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------- the picker */

function Picker({
  tab,
  onTab,
  position,
  onPosition,
  segments,
  query,
  onQuery,
  rows,
  chosen,
  onToggle,
  verdict,
  onSeeComparison,
}: {
  tab: PoolTab;
  onTab: (tab: PoolTab) => void;
  position: string;
  onPosition: (position: string) => void;
  segments: string[];
  query: string;
  onQuery: (q: string) => void;
  rows: PoolRow[] | null;
  chosen: string[];
  onToggle: (row: PoolRow) => void;
  verdict: string | null;
  onSeeComparison: () => void;
}) {
  return (
    <section className="cmp2-picker" aria-label="Choose players" data-testid="compare-picker">
      {verdict ? (
        <button type="button" className="cmp2-mini-verdict" data-testid="compare-mini-verdict" onClick={onSeeComparison}>
          <span>{verdict}</span>
          <span aria-hidden="true">›</span>
        </button>
      ) : null}
      <SegmentedControl
        label="Which players"
        value={tab}
        onChange={onTab}
        testId="compare-tabs"
        segments={TABS.map((t) => ({ id: t.id, label: t.label, testId: `compare-tab-${t.id}` }))}
      />
      <div className="cmp2-search">
        <SearchField value={query} onChange={onQuery} placeholder="Search players" label="Search players to compare" testId="compare-search" />
      </div>
      <SegmentedControl
        label="Filter by position"
        value={position}
        onChange={onPosition}
        compact
        segments={segments.map((p) => ({ id: p, label: p, ...(p === 'FLX' ? { testId: 'flx-filter' } : {}) }))}
      />
      {rows == null ? (
        <p className="cmp2-empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="cmp2-empty">Nobody matches that.</p>
      ) : (
        <ul className="cmp2-list" aria-label="Players, highest projection first">
          {rows.map((row) => {
            const on = chosen.includes(row.id);
            return (
              <li key={row.id}>
                <button
                  type="button"
                  className={on ? 'cmp2-row cmp2-row-on' : 'cmp2-row'}
                  data-testid="compare-candidate"
                  data-player-id={row.id}
                  data-chosen={on ? 'true' : 'false'}
                  aria-pressed={on}
                  aria-label={`${row.name}, ${row.position} ${row.team}, ${row.week.points == null ? 'no projection' : `${pts(row.week.points)} projected`}${row.week.lowerConfidence && row.week.points != null ? ', lower confidence' : ''}${on ? ', in the comparison' : ''}`}
                  onClick={() => onToggle(row)}
                >
                  <span className="cmp2-row-check" aria-hidden="true">
                    {on ? <CheckIcon size={14} /> : null}
                  </span>
                  <span className="cmp2-row-who">
                    <span className="cmp2-row-name">
                      {row.name}
                      {row.status ? <span className="cmp2-row-status">{statusCode(row.status)}</span> : null}
                    </span>
                    <span className="cmp2-row-meta">
                      <PositionPill position={row.position} />
                      <span>{row.team || 'FA'}</span>
                      {row.starter != null ? (
                        <span className="cmp2-tag" data-testid="compare-role">
                          {row.starter ? 'Starter' : 'Bench'}
                        </span>
                      ) : row.owner === 'rostered' ? (
                        <span className="cmp2-tag" data-testid="compare-owner">
                          {row.ownerName ?? 'Rostered'}
                        </span>
                      ) : row.owner === 'mine' ? (
                        <span className="cmp2-tag cmp2-tag-mine">Yours</span>
                      ) : tab === 'all' ? (
                        <span className="cmp2-tag">Free agent</span>
                      ) : null}
                      <PillChip pill={row.pill} />
                    </span>
                  </span>
                  <span className="cmp2-row-pts" data-testid="compare-points">
                    <span className={row.week.lowerConfidence ? 'cmp2-num cmp2-num-soft' : 'cmp2-num'}>{pts(row.week.points)}</span>
                    {row.week.lowerConfidence ? (
                      <span className="cmp2-soft" data-testid="lower-confidence">
                        lower confidence
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------- the verdict */

function rankedColumns(comparison: StartSitComparison): StartSitEvaluation[] {
  const points = (e: StartSitEvaluation) => weekPointsFrom(e.decision).points ?? -Infinity;
  const pick = comparison.recommendedPlayerId;
  return [...comparison.evaluations].sort((a, b) =>
    a.playerId === pick ? -1 : b.playerId === pick ? 1 : points(b) - points(a),
  );
}

/** The one line under the verdict: the tie-break's sentence, or the gap and where it came from. */
export function verdictLine(comparison: StartSitComparison): string {
  const comparable = comparison.slot?.comparable ?? true;
  if (!comparable) return 'Not the same lineup decision: no slot takes both.';
  const columns = rankedColumns(comparison);
  const pick = columns.find((e) => e.playerId === comparison.recommendedPlayerId) ?? null;
  if (!pick) return 'Not enough to choose between them.';
  if (comparison.tiebreak) return comparison.tiebreak.sentence;
  const next = columns.find((e) => e.playerId !== pick.playerId) ?? null;
  const a = weekPointsFrom(pick.decision).points;
  const b = next ? weekPointsFrom(next.decision).points : null;
  if (a == null || b == null || !next) return `Start ${shortName(pick.name)}.`;
  const gap = a - b;
  const vegas = (e: StartSitEvaluation) => e.components.find((c) => c.key === 'vegas')?.value ?? 0;
  const fromLines = Math.abs(vegas(pick) - vegas(next)) >= Math.abs(gap) * 0.6;
  const close = gap < 0.75 ? 'Close call. ' : '';
  return `${close}Start ${shortName(pick.name)}, ${gap.toFixed(1)} pts ahead${fromLines ? ', mostly on the Vegas lines' : ''}.`;
}

function Verdict({ comparison }: { comparison: StartSitComparison }) {
  const columns = rankedColumns(comparison);
  const comparable = comparison.slot?.comparable ?? true;
  const pick = comparable ? comparison.recommendedPlayerId : null;
  return (
    <section className="cmp2-verdict" aria-label="Verdict" data-testid="comparison" data-columns={columns.length}>
      <ul className="cmp2-cols" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
        {columns.map((e) => {
          const week = weekPointsFrom(e.decision);
          const lead = e.playerId === pick;
          return (
            <li
              key={e.playerId}
              className={lead ? 'cmp2-col cmp2-col-lead' : 'cmp2-col'}
              data-testid="compare-column"
              data-player-id={e.playerId}
              data-pick={lead ? 'true' : 'false'}
            >
              <span className="cmp2-col-name">{shortName(e.name)}</span>
              <span className="cmp2-col-meta">
                {e.position} · {e.team}
                {e.statusFlag ? ` · ${statusCode(e.statusFlag)}` : ''}
              </span>
              <span className="cmp2-col-score" data-testid="compare-score">
                {pts(week.points)}
              </span>
              {week.lowerConfidence && week.points != null ? <span className="cmp2-soft">lower confidence</span> : null}
              <PillChip pill={e.pill} />
              {lead ? (
                <span className="cmp2-start">
                  <CheckIcon size={12} /> Start
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="cmp2-why" data-testid="comparison-verdict">
        {verdictLine(comparison)}
      </p>
    </section>
  );
}

/* --------------------------------------------------------- the score table */

interface FactorRow {
  key: string;
  label: string;
  cells: { value: number | null; display: string }[];
}

/** One row per factor that moved anybody; the rest named once. */
export function scoreRows(columns: StartSitEvaluation[]): { rows: FactorRow[]; noEffect: string[] } {
  const keys: { key: string; label: string }[] = [];
  for (const e of columns) {
    for (const c of e.components) if (!keys.some((k) => k.key === c.key)) keys.push({ key: c.key, label: c.label });
  }
  const rows: FactorRow[] = [];
  const noEffect: string[] = [];
  for (const { key, label } of keys) {
    const cells = columns.map((e) => {
      const c = e.components.find((x) => x.key === key);
      const value = c == null || c.unknown || c.textOnly ? null : (c.shownValue ?? c.value);
      return { value, display: c?.display ?? 'not read' };
    });
    const moved = cells.some((cell) => cell.value != null && Math.abs(cell.value) >= 0.005);
    if (moved || key === 'vegas') rows.push({ key, label: key === 'vegas' ? 'Vegas lines' : label, cells });
    else noEffect.push(label.toLowerCase());
  }
  return { rows, noEffect };
}

function ScoreTable({ comparison }: { comparison: StartSitComparison }) {
  const columns = rankedColumns(comparison);
  const { rows, noEffect } = scoreRows(columns);
  const [open, setOpen] = useState<string | null>(null);
  const grid = { gridTemplateColumns: `minmax(0, 1.25fr) repeat(${columns.length}, minmax(0, 1fr))` };
  return (
    <section className="cmp2-table" aria-label="How the score is built" data-testid="compare-grid" data-columns={columns.length}>
      <div className="cmp-eyebrow">How the score is built</div>
      <div className="cmp2-rows" role="table">
        <div className="cmp2-tr cmp2-th" role="row" style={grid}>
          <span role="columnheader" className="sr-only">
            Factor
          </span>
          {columns.map((e) => (
            <span role="columnheader" key={e.playerId}>
              {shortName(e.name)}
            </span>
          ))}
        </div>
        {rows.map((row) => (
          <div key={row.key} role="rowgroup">
            <button
              type="button"
              className="cmp2-tr cmp2-factor"
              role="row"
              style={grid}
              data-testid="compare-factor"
              data-factor={row.key}
              aria-expanded={open === row.key}
              onClick={() => setOpen((k) => (k === row.key ? null : row.key))}
            >
              <span role="rowheader" className="cmp2-factor-label">
                {row.label}
              </span>
              {row.cells.map((cell, i) => (
                <span role="cell" key={columns[i]!.playerId} className="cmp2-num" data-testid="compare-cell">
                  {cell.value == null ? '–' : row.key === 'vegas' ? cell.value.toFixed(1) : signed(cell.value)}
                </span>
              ))}
            </button>
            {open === row.key ? (
              <div className="cmp2-detail" data-testid="compare-factor-detail">
                {row.cells.map((cell, i) => (
                  <p key={columns[i]!.playerId}>
                    <strong>{shortName(columns[i]!.name)}:</strong> {cell.display}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        <div className="cmp2-tr cmp2-total" role="row" style={grid}>
          <span role="rowheader">Score</span>
          {columns.map((e) => (
            <span role="cell" key={e.playerId} className="cmp2-num">
              {pts(weekPointsFrom(e.decision).points)}
            </span>
          ))}
        </div>
      </div>
      {noEffect.length > 0 ? (
        <p className="cmp2-noeffect" data-testid="compare-untracked">
          No effect: {noEffect.join(', ')}.
        </p>
      ) : null}
    </section>
  );
}

/* ----------------------------------------------------------------- helpers */

function signed(v: number): string {
  if (Math.abs(v) < 0.005) return '0.0';
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;
}

/** `J. Smith-Njigba` from `Jaxon Smith-Njigba`; a defence keeps its name. */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2 || /defen[cs]e|^[A-Z]{2,3}$/i.test(parts[parts.length - 1]!)) return name;
  return `${parts[0]!.charAt(0)}. ${parts.slice(1).join(' ')}`;
}

function statusCode(status: string): string {
  const word = status.split(/[ ·]/)[0]!.toUpperCase();
  if (word.startsWith('QUEST')) return 'Q';
  if (word.startsWith('DOUBT')) return 'D';
  if (word === 'OUT' || word === 'IR' || word === 'PUP' || word === 'SUS') return word;
  return word.slice(0, 3);
}
