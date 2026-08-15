/**
 * Team: who to start this week, who is on the bench, and whether anybody
 * unrostered would be better.
 *
 * The screen answers one question at a glance — **who does Fantasy Analyst
 * currently recommend starting?** — and it answers it in the same visual
 * language the rest of the app uses for a position: a recommended starter keeps
 * the position tint on its card, a backup sits underneath on the ordinary
 * surface. The colour is an accelerator; every card also says the word, because
 * a tint that is the only cue is not a cue for everybody.
 *
 * There is no lineup-editing control anywhere here, and there is no add, drop or
 * claim either. The app never changes a fantasy lineup and never transacts —
 * every one of these is a sentence the user acts on in Sleeper, by hand.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type LeagueSummary,
  type LineupRecommendation,
  type LineupSlot,
  type RosterPlayer,
  type StartSitComparison,
  type WaiverAdvice,
  type WaiverUpgrade,
} from '../api.ts';
import {
  Badge,
  Confidence,
  Empty,
  formatAge,
  Notice,
  PositionBadge,
  Signal,
  Unknown,
  positionCardClass,
} from '../components/common.tsx';
import { NavBar, SearchField, SegmentedControl, Sheet, SkeletonRows } from '../components/native.tsx';
import { FLX_FILTER, offersFlexFilter, orderPositions, slotAccepts } from '../../core/sleeper/eligibility.ts';
import { buildRosterShape, startablePositions } from '../../core/sleeper/scoring.ts';

interface OpenSlot {
  slot: string;
  count: number;
  accepts: string[];
}

interface RosterResponse {
  league: { id: string; name: string; scoringLabel: string; notes: string[] };
  starters: RosterPlayer[];
  bench: RosterPlayer[];
  /** True while the draft is running: `drafted` is the current truth, not `starters`. */
  live: boolean;
  drafted: (RosterPlayer & { pickNo: number | null })[];
  counts: Record<string, number>;
  filled: number;
  remaining: number;
  openStarters: OpenSlot[];
  picksMade: number;
  found: boolean;
}

/** How many players may be compared at once. Matched by the server. */
const MAX_COMPARE = 4;

/**
 * How deep the comparison picker's list goes.
 *
 * The search itself reaches the whole player universe — the server searches
 * every name and only then cuts to this — so the number is about *browsing*:
 * how far somebody who has typed nothing can scroll before the list ends. Forty
 * was the draft board's old cap and it ended silently, looking exactly like the
 * end of the player pool rather than the end of a page.
 */
const PICKER_ROWS = 100;

const ALL_FILTER = 'ALL';

