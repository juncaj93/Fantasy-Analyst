/**
 * Compare, rebuilt in October 2026 to fit on one phone screen.
 *
 * What it replaced: a picker under the answer, so changing who was compared
 * meant scrolling down, deselecting, and watching the screen shift; and a
 * "How the score is built" section that was one long stacked list per player.
 *
 * Now, top to bottom:
 *
 *  1. **A pinned strip** of the chosen players (at most four) on one line,
 *     each with an X. `+ Add` sits in the header row beside the close X
 *     (16 October 2026), so the chips have the whole width.
 *  2. **The verdict**: the players side by side with their score and the
 *     winner, and one line saying why. Each card keeps two fixed chip slots,
 *     the pill and availability, so a chip never moves the layout.
 *  3. **One table**, straight under the verdict: a row per factor that moved
 *     anybody, a column per player, short labels and no sub-lines. A tap on a
 *     row shows the engine's own sentence for each player. Factors that moved
 *     nobody are not shown, and availability is the card's chip, not a row.
 *     With four players the table scrolls sideways and its labels stay put.
 *  4. **The picker**, when open: My team, Waivers or All players, sorted by
 *     this week's number, highest first. A tap adds, a second tap removes, and
 *     the list stays open for quick swaps.
 *
 * Every number on it is the one `weekPoints` produces on the server: the same
 * figure the Team screen's Best move card and the waiver tiers print. Nothing
 * here computes a score.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type PillReading, type StartSitComparison, type StartSitEvaluation } from '../api.ts';
import { CompactFace, InjuryTag, PositionPill, TeamLogo } from './common.tsx';
import { SearchField, SegmentedControl, Sheet } from './native.tsx';
import { CheckIcon } from './icons.tsx';
import { buildRosterShape, startablePositions } from '../../core/sleeper/rosterShape.ts';
import { orderFilterChips } from '../../core/sleeper/eligibility.ts';
import type { WeekPoints } from '../../core/startsit/weekPoints.ts';
import { weekPointsOf } from '../../core/startsit/weekPoints.ts';
import { compareTable } from '../compareTable.ts';
import { SLEEPER_SPOKEN, sleeperClass, weekIsSleeper } from '../sleeperFallback.ts';

/** Up to four fit a 360px phone side by side. Matched by the server. */
export const MAX_COMPARE = 4;

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
  { id: 'mine', label: 'My team' },
  { id: 'waivers', label: 'Waivers' },
  { id: 'all', label: 'All players' },
];

const ALL = 'ALL';

/** `12.4`, or a dash for nobody's number. */
export function pts(points: number | null | undefined): string {
  return points == null ? '–' : points.toFixed(1);
}

