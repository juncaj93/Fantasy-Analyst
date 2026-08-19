/**
 * Trades.
 *
 * Sections in a fixed order so the screen does not reshuffle under the reader
 * as evidence arrives, and every row says why it is there. A trade call with no
 * reason attached is a horoscope.
 *
 * What changed in the density pass: a suggestion used to be a card five lines
 * tall — a name, an injury line, a three-cell table of tally windows, a trend
 * line and a confidence badge — which meant four ideas filled a phone and the
 * fifth was below the fold. The same five facts now fit two lines and a note:
 * the windows are a labelled row rather than a table, and the case behind them —
 * why, the counterpoints, what the league paid for him — moved onto the
 * player's own page, where the rest of what the app knows about him already is.
 *
 * **Nothing about which players appear, in which section, in which order, or
 * with what confidence has changed.** The board is read exactly as it arrives
 * from `/api/trades`; this file decides only how much of a phone each idea is
 * allowed to take.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, type TradeBoard, type TradeSuggestion } from '../api.ts';
import { Confidence, DetailLabel, Empty, Notice, SignedValue } from '../components/common.tsx';
import { NavBar, SkeletonRows } from '../components/native.tsx';
import { CompactPlayerRow, RowNote } from '../components/playerRow.tsx';
import { PlayerPage } from '../components/playerPage.tsx';
import { ReasonList, withoutRepeats } from '../components/decisions.tsx';

export function TradesScreen() {
  const [board, setBoard] = useState<TradeBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBoard(await api.get<TradeBoard>('/api/trades'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!board) {
    return (
      <>
        <NavBar title="Trades" subtitle="Reading your evidence…" />
        <SkeletonRows rows={5} testId="trades-skeleton" />
      </>
    );
  }

  const open = openId == null ? null : (board.sections.flatMap((s) => s.players).find((p) => p.playerId === openId) ?? null);

  /*
   * The same player page every other screen opens, with the trade case at the
   * top of it.
   *
   * A separate "trade detail" screen would have been a second place where a
   * player's evidence, injury and outlook are rendered — and a reader who taps
   * a name expects the player, not a sub-view of the screen they came from. The
   * case is passed in as context and sits above the page's own tabs.
   */
  if (open) {
    return (
      <PlayerPage
        player={{ id: open.playerId, name: open.name, position: open.position, team: open.team }}
        backLabel="Trades"
        onBack={() => setOpenId(null)}
        context={<TradeCase suggestion={open} />}
      />
    );
  }

  return (
    <>
      {/*
        The card that said "Trades" and then where the ideas come from was a
        title and a caption in a box, above a screen whose title is Trades. The
        navigation bar says both, in the height the bar was already taking.
      */}
      <NavBar
        testId="trades-nav"
        title="Trades"
        subtitle={
          board.league
            ? `${board.league.name} — newsletter evidence, last 30 days leading`
            : 'No league selected'
        }
      />

      {board.warnings.map((w) => (
        <Notice key={w}>{w}</Notice>
      ))}

      {board.sections.length === 0 ? (
        <Empty>
          Nothing to suggest yet. Trade ideas come from newsletter evidence moving in the last 30 days — once a few
          issues have been read, this fills in.
        </Empty>
      ) : (
        board.sections.map((section) => (
          <div key={section.verdict}>
            <div className="section-title">
              {section.label} <span className="section-count">{section.players.length}</span>
            </div>
            <div className="dense-group" role="list" aria-label={section.label}>
              {section.players.map((s) => (
                <TradeRow key={s.playerId} suggestion={s} onOpen={() => setOpenId(s.playerId)} />
              ))}
            </div>
          </div>
        ))
      )}

      {board.considered > 0 ? (
        <div className="faint" style={{ margin: '8px 2px' }}>
          {board.considered} player{board.considered === 1 ? '' : 's'} with evidence were considered. Players nobody
          has written about recently are left out rather than listed as holds.
        </div>
      ) : null}
    </>
  );
}