export function TeamScreen({
  leagues,
  onLeaguesChanged,
}: {
  leagues: LeagueSummary[];
  onLeaguesChanged: () => void;
}) {
  const selected = leagues.find((l) => l.isSelected) ?? null;
  const [roster, setRoster] = useState<RosterResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [lineup, setLineup] = useState<LineupRecommendation | null>(null);
  const [waivers, setWaivers] = useState<WaiverAdvice | null>(null);
  /** Open with the slot it was launched from, and whoever it was launched on. */
  const [compare, setCompare] = useState<{ slot: string | null; seed: string[] } | null>(null);

  const loadRoster = useCallback(async () => {
    if (!selected) return;
    try {
      setRoster(await api.get<RosterResponse>(`/api/leagues/${selected.id}/roster`));
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }, [selected]);

  const loadLineup = useCallback(async () => {
    if (!selected) return;
    try {
      setLineup(await api.get<LineupRecommendation>(`/api/leagues/${selected.id}/lineup`));
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }, [selected]);

  /*
   * The free-agent scan arrives on its own, after the roster.
   *
   * It is the only part of this screen that has to look outside the roster, and
   * it must never be the reason the roster is slow to appear — so it is a
   * separate request whose failure costs the waiver card and nothing else.
   */
  const loadWaivers = useCallback(async () => {
    if (!selected) return;
    try {
      setWaivers(await api.get<WaiverAdvice>(`/api/leagues/${selected.id}/waivers`));
    } catch {
      setWaivers(null);
    }
  }, [selected]);

  useEffect(() => {
    void loadRoster();
    void loadLineup();
    void loadWaivers();
  }, [loadRoster, loadLineup, loadWaivers]);

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setMessage(null);
    try {
      setMessage({ tone: 'ok', text: await fn() });
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  /** Every player on the roster, however Sleeper currently has them arranged. */
  const byId = useMemo(() => {
    const map = new Map<string, RosterPlayer>();
    for (const p of roster?.starters ?? []) map.set(p.playerId, p);
    for (const p of roster?.bench ?? []) map.set(p.playerId, p);
    return map;
  }, [roster]);

  const startingIds = useMemo(
    () => new Set((lineup?.slots ?? []).map((s) => s.playerId).filter((id): id is string => id != null)),
    [lineup],
  );

  /*
   * The bench, in the order the recommendation puts it.
   *
   * Best replacement first, then the players it could not score at all, then
   * anybody the lineup never saw. Never a cross-position ranking against the
   * starters: a backup quarterback above a starting flex answers no question.
   */
  const bench = useMemo(() => {
    if (!roster) return [];
    const order = [
      ...(lineup?.bench ?? []).map((e) => e.playerId),
      ...(lineup?.undecidable ?? []).map((e) => e.playerId),
    ];
    const ranked = order.map((id) => byId.get(id)).filter((p): p is RosterPlayer => p != null && !startingIds.has(p.playerId));
    const seen = new Set(ranked.map((p) => p.playerId));
    const rest = [...byId.values()].filter((p) => !seen.has(p.playerId) && !startingIds.has(p.playerId));
    return [...ranked, ...rest];
  }, [roster, lineup, byId, startingIds]);

  const hasRecommendation = Boolean(lineup?.found && (lineup?.slots.length ?? 0) > 0);

  return (
    <>
      {/*
        The league is the page's identity, so it is the page's title — and only
        the title.

        The bar used to carry the season, the team count and the scoring format
        under the name, and a row of badges under that repeating the flex count
        and the passing-TD rule. Every one of those is a fact about the league
        that the engine reads and the reader does not: they do not change what to
        do this week, they never changed between visits, and on a phone they cost
        two rows of the screen before the first player appeared. They are still
        exactly where they were in the data — Setup shows the league's settings,
        and every recommendation below is computed from them.
      */}
      {selected ? (
        <NavBar
          testId="league-card"
          title={selected.name}
          trailing={
            <button
              className="btn btn-sm"
              disabled={busy != null}
              onClick={() =>
                run('sync', async () => {
                  await api.post(`/api/leagues/${selected.id}/sync`);
                  onLeaguesChanged();
                  await loadRoster();
                  await loadLineup();
                  await loadWaivers();
                  return 'Roster refreshed from Sleeper.';
                })
              }
            >
              {busy === 'sync' ? 'Refreshing…' : 'Refresh'}
            </button>
          }
        />
      ) : (
        <NavBar title="Team" />
      )}

      {message ? <Notice tone={message.tone === 'ok' ? 'ok' : message.tone === 'error' ? 'error' : 'warn'}>{message.text}</Notice> : null}

      {!selected ? (
        <Empty>No league chosen yet. Open Setup to connect Sleeper and pick your league.</Empty>
      ) : (
        <>
          {/*
            One compact entry point, high on the screen.

            It opens over the page rather than pushing, because a comparison is
            a question asked *about* this roster and answered back to it.
          */}
          <div className="btn-row" style={{ margin: '0 2px 10px' }}>
            <button
              className="btn"
              data-testid="compare-open"
              onClick={() => setCompare({ slot: null, seed: [] })}
            >
              Compare players
            </button>
          </div>

          {!roster ? (
            <SkeletonRows rows={6} testId="roster-skeleton" />
          ) : !roster.found ? (
            <Empty>Your roster was not found in this league. Check the connected Sleeper user.</Empty>
          ) : (
            <>
              {/*
                During a draft the live view goes first, because that is the
                current truth. It is added to rather than swapped in: if Sleeper
                also has a settled lineup, hiding it would take away the
                start/sit comparison for no reason.
              */}
              {roster.live ? <LiveDraftRoster roster={roster} /> : null}

              {hasRecommendation ? (
                <>
                  <div className="section-title" data-testid="starters-title">
                    Recommended starters
                  </div>
                  {lineup!.slots.map((slot, i) => (
                    <StarterCard
                      key={`${slot.slot}-${i}`}
                      slot={slot}
                      player={slot.playerId ? (byId.get(slot.playerId) ?? null) : null}
                      onCompare={() => setCompare({ slot: slot.slot, seed: slot.playerId ? [slot.playerId] : [] })}
                    />
                  ))}
                </>
              ) : null}

              {bench.length > 0 ? (
                <>
                  <div className="section-title" data-testid="bench-title">
                    Bench
                  </div>
                  {bench.map((p) => (
                    <BenchCard
                      key={p.playerId}
                      player={p}
                      onCompare={() => setCompare({ slot: null, seed: [p.playerId] })}
                    />
                  ))}
                </>
              ) : null}

              {waivers?.found ? (
                <WaiverCard
                  advice={waivers}
                  onCompare={(upgrade, candidateId) =>
                    setCompare({
                      slot: upgrade.slot,
                      seed: [upgrade.currentPlayerId, candidateId].filter((id): id is string => id != null),
                    })
                  }
                />
              ) : null}

              {lineup?.found ? <LineupCard lineup={lineup} /> : null}
            </>
          )}
        </>
      )}

      {compare && selected ? (
        <CompareSheet
          leagueId={selected.id}
          rosterPositions={selected.rosterPositions}
          slot={compare.slot}
          seed={compare.seed}
          nameOf={(id) => byId.get(id)?.name ?? id}
          onClose={() => setCompare(null)}
        />
      ) : null}
    </>
  );
}

/**
 * One recommended starter, in the slot the league actually starts.
 *
 * The card keeps the position tint, which is what makes the recommended lineup
 * readable at arm's length. **The tint is never the only cue**: the slot is
 * printed on the card, the row is labelled as a starter for anything reading it
 * aloud, and an empty slot says so in words rather than by being a paler shade
 * of the same thing.
 */
function StarterCard({
  slot,
  player,
  onCompare,
}: {
  slot: LineupSlot;
  player: RosterPlayer | null;
  onCompare: () => void;
}) {
  if (!slot.playerId || !slot.name) {
    return (
      <div className="player-row" data-testid="starter-row" data-slot={slot.slot} data-starter="empty">
        <div className="player-row-top">
          <span className="slot-label">{slot.slot}</span>
          <span className="player-name faint">Nobody eligible to start here</span>
        </div>
        <div className="player-row-metrics">
          <span className="metric">Takes {slot.accepts.join(', ')}</span>
        </div>
      </div>
    );
  }

  const position = player?.position ?? slot.position ?? '';
  return (
    <button
      className={positionCardClass(position)}
      data-testid="starter-row"
      data-slot={slot.slot}
      data-starter="true"
      data-position={position.toUpperCase()}
      data-player-id={slot.playerId}
      aria-label={`${slot.name}, recommended starter at ${slot.slot}`}
      onClick={onCompare}
    >
      <div className="player-row-top">
        <span className="slot-label">{slot.slot}</span>
        <span className="player-name">{slot.name}</span>
        <PositionBadge position={position} team={player?.team ?? ''} />
      </div>
      <div className="player-row-metrics">
        {/* The word, beside the colour, for everybody who does not see one. */}
        <span className="metric">Starter</span>
        <span className="metric">
          Proj <strong>{slot.score == null ? '—' : slot.score.toFixed(1)}</strong>
        </span>
        {slot.locked ? <span className="tag tag-calm" data-testid="locked-tag">🔒 Locked</span> : null}
        {!slot.alreadyStarting && !slot.locked ? <Badge tone="warn">not in your Sleeper lineup</Badge> : null}
        {player?.status ? <Badge tone="warn">{player.status}</Badge> : null}
      </div>
    </button>
  );
}

/**
 * A backup: the same row, on the ordinary surface.
 *
 * No card tint, and that absence is the whole point — it is what makes the
 * tinted cards above read as an answer rather than as decoration. The position
 * badge stays, because "which position is this" is still a fact worth knowing
 * about a bench player.
 */
function BenchCard({ player, onCompare }: { player: RosterPlayer; onCompare: () => void }) {
  return (
    <button
      className="player-row"
      data-testid="bench-row"
      data-starter="false"
      data-position={(player.position ?? '').toUpperCase()}
      data-player-id={player.playerId}
      aria-label={`${player.name}, bench`}
      onClick={onCompare}
    >
      <div className="player-row-top">
        <span className="player-name">{player.name}</span>
        <PositionBadge position={player.position} team={player.team} />
      </div>
      <div className="player-row-metrics">
        <span className="metric">Bench</span>
        <Signal net={player.recentNet} label="recent news (21d)" />
        {player.status ? <Badge tone="warn">{player.status}</Badge> : null}
        {player.pending > 0 ? <Badge tone="warn">{player.pending} to review</Badge> : null}
      </div>
    </button>
  );
}

/**
 * Whether anybody unrostered would actually be an improvement.
 *
 * Compact by design and quiet by default: the interesting case is usually that
 * there is nothing to do, and a card that shouts about three marginal adds every
 * week is one the reader stops looking at. Nothing here executes anything —
 * "available" means available in Sleeper, and the add is made there.
 */
function WaiverCard({
  advice,
  onCompare,
}: {
  advice: WaiverAdvice;
  onCompare: (upgrade: WaiverUpgrade, candidateId: string) => void;
}) {
  if (advice.upgrades.length === 0) {
    return (
      <div className="card card-tight" data-testid="waiver-card">
        <div className="faint" data-testid="waiver-verdict">
          {advice.headline ?? 'No waiver comparison available yet.'}
        </div>
      </div>
    );
  }

  return (
    <div className="card" data-testid="waiver-card">
      <div className="header-row">
        <strong>Waiver upgrades</strong>
        <span className="faint">{advice.considered} available players checked</span>
      </div>
      {advice.upgrades.map((upgrade) => {
        const best = upgrade.candidates[0]!;
        return (
          <div className="swap" key={upgrade.slot} data-testid="waiver-upgrade" data-slot={upgrade.slot}>
            <div>
              <strong>{upgrade.slot} upgrade available</strong>
            </div>
            <div className="faint">
              Current: {upgrade.currentName ?? 'nobody eligible'}
              {upgrade.currentScore == null ? '' : ` (${upgrade.currentScore.toFixed(1)})`}
            </div>
            <div className="faint">
              Best available: <strong>{best.name}</strong> ({best.position}
              {best.team ? ` · ${best.team}` : ''}
              {best.score == null ? '' : ` · ${best.score.toFixed(1)}`}) · +{best.gain} pts
            </div>
            <div className="faint">{best.reasons.join(' · ')}</div>
            <div className="btn-row" style={{ margin: '4px 0 0' }}>
              <button
                className="btn btn-sm"
                data-testid="waiver-compare"
                onClick={() => onCompare(upgrade, best.playerId)}
              >
                Compare
              </button>
            </div>
            {upgrade.candidates.length > 1 ? (
              <div className="faint" style={{ marginTop: 4 }}>
                Also available:{' '}
                {upgrade.candidates
                  .slice(1)
                  .map((c) => `${c.name} (+${c.gain})`)
                  .join(', ')}
              </div>
            ) : null}
          </div>
        );
      })}
      <div className="faint" style={{ margin: '6px 2px 0' }}>
        Advisory only — add or drop in Sleeper. This app never makes a transaction.
      </div>
      {advice.notes.map((n) => (
        <div className="faint" key={n}>
          {n}
        </div>
      ))}
    </div>
  );
}

/**
 * Pick two to four players and rank them for one lineup spot.
 *
 * The pool is the whole player universe, not the roster: "start my tight end or
 * the one on waivers" is an ordinary question, and a picker that could only see
 * players you already own could not ask it. Who is *addable* is the waiver
 * card's business; this ranks whoever is chosen.
 *
 * Everything below the picker comes from the same start/sit engine the lineup
 * above was built with — there is exactly one scoring formula in this app.
 */
function CompareSheet({
  leagueId,
  rosterPositions,
  slot,
  seed,
  nameOf,
  onClose,
}: {
  leagueId: string;
  rosterPositions: string[];
  /** The slot this was launched from, or null when launched from the header. */
  slot: string | null;
  seed: string[];
  nameOf: (id: string) => string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState(() => {
    // Launched from a slot that takes exactly one position, the picker starts
    // narrowed to it; from a flex slot, to the flex view. Both are a starting
    // point the reader can change, never a restriction.
    if (!slot) return ALL_FILTER;
    const accepts = slotAccepts(slot);
    if (accepts.length === 1) return accepts[0]!;
    return FLX_FILTER;
  });
  const [ids, setIds] = useState<string[]>(() => [...new Set(seed)].slice(0, MAX_COMPARE));
  const [names, setNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(seed.map((id) => [id, nameOf(id)])),
  );
  const [results, setResults] = useState<PickerPlayer[]>([]);
  const [loading, setLoading] = useState(false);
  const [comparison, setComparison] = useState<StartSitComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const segments = useMemo(() => {
    const startable = startablePositions(buildRosterShape(rosterPositions));
    if (startable.size === 0) return [ALL_FILTER];
    // FLX last, as everywhere else: a view over three positions, after them.
    return [ALL_FILTER, ...orderPositions(startable), ...(offersFlexFilter(startable) ? [FLX_FILTER] : [])];
  }, [rosterPositions]);

  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setLoading(true);
      try {
        const filter = position === ALL_FILTER ? '' : `&position=${encodeURIComponent(position)}`;
        const res = await api.get<{ players: PickerPlayer[] }>(
          `/api/players?q=${encodeURIComponent(query)}&leagueId=${encodeURIComponent(leagueId)}${filter}&limit=${PICKER_ROWS}`,
        );
        if (!cancelled) setResults(res.players);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query, position, leagueId]);

  /**
   * Add or remove one player.
   *
   * A player already chosen is removed, which is the only way a tap on a
   * selected row can be read. A fifth is refused out loud rather than silently
   * dropping the first — quietly rewriting the selection is how a reader ends up
   * comparing three players they did not choose.
   */
  const toggle = (player: PickerPlayer) => {
    setComparison(null);
    setError(null);
    setIds((current) => {
      if (current.includes(player.id)) return current.filter((id) => id !== player.id);
      if (current.length >= MAX_COMPARE) {
        setError(`Up to ${MAX_COMPARE} players at once. Remove one to add another.`);
        return current;
      }
      setNames((n) => ({ ...n, [player.id]: player.name }));
      return [...current, player.id];
    });
  };

  const compare = async () => {
    setBusy(true);
    setError(null);
    try {
      setComparison(
        await api.post<StartSitComparison>('/api/startsit/compare', {
          leagueId,
          playerIds: ids,
          slot,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={slot ? `Compare for ${slot}` : 'Compare players'} onClose={onClose} testId="compare-sheet">
      <div className="faint" style={{ margin: '0 2px 8px' }} data-testid="compare-hint">
        Choose 2–{MAX_COMPARE} players. Anyone in the league is fair game — your roster, the bench, or the
        free-agent pool.
      </div>

      {ids.length > 0 ? (
        <div className="tag-row" data-testid="compare-selection">
          {ids.map((id) => (
            <button
              key={id}
              type="button"
              className="tag tag-calm chip-removable"
              data-testid="compare-chosen"
              data-player-id={id}
              aria-label={`Remove ${names[id] ?? id} from the comparison`}
              onClick={() => {
                setComparison(null);
                setError(null);
                setIds((current) => current.filter((x) => x !== id));
              }}
            >
              {names[id] ?? id} ✕
            </button>
          ))}
        </div>
      ) : null}

      <div style={{ margin: '8px 0' }}>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search players"
          label="Search players to compare"
          testId="compare-search"
        />
      </div>

      <SegmentedControl
        label="Filter by position"
        value={position}
        onChange={setPosition}
        segments={segments.map((p) => ({
          id: p,
          label: p,
          ...(p === FLX_FILTER
            ? { ariaLabel: 'Flex-eligible players: running backs, receivers and tight ends', testId: 'flx-filter' }
            : {}),
        }))}
      />

      {error ? <Notice tone="warn">{error}</Notice> : null}

      <div className="btn-row" style={{ margin: '8px 2px' }}>
        <button
          className="btn btn-primary"
          data-testid="compare-run"
          disabled={ids.length < 2 || busy}
          onClick={() => void compare()}
        >
          {busy ? 'Comparing…' : `Compare ${ids.length} player${ids.length === 1 ? '' : 's'}`}
        </button>
      </div>

      {comparison ? <ComparisonCard comparison={comparison} /> : null}

      {loading && results.length === 0 ? (
        <SkeletonRows rows={5} testId="compare-skeleton" />
      ) : results.length === 0 ? (
        <Empty>Nobody matching that search.</Empty>
      ) : (
        <div role="list" aria-label="Players to compare">
          {results.map((p) => {
            const chosen = ids.includes(p.id);
            return (
              <button
                key={p.id}
                className={chosen ? 'player-row player-row-open' : 'player-row'}
                data-testid="compare-candidate"
                data-player-id={p.id}
                data-chosen={chosen ? 'true' : 'false'}
                aria-pressed={chosen}
                onClick={() => toggle(p)}
              >
                <div className="player-row-top">
                  <span className="rank">{chosen ? '✓' : ''}</span>
                  <span className="player-name">{p.name}</span>
                  <PositionBadge position={p.position} team={p.team} />
                </div>
                <div className="player-row-metrics">
                  <span className="metric">{availabilityLabel(p.availability)}</span>
                  {p.status ? <Badge tone="warn">{p.status}</Badge> : null}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}

interface PickerPlayer {
  id: string;
  name: string;
  position: string;
  team: string;
  status: string | null;
  /** Absent when the response predates league-aware availability. */
  availability?: 'mine' | 'rostered' | 'available';
}

function availabilityLabel(availability: PickerPlayer['availability']): string {
  if (availability === 'mine') return 'Your roster';
  if (availability === 'rostered') return 'Rostered elsewhere';
  if (availability === 'available') return 'Free agent';
  return '';
}

/**
 * Whole-roster start/sit, as a difference from what Sleeper currently has set.
 *
 * The recommended lineup itself is drawn above as cards; this is the part that
 * asks something of the reader — which slots differ, and by how much. Nothing
 * here can alter a lineup: Sleeper is still where a change is made.
 */
function LineupCard({ lineup }: { lineup: LineupRecommendation }) {
  const gain =
    lineup.currentPoints == null ? null : Math.round((lineup.recommendedPoints - lineup.currentPoints) * 10) / 10;

  return (
    <div className="card" data-testid="lineup-card">
      <div className="header-row">
        <strong>Changes to consider</strong>
        <Confidence level={lineup.confidence} />
      </div>

      {lineup.swaps.length === 0 ? (
        <div className="faint" data-testid="lineup-verdict">
          {lineup.currentPoints == null
            ? 'No changes to suggest from what is known so far.'
            : 'Your lineup already matches the recommendation.'}
        </div>
      ) : (
        <>
          <div className="faint" data-testid="lineup-verdict">
            {lineup.swaps.length} change{lineup.swaps.length === 1 ? '' : 's'} to consider
            {gain != null && gain > 0 ? ` · worth about ${gain} pts` : ''}
          </div>
          {/*
            A swap is a sentence, not a box. The card used to hold a bordered
            card per change, which made three suggestions look like three
            separate screens; an accent rule and the type do the same job in a
            third of the height.
          */}
          {lineup.swaps.map((s) => (
            <div className="swap" key={`${s.inPlayerId}-${s.outPlayerId}`} data-testid="lineup-swap">
              <div>
                <strong>Start {s.inName}</strong> over {s.outName} <span className="faint">({s.slot})</span>
              </div>
              <div className="faint">
                +{s.gain} pts · {s.reason}
              </div>
            </div>
          ))}
          <div className="faint" style={{ margin: '6px 2px 0' }}>
            Make changes in Sleeper — this app never edits a lineup.
          </div>
        </>
      )}

      {/*
        Missing data is ordinary, not an incident: it gets a caution rule and a
        readable sentence rather than an inset warning box.
      */}
      {lineup.warnings.map((w) => (
        <div className="hint hint-caution" key={w}>
          {w}
        </div>
      ))}

      <details className="disclosure">
        <summary>Recommended lineup in full</summary>
        <table className="compact">
          <thead>
            <tr>
              <th>Slot</th>
              <th>Player</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {lineup.slots.map((s, i) => (
              <tr key={`${s.slot}-${i}`}>
                <td>{s.slot}</td>
                <td>
                  {s.name ?? <Unknown what="nobody eligible" />}
                  {/* A locked slot is settled, so it never carries a change arrow. */}
                  {s.locked ? <span className="tag tag-calm" data-testid="locked-tag"> 🔒 Locked</span> : null}
                  {s.name && !s.alreadyStarting && !s.locked ? ' ←' : ''}
                </td>
                <td>{s.score == null ? <Unknown what="score" /> : s.score.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {lineup.bench.length > 0 ? (
          <div className="faint" style={{ marginTop: 6 }}>
            Bench: {lineup.bench.map((e) => `${e.name} (${e.score?.toFixed(1) ?? '—'})`).join(', ')}
          </div>
        ) : null}
        {lineup.undecidable.length > 0 ? (
          <div className="faint" style={{ marginTop: 6 }}>
            Not enough data to rank: {lineup.undecidable.map((e) => e.name).join(', ')}
          </div>
        ) : null}
        {lineup.notes.map((n) => (
          <div className="faint" key={n}>
            {n}
          </div>
        ))}
      </details>
    </div>
  );
}

function ComparisonCard({ comparison }: { comparison: StartSitComparison }) {
  const winner = comparison.evaluations.find((e) => e.playerId === comparison.recommendedPlayerId);
  /*
   * A comparison with no legal shared slot is reported, never forced.
   *
   * The numbers underneath are still honest — they are the same per-player
   * evaluation as everywhere else — but "Start X" over a set of players who
   * cannot occupy the same spot would be answering a question nobody asked.
   */
  const comparable = comparison.slot?.comparable ?? true;
  const ranked = [...comparison.evaluations].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));

  return (
    <div className="card" data-testid="comparison">
      {/*
        The recommendation, first and loudest.

        A start/sit screen is one question with one answer, and everything under
        it is why. The answer used to be a line of bold text among six other
        lines of bold text; it is now the only thing on the card that looks like
        a conclusion. Nothing about how it is reached has changed.
      */}
      <div className={winner && comparable ? 'verdict verdict-take' : 'verdict verdict-calm'}>
        <div className="verdict-label" data-testid="comparison-verdict">
          {!comparable
            ? 'Not the same lineup decision'
            : winner
              ? `Start ${winner.name}`
              : 'No recommendation'}
        </div>
        <div className="verdict-detail">
          <Confidence level={comparison.confidence} /> · Vegas data{' '}
          {comparison.dataFreshness.provider ?? 'none'} · {formatAge(comparison.dataFreshness.fetchedAt)}
        </div>
      </div>

      {comparison.slot ? (
        <div className={comparable ? 'faint' : 'hint hint-caution'} data-testid="comparison-slot">
          {comparison.slot.detail}
        </div>
      ) : null}

      {/*
        The order, said plainly. The brief asks for a ranking rather than only a
        winner, and with four players a table alone buries it.
      */}
      {comparable && ranked.length > 0 ? (
        <ol className="reason-list" data-testid="comparison-order" style={{ margin: '8px 0' }}>
          {/* The list numbers itself; printing the position again reads "2. 2." */}
          {ranked.map((e, i) => (
            <li key={e.playerId}>
              {i === 0 ? <strong>Start: {e.name}</strong> : e.name}
              {e.score == null ? ' — not enough data to rank' : ` — ${e.score.toFixed(1)}`}
            </li>
          ))}
        </ol>
      ) : null}

      {/*
        Compact tags for the two things a projection cannot express: whether
        kickoff timing is a problem, and whether the market has moved since the
        last look. The numbers behind them are in the reasons and warnings
        below rather than repeated here.
      */}
      <div className="tag-row">
        {comparison.lateSwap && comparison.lateSwap.verdict !== 'no_risk' && comparison.lateSwap.verdict !== 'unknown' ? (
          <span
            className={comparison.lateSwap.verdict === 'consider_early_option' ? 'tag tag-urgent' : 'tag tag-calm'}
            title={comparison.lateSwap.detail}
            data-testid="late-swap-tag"
          >
            ⏱ {comparison.lateSwap.label}
          </span>
        ) : null}
        {comparison.evaluations
          .filter((e) => e.movement?.headline)
          .map((e) => (
            <span
              key={`move-${e.playerId}`}
              className={e.movement.direction === 'up' ? 'tag tag-star' : 'tag tag-warn'}
              title={e.movement.significant.map((m) => m.display).join('; ')}
              data-testid="movement-tag"
            >
              {e.movement.direction === 'up' ? '↑' : '↓'} {e.name}: {e.movement.headline}
            </span>
          ))}
        {comparison.evaluations
          .filter((e) => e.lock?.locked)
          .map((e) => (
            <span key={`lock-${e.playerId}`} className="tag tag-calm" data-testid="locked-tag">
              🔒 {e.name} locked
            </span>
          ))}
      </div>

      {/*
        Availability, per player, in the terms a lineup decision is made in.
        `Q · hamstring · limited → full` is the whole difference between two
        players who are both "Questionable", and it is where the injury report
        earns its place. Nothing shows for anybody healthy.
      */}
      {comparison.evaluations
        .filter((e) => e.statusFlag)
        .map((e) => (
          <div className="injury-line" key={`inj-${e.playerId}`} data-testid="startsit-injury">
            {e.name}: {e.statusFlag}
            {e.injury?.conflictNote ? <span className="faint"> — sources disagree ({e.injury.conflictNote})</span> : null}
          </div>
        ))}

      {comparison.warnings.map((w) => (
        <div className="hint hint-caution" key={w}>
          {w}
        </div>
      ))}

      {comparison.reasons.length > 0 ? (
        <ul className="reason-list" style={{ margin: '8px 0' }}>
          {comparison.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}

      <table className="compact">
        <thead>
          <tr>
            <th>Player</th>
            <th>Vegas</th>
            <th>Score</th>
            <th>Coverage</th>
          </tr>
        </thead>
        <tbody>
          {comparison.evaluations.map((e) => (
            <tr key={e.playerId}>
              <td>
                {comparable && e.playerId === comparison.recommendedPlayerId ? '★ ' : ''}
                {e.name}
              </td>
              <td>{e.expectation.points == null ? <Unknown what="Vegas expectation" /> : e.expectation.points.toFixed(1)}</td>
              <td>{e.score == null ? <Unknown what="score" /> : e.score.toFixed(1)}</td>
              <td>{Math.round(e.expectation.coverage * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>

      {comparison.evaluations.map((e) => (
        <details className="disclosure" key={e.playerId}>
          <summary>{e.name} breakdown</summary>
          <div className="components">
            {e.components.map((c) => (
              <div className="component" key={c.key}>
                <span className="component-label">
                  {c.label}
                  {c.unknown ? ' (unknown)' : ''}
                </span>
                <span className="component-value">{c.value.toFixed(2)}</span>
                <span className="component-detail">{c.display}</span>
              </div>
            ))}
          </div>
          {e.expectation.contributions.length > 0 ? (
            <div className="components">
              {e.expectation.contributions.map((c) => (
                <div className="component" key={c.market}>
                  <span className="component-label">{c.market}</span>
                  <span className="component-value">{c.points.toFixed(2)}</span>
                  <span className="component-detail">{c.detail}</span>
                </div>
              ))}
            </div>
          ) : null}
          {e.expectation.notes.map((n) => (
            <div className="faint" key={n}>
              {n}
            </div>
          ))}
        </details>
      ))}
    </div>
  );
}


/**
 * The roster during an active draft.
 *
 * Deliberately not a starters/bench split: mid-draft nobody has decided who
 * starts, and showing a lineup would invent that decision. Players held,
 * grouped by position, plus the requirements still open.
 */
function LiveDraftRoster({
  roster,
}: {
  roster: {
    drafted: (RosterPlayer & { pickNo: number | null })[];
    counts: Record<string, number>;
    filled: number;
    remaining: number;
    openStarters: OpenSlot[];
    picksMade: number;
  };
}) {
  const positions = Object.keys(roster.counts).sort();
  return (
    <>
      {/*
        Live, but quietly so: a dot and a word, not a coloured banner. What is
        still missing is the sentence worth reading here, so it gets the type.
      */}
      <div className="card card-tight" data-testid="live-draft-card">
        <div className="header-row">
          <span className="live-dot">Live draft</span>
          <span className="faint">
            {roster.picksMade} {roster.picksMade === 1 ? 'pick' : 'picks'} · {roster.filled} filled ·{' '}
            {roster.remaining} left
          </span>
        </div>
        {roster.openStarters.length > 0 ? (
          <div className="muted" style={{ marginTop: 4 }}>
            Still need:{' '}
            <strong>
              {roster.openStarters.map((o) => `${o.count > 1 ? `${o.count} ` : ''}${o.slot}`).join(', ')}
            </strong>
          </div>
        ) : (
          <div className="muted" style={{ marginTop: 4 }}>
            Every starting slot is covered.
          </div>
        )}
      </div>

      {/*
        One card per position group holding one line per player, rather than one
        card per player. Same information, roughly three times as many players
        on a phone screen.
      */}
      {roster.drafted.length === 0 ? (
        <Empty>Nothing drafted yet. Your picks appear here as you make them.</Empty>
      ) : (
        positions.map((position) => (
          <div key={position}>
            <div className="section-title">
              {position} ({roster.counts[position]})
            </div>
            <div className="list-card">
              {roster.drafted
                .filter((p) => (p.position || 'UNKNOWN') === position)
                .map((p) => (
                  <div key={p.playerId} className="roster-line" data-testid="drafted-line">
                    <span className="player-name">{p.name}</span>
                    <PositionBadge position={p.position} team={p.team} />
                    <span className="pick-no">{p.pickNo ? `#${p.pickNo}` : 'held'}</span>
                  </div>
                ))}
            </div>
          </div>
        ))
      )}
    </>
  );
}