/** A week's number as printed: `Out` for a ruled-out player, never his gate value. */
export function weekText(week: WeekPoints | null | undefined): string {
  if (week?.out) return 'Out';
  return pts(week?.points);
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
  note,
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
  /**
   * Short lines from the Best move that opened this: the drop a pickup needs,
   * or a free agent who ties. Drawn as the sheet's existing notice, one per line.
   */
  note?: readonly string[] | null;
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

  /*
   * A new tab or position is a new list: clear the old one first, so a quick
   * tap cannot land on a row from the list that is being replaced.
   */
  useEffect(() => setRows(null), [tab, position]);

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
      setNotice(`Up to ${MAX_COMPARE} players.`);
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
  const weekOf = (id: string): WeekPoints | null => {
    const fromRow = rows?.find((r) => r.id === id)?.week;
    if (fromRow !== undefined) return fromRow;
    const evaluation = comparison?.evaluations.find((e) => e.playerId === id);
    return evaluation ? weekPointsOf(evaluation) : null;
  };

  /*
   * The chips follow the cards once the comparison shows (16 October 2026):
   * the pick first, then the rest in ranked order. Reopening the list keeps
   * that order and puts anyone newly added at the end, so nothing jumps under
   * his thumb. Only the drawing changes; `ids` keeps its order, so no new
   * request is sent.
   */
  const [rankedOrder, setRankedOrder] = useState<string[]>([]);
  useEffect(() => {
    if (pickerOpen || !comparison) return;
    const ranked = rankedColumns(comparison).map((e) => e.playerId);
    if (ranked.length === ids.length && ids.every((id) => ranked.includes(id))) setRankedOrder(ranked);
  }, [ids, comparison, pickerOpen]);
  const chipIds = useMemo(() => {
    const place = (id: string) => {
      const at = rankedOrder.indexOf(id);
      return at === -1 ? rankedOrder.length + ids.indexOf(id) : at;
    };
    return [...ids].sort((a, b) => place(a) - place(b));
  }, [ids, rankedOrder]);

  /*
   * The slot is the server's answer once there is one, not the row this was
   * opened from (23 October 2026): a TE added to a Compare opened on a WR row
   * is a FLEX comparison, and a pair that shares no slot shows no slot at all.
   * Before the first answer (one player chosen) it is the row's slot.
   */
  const answeredSlot = comparison ? (comparison.slot?.comparable ? comparison.slot.slot : null) : slot;
  const subtitle = [comparison?.week != null ? `Week ${comparison.week}` : null, answeredSlot ? `${answeredSlot} slot` : null]
    .filter(Boolean)
    .join(' · ');

  /*
   * One header row (16 October 2026): the title and week, the list's one
   * action, and the X. The action used to sit at the end of the chip row,
   * under Done, which made the header two rows tall and squeezed the chips.
   */
  const action = (
    <button
      type="button"
      className={pickerOpen && ids.length >= 2 ? 'cmp2-add cmp2-add-primary' : 'cmp2-add'}
      data-testid="compare-add"
      aria-expanded={pickerOpen}
      onClick={() => setPickerOpen((open) => !open)}
    >
      {pickerOpen ? (ids.length >= 2 ? 'Compare' : 'Hide list') : '+ Add'}
    </button>
  );

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
      headerAction={action}
    >
      {/* 1. The strip: pinned to the top of the sheet's scroll. Up to four chips share its width. */}
      <div className="cmp2-strip" data-testid="compare-strip" hidden={ids.length === 0}>
        <ul
          className={ids.length >= 3 ? 'cmp2-chips cmp2-chips-tight' : 'cmp2-chips'}
          aria-label="Players being compared"
          data-testid="compare-chips"
        >
          {chipIds.map((id) => (
            <li key={id} className="cmp2-chip" data-testid="compare-chosen" data-player-id={id}>
              <span className="cmp2-chip-text">
              <span className="cmp2-chip-name">{lastName(names[id] ?? id)}</span>
              <span className={sleeperClass('cmp2-chip-pts', weekIsSleeper(weekOf(id)))}>
                {weekText(weekOf(id))}
                {weekIsSleeper(weekOf(id)) ? <span className="sr-only">, {SLEEPER_SPOKEN}</span> : null}
              </span>
              </span>
              <button
                type="button"
                className="cmp2-chip-x"
                aria-label={`Remove ${names[id] ?? id} from the comparison`}
                data-testid="compare-remove"
                onClick={() => remove(id)}
              >
                <span aria-hidden="true">✕</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {note && note.length > 0
        ? note.map((line) => (
            <p key={line} className="cmp2-notice cmp2-note" data-testid="compare-best-move-note">
              {line}
            </p>
          ))
        : null}
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
}) {
  /* No preview of the answer while choosing (16 October 2026): it resized the sheet under the finger. */
  return (
    <section className="cmp2-picker" aria-label="Choose players" data-testid="compare-picker">
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
        segments={segments.map((p) => ({ id: p, label: p, ...(p === 'FLX' ? { testId: 'flx-filter', ariaLabel: 'Flex-eligible players: running backs, receivers and tight ends' } : {}) }))}
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
                  aria-label={`${row.name}, ${row.position} ${row.team}, ${row.week.out ? 'out' : row.week.points == null ? 'no projection' : `${pts(row.week.points)} projected`}${weekIsSleeper(row.week) ? `, ${SLEEPER_SPOKEN}` : ''}${on ? ', in the comparison' : ''}`}
                  onClick={() => onToggle(row)}
                >
                  <span className="cmp2-row-check" aria-hidden="true">
                    {on ? <CheckIcon size={14} /> : null}
                  </span>
                  <CompactFace playerId={row.id} name={row.name} position={row.position} team={row.team} />
                  <span className="cmp2-row-who">
                    <span className="cmp2-row-name">
                      <span className="cmp2-row-name-text">{row.name}</span>
                      <InjuryTag status={row.status} />
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
                    <span className={sleeperClass('cmp2-num', weekIsSleeper(row.week))}>{weekText(row.week)}</span>
                    {weekIsSleeper(row.week) ? <span className="sr-only">, {SLEEPER_SPOKEN}</span> : null}
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
  const points = (e: StartSitEvaluation) => weekPointsOf(e).points ?? -Infinity;
  const pick = comparison.recommendedPlayerId;
  /* The pick, then the Sleeper-only second choice beside him, then everybody by number. */
  const second = comparison.sleeperOnly?.playerId ?? null;
  const rank = (e: StartSitEvaluation) => (e.playerId === pick ? 0 : e.playerId === second ? 1 : 2);
  return [...comparison.evaluations].sort((a, b) => rank(a) - rank(b) || points(b) - points(a));
}

/**
 * The cards, one centred column each (16 October 2026): name, position and
 * team logo, photo, score, and Start on the pick. No verdict sentence under
 * them: the cards and the table say it. A Sleeper-only player ahead of the
 * pick is a second choice: dashed grey outline, the fallback marker on his
 * number, no check and no green.
 */
export function Verdict({
  comparison,
  pickLabel = 'Start',
  faceSize: faceOverride,
}: {
  comparison: StartSitComparison;
  /** `Better` on the waiver sheet, where the question is the pickup, not the start (22 October 2026). */
  pickLabel?: 'Start' | 'Better';
  faceSize?: number;
}) {
  const columns = rankedColumns(comparison);
  const comparable = comparison.slot?.comparable ?? true;
  const pick = comparable ? comparison.recommendedPlayerId : null;
  const second = comparable ? comparison.sleeperOnly ?? null : null;
  /* Photos scale with the room each card has: largest for two, still well up for four. */
  const faceSize = faceOverride ?? (columns.length <= 2 ? 96 : columns.length === 3 ? 76 : 56);
  return (
    <section className="cmp2-verdict" aria-label="Verdict" data-testid="comparison" data-columns={columns.length}>
      <ul
        className={columns.length > 3 ? 'cmp2-cols cmp2-cols-wide' : 'cmp2-cols'}
        style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
      >
        {columns.map((e) => {
          const week = weekPointsOf(e);
          const sleeper = weekIsSleeper(week);
          const lead = e.playerId === pick;
          const isSecond = second?.playerId === e.playerId;
          const status = designationOf(e.statusFlag) ?? (e.ruledOut ? 'Out' : null);
          return (
            <li
              key={e.playerId}
              className={lead ? 'cmp2-col cmp2-col-lead' : isSecond ? 'cmp2-col cmp2-col-second' : 'cmp2-col'}
              data-testid="compare-column"
              data-player-id={e.playerId}
              data-pick={lead ? 'true' : 'false'}
              data-second={isSecond ? 'true' : undefined}
            >
              <span className="cmp2-col-name">{shortName(e.name)}</span>
              <span className="cmp2-col-meta">
                <PositionPill position={e.position} />
                <TeamLogo team={e.team} />
                {status ? <InjuryTag status={status} /> : null}
              </span>
              <CompactFace playerId={e.playerId} name={e.name} position={e.position} team={e.team} size={faceSize} />
              <span className={sleeperClass('cmp2-col-score', sleeper)} data-testid="compare-score">
                {weekText(week)}
                {sleeper ? <span className="sr-only">, {SLEEPER_SPOKEN}</span> : null}
              </span>
              {/* One foot row on every card, so the rows line up across them. */}
              <span className="cmp2-col-foot">
                {lead && pickLabel === 'Better' ? (
                  <span className="cmp2-better" data-testid="compare-better">
                    Better
                  </span>
                ) : lead ? (
                  <span className="cmp2-start">
                    <CheckIcon size={12} /> Start
                  </span>
                ) : !sleeper && e.pill ? (
                  <PillChip pill={e.pill} />
                ) : null}
                {isSecond ? <span className="sr-only">second choice, Sleeper projection only</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* --------------------------------------------------------- the score table */

/**
 * The table: Base, the Vegas lines under it, Recent news, Opponent, Score.
 * The arithmetic lives in `compareTable.ts`. One line per row, no taps and no
 * paragraphs (15 October 2026): the lines say what Vegas thinks, and a grey
 * cell is a number on Sleeper's week or a line nobody has posted.
 */
export function ScoreTable({ comparison }: { comparison: StartSitComparison }) {
  const columns = rankedColumns(comparison);
  const { rows, score } = compareTable(columns);
  const wide = columns.length > 3;
  /* Every column fits the phone, four included: the label column is fixed and the players share the rest. */
  const grid = {
    gridTemplateColumns: wide
      ? `minmax(64px, 1.1fr) repeat(${columns.length}, minmax(0, 1fr))`
      : `minmax(0, 1.2fr) repeat(${columns.length}, minmax(0, 1fr))`,
  };
  return (
    <section
      className={wide ? 'cmp2-table cmp2-table-wide' : 'cmp2-table'}
      aria-label="How the score is built"
      data-testid="compare-grid"
      data-columns={columns.length}
    >
      <div className="cmp2-rows" role="table" data-testid="compare-table-scroll">
        <div className="cmp2-tr cmp2-th" role="row" style={grid}>
          <span role="columnheader" className="cmp2-pin">
            <span className="sr-only">Factor</span>
          </span>
          {columns.map((e) => (
            <span role="columnheader" key={e.playerId}>
              {lastName(e.name)}
            </span>
          ))}
        </div>
        {rows.map((row) => (
          <div
            key={row.key}
            className={row.kind === 'line' ? 'cmp2-tr cmp2-factor cmp2-line' : 'cmp2-tr cmp2-factor'}
            role="row"
            style={grid}
            data-testid="compare-factor"
            data-factor={row.key}
            data-kind={row.kind}
          >
            <span role="rowheader" className="cmp2-factor-label cmp2-pin">
              {row.label}
            </span>
            {row.cells.map((cell, i) => (
              <span
                role="cell"
                key={columns[i]!.playerId}
                className={cellClass(cell)}
                data-testid="compare-cell"
                data-muted={cell.muted ? 'true' : undefined}
              >
                {cell.text}
              </span>
            ))}
          </div>
        ))}
        <div className="cmp2-tr cmp2-total" role="row" style={grid} data-testid="compare-total">
          <span role="rowheader" className="cmp2-pin">
            Score
          </span>
          {score.map((cell, i) => (
            <span
              role="cell"
              key={columns[i]!.playerId}
              className={cellClass(cell)}
              data-muted={cell.muted ? 'true' : undefined}
            >
              {cell.text}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- helpers */

/** The surname alone, for a chip or a column head with three others beside it on a phone. */
function lastName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  const last = parts[parts.length - 1]!;
  return /^(jr\.?|sr\.?|ii|iii|iv)$/i.test(last) && parts.length > 2 ? parts[parts.length - 2]! : last;
}

/** A table cell: grey when muted, and the fallback marker too when it is Sleeper's week. */
function cellClass(cell: { muted?: boolean; sleeper?: boolean }): string {
  if (cell.sleeper) return sleeperClass('cmp2-num cmp2-muted', true);
  return cell.muted ? 'cmp2-num cmp2-muted' : 'cmp2-num';
}

/** `J. Smith-Njigba` from `Jaxon Smith-Njigba`; a defence keeps its name. */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2 || /defen[cs]e|^[A-Z]{2,3}$/i.test(parts[parts.length - 1]!)) return name;
  return `${parts[0]!.charAt(0)}. ${parts.slice(1).join(' ')}`;
}

/** `Questionable · hamstring · limited → full` → `Questionable`, for the small badge. */
function designationOf(statusFlag: string | null | undefined): string | null {
  const first = statusFlag?.split('·')[0]?.trim();
  return first ? first : null;
}


