/**
 * Build a trade: mark who you would sell, pick a team, mark who you want.
 *
 * A fold on Trades, closed and free until it is opened. Opening it reads the
 * rosters (the same small request Check a trade makes); the packages are built
 * on a deliberate tap of `Find trades`, never on a mark.
 *
 * ## Layout, as Alex asked for it
 *
 *  - short ranked lines, one item per line, names in normal weight and stats
 *    muted, chips that stay on one line;
 *  - a card is Give and Get lines, three numbers (this week, next 3 weeks,
 *    playoffs), one line on why it works for them, and the status chip;
 *  - everything else (the full reasons, the drop, the manager's record, the
 *    pitch) is in the sheet a tap opens.
 *
 * Marks live in this phone's browser storage (`tradeMarks.ts`). Nothing here
 * sends, proposes or accepts a trade; `Copy pitch` puts a message on the
 * clipboard for Alex to paste himself.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { DetailLabel, PositionPill, StatusRow } from './common.tsx';
import { ReasonList } from './decisions.tsx';
import { Fold, ListGroup, ListRow, Sheet, SkeletonRows } from './native.tsx';
import type { TradeTeam, TradeTeamsResponse } from '../../core/tradeValue/response.ts';
import {
  PACKAGE_STATUS_LABEL,
  type BuilderResponse,
  type BuiltPackage,
  type PackagePlayer,
} from '../../core/trades/builderResponse.ts';
import { builderQuery, clearMarks, marksSummary, readMarks, toggle, writeMarks, type TradeMarks } from '../tradeMarks.ts';

type Load<T> = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; view: T } | { kind: 'failed' };

/** A signed number to one decimal, with a real minus sign. */
function signed(value: number): string {
  const text = Math.abs(value).toFixed(1);
  if (value > 0) return `+${text}`;
  if (value < 0) return `−${text}`;
  return '0.0';
}

