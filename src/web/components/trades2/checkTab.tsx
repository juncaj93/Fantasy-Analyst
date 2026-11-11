/**
 * Check a trade, rebuilt (Round 19): pick the team, pick what each side
 * gives, and get one line: Good for you, Fair or Bad for you. Under it, your
 * lineup change this week and over the rest of the season, theirs, the edge,
 * and who gets better where. The same verdict the offers are labelled with.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.ts';
import type { ScreensTeams, ScreensVerdict } from '../../../core/trades/screensWire.ts';
import { ListGroup, ListRow, Sheet, SkeletonRows } from '../native.tsx';
import { Compare, Players, signed, startsFor } from './offerCard.tsx';

const MAX_SIDE = 3;

export function CheckTab({ teams, query }: { teams: ScreensTeams | null; query: string }) {
  const partners = useMemo(() => (teams?.teams ?? []).filter((t) => !t.isMine), [teams]);
  const mine = useMemo(() => (teams?.teams ?? []).find((t) => t.isMine) ?? null, [teams]);
  const [partnerId, setPartnerId] = useState<number | null>(null);
  const [give, setGive] = useState<string[]>([]);
  const [get, setGet] = useState<string[]>([]);
  const [picking, setPicking] = useState<'give' | 'get' | null>(null);
  const [verdict, setVerdict] = useState<ScreensVerdict | null>(null);
  const [checking, setChecking] = useState(false);

  const partner = partners.find((t) => t.rosterId === partnerId) ?? null;
  const nameOf = (id: string) => [...(mine?.players ?? []), ...(partner?.players ?? [])].find((p) => p.playerId === id);

  useEffect(() => {
    if (partnerId == null || give.length + get.length === 0) {
      setVerdict(null);
      return;
    }
    let live = true;
    setChecking(true);
    const path =
      `/api/trades/screens/verdict?b=${partnerId}&give=${give.map(encodeURIComponent).join(',')}` +
      `&get=${get.map(encodeURIComponent).join(',')}${query ? `&${query}` : ''}`;
    api
      .get<ScreensVerdict>(path)
      .then((v) => live && setVerdict(v))
      .catch(() => live && setVerdict({ found: false, reason: 'Could not check this trade right now.' }))
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
  }, [partnerId, give, get, query]);

  if (!teams) return <SkeletonRows rows={3} testId="t2-check-loading" />;
  if (!mine || partners.length === 0) return <div className="faint t2-empty">{teams.reason ?? 'Nobody to trade with yet.'}</div>;

  const toggle = (side: 'give' | 'get', id: string) => {
    const set = side === 'give' ? setGive : setGet;
    set((was) => (was.includes(id) ? was.filter((x) => x !== id) : was.length >= MAX_SIDE ? was : [...was, id]));
  };
  const summary = verdict?.summary ?? null;

  return (
    <div data-testid="t2-check">
      <label className="t2-field">
        <span className="t2-sub">Trade with</span>
        <select
          className="t2-select"
          data-testid="t2-check-team"
          value={partnerId ?? ''}
          onChange={(e) => {
            setPartnerId(e.target.value ? Number(e.target.value) : null);
            setGet([]);
          }}
        >
          <option value="">Pick a team</option>
          {partners.map((t) => (
            <option key={t.rosterId} value={t.rosterId}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      <Side
        title="You give"
        ids={give}
        nameOf={nameOf}
        onAdd={() => setPicking('give')}
        onRemove={(id) => toggle('give', id)}
        testId="t2-check-give"
      />
      {partner ? (
        <Side
          title="You get"
          ids={get}
          nameOf={nameOf}
          onAdd={() => setPicking('get')}
          onRemove={(id) => toggle('get', id)}
          testId="t2-check-get"
        />
      ) : null}

      {checking && !verdict ? <SkeletonRows rows={2} testId="t2-check-checking" /> : null}
      {verdict && !verdict.found ? <div className="t2-note">{verdict.reason}</div> : null}
      {verdict?.found && !summary ? <div className="t2-note">{verdict.insufficient ?? 'This trade cannot be judged yet.'}</div> : null}
      {summary && partner ? (
        <div className="card t2-result" data-testid="t2-check-result" data-verdict={summary.verdict}>
          <div className="t2-verdict" data-verdict={summary.verdict}>
            <span className="t2-verdict-word" data-testid="t2-check-word">
              {summary.word}
            </span>
            <span className="t2-verdict-reason">{summary.reason}</span>
          </div>
          <Compare
            rows={[
              ['This week', signed(summary.you.thisWeek, 1), signed(summary.them.thisWeek, 1)],
              ['Rest of season', signed(summary.you.restOfSeason), signed(summary.them.restOfSeason)],
            ]}
            them={partner.label}
          />
          <dl className="t2-facts">
            <div>
              <dt>Edge</dt>
              <dd data-testid="t2-check-edge">
                {signed(summary.edgePercent)}% {summary.edgePercent > 0 ? 'your way' : summary.edgePercent < 0 ? 'their way' : ''}
              </dd>
            </div>
            <div>
              <dt>You get better at</dt>
              <dd data-testid="t2-check-better-you">
                {summary.positions.you.better.join(', ') || 'Nothing'}
                {summary.positions.you.thinner.length ? `; thinner at ${summary.positions.you.thinner.join(', ')}` : ''}
              </dd>
            </div>
            <div>
              <dt>{partner.label} gets better at</dt>
              <dd>
                {summary.positions.them.better.join(', ') || 'Nothing'}
                {summary.positions.them.thinner.length ? `; thinner at ${summary.positions.them.thinner.join(', ')}` : ''}
              </dd>
            </div>
            {verdict?.drop ? (
              <div>
                <dt>You cut</dt>
                <dd>{verdict.drop}</dd>
              </div>
            ) : null}
          </dl>
          {verdict?.give?.length ? (
            <Players title="You give" players={verdict.give} describe={(p) => (p.starts > 0 ? `Starts ${p.starts} of ${verdict.weeks ?? p.starts} weeks for you now` : 'On your bench now')} />
          ) : null}
          {verdict?.get?.length ? <Players title="You get" players={verdict.get} describe={startsFor('you', verdict.weeks ?? 1)} /> : null}
        </div>
      ) : null}

      {picking ? (
        <Sheet title={picking === 'give' ? 'You give' : `You get from ${partner?.label ?? ''}`} onClose={() => setPicking(null)} testId="t2-check-picker">
          <ListGroup>
            {(picking === 'give' ? mine.players : (partner?.players ?? [])).map((p) => {
              const on = (picking === 'give' ? give : get).includes(p.playerId);
              return (
                <ListRow
                  key={p.playerId}
                  label={p.name}
                  detail={`${p.position} · ${p.team}`}
                  mark={on ? '✓' : undefined}
                  pressed={on}
                  onClick={() => toggle(picking, p.playerId)}
                  testId="t2-check-option"
                />
              );
            })}
          </ListGroup>
        </Sheet>
      ) : null}
    </div>
  );
}

function Side({
  title,
  ids,
  nameOf,
  onAdd,
  onRemove,
  testId,
}: {
  title: string;
  ids: string[];
  nameOf: (id: string) => { name: string; position: string } | undefined;
  onAdd: () => void;
  onRemove: (id: string) => void;
  testId: string;
}) {
  return (
    <ListGroup header={title} testId={testId}>
      {ids.map((id) => {
        const p = nameOf(id);
        return (
          <ListRow
            key={id}
            label={p?.name ?? id}
            detail={p?.position}
            value={<span className="t2-change">Remove</span>}
            onClick={() => onRemove(id)}
            testId={`${testId}-player`}
          />
        );
      })}
      {ids.length < MAX_SIDE ? <ListRow label={<span className="t2-add">Add a player</span>} onClick={onAdd} testId={`${testId}-add`} /> : null}
    </ListGroup>
  );
}
