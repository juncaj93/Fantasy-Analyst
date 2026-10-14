/**
 * Build a trade: mark who you would sell, pick a team, mark who you want.
 *
 * A fold on Trades, closed and free until opened. Opening it reads the rosters
 * (the request Check a trade makes); packages are built on a deliberate tap of
 * `Find trades`, never on a mark.
 *
 * ## Compact, as Alex asked on 15 October 2026
 *
 *  - rosters are wrapped chips (`chipPicker.tsx`), so a sixteen-player roster
 *    is five or six rows and the whole build flow (Sell chips, team, Want
 *    chips, Find trades) fits a 390 by 844 phone without scrolling;
 *  - `Find trades` sticks above the tab bar; results scroll below;
 *  - a card is a status chip and the team, one Give line, one Get line, one row
 *    of numbers (this week, next 3 weeks, playoffs, them) and one short phrase
 *    for their need. No sentences;
 *  - the sheet keeps the title, the status with one short reason, a three-row
 *    table and at most two short reasons on screen; the rest is under `More`.
 *
 * ## All teams, one team per request
 *
 * All teams asks the server for one team at a time (`sweep=1`) and shows
 * results as they arrive, so no single request is heavy enough to time out on
 * the free plan. A progress line says how far it has got; a team that fails
 * can be retried on its own.
 *
 * Marks live in this phone's browser storage (`tradeMarks.ts`). Nothing here
 * sends, proposes or accepts a trade; `Copy pitch` puts a message on the
 * clipboard for Alex to paste himself.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { DetailLabel } from './common.tsx';
import { ReasonList } from './decisions.tsx';
import { Fold, Sheet, SkeletonRows } from './native.tsx';
import { ChipPicker, InfoLine, shortName } from './chipPicker.tsx';
import type { TradeTeamsResponse } from '../../core/tradeValue/response.ts';
import {
  PACKAGE_STATUS_LABEL,
  followUpChip,
  topAcrossTeams,
  type BuilderResponse,
  type BuiltPackage,
  type PackagePlayer,
} from '../../core/trades/builderResponse.ts';
import { builderQuery, clearMarks, marksSummary, readMarks, toggle, writeMarks, type TradeMarks } from '../tradeMarks.ts';

type Load<T> = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; view: T } | { kind: 'failed' };

/** One team's answer in a sweep. */
type TeamRun = { rosterId: number; label: string; state: 'waiting' | 'loading' | 'done' | 'failed'; view?: BuilderResponse };

/** Results: one team's answer, or an All teams sweep in progress. */
type Results = { kind: 'idle' } | { kind: 'one'; state: Load<BuilderResponse> } | { kind: 'sweep'; runs: TeamRun[] };

/** A signed number to one decimal, with a real minus sign. */
export function signed(value: number): string {
  const text = Math.abs(value).toFixed(1);
  if (value > 0) return `+${text}`;
  if (value < 0) return `−${text}`;
  return '0.0';
}

