/**
 * Check a trade: what any trade does to each team over the rest of the season.
 *
 * Two questions share this one control. Alex asks it about a deal he is thinking
 * of: does this help me. The league's three-person review panel asks it about a
 * deal between any two teams: is this lopsided. The server answers both from the
 * same roster-aware lineup math; the only difference is that Alex's own side
 * carries his stated preferences, as labeled lines.
 *
 * ## It is a fold, and it asks for nothing until it is used
 *
 * The check reads two rosters, a free-agent shortlist and the market, so the
 * request is made on a deliberate tap of `Check this trade`, never on a
 * selection change and never on the screen's first paint. Opening the fold costs
 * one small request for the rosters; the check costs one more per tap.
 *
 * ## The layout rule this file is written around
 *
 * Past rounds regressed when a third number was added to a row and the row
 * spread across the whole width. So no row here carries a third figure:
 *
 *  - a **player row** is a position pill, a name and a check mark, and nothing
 *    else (his team and status are the quiet line under the name);
 *  - a **result row** is a label, one number and a quiet sentence that wraps.
 *
 * `resultRows` is the only place a result row is made, and
 * `tests/tradeCheck.layout.test.ts` fails if one ever carries a second figure.
 * `e2e/trade-check.spec.ts` measures the same thing at 360, 375, 390 and 430.
 *
 * Nothing here proposes, makes or answers a trade. The response says so and so
 * does the card.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { PositionPill, StatusRow, DetailLabel, Confidence } from './common.tsx';
import { ReasonList } from './decisions.tsx';
import { CheckIcon } from './icons.tsx';
import { Fold, ListGroup, ListRow, SkeletonRows } from './native.tsx';
import type { SideResult, TradeEvaluation } from '../../core/tradeValue/evaluate.ts';
import type {
  TradeCheckResponse,
  TradeHorizonView,
  TradeTeam,
  TradeTeamsResponse,
} from '../../core/tradeValue/response.ts';

/** A signed number to one decimal, with a real minus sign. */
export function signed(value: number): string {
  const text = Math.abs(value).toFixed(1);
  if (value > 0) return `+${text}`;
  if (value < 0) return `−${text}`;
  return '0.0';
}

export interface ResultRow {
  key: string;
  /** Whose number it is. */
  label: string;
  /** The one figure on the row. */
  value: string;
  /** Which way it points, for the colour only. */
  tone: 'pos' | 'neg' | 'none';
  /** A sentence under the figure. Wraps; never a second number column. */
  note: string;
}

/** The name a side is called on the card. */
export function sideName(side: { label: string; isMine: boolean }): string {
  return side.isMine ? 'You' : side.label;
}

function breakdown(side: SideResult): string {
  const parts = [`lineup ${signed(side.lineupChange)}`];
  if (side.depthChange !== 0) parts.push(`bench depth ${signed(side.depthChange)}`);
  if (side.adjustmentTotal !== 0) parts.push(`your habits ${signed(side.adjustmentTotal)}`);
  return parts.join(', ');
}

/**
 * The rows of a result: one per side, one figure each.
 *
 * The breakdown is prose on purpose. A lineup change, a depth change and a
 * preference total are three numbers, and three numbers on one row is the
 * layout that regressed. They are all still there, in a sentence that wraps.
 */
export function resultRows(evaluation: TradeEvaluation): ResultRow[] {
  if (evaluation.status !== 'ok' || !evaluation.a || !evaluation.b) return [];
  const weeks = evaluation.weeks.count;
  return [evaluation.a, evaluation.b].map((side, i) => ({
    key: i === 0 ? 'a' : 'b',
    label: sideName(side),
    value: `${signed(side.net)} pts`,
    tone: side.net > 0 ? 'pos' : side.net < 0 ? 'neg' : 'none',
    note: `over ${weeks} week${weeks === 1 ? '' : 's'}: ${breakdown(side)}`,
  }));
}

