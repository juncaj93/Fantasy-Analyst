/**
 * Players, in season (Round 24, behind the `PLAYERS_INSEASON` switch).
 *
 * The draft list's rows and controls, ranked by rest-of-season value by
 * default, with draft order one tap away and the pick, 7-day and 30-day moves
 * kept on every row (Alex). Two new filters: Trade targets (players on other
 * teams who would start for you, with how likely the owner is to deal) and
 * Injured (out now, and the week he is back). A tap opens the player with
 * this week's number, the next four weeks with byes, and the last five games.
 *
 * One request for the whole list; sorting, filtering and searching it cost no
 * reads. A search that finds nobody on the list asks the draft list's own
 * search, so any player can still be found by name.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type LeagueSummary } from '../api.ts';
import type { SeasonBoard, SeasonCard, SeasonRow, Willingness } from '../../core/players/seasonWire.ts';
import { byOverFreeAgent, byWillingness } from '../../core/players/seasonOrder.ts';
import { FLX_FILTER, positionMatchesFilter } from '../../core/sleeper/eligibility.ts';
import { buildRosterShape, startablePositions } from '../../core/sleeper/rosterShape.ts';
import { ANYONE_OWNER, matchesOwner, parseOwnerFilter, resolveOwnerFilter, type OwnerTeam } from '../../core/roster/ownership.ts';
import { ALL_FILTER, ownerButtonLabel, ownerFilterOptions, ownerPillLabel, playerFilterChips, playersEmptyLine, teamLabel } from '../playerFilters.ts';
import { Empty, Notice, PlayerSheetTitle, SignedValue } from '../components/common.tsx';
import { ListGroup, ListRow, NavBar, SearchField, SegmentedControl, Sheet, SkeletonRows } from '../components/native.tsx';
import { CompactPlayerRow } from '../components/playerRow.tsx';
import { PlayerPage, PlayerSheet, type PlayerSummary } from '../components/playerPage.tsx';
import { SeasonCardBlock } from '../components/players2/seasonCard.tsx';
import { pageScrollTop } from '../overlay.ts';
import { unwindOne } from '../tabReset.ts';
import '../components/players2/players2.css';

type View = 'all' | 'trade' | 'injured';
type Sort = 'value' | 'draft';

/** Rows drawn at a time; the rest are one tap away. */
const PAGE = 100;

const SORT_LABEL: Record<Sort, string> = { value: 'Value', draft: 'Draft order' };

/** The draft list's own row shape, for a search that reaches past the board. */
interface DraftListItem {
  id: string;
  name: string;
  position: string;
  team: string;
  status: string | null;
  draftRank: number | null;
  adjustedRank: number | null;
  ownerRosterId?: number | null;
  draftPick?: string | null;
  signal: { raw: { net: number }; last7: { net: number }; last30: { net: number } } | null;
}

function fromDraftList(p: DraftListItem): SeasonRow {
  return {
    id: p.id,
    name: p.name,
    position: p.position,
    team: p.team,
    status: p.status,
    ownerRosterId: p.ownerRosterId ?? null,
    value: null,
    overFreeAgent: null,
    injury: null,
    trade: null,
    draftRank: p.draftRank,
    adjustedRank: p.adjustedRank,
    draftPick: p.draftPick ?? null,
    last7: p.signal?.last7.net ?? 0,
    last30: p.signal?.last30.net ?? 0,
    lifetime: p.signal?.raw.net ?? 0,
  };
}

/** Lower case, accents off, so "Saldana" finds "Saldaña". */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

const byValue = byOverFreeAgent<SeasonRow>;
const byDraft = (a: SeasonRow, b: SeasonRow) => (a.adjustedRank ?? Infinity) - (b.adjustedRank ?? Infinity) || byValue(a, b);