export function TradeBuilderFold({ leagueId }: { leagueId: string }) {
  const [open, setOpen] = useState(false);
  const [teams, setTeams] = useState<Load<TradeTeamsResponse>>({ kind: 'idle' });
  const [marks, setMarks] = useState<TradeMarks>(() => readMarks(leagueId));
  const [result, setResult] = useState<Load<BuilderResponse>>({ kind: 'idle' });
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => setMarks(readMarks(leagueId)), [leagueId]);

  const update = useCallback(
    (next: TradeMarks) => {
      setMarks(next);
      writeMarks(leagueId, next);
      setResult({ kind: 'idle' });
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

  const run = () => {
    if (!mine) return;
    setResult({ kind: 'loading' });
    api
      .get<BuilderResponse>(`/api/leagues/${encodeURIComponent(leagueId)}/trades/build?${builderQuery(marks, onRoster, String(mine.rosterId))}`)
      .then((view) => setResult({ kind: 'ready', view }))
      .catch(() => setResult({ kind: 'failed' }));
  };

  const opened = result.kind === 'ready' ? (result.view.packages.find((p) => p.id === openId) ?? null) : null;

  return (
    <Fold label="Build a trade" summary={marksSummary(marks) ?? 'Sell and Want marks'} open={open} onToggle={toggleFold} testId="trade-builder">
      {teams.kind === 'idle' || teams.kind === 'loading' ? (
        <SkeletonRows rows={3} testId="trade-builder-skeleton" />
      ) : teams.kind === 'failed' ? (
        <StatusRow tone="info" data-testid="trade-builder-error">
          Could not read the rosters just now.
        </StatusRow>
      ) : !teams.view.found || !mine ? (
        <StatusRow tone="info" data-testid="trade-builder-absent">
          {teams.view.reason ?? 'No trade can be built yet.'}
        </StatusRow>
      ) : (
        <div data-testid="trade-builder-panel">
          {teams.view.horizon?.deadlineWeek != null ? (
            <StatusRow tone={teams.view.horizon.deadlinePassed ? 'warn' : 'info'} data-testid="trade-builder-deadline">
              {deadlineText(teams.view.horizon)}
            </StatusRow>
          ) : null}

          <MarkList
            title="Your players: tap to mark Sell"
            team={mine}
            marked={marks.sell}
            chip="Sell"
            testId="trade-builder-mine"
            onToggle={(id) => update({ ...marks, sell: toggle(marks.sell, id) })}
          />
          <ListGroup testId="trade-builder-options">
            <ListRow
              label="Also consider unmarked players"
              detail="Never your elite backs"
              mark={<span className="mark-chip" data-on={marks.unmarked ? 'yes' : 'no'}>{marks.unmarked ? 'On' : 'Off'}</span>}
              pressed={marks.unmarked}
              onClick={() => update({ ...marks, unmarked: !marks.unmarked })}
              testId="trade-builder-unmarked"
            />
          </ListGroup>

          <div className="field">
            <label className="field-label" htmlFor="trade-builder-team">
              Trade with
            </label>
            <select
              id="trade-builder-team"
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
          </div>

          {picked ? (
            <MarkList
              title="Their players: tap to mark Want"
              team={picked}
              marked={marks.want[String(picked.rosterId)] ?? []}
              chip="Want"
              hint="Mark nobody and the app suggests who would help you most."
              testId="trade-builder-theirs"
              onToggle={(id) => {
                const key = String(picked.rosterId);
                const next = toggle(marks.want[key] ?? [], id);
                const want = { ...marks.want, [key]: next };
                if (next.length === 0) delete want[key];
                update({ ...marks, want });
              }}
            />
          ) : null}

          <div className="field trade-builder-actions">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="trade-builder-run"
              disabled={(sellCount === 0 && !marks.unmarked) || result.kind === 'loading' || teams.view.horizon?.deadlinePassed === true}
              onClick={run}
            >
              {result.kind === 'loading' ? 'Finding trades' : 'Find trades'}
            </button>
            <button
              type="button"
              className="btn"
              data-testid="trade-builder-clear"
              disabled={marksSummary(marks) == null && !marks.unmarked}
              onClick={() => {
                clearMarks(leagueId);
                const next = { ...marks, sell: [], want: {}, unmarked: false };
                setMarks(next);
                setResult({ kind: 'idle' });
              }}
            >
              Clear marks
            </button>
          </div>
          {sellCount === 0 && !marks.unmarked ? (
            <div className="faint trade-builder-hint" data-testid="trade-builder-need-sell">
              Mark at least one of your players Sell to find trades.
            </div>
          ) : null}

          <BuilderResults state={result} onOpen={setOpenId} />
        </div>
      )}

      {opened ? <PackageSheet pkg={opened} result={(result as { view: BuilderResponse }).view} onClose={() => setOpenId(null)} /> : null}
    </Fold>
  );
}

function deadlineText(h: NonNullable<TradeTeamsResponse['horizon']>): string {
  if (h.deadlineWeek == null) return '';
  if (h.deadlinePassed) return `The trade deadline was after week ${h.deadlineWeek}. Trades are closed.`;
  const left = h.weeksToDeadline ?? 0;
  if (left <= 1) return `Last week to trade: the deadline is after week ${h.deadlineWeek}.`;
  return `Trades close after week ${h.deadlineWeek} (${left} weeks left).`;
}

/** A roster as a list of tappable rows, each with its mark chip on the trailing edge. */
function MarkList({
  title,
  team,
  marked,
  chip,
  hint,
  testId,
  onToggle,
}: {
  title: string;
  team: TradeTeam;
  marked: readonly string[];
  chip: 'Sell' | 'Want';
  hint?: string;
  testId: string;
  onToggle: (playerId: string) => void;
}) {
  return (
    <ListGroup header={title} footer={hint} testId={testId}>
      {team.players.map((p) => {
        const on = marked.includes(p.playerId);
        return (
          <ListRow
            key={p.playerId}
            state={<PositionPill position={p.position} />}
            label={p.name}
            detail={[p.team || null, p.reserve ? 'IR slot' : null, p.status].filter(Boolean).join(' · ') || undefined}
            mark={on ? <span className="mark-chip" data-kind={chip.toLowerCase()} data-testid="trade-builder-chip">{chip}</span> : undefined}
            onClick={() => onToggle(p.playerId)}
            dataState={on ? 'marked' : 'idle'}
            pressed={on}
            testId="trade-builder-player"
          />
        );
      })}
    </ListGroup>
  );
}

function BuilderResults({ state, onOpen }: { state: Load<BuilderResponse>; onOpen: (id: string) => void }) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'loading') return <SkeletonRows rows={3} testId="trade-builder-result-skeleton" />;
  if (state.kind === 'failed') {
    return (
      <StatusRow tone="info" data-testid="trade-builder-result-error">
        Could not build trades just now.
      </StatusRow>
    );
  }
  const view = state.view;
  return (
    <div data-testid="trade-builder-results">
      {view.notes.map((n) => (
        <StatusRow key={n} tone="info" data-testid="trade-builder-note">
          {n}
        </StatusRow>
      ))}
      {view.packages.length === 0 ? (
        <StatusRow tone="info" data-testid="trade-builder-empty">
          {view.message ?? 'No package helps both sides right now.'}
        </StatusRow>
      ) : (
        <>
          <div className="section-title section-title-row">
            <span>Packages</span>
            <span className="section-title-meta">
              <span className="section-count">{view.packages.length}</span>
            </span>
          </div>
          <div className="smart-trade-group" role="list" aria-label="Trade packages">
            {view.packages.map((p) => (
              <div role="listitem" key={p.id}>
                <PackageCard pkg={p} weeks={view.weeks} onOpen={() => onOpen(p.id)} />
              </div>
            ))}
          </div>
        </>
      )}
      <div className="faint trade-builder-hint" data-testid="trade-builder-willingness">
        {view.willingness}
      </div>
    </div>
  );
}