/** What the card says about the deadline, or nothing. */
export function horizonLine(horizon: TradeHorizonView): string {
  const season = `Rest of the season: week ${horizon.currentWeek} to week ${horizon.lastWeek}, through the playoffs.`;
  if (horizon.deadlineWeek == null) return season;
  if (horizon.deadlinePassed) return `${season} The trade deadline was week ${horizon.deadlineWeek}.`;
  const left = horizon.weeksToDeadline ?? 0;
  return `${season} Trades close after week ${horizon.deadlineWeek} (${left} week${left === 1 ? '' : 's'} left).`;
}

type Load<T> = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; view: T } | { kind: 'failed' };

const MAX_PER_SIDE = 4;

export function TradeCheckFold({ leagueId }: { leagueId: string }) {
  const [open, setOpen] = useState(false);
  const [teams, setTeams] = useState<Load<TradeTeamsResponse>>({ kind: 'idle' });
  const [aId, setAId] = useState<number | null>(null);
  const [bId, setBId] = useState<number | null>(null);
  const [give, setGive] = useState<string[]>([]);
  const [get, setGet] = useState<string[]>([]);
  const [result, setResult] = useState<Load<TradeCheckResponse>>({ kind: 'idle' });

  const toggle = useCallback(() => {
    const opening = !open;
    setOpen(opening);
    if (!opening || teams.kind !== 'idle') return;
    setTeams({ kind: 'loading' });
    api
      .get<TradeTeamsResponse>(`/api/leagues/${encodeURIComponent(leagueId)}/trades/check/teams`)
      .then((view) => setTeams({ kind: 'ready', view }))
      .catch(() => setTeams({ kind: 'failed' }));
  }, [leagueId, open, teams.kind]);

  /* Alex on one side, and the first other team with a roster on the other. */
  useEffect(() => {
    if (teams.kind !== 'ready' || !teams.view.teams || aId != null) return;
    const list = teams.view.teams;
    const mine = list.find((t) => t.isMine) ?? list[0];
    const other = list.find((t) => t.rosterId !== mine?.rosterId && t.players.length > 0);
    if (mine) setAId(mine.rosterId);
    if (other) setBId(other.rosterId);
  }, [teams, aId]);

  const list = teams.kind === 'ready' ? (teams.view.teams ?? []) : [];
  const a = list.find((t) => t.rosterId === aId) ?? null;
  const b = list.find((t) => t.rosterId === bId) ?? null;

  const pick = (side: 'a' | 'b', rosterId: number) => {
    if (side === 'a') {
      setAId(rosterId);
      setGive([]);
      if (rosterId === bId) setBId(list.find((t) => t.rosterId !== rosterId && t.players.length > 0)?.rosterId ?? null);
    } else {
      setBId(rosterId);
      setGet([]);
      if (rosterId === aId) setAId(list.find((t) => t.rosterId !== rosterId)?.rosterId ?? null);
    }
    setResult({ kind: 'idle' });
  };

  const toggleOne = (side: 'a' | 'b', playerId: string) => {
    const [ids, set] = side === 'a' ? ([give, setGive] as const) : ([get, setGet] as const);
    if (ids.includes(playerId)) set(ids.filter((id) => id !== playerId));
    else if (ids.length < MAX_PER_SIDE) set([...ids, playerId]);
    setResult({ kind: 'idle' });
  };

  const ready = a != null && b != null && give.length + get.length > 0;

  const run = () => {
    if (!a || !b || !ready) return;
    setResult({ kind: 'loading' });
    const query = `a=${a.rosterId}&b=${b.rosterId}&give=${encodeURIComponent(give.join(','))}&get=${encodeURIComponent(get.join(','))}`;
    api
      .get<TradeCheckResponse>(`/api/leagues/${encodeURIComponent(leagueId)}/trades/check?${query}`)
      .then((view) => setResult({ kind: 'ready', view }))
      .catch(() => setResult({ kind: 'failed' }));
  };

  return (
    <Fold label="Check a trade" summary="Rest of season" open={open} onToggle={toggle} testId="trade-check">
      {teams.kind === 'idle' || teams.kind === 'loading' ? (
        <SkeletonRows rows={3} testId="trade-check-skeleton" />
      ) : teams.kind === 'failed' ? (
        <StatusRow tone="info" data-testid="trade-check-error">
          Could not read the rosters just now.
        </StatusRow>
      ) : !teams.view.found || !teams.view.teams ? (
        <StatusRow tone="info" data-testid="trade-check-absent">
          {teams.view.reason ?? 'No trade can be checked yet.'}
        </StatusRow>
      ) : (
        <div data-testid="trade-check-panel">
          {teams.view.horizon ? (
            <StatusRow tone="info" data-testid="trade-check-horizon">
              {horizonLine(teams.view.horizon)}
            </StatusRow>
          ) : null}

          <TeamPicker
            side="a"
            title="First team gives"
            teams={list}
            teamId={aId}
            otherId={bId}
            team={a}
            selected={give}
            onTeam={(id) => pick('a', id)}
            onToggle={(id) => toggleOne('a', id)}
          />
          <TeamPicker
            side="b"
            title="Second team gives"
            teams={list}
            teamId={bId}
            otherId={aId}
            team={b}
            selected={get}
            onTeam={(id) => pick('b', id)}
            onToggle={(id) => toggleOne('b', id)}
          />

          <div className="field">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="trade-check-run"
              disabled={!ready || result.kind === 'loading'}
              onClick={run}
              style={{ width: '100%', minHeight: 44 }}
            >
              {result.kind === 'loading' ? 'Checking' : 'Check this trade'}
            </button>
          </div>

          <CheckResult state={result} />
        </div>
      )}
    </Fold>
  );
}