/**
 * One trade idea, in two lines and a sentence.
 *
 * The three windows sit in the row's own columns rather than in a table of
 * their own: `Life +13 · 30d +13 · 7d +13` reads as three readings of one
 * signal, which is what they are, and the eye can run down any one of them
 * across the whole section. Confidence qualifies the signal, so it sits at the
 * end of the reason line in the quietest treatment that is still legible.
 *
 * The availability line survives, and it is deliberately the trade vocabulary
 * rather than the Start/Sit one: a designation costing a lineup six points is
 * not the same fact as a player whose season is in question. It replaces the
 * reason on the rows that have one, because a row may have exactly one sentence
 * and an injury outranks a trend.
 */
function TradeRow({ suggestion, onOpen }: { suggestion: TradeSuggestion; onOpen: () => void }) {
  const w = suggestion.windows;
  const reasons = withoutRepeats(suggestion.reasons);
  const line = suggestion.injury.line ?? reasons[0];

  return (
    <div role="listitem">
      <CompactPlayerRow
        playerId={suggestion.playerId}
        name={suggestion.name}
        position={suggestion.position}
        team={suggestion.team}
        onOpen={onOpen}
        testId="trade-row"
        label={`${suggestion.name} — open the case for him`}
        metrics={[
          { label: 'Life', value: <SignedValue net={w.lifetime} /> },
          { label: '30d', value: <SignedValue net={w.last30} /> },
          { label: '7d', value: <SignedValue net={w.last7} /> },
        ]}
        note={
          line ? (
            <RowNote trailing={<Confidence level={suggestion.confidence} />}>
              <span
                className={suggestion.injury.line ? 'injury-line-inline' : undefined}
                data-testid={suggestion.injury.line ? 'trade-injury' : 'trade-line'}
              >
                {line}
              </span>
            </RowNote>
          ) : (
            <RowNote trailing={<Confidence level={suggestion.confidence} />}>
              <span className="faint">No single reason leads — the case is on his page.</span>
            </RowNote>
          )
        }
      />
    </div>
  );
}

/**
 * The whole case for moving him, at the top of his own page.
 *
 * Everything the collapsed card used to hide behind a disclosure, in the place
 * a reader who tapped the row is already looking — and nothing is lost on the
 * way: the reasons, the counterpoints, what this league paid for him, and how
 * much evidence is behind all of it.
 */
function TradeCase({ suggestion }: { suggestion: TradeSuggestion }) {
  const w = suggestion.windows;
  const reasons = withoutRepeats(suggestion.reasons);
  const counterpoints = withoutRepeats(suggestion.counterpoints, reasons);

  return (
    <div data-testid="trade-case">
      <div className="trade-case-head">
        <span className="trade-case-verdict">{suggestion.label}</span>
        <Confidence level={suggestion.confidence} />
      </div>

      {suggestion.injury.line ? (
        <div className="injury-line" data-testid="trade-injury">
          {suggestion.injury.line}
        </div>
      ) : null}

      <DetailLabel>Why</DetailLabel>
      <ReasonList items={reasons} />
      {counterpoints.length > 0 ? (
        <>
          <DetailLabel>{counterpoints.length === 1 ? 'Counterpoint' : 'Counterpoints'}</DetailLabel>
          <ReasonList muted items={counterpoints} />
        </>
      ) : null}
      {/*
        What his manager spent on him.

        Real context for a trade rather than decoration: what somebody paid is
        most of what they will want back, and a second-round pick from August is
        the number a February offer gets measured against. Absent for anybody
        picked up off waivers, which is the honest answer — they cost nothing,
        and a `0.00` would be a fabrication.
      */}
      {suggestion.draft?.line ? (
        <>
          <DetailLabel>Draft</DetailLabel>
          <div className="muted" data-testid="trade-draft-provenance">
            {suggestion.draft.line}
          </div>
        </>
      ) : null}
      <div className="faint" style={{ marginTop: 8 }}>
        {w.itemsLifetime} news item{w.itemsLifetime === 1 ? '' : 's'} in total, {w.items30} in the last 30 days.
      </div>
    </div>
  );
}