/** Give and Get lines, three numbers, why it works for them, and the status chip. */
function PackageCard({ pkg, weeks, onOpen }: { pkg: BuiltPackage; weeks: BuilderResponse['weeks']; onOpen: () => void }) {
  return (
    <button type="button" className="smart-trade builder-card" data-testid="builder-card" data-status={pkg.status} onClick={onOpen}>
      <span className="builder-card-head">
        <span className="builder-status" data-status={pkg.status} data-testid="builder-status">
          {PACKAGE_STATUS_LABEL[pkg.status]}
        </span>
        <span className="builder-partner faint">with {pkg.partner.label}</span>
      </span>
      <PlayerLines label="Give" players={pkg.give} testId="builder-give" />
      <PlayerLines label="Get" players={pkg.get} testId="builder-get" />
      {pkg.drops.length > 0 ? <PlayerLines label="Drop" players={pkg.drops} testId="builder-drop" /> : null}
      <span className="builder-nums" data-testid="builder-nums">
        <Num label={weeks ? `Week ${weeks.thisWeek}` : 'This week'} value={pkg.alex.thisWeek} />
        <Num label="Next 3 weeks" value={pkg.alex.next3} />
        <Num label="Playoffs" value={pkg.alex.playoffs} />
      </span>
      <span className="builder-why" data-testid="builder-why">
        <span className="builder-them">Them {signed(pkg.them.next3)}</span>
        <span className="builder-why-text">{pkg.why}</span>
      </span>
    </button>
  );
}