function TeamPicker({
  side,
  title,
  teams,
  teamId,
  otherId,
  team,
  selected,
  onTeam,
  onToggle,
}: {
  side: 'a' | 'b';
  title: string;
  teams: TradeTeam[];
  teamId: number | null;
  otherId: number | null;
  team: TradeTeam | null;
  selected: string[];
  onTeam: (rosterId: number) => void;
  onToggle: (playerId: string) => void;
}) {
  const selectId = `trade-check-team-${side}`;
  return (
    <div data-testid={`trade-check-side-${side}`}>
      <div className="field">
        <label className="field-label" htmlFor={selectId}>
          {title}
        </label>
        <select
          id={selectId}
          data-testid={selectId}
          value={teamId ?? ''}
          onChange={(e) => onTeam(Number(e.target.value))}
        >
          {teams.map((t) => (
            <option key={t.rosterId} value={t.rosterId} disabled={t.rosterId === otherId}>
              {t.isMine ? `${t.label} (you)` : t.label}
            </option>
          ))}
        </select>
      </div>
      {team ? (
        <ListGroup testId={`trade-check-players-${side}`}>
          {team.players.map((p) => {
            const on = selected.includes(p.playerId);
            const full = !on && selected.length >= MAX_PER_SIDE;
            return (
              <ListRow
                key={p.playerId}
                state={<PositionPill position={p.position} />}
                label={p.name}
                detail={[p.team || null, p.reserve ? 'IR slot' : null, p.status].filter(Boolean).join(' · ') || undefined}
                mark={on ? <CheckIcon size={16} /> : undefined}
                onClick={full ? undefined : () => onToggle(p.playerId)}
                dataState={on ? 'selected' : full ? 'full' : 'idle'}
                pressed={on}
                testId="trade-check-player"
              />
            );
          })}
        </ListGroup>
      ) : null}
    </div>
  );
}