export function TradeBuilderFold({ leagueId }: { leagueId: string }) {
  const [open, setOpen] = useState(false);
  const [teams, setTeams] = useState<Load<TradeTeamsResponse>>({ kind: 'idle' });
  const [marks, setMarks] = useState<TradeMarks>(() => readMarks(leagueId));
  const [results, setResults] = useState<Results>({ kind: 'idle' });
  const [openId, setOpenId] = useState<string | null>(null);
  const top = useRef<HTMLDivElement | null>(null);
  const sweepId = useRef(0);

  useEffect(() => setMarks(readMarks(leagueId)), [leagueId]);

  /* Once the rosters are in, bring the build flow to the top of the screen, so all of it is in view at once. */
  const ready = open && teams.kind === 'ready';
  useEffect(() => {
    if (ready) requestAnimationFrame(() => top.current?.scrollIntoView?.({ block: 'start' }));
  }, [ready]);

  const update = useCallback(
    (next: TradeMarks) => {
      setMarks(next);
      writeMarks(leagueId, next);
      sweepId.current += 1;
      setResults({ kind: 'idle' });
    },
    [leagueId],
  );

  const toggleFold = useCallback(() => {
    const opening = !open;
    setOpen(opening);
    if (!opening || teams.kind !== 'idle') return;
    setTeams({ kind: 'loading' });
    api
      .get<TradeTeamsResponse>(`/api/leagues/${encodeURIComponent(leagueId)}/trades/check/teams`)
      .then((view) => setTeams({ kind: 'ready', view }))
      .catch(() => setTeams({ kind: 'failed' }));
  }, [leagueId, open, teams.kind]);

  const list = teams.kind === 'ready' ? (teams.view.teams ?? []) : [];
  const mine = list.find((t) => t.isMine) ?? null;
  const others = list.filter((t) => !t.isMine && t.players.length > 0);
  const picked = marks.team === 'all' ? null : (others.find((t) => String(t.rosterId) === marks.team) ?? null);
  const onRoster = useMemo(() => {
    const byTeam = new Map(list.map((t) => [String(t.rosterId), new Set(t.players.map((p) => p.playerId))] as const));
    return (team: string, id: string) => byTeam.get(team)?.has(id) ?? false;
  }, [list]);
  const sellCount = mine ? marks.sell.filter((id) => onRoster(String(mine.rosterId), id)).length : 0;
  const horizon = teams.kind === 'ready' ? teams.view.horizon : undefined;
  const closed = horizon?.deadlinePassed === true;
  const canRun = mine != null && !closed && (sellCount > 0 || marks.unmarked);

  const ask = (team: number | 'all', sweep: boolean): Promise<BuilderResponse> => {
    const query = builderQuery({ ...marks, team: String(team) }, onRoster, String(mine!.rosterId));
    return api.get<BuilderResponse>(`/api/leagues/${encodeURIComponent(leagueId)}/trades/build?${query}${sweep ? '&sweep=1' : ''}`);
  };

  /* All teams, one request per team, in order; each answer lands as it arrives. */
  const sweep = async (runs: TeamRun[]) => {
    const id = (sweepId.current += 1);
    let current = runs;
    setResults({ kind: 'sweep', runs: current });
    for (const run of runs) {
      if (run.state === 'done') continue;
      if (sweepId.current !== id) return;
      current = current.map((r) => (r.rosterId === run.rosterId ? { ...r, state: 'loading' } : r));
      setResults({ kind: 'sweep', runs: current });
      let next: TeamRun;
      try {
        next = { ...run, state: 'done', view: await ask(run.rosterId, true) };
      } catch {
        next = { ...run, state: 'failed' };
      }
      if (sweepId.current !== id) return;
      current = current.map((r) => (r.rosterId === run.rosterId ? next : r));
      setResults({ kind: 'sweep', runs: current });
    }
  };

  const run = () => {
    if (!canRun) return;
    if (picked) {
      sweepId.current += 1;
      setResults({ kind: 'one', state: { kind: 'loading' } });
      ask(picked.rosterId, false)
        .then((view) => setResults({ kind: 'one', state: { kind: 'ready', view } }))
        .catch(() => setResults({ kind: 'one', state: { kind: 'failed' } }));
      return;
    }
    void sweep(others.map((t) => ({ rosterId: t.rosterId, label: t.label, state: 'waiting' })));
  };

  const shown = packagesOf(results);
  const opened = shown.find((p) => p.id === openId) ?? null;
  const meta = metaOf(results);
  const busy =
    (results.kind === 'one' && results.state.kind === 'loading') ||
    (results.kind === 'sweep' && results.runs.some((r) => r.state === 'loading' || r.state === 'waiting'));

  return (
    <Fold label="Build a trade" tag="Beta" summary={marksSummary(marks) ?? 'Sell and Want marks'} open={open} onToggle={toggleFold} testId="trade-builder">
      <div ref={top} className="trade-builder-top" />
      {teams.kind === 'idle' || teams.kind === 'loading' ? (
        <SkeletonRows rows={3} testId="trade-builder-skeleton" />
      ) : teams.kind === 'failed' ? (
        <InfoLine text="Could not read the rosters just now." testId="trade-builder-error" />
      ) : !teams.view.found || !mine ? (
        <InfoLine text={teams.view.reason ?? 'No trade can be built yet.'} testId="trade-builder-absent" />
      ) : (
        <div data-testid="trade-builder-panel">
          {horizon?.deadlineWeek != null ? (
            <InfoLine
              testId="trade-builder-deadline"
              text={closed ? `Trades closed after week ${horizon.deadlineWeek}` : `Trades close after week ${horizon.deadlineWeek} · ${horizon.weeksToDeadline ?? 0} wks left`}
              detail={`Read from your league's settings. Packages count week ${horizon.currentWeek} to week ${horizon.lastWeek}, playoffs included.`}
            />
          ) : null}

          <div className="tb-label" id="tb-sell-label">
            Sell <span className="tb-hint">tap yours</span>
          </div>
          <ChipPicker
            players={mine.players}
            marked={marks.sell}
            tag="Sell"
            label="Your players to sell"
            testId="trade-builder-mine"
            onToggle={(id) => update({ ...marks, sell: toggle(marks.sell, id) })}
          />

          <div className="tb-row">
            <label className="tb-select">
              <span className="sr-only">Trade with</span>
              <select
                aria-label="Trade with"
                data-testid="trade-builder-team"
                value={picked ? String(picked.rosterId) : 'all'}
                onChange={(e) => update({ ...marks, team: e.target.value })}
              >
                <option value="all">All teams</option>
                {others.map((t) => (
                  <option key={t.rosterId} value={String(t.rosterId)}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="mark-chip tb-toggle"
              data-on={marks.unmarked ? 'yes' : 'no'}
              aria-pressed={marks.unmarked}
              data-testid="trade-builder-unmarked"
              title="Also offer players you did not mark (never your elite backs or their handcuffs)"
              onClick={() => update({ ...marks, unmarked: !marks.unmarked })}
            >
              + unmarked {marks.unmarked ? 'on' : 'off'}
            </button>
          </div>

          {picked ? (
            <>
              <div className="tb-label">
                Want <span className="tb-hint">none marked: we suggest</span>
              </div>
              <ChipPicker
                players={picked.players}
                marked={marks.want[String(picked.rosterId)] ?? []}
                tag="Want"
                label={`${picked.label}'s players to want`}
                testId="trade-builder-theirs"
                onToggle={(id) => {
                  const key = String(picked.rosterId);
                  const next = toggle(marks.want[key] ?? [], id);
                  const want = { ...marks.want, [key]: next };
                  if (next.length === 0) delete want[key];
                  update({ ...marks, want });
                }}
              />
            </>
          ) : null}

          <div className="tb-sticky" data-testid="trade-builder-sticky">
            <button type="button" className="btn btn-primary" data-testid="trade-builder-run" disabled={!canRun || busy} onClick={run}>
              {busy ? 'Finding trades' : canRun || closed ? 'Find trades' : 'Mark a Sell first'}
            </button>
            <button
              type="button"
              className="btn"
              data-testid="trade-builder-clear"
              disabled={marksSummary(marks) == null && !marks.unmarked}
              onClick={() => {
                clearMarks(leagueId);
                sweepId.current += 1;
                setMarks({ ...marks, sell: [], want: {}, unmarked: false });
                setResults({ kind: 'idle' });
              }}
            >
              Clear
            </button>
          </div>

          <Results
            results={results}
            packages={shown}
            meta={meta}
            onOpen={setOpenId}
            onRetry={() => results.kind === 'sweep' && void sweep(results.runs.map((r) => (r.state === 'failed' ? { ...r, state: 'waiting' } : r)))}
          />
        </div>
      )}

      {opened && meta ? <PackageSheet pkg={opened} meta={meta} onClose={() => setOpenId(null)} /> : null}
    </Fold>
  );
}

/** The packages to show: one team's, or the merged best of a sweep. */
function packagesOf(results: Results): BuiltPackage[] {
  if (results.kind === 'one') return results.state.kind === 'ready' ? results.state.view.packages : [];
  if (results.kind === 'sweep') return topAcrossTeams(results.runs.flatMap((r) => r.view?.packages ?? []));
  return [];
}

/** What every answer shares: the weeks, the willingness line, the advisory. */
function metaOf(results: Results): BuilderResponse | null {
  if (results.kind === 'one') return results.state.kind === 'ready' ? results.state.view : null;
  if (results.kind === 'sweep') return results.runs.find((r) => r.view)?.view ?? null;
  return null;
}

function Results({
  results,
  packages,
  meta,
  onOpen,
  onRetry,
}: {
  results: Results;
  packages: BuiltPackage[];
  meta: BuilderResponse | null;
  onOpen: (id: string) => void;
  onRetry: () => void;
}) {
  if (results.kind === 'idle') return null;
  if (results.kind === 'one' && results.state.kind === 'loading') return <SkeletonRows rows={3} testId="trade-builder-result-skeleton" />;
  if (results.kind === 'one' && results.state.kind === 'failed') {
    return <InfoLine text="Could not build trades just now. Try again." testId="trade-builder-result-error" />;
  }

  const sweep = results.kind === 'sweep' ? results.runs : null;
  const done = sweep ? sweep.filter((r) => r.state === 'done' || r.state === 'failed').length : 0;
  const failed = sweep ? sweep.filter((r) => r.state === 'failed') : [];
  const finished = sweep ? done === sweep.length : true;
  const message = results.kind === 'one' && results.state.kind === 'ready' ? results.state.view.message : null;
  const notes = results.kind === 'one' && results.state.kind === 'ready' ? results.state.view.notes : [];

  return (
    <div data-testid="trade-builder-results">
      {sweep ? (
        <div className="tb-progress" data-testid="trade-builder-progress" aria-live="polite">
          {finished ? `${sweep.length} of ${sweep.length} teams` : `${done} of ${sweep.length} teams`}
          {failed.length > 0 && finished ? (
            <>
              {' · '}
              {failed.length} didn’t load{' '}
              <button type="button" className="tb-retry" data-testid="trade-builder-retry" onClick={onRetry}>
                Retry
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {notes.map((n) => (
        <InfoLine key={n} text={n} testId="trade-builder-note" />
      ))}
      {packages.length === 0 && (finished || !sweep) ? (
        <InfoLine
          testId="trade-builder-empty"
          text={message ?? 'No package helps both sides right now.'}
        />
      ) : (
        <div className="smart-trade-group" role="list" aria-label="Trade packages">
          {packages.map((p) => (
            <div role="listitem" key={p.id}>
              <PackageCard pkg={p} week={meta?.weeks?.thisWeek ?? null} onOpen={() => onOpen(p.id)} />
            </div>
          ))}
        </div>
      )}
      {meta ? <InfoLine testId="trade-builder-willingness" text="Willingness unknown" detail={meta.willingness} /> : null}
    </div>
  );
}

/** `week 6`, `weeks 6 and 8`, `weeks 6, 8 and 9`. */
function weeksText(weeks: readonly number[]): string {
  if (weeks.length === 1) return `week ${weeks[0]}`;
  return `weeks ${weeks.slice(0, -1).join(', ')} and ${weeks[weeks.length - 1]}`;
}

/** `T. Pollard RB 11.0`, players joined on one line. */
function sideText(players: readonly PackagePlayer[]): string {
  return players.map((p) => `${shortName(p.name, p.position, p.team)} ${p.position} ${statNumber(p.stat)}`.trim()).join(' + ');
}

/** The one stat: the points a game from `RB · 11.0 a game · Questionable`. */
function statNumber(stat: string): string {
  return /(\d+(?:\.\d+)?) a game/.exec(stat)?.[1] ?? '';
}

/** Status chip and team; Give; Get; one row of numbers; one phrase for their need. */
function PackageCard({ pkg, week, onOpen }: { pkg: BuiltPackage; week: number | null; onOpen: () => void }) {
  return (
    <button type="button" className="smart-trade builder-card" data-testid="builder-card" data-status={pkg.status} onClick={onOpen}>
      <span className="builder-card-head">
        <span className="builder-chips">
          <span className="builder-status" data-status={pkg.status} data-testid="builder-status">
            {PACKAGE_STATUS_LABEL[pkg.status]}
          </span>
          {pkg.costsNow ? (
            <span className="builder-status builder-costs" data-testid="builder-costs-now">
              Costs you now
            </span>
          ) : null}
          {followUpChip(pkg.followUp) ? (
            <span className="builder-status builder-costs" data-testid="builder-add">
              {followUpChip(pkg.followUp)}
            </span>
          ) : null}
        </span>
        <span className="builder-partner">{pkg.partner.label}</span>
      </span>
      <span className="builder-line" data-testid="builder-give">
        <span className="builder-label">Give</span>
        <span className="builder-one">{sideText(pkg.give)}</span>
      </span>
      <span className="builder-line" data-testid="builder-get">
        <span className="builder-label">Get</span>
        <span className="builder-one">{sideText(pkg.get)}</span>
      </span>
      {pkg.drops.length > 0 ? (
        <span className="builder-line" data-testid="builder-drop">
          <span className="builder-label">Drop</span>
          <span className="builder-one">{sideText(pkg.drops)}</span>
        </span>
      ) : null}
      <span className="builder-nums" data-testid="builder-nums">
        <Num label={week != null ? `Wk ${week}` : 'Now'} value={pkg.alex.thisWeek} />
        <Num label="Next 3" value={pkg.alex.next3} />
        <Num label="Playoffs" value={pkg.alex.playoffs} />
        <Num label="Them" value={pkg.them.next3} />
      </span>
      {pkg.needShort ?? pkg.need ? (
        <span className="builder-need" data-testid="builder-why">
          {pkg.needShort ?? pkg.need}
        </span>
      ) : null}
    </button>
  );
}

function Num({ label, value }: { label: string; value: number }) {
  return (
    <span className="builder-num">
      <span className="builder-num-label">{label}</span>
      <span className={`builder-num-value tally tally-${value > 0 ? 'pos' : value < 0 ? 'neg' : 'none'}`}>{signed(value)}</span>
    </span>
  );
}

/** The title, the status with one reason, a three-row table, two reasons; the rest under More. */
function PackageSheet({ pkg, meta, onClose }: { pkg: BuiltPackage; meta: BuilderResponse; onClose: () => void }) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const [more, setMore] = useState(false);
  const names = (list: readonly PackagePlayer[]) => list.map((p) => shortName(p.name, p.position, p.team)).join(' + ');
  const week = meta.weeks?.thisWeek;
  const why = (pkg.whyShort ?? pkg.reasons).slice(0, 2);
  return (
    <Sheet title={`${names(pkg.give)} → ${names(pkg.get)}`} accessibleLabel={`Trade with ${pkg.partner.label}`} onClose={onClose} testId="builder-detail">
      <div className="weekly" data-testid="builder-detail-body" data-package-id={pkg.id}>
        <div className="builder-sheet-status">
          <span className="builder-status" data-status={pkg.status}>
            {PACKAGE_STATUS_LABEL[pkg.status]}
          </span>
          {pkg.costsNow ? <span className="builder-status builder-costs">Costs you now</span> : null}
          <span className="builder-sheet-reason">{pkg.statusShort ?? pkg.statusReason}</span>
        </div>

        <table className="builder-table" data-testid="builder-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Who</span>
              </th>
              <th scope="col">{week != null ? `Wk ${week}` : 'Now'}</th>
              <th scope="col">Next 3</th>
              <th scope="col">Playoffs</th>
              <th scope="col">Season</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Your lineup</th>
              <Cell value={pkg.alex.thisWeek} />
              <Cell value={pkg.alex.next3} />
              <Cell value={pkg.alex.playoffs} />
              <Cell value={pkg.alex.restOfSeason} />
            </tr>
            <tr>
              <th scope="row">Them</th>
              <td className="builder-table-dim">·</td>
              <Cell value={pkg.them.next3} />
              <td className="builder-table-dim">·</td>
              <Cell value={pkg.them.restOfSeason} />
            </tr>
            <tr>
              <th scope="row">Their need</th>
              <td colSpan={4} className="builder-table-text" data-testid="builder-need">
                {pkg.needShort ?? pkg.need ?? 'None named'}
              </td>
            </tr>
          </tbody>
        </table>

        {why.length > 0 ? (
          <div data-testid="builder-reasons">
            <ReasonList items={why} />
          </div>
        ) : null}
        {pkg.drops.length > 0 ? (
          <div className="builder-sheet-line" data-testid="builder-detail-drops">
            Drop {names(pkg.drops)} <span className="faint">· {pkg.drops[0]!.reason}</span>
          </div>
        ) : null}
        {pkg.irMoves.length > 0 ? (
          <div className="builder-sheet-line">
            {names(pkg.irMoves)} to IR <span className="faint">· open IR slot</span>
          </div>
        ) : null}
        {(pkg.followUp ?? []).map((f) => (
          <div className="builder-sheet-line" data-testid="builder-detail-add" key={f.position}>
            No {f.position} on your roster in {weeksText(f.weeks)}.{' '}
            {f.assumes ? (
              <span className="faint">
                Numbers assume a free agent at {f.assumes.rate.toFixed(1)} pts: {f.assumes.names.join(', ')}
                {f.assumes.names.length > 1 ? ' (their average)' : ''}
              </span>
            ) : (
              <span className="faint">No free-agent {f.position} is priced to fill it.</span>
            )}
          </div>
        ))}
        {pkg.basis === 'sleeper' ? (
          <div className="builder-sheet-line faint" data-testid="builder-basis">
            Built mostly on Sleeper’s projection, not Vegas
          </div>
        ) : null}

        <div className="field builder-sheet-actions">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="builder-copy"
            onClick={() => {
              copyText(pkg.pitch).then(
                () => setCopied('done'),
                () => setCopied('failed'),
              );
            }}
          >
            {copied === 'done' ? 'Copied' : 'Copy pitch'}
          </button>
          <button type="button" className="btn" aria-expanded={more} data-testid="builder-more" onClick={() => setMore((m) => !m)}>
            {more ? 'Less' : 'More'}
          </button>
        </div>
        {copied === 'failed' ? <div className="faint">Could not copy. Open More and press and hold the message.</div> : null}

        {more ? (
          <div data-testid="builder-more-body">
            <DetailLabel>Pitch</DetailLabel>
            <p className="builder-pitch" data-testid="builder-pitch">
              {pkg.pitch}
            </p>
            <DetailLabel>This manager</DetailLabel>
            <div className="builder-sheet-line" data-testid="builder-activity">
              {pkg.partner.activity.line}
            </div>
            <DetailLabel>Value</DetailLabel>
            <div className="builder-sheet-line">
              {pkg.balance.label} <span className="faint">· give {Math.round(pkg.balance.give)}, get {Math.round(pkg.balance.get)} over a free agent</span>
            </div>
            {pkg.alex.adjustments.length > 0 ? (
              <>
                <DetailLabel>Your habits</DetailLabel>
                <ReasonList muted items={pkg.alex.adjustments.map((a) => `${signed(a.points)} ${a.label}`)} />
              </>
            ) : null}
            {pkg.caveats.length > 0 ? (
              <>
                <DetailLabel>{pkg.caveats.length === 1 ? 'Caveat' : 'Caveats'}</DetailLabel>
                <ReasonList muted items={pkg.caveats} />
              </>
            ) : null}
            <div className="faint" style={{ marginTop: 8 }} data-testid="builder-advisory">
              {meta.willingness} {meta.advisory}
            </div>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

function Cell({ value }: { value: number }) {
  return <td className={`tally tally-${value > 0 ? 'pos' : value < 0 ? 'neg' : 'none'}`}>{signed(value)}</td>;
}

/** The clipboard, with the old select-and-copy route for a browser that refuses it. */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* Fall through. */
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(area);
  if (!ok) throw new Error('copy refused');
}
