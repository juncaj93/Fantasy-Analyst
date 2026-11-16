/**
 * Check a trade, rebuilt (Round 19): pick the team, pick what each side
 * gives, and get one line: Good for you, Fair or Bad for you. Under it, your
 * lineup change this week and over the rest of the season, theirs, the edge,
 * and who gets better where. The same verdict the offers are labelled with.
 *
 * Round 32: one field takes typed names for both sides (`core/trades/
 * checkSearch.ts`): your player goes to "You give", anyone else's to "You
 * get", and his manager becomes the partner. The field has the keyboard as
 * soon as Check opens, so a received 1-for-1 checks in four taps: Trades,
 * Check, one name, the other name. An offer card's "Check this offer" opens
 * here with both sides filled.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.ts';
import type { ScreensTeams, ScreensVerdict } from '../../../core/trades/screensWire.ts';
import {
  addToCheck,
  CHECK_MAX_SIDE,
  checkMatches,
  checkPool,
  type CheckState,
} from './checkSearch.ts';
import { ListGroup, ListRow, SearchField, SkeletonRows } from '../native.tsx';
import { PlayerPicker } from './playerPicker.tsx';
import { Compare, Players, signed, startsFor } from './offerCard.tsx';

const MAX_SIDE = CHECK_MAX_SIDE;

/** The field's test id, also how the screen gives it the keyboard on the tap that opens Check. */
export const CHECK_SEARCH_ID = 't2-check-search';

/** Puts the keyboard in the name field. Called inside a tap, so iPhone Safari opens the keyboard. */
export function focusCheckSearch(): void {
  document.querySelector<HTMLInputElement>(`[data-testid="${CHECK_SEARCH_ID}"]`)?.focus();
}

const EMPTY: CheckState = { partnerId: null, give: [], get: [] };

export function CheckTab({ teams, query, start }: { teams: ScreensTeams | null; query: string; start?: CheckState | null }) {
  const partners = useMemo(() => (teams?.teams ?? []).filter((t) => !t.isMine), [teams]);
  const mine = useMemo(() => (teams?.teams ?? []).find((t) => t.isMine) ?? null, [teams]);
  const pool = useMemo(() => checkPool(teams), [teams]);
  const [trade, setTrade] = useState<CheckState>(start ?? EMPTY);
  const { partnerId, give, get } = trade;
  const [text, setText] = useState('');
  const [picking, setPicking] = useState<'give' | 'get' | null>(null);
  const [verdict, setVerdict] = useState<ScreensVerdict | null>(null);
  const [checking, setChecking] = useState(false);

  const partner = partners.find((t) => t.rosterId === partnerId) ?? null;
  const nameOf = (id: string) => [...(mine?.players ?? []), ...(partner?.players ?? [])].find((p) => p.playerId === id);
  const matches = useMemo(() => checkMatches(pool, text, trade), [pool, text, trade]);
  const setGive = (next: (was: string[]) => string[]) => setTrade((t) => ({ ...t, give: next(t.give) }));
  const setGet = (next: (was: string[]) => string[]) => setTrade((t) => ({ ...t, get: next(t.get) }));

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

  const search = (
    <SearchField value={text} onChange={setText} placeholder="Type a player's name" label="Player in the trade" testId={CHECK_SEARCH_ID} />
  );

  /* The field is there while the rosters load, so the tap that opened Check can give it the keyboard. */
  if (!teams) {
    return (
      <div data-testid="t2-check">
        {search}
        <SkeletonRows rows={3} testId="t2-check-loading" />
      </div>
    );
  }
  if (!mine || partners.length === 0) return <div className="faint t2-empty">{teams.reason ?? 'Nobody to trade with yet.'}</div>;

  const remove = (side: 'give' | 'get', id: string) => (side === 'give' ? setGive : setGet)((was) => was.filter((x) => x !== id));
  const summary = verdict?.summary ?? null;

  return (
    <div data-testid="t2-check">
      {search}
      {matches.length > 0 ? (
        <ListGroup testId="t2-check-matches">
          {matches.map((p) => (
            <ListRow
              key={p.playerId}
              label={p.name}
              detail={`${p.position} · ${p.mine ? 'yours' : p.owner}`}
              value={<span className="t2-add">{p.mine ? 'Give' : 'Get'}</span>}
              onClick={() => {
                setTrade((t) => addToCheck(t, p));
                setText('');
                /* Keep the keyboard up for the next name. */
                focusCheckSearch();
              }}
              testId="t2-check-match"
            />
          ))}
        </ListGroup>
      ) : text.trim().length >= 2 ? (
        <div className="faint t2-empty">Nobody by that name.</div>
      ) : null}
      <label className="t2-field">
        <span className="t2-sub">Trade with</span>
        <select
          className="t2-select"
          data-testid="t2-check-team"
          value={partnerId ?? ''}
          onChange={(e) => {
            const next = e.target.value ? Number(e.target.value) : null;
            setTrade((t) => ({ ...t, partnerId: next, get: [] }));
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
        onRemove={(id) => remove('give', id)}
        testId="t2-check-give"
      />
      {partner ? (
        <Side
          title="You get"
          ids={get}
          nameOf={nameOf}
          onAdd={() => setPicking('get')}
          onRemove={(id) => remove('get', id)}
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
        <PlayerPicker
          title={picking === 'give' ? 'You give' : `You get from ${partner?.label ?? ''}`}
          players={(picking === 'give' ? mine.players : (partner?.players ?? [])).filter((p) => !(picking === 'give' ? give : get).includes(p.playerId))}
          room={MAX_SIDE - (picking === 'give' ? give : get).length}
          onAdd={(ids) => {
            const set = picking === 'give' ? setGive : setGet;
            set((was) => [...was, ...ids.filter((id) => !was.includes(id))].slice(0, MAX_SIDE));
            setPicking(null);
          }}
          onCancel={() => setPicking(null)}
        />
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