export function PlayersSeasonScreen({
  leagues,
  resetNonce,
  searchBeyond = true,
  dossier = true,
}: {
  leagues: LeagueSummary[];
  resetNonce: number;
  /** Ask the draft list when a search finds nobody on the board. Off on the preview, which has only made-up names. */
  searchBeyond?: boolean;
  /**
   * The card keeps everything it shows today under the in-season part. Off on
   * the preview: made-up players have no news or outlook to show.
   */
  dossier?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState(ALL_FILTER);
  const [owner, setOwner] = useState<string>(ANYONE_OWNER);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [view, setView] = useState<View>('all');
  const [sort, setSort] = useState<Sort>('value');
  const [sortOpen, setSortOpen] = useState(false);
  const [board, setBoard] = useState<SeasonBoard | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [extra, setExtra] = useState<SeasonRow[]>([]);
  const [shown, setShown] = useState(PAGE);
  const [openId, setOpenId] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const restoreScroll = useRef<number | null>(null);

  const selected = leagues.find((l) => l.isSelected) ?? null;
  const leagueId = selected?.id ?? null;
  const segments = useMemo(
    () => (selected ? playerFilterChips(startablePositions(buildRosterShape(selected.rosterPositions))) : []),
    [selected],
  );

  /* The board: one request, from the session cache first when there is one. */
  useEffect(() => {
    let live = true;
    setFailed(null);
    const path = `/api/players/season${leagueId ? `?leagueId=${encodeURIComponent(leagueId)}` : ''}`;
    api
      .get<SeasonBoard>(path, { onFresh: (fresh) => live && setBoard(fresh) })
      .then((b) => live && setBoard(b))
      .catch((err) => live && setFailed(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [leagueId]);

  useEffect(() => setOwner(ANYONE_OWNER), [leagueId]);
  useEffect(() => setShown(PAGE), [query, position, owner, view, sort]);

  /*
   * A search also asks the draft list's server search, which forgives a typo
   * and reaches every player. A player on the board comes back as his board
   * row; the rest as plain rows with no value.
   */
  const boardById = useMemo(() => new Map((board?.rows ?? []).map((r) => [r.id, r] as const)), [board]);
  useEffect(() => {
    const q = query.trim();
    if (!searchBeyond || q.length < 2) {
      setExtra([]);
      return;
    }
    let live = true;
    const handle = window.setTimeout(() => {
      const league = leagueId ? `&leagueId=${encodeURIComponent(leagueId)}` : '';
      api
        .get<{ players: DraftListItem[] }>(`/api/players?q=${encodeURIComponent(q)}${league}&limit=20&offset=0`)
        .then((res) => live && setExtra(res.players.map((p) => boardById.get(p.id) ?? fromDraftList(p))))
        .catch(() => live && setExtra([]));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(handle);
    };
  }, [query, leagueId, boardById, searchBeyond]);

  useEffect(() => {
    if (resetNonce === 0) return;
    unwindOne([
      { when: full, undo: () => setFull(false) },
      { when: openId != null, undo: () => setOpenId(null) },
      { when: query !== '', undo: () => setQuery('') },
      { when: view !== 'all', undo: () => setView('all') },
    ]);
  }, [resetNonce]);

  useLayoutEffect(() => {
    if (full || restoreScroll.current === null) return;
    const top = restoreScroll.current;
    restoreScroll.current = null;
    window.scrollTo({ top, behavior: 'auto' });
  }, [full]);

  const teams: OwnerTeam[] = board?.teams ?? [];
  const ownerOptions = useMemo(() => ownerFilterOptions(teams), [teams]);
  const ownerFilter = parseOwnerFilter(owner);
  const ownerLabel =
    ownerFilter.kind === 'roster'
      ? (() => {
          const team = teams.find((t) => t.rosterId === ownerFilter.rosterId);
          return team ? teamLabel(team) : null;
        })()
      : null;

  const rows = useMemo(() => {
    const all = board?.rows ?? [];
    const owned = new Map<string, number>();
    for (const r of [...all, ...extra]) if (r.ownerRosterId != null) owned.set(r.id, r.ownerRosterId);
    const resolved = resolveOwnerFilter(ownerFilter, teams);
    const q = fold(query.trim());
    const keep = (r: SeasonRow) =>
      (position === ALL_FILTER || positionMatchesFilter(r.position, position)) &&
      matchesOwner(r.id, resolved, owned) &&
      (view === 'trade' ? r.trade != null : view === 'injured' ? r.injury != null : true);
    /* Trade targets: Likely first, then Maybe, then Unlikely; the sort decides within each. */
    const order = (a: SeasonRow, b: SeasonRow) => (view === 'trade' ? byWillingness(a, b) : 0) || (sort === 'value' ? byValue(a, b) : byDraft(a, b));
    if (!q) return all.filter(keep).sort(order);
    /* Names that contain the search first, in the list's order; then the server's other matches, best match first. */
    const direct = all.filter((r) => fold(r.name).includes(q) && keep(r)).sort(order);
    const seen = new Set(direct.map((r) => r.id));
    return [...direct, ...extra.filter((r) => !seen.has(r.id) && keep(r))];
  }, [board, extra, query, position, owner, teams, view, sort]);

  const open = openId == null ? null : ([...(board?.rows ?? []), ...extra].find((r) => r.id === openId) ?? null);
  const summary = (r: SeasonRow): PlayerSummary => ({ id: r.id, name: r.name, position: r.position, team: r.team, status: r.status, draftRank: r.draftRank, adjustedRank: r.adjustedRank });
  const pill = (r: SeasonRow) => <OwnerPill label={ownerPillLabel(r.ownerRosterId, teams)} />;
  const context = (r: SeasonRow) => <SeasonCardBlock row={r} leagueId={leagueId} />;

  if (open && full) {
    return <PlayerPage player={summary(open)} backLabel="Players" onBack={() => setFull(false)} trailing={pill(open)} context={context(open)} />;
  }

  const views: { id: View; label: string; testId: string }[] = [
    { id: 'all', label: 'All', testId: 'p2-view-all' },
    ...(board?.tradeOpen === false ? [] : [{ id: 'trade' as const, label: 'Trade targets', testId: 'p2-view-trade' }]),
    { id: 'injured', label: 'Injured', testId: 'p2-view-injured' },
  ];

  return (
    <div data-testid="players-season">
      <NavBar
        testId="players-nav"
        content={<SearchField value={query} onChange={setQuery} placeholder="Search players" label="Search players" testId="player-search" />}
      />
      {segments.length > 0 || ownerOptions.length > 0 ? (
        <div className="control-row" data-testid="players-controls">
          {segments.length > 0 ? (
            <SegmentedControl
              label="Filter by position"
              value={position}
              onChange={setPosition}
              compact
              segments={segments.map((p) => ({
                id: p,
                label: p,
                ...(p === FLX_FILTER ? { ariaLabel: 'Flex-eligible players: running backs, receivers and tight ends', testId: 'flx-filter' } : {}),
              }))}
            />
          ) : null}
          {ownerOptions.length > 0 ? (
            <button
              type="button"
              className="btn btn-compact"
              data-testid="players-owner-open"
              aria-haspopup="dialog"
              aria-expanded={ownerOpen}
              aria-label={`Filter by who holds them: ${ownerFilter.kind === 'anyone' ? 'anyone' : ownerButtonLabel(ownerFilter, ownerLabel)}`}
              onClick={() => setOwnerOpen(true)}
            >
              {ownerButtonLabel(ownerFilter, ownerLabel)}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="control-row p2-views" data-testid="p2-controls">
        <SegmentedControl label="Show" value={view} onChange={setView} compact testId="p2-views" segments={views} />
        <button
          type="button"
          className="btn btn-compact"
          data-testid="p2-sort-open"
          aria-haspopup="dialog"
          aria-expanded={sortOpen}
          aria-label={`Sort: ${SORT_LABEL[sort]}`}
          onClick={() => setSortOpen(true)}
        >
          {SORT_LABEL[sort]}
        </button>
      </div>
      {ownerOpen ? (
        <Sheet title="Who holds them" onClose={() => setOwnerOpen(false)} testId="players-owner-sheet">
          <ListGroup testId="players-owner-options">
            {ownerOptions.map((option) => (
              <ListRow
                key={option.id}
                label={option.label}
                testId="players-owner-option"
                dataState={option.id === owner ? 'chosen' : 'other'}
                {...(option.id === owner ? { value: <span aria-label="Chosen">✓</span> } : {})}
                onClick={() => {
                  setOwner(option.id);
                  setOwnerOpen(false);
                }}
              />
            ))}
          </ListGroup>
        </Sheet>
      ) : null}
      {sortOpen ? (
        <Sheet title="Sort" onClose={() => setSortOpen(false)} testId="p2-sort-sheet">
          <ListGroup testId="p2-sort-options">
            {(['value', 'draft'] as const).map((id) => (
              <ListRow
                key={id}
                label={id === 'value' ? 'Value (rest of season)' : 'Draft order'}
                testId={`p2-sort-${id}`}
                dataState={id === sort ? 'chosen' : 'other'}
                {...(id === sort ? { value: <span aria-label="Chosen">✓</span> } : {})}
                onClick={() => {
                  setSort(id);
                  setSortOpen(false);
                }}
              />
            ))}
          </ListGroup>
        </Sheet>
      ) : null}
      {failed ? <Notice tone="error">{failed}</Notice> : null}
      {!board && !failed ? (
        <SkeletonRows rows={8} testId="players-skeleton" />
      ) : board && board.rows.length === 0 && board.reason ? (
        <Empty>{board.reason}</Empty>
      ) : rows.length === 0 ? (
        failed ? null : (
          <Empty>
            {view === 'trade'
              ? 'No trade targets right now.'
              : view === 'injured'
                ? 'Nobody is out right now.'
                : playersEmptyLine({ query, position, owner: ownerFilter, ownerLabel })}
          </Empty>
        )
      ) : (
        <>
          <div className="list-head" data-testid="players-rank-head">
            <span className="list-head-rank">Rank</span>
            <span className="list-head-note">{sort === 'value' ? 'Rest of season, points over a free agent' : 'Draft order, moved by your research'}</span>
          </div>
          <div className="dense-group" role="list" aria-label={`Players, by ${SORT_LABEL[sort].toLowerCase()}`} data-testid="players-list">
            {rows.slice(0, shown).map((r, i) => (
              <div role="listitem" key={r.id}>
                <CompactPlayerRow
                  playerId={r.id}
                  name={r.name}
                  position={r.position}
                  team={r.team}
                  status={r.status}
                  tally={r.lifetime}
                  rank={sort === 'value' ? i + 1 : r.adjustedRank == null ? '—' : Math.round(r.adjustedRank)}
                  trailing={pill(r)}
                  onOpen={() => setOpenId(r.id)}
                  testId="player-search-row"
                  cluster
                  metrics={[
                    { label: 'Value', testId: 'p2-value', value: r.overFreeAgent == null ? <span className="faint">—</span> : r.overFreeAgent.toFixed(1) },
                    { label: '7d', value: <SignedValue net={r.last7} /> },
                    { label: '30d', value: <SignedValue net={r.last30} /> },
                    {
                      label: 'Pick',
                      testId: 'players-pick',
                      value: r.draftPick ?? (
                        <span className="faint" title="Not drafted in this league">
                          —
                        </span>
                      ),
                    },
                  ]}
                  {...(view === 'trade' && r.trade
                    ? { trailingBelow: <WillingnessTag word={r.trade.willingness} /> }
                    : view === 'injured' && r.injury
                      ? { trailingBelow: <BackTag backWeek={r.injury.backWeek} /> }
                      : {})}
                />
              </div>
            ))}
          </div>
          {rows.length > shown ? (
            <div className="list-end" data-testid="players-more">
              <button type="button" className="link-button" onClick={() => setShown((n) => n + PAGE)}>
                Show more players
              </button>
            </div>
          ) : (
            <div className="list-end" data-testid="players-end" />
          )}
          {open && !full && !dossier ? (
            <Sheet
              testId="player-sheet"
              onClose={() => setOpenId(null)}
              accessibleLabel={open.name}
              title={<PlayerSheetTitle playerId={open.id} name={open.name} position={open.position} team={open.team} status={open.status} trailing={pill(open)} />}
            >
              {context(open)}
            </Sheet>
          ) : null}
          {open && !full && dossier ? (
            <PlayerSheet
              player={summary(open)}
              onClose={() => setOpenId(null)}
              onOpenFull={() => {
                restoreScroll.current = pageScrollTop();
                setFull(true);
              }}
              trailing={pill(open)}
              context={context(open)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function OwnerPill({ label }: { label: string | null }) {
  if (!label) return null;
  return (
    <span className={label === 'Available' ? 'tag tag-take' : 'tag'} data-testid="owner-pill" data-owner={label}>
      {label}
    </span>
  );
}

export function WillingnessTag({ word }: { word: Willingness }) {
  return (
    <span className="p2-tag" data-word={word} data-testid="p2-willing">
      {word}
    </span>
  );
}

function BackTag({ backWeek }: { backWeek: number | null }) {
  return (
    <span className="p2-tag" data-word="out" data-testid="p2-back">
      {backWeek == null ? 'Out' : `Back Wk ${backWeek}`}
    </span>
  );
}

export type { SeasonCard };