function CheckResult({ state }: { state: Load<TradeCheckResponse> }) {
  /*
   * The answer lands below two roster lists, which on a phone is a screen or two
   * away from the button that asked for it. Bring it into view when it arrives,
   * and only then: a re-render must never move a reader who has scrolled away.
   */
  const anchor = useRef<HTMLDivElement | null>(null);
  const settled = state.kind === 'ready' || state.kind === 'failed';
  useEffect(() => {
    if (settled) anchor.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [settled]);
  return (
    <div ref={anchor}>
      <ResultBody state={state} />
    </div>
  );
}

function ResultBody({ state }: { state: Load<TradeCheckResponse> }) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'loading') return <SkeletonRows rows={3} testId="trade-check-result-skeleton" />;
  if (state.kind === 'failed') {
    return (
      <StatusRow tone="info" data-testid="trade-check-result-error">
        Could not check this trade just now.
      </StatusRow>
    );
  }
  const view = state.view;
  if (!view.found || !view.evaluation) {
    return (
      <StatusRow tone="info" data-testid="trade-check-result-absent">
        {view.reason ?? 'This trade could not be checked.'}
      </StatusRow>
    );
  }
  const ev = view.evaluation;
  if (ev.status !== 'ok' || !ev.verdict) {
    return (
      <StatusRow tone="info" data-testid="trade-check-insufficient">
        {ev.insufficientReason ?? 'There is not enough to put a number on this trade.'}
      </StatusRow>
    );
  }

  const rows = resultRows(ev);
  return (
    <div className="weekly" data-testid="trade-check-result" data-verdict={ev.verdict.kind}>
      <div className="trade-case-head">
        <span className="trade-case-verdict" data-testid="trade-check-verdict">
          {ev.verdict.headline}
        </span>
        <Confidence level={ev.confidence} compact />
      </div>

      <dl className="weekly-lines" data-testid="trade-check-rows">
        {rows.map((row) => (
          <div className="weekly-line weekly-line-team" key={row.key} data-testid="trade-check-row">
            <dt title={row.label}>{row.label}</dt>
            <dd>
              <span className={`tally tally-${row.tone}`} data-testid="trade-check-figure">
                {row.value}
              </span>{' '}
              <span className="faint">{row.note}</span>
            </dd>
          </div>
        ))}
      </dl>

      {ev.reasons.length > 0 ? (
        <>
          <DetailLabel>Why</DetailLabel>
          <div data-testid="trade-check-reasons">
            <ReasonList items={ev.reasons} />
          </div>
        </>
      ) : null}

      <Details evaluation={ev} />

      <div className="faint" style={{ marginTop: 8 }} data-testid="trade-check-advisory">
        Points are projected fantasy points above what a free agent would give the same lineup. The gap in the headline
        is one side\u2019s change minus the other\u2019s. {view.advisory}
      </div>
    </div>
  );
}

/** The working, closed until asked for. */
function Details({ evaluation }: { evaluation: TradeEvaluation }) {
  const [open, setOpen] = useState(false);
  const sides = useMemo(() => [evaluation.a, evaluation.b].filter((s): s is SideResult => s != null), [evaluation]);
  const notes = [...evaluation.confidenceReasons, ...evaluation.caveats];
  return (
    <Fold label="The numbers behind it" open={open} onToggle={() => setOpen((o) => !o)} testId="trade-check-details">
      {sides.map((side) => (
        <div key={side.rosterId ?? side.label} data-testid="trade-check-side-detail">
          <DetailLabel>{`${sideName(side)} ${side.isMine ? 'get' : 'gets'}`}</DetailLabel>
          <dl className="weekly-lines">
            {side.incoming.map((p) => (
              <div className="weekly-line" key={p.playerId}>
                <dt>{p.name}</dt>
                <dd>
                  {p.rate == null ? 'no projection' : `${p.rate.toFixed(1)} a game`}
                  <span className="faint">
                    {' '}
                    · {p.position}, plays {p.games.toFixed(0)} of {evaluation.weeks.count} weeks, starts {p.startsWeeks}
                    {p.rosValue != null ? `, ${p.rosValue.toFixed(0)} pts over a free agent` : ''}
                  </span>
                </dd>
              </div>
            ))}
            {side.adjustments.map((adj) => (
              <div className="weekly-line" key={adj.key} data-testid="trade-check-adjustment">
                <dt>Your habits</dt>
                <dd>
                  {signed(adj.points)} <span className="faint">{adj.label}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      {notes.length > 0 ? (
        <>
          <DetailLabel>Before you lean on it</DetailLabel>
          <ReasonList muted items={notes} />
        </>
      ) : null}
    </Fold>
  );
}