function PlayerLines({ label, players, testId }: { label: string; players: readonly PackagePlayer[]; testId: string }) {
  return (
    <span className="builder-line" data-testid={testId}>
      <span className="builder-label">{label}</span>
      <span className="builder-players">
        {players.map((p) => (
          <span className="builder-player" key={p.playerId}>
            <span className="builder-name">{p.name}</span> <span className="builder-stat">{p.stat}</span>
          </span>
        ))}
      </span>
    </span>
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

/** The whole case, in the sheet grammar every other detail uses. */
function PackageSheet({ pkg, result, onClose }: { pkg: BuiltPackage; result: BuilderResponse; onClose: () => void }) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const names = (list: readonly PackagePlayer[]) => list.map((p) => p.name).join(' + ');
  const weeks = result.weeks;
  return (
    <Sheet title={`${names(pkg.give)} → ${names(pkg.get)}`} accessibleLabel={`Trade with ${pkg.partner.label}`} onClose={onClose} testId="builder-detail">
      <div className="weekly" data-testid="builder-detail-body" data-package-id={pkg.id}>
        <div className="trade-case-head">
          <span className="builder-status" data-status={pkg.status}>
            {PACKAGE_STATUS_LABEL[pkg.status]}
          </span>
          <span className="faint">{pkg.statusReason}</span>
        </div>
        <dl className="weekly-lines">
          <div className="weekly-line">
            <dt>Your lineup</dt>
            <dd>
              {signed(pkg.alex.thisWeek)}{' '}
              <span className="faint">
                week {weeks?.thisWeek ?? ''}, {signed(pkg.alex.next3)} next 3 weeks, {signed(pkg.alex.playoffs)} playoffs, {signed(pkg.alex.restOfSeason)} rest of season
              </span>
            </dd>
          </div>
          <div className="weekly-line">
            <dt>{pkg.partner.label}</dt>
            <dd>
              {signed(pkg.them.next3)}{' '}
              <span className="faint">next 3 weeks, {signed(pkg.them.restOfSeason)} rest of season</span>
            </dd>
          </div>
          <div className="weekly-line">
            <dt>Their need</dt>
            <dd>{pkg.need ? pkg.need.charAt(0).toUpperCase() + pkg.need.slice(1) : 'None named'}</dd>
          </div>
          <div className="weekly-line">
            <dt>Value</dt>
            <dd>
              {pkg.balance.label.charAt(0).toUpperCase() + pkg.balance.label.slice(1)}{' '}
              <span className="faint">
                you give {Math.round(pkg.balance.give)}, get {Math.round(pkg.balance.get)} pts over a free agent
              </span>
            </dd>
          </div>
          <div className="weekly-line">
            <dt>This manager</dt>
            <dd data-testid="builder-activity">{pkg.partner.activity.line}</dd>
          </div>
        </dl>

        {pkg.drops.length > 0 || pkg.irMoves.length > 0 ? (
          <>
            <DetailLabel>Roster spot</DetailLabel>
            <ol className="best-drops-why" data-testid="builder-detail-drops">
              {pkg.irMoves.map((p) => (
                <li key={p.playerId}>
                  <span className="best-drops-name">Move {p.name} to IR</span> <span className="best-drops-stat">{p.stat}</span>
                  <span className="best-drops-reason faint">{p.reason}</span>
                </li>
              ))}
              {pkg.drops.map((p) => (
                <li key={p.playerId}>
                  <span className="best-drops-name">Drop {p.name}</span> <span className="best-drops-stat">{p.stat}</span>
                  <span className="best-drops-reason faint">{p.reason}</span>
                </li>
              ))}
            </ol>
          </>
        ) : null}

        <DetailLabel>Why it works</DetailLabel>
        <div data-testid="builder-reasons">
          <ReasonList items={pkg.reasons} />
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

        <DetailLabel>Pitch</DetailLabel>
        <p className="builder-pitch" data-testid="builder-pitch">
          {pkg.pitch}
        </p>
        <div className="field">
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
        </div>
        {copied === 'failed' ? <div className="faint">Could not copy. Press and hold the message above to copy it.</div> : null}

        <div className="faint" style={{ marginTop: 8 }} data-testid="builder-advisory">
          {result.willingness} {result.advisory} You paste the pitch into Sleeper yourself.
        </div>
      </div>
    </Sheet>
  );
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
