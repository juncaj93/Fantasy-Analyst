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
import { Confidence, DetailLabel, Empty, Notice, SignedValue, StatusRow } from '../components/common.tsx';
import { NavBar, SkeletonRows } from '../components/native.tsx';
import { CompactPlayerRow, RowNote } from '../components/playerRow.tsx';
import { PlayerPage, PlayerSheet } from '../components/playerPage.tsx';
import { ReasonList, withoutRepeats } from '../components/decisions.tsx';
import { unwindOne } from '../tabReset.ts';

export function TradesScreen({ resetNonce }: { resetNonce: number }) {
  const [board, setBoard] = useState<TradeBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  /** Whether a skim has turned into a study — see `PlayerSheet`. */
  const [full, setFull] = useState(false);

  /*
   * Tapping Trades while already on Trades.
   *
   * The sheet closes, the pushed page unwinds, and the board returns to the
   * top. Nothing about the suggestions themselves is touched — they are the
   * server's answer, not a view state.
   */
  useEffect(() => {
    if (resetNonce === 0) return;
    unwindOne([
      { when: full, undo: () => setFull(false) },
      { when: openId != null, undo: () => setOpenId(null) },
    ]);
  }, [resetNonce]);

  const load = useCallback(async () => {
    try {
      setBoard(await api.get<TradeBoard>('/api/trades', { onFresh: setBoard }));
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
  if (open && full) {
    return (
      <PlayerPage
        player={{ id: open.playerId, name: open.name, position: open.position, team: open.team }}
        backLabel="Trades"
        onBack={() => setFull(false)}
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

      {/*
        The board's own caveats, as status lines rather than warning blocks.

        These are almost always one sentence about what could not be worked out
        — "your roster was not identified, so sell suggestions are unavailable" —
        and a filled yellow box the width of the phone was the loudest object on
        a screen whose subject is a list of trade ideas.
      */}
      {board.warnings.map((w) => (
        <StatusRow key={w} tone="info" data-testid="trades-warning">
          {w}
        </StatusRow>
      ))}

      {board.sections.length === 0 ? (
        <Empty>
          Nothing to suggest yet. Trade ideas come from newsletter evidence moving in the last 30 days — once a few
          issues have been read, this fills in.
        </Empty>
      ) : (
        board.sections.map((section) => {
          /*
           * A confidence every row shares is a fact about the section.
           *
           * Printed per row it was the same two words down the right-hand edge
           * of every suggestion — a pattern the eye follows instead of the
           * names, qualifying nothing because it never varies. Said once beside
           * the section's own count it still qualifies everything under it, and
           * the rows get their line back for the reason they are there.
           *
           * Only when it is genuinely unanimous. A section where the confidence
           * differs row to row is one where the reader needs it row to row.
           */
          const levels = new Set(section.players.map((p) => p.confidence));
          const shared = levels.size === 1 ? [...levels][0]! : null;
          return (
            <div key={section.verdict}>
              <div className="section-title section-title-row">
                <span>{section.label}</span>
                <span className="section-title-meta">
                  <span className="section-count">{section.players.length}</span>
                  {shared ? <Confidence level={shared} /> : null}
                </span>
              </div>
              <div className="dense-group" role="list" aria-label={section.label}>
                {section.players.map((s) => (
                  <TradeRow
                    key={s.playerId}
                    suggestion={s}
                    showConfidence={shared == null}
                    onOpen={() => setOpenId(s.playerId)}
                  />
                ))}
              </div>
            </div>
          );
        })
      )}

      {/*
        The case, over the list rather than instead of it.

        This is where the rows' explanations went. A collapsed row now says who
        and how he is moving; everything about *why* — the reasons, the
        counterpoints, what this league paid for him, how much evidence is
        behind it — is one tap away and arrives without taking the board off the
        screen. The full page is still there for a reader who wants the whole
        ledger, one step further in.
      */}
      {open && !full ? (
        <PlayerSheet
          player={{ id: open.playerId, name: open.name, position: open.position, team: open.team }}
          onClose={() => setOpenId(null)}
          onOpenFull={() => setFull(true)}
          context={<TradeCase suggestion={open} />}
        />
      ) : null}

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
function TradeRow({
  suggestion,
  showConfidence,
  onOpen,
}: {
  suggestion: TradeSuggestion;
  /** False when the section header already said it for every row under it. */
  showConfidence: boolean;
  onOpen: () => void;
}) {
  const w = suggestion.windows;


  return (
    <div role="listitem">
      <CompactPlayerRow
        playerId={suggestion.playerId}
        name={suggestion.name}
        position={suggestion.position}
        team={suggestion.team}
        onOpen={onOpen}
        testId="trade-row"
        /*
          Two windows, and nothing that reads like a sentence.

          The row used to carry three numbers and a line of prose under them —
          `improving over 30 days (+7 from 1 item(s))` beneath `30d +7`, which
          is the number saying itself twice, once in figures and once in words.
          `Life` went with it: a lifetime tally answers "has he ever mattered",
          and this screen is about who is moving *now*.

          What is left is the question the list exists to answer — who should I
          care about right now — and the answer to *why* is one tap away in the
          sheet, where there is room to say it properly.
        */
        metrics={[
          { label: '30d', value: <SignedValue net={w.last30} /> },
          { label: '7d', value: <SignedValue net={w.last7} /> },
        ]}
        {...(showConfidence
          ? {
              /*
                Only where it varies. A section whose rows all share a
                confidence says so in its own header — see the note there — and
                repeating it down the edge of every row is a pattern the eye
                follows instead of the names.
              */
              note: (
                <RowNote trailing={<Confidence level={suggestion.confidence} />}>
                  <span className="faint">{suggestion.label}</span>
                </RowNote>
              ),
            }
          : {})}
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
