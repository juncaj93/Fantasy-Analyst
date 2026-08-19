/**
 * The weekly card: one of your players, this Sunday, in a sheet you can read
 * standing up.
 *
 * The rule this screen is built to is a negative one — **it is not a stat
 * dump**. Everything the engine knows about a player is still one tap further
 * on, in Compare, where the full breakdown, every component, its weight and its
 * contribution have always lived. What arrives here is the short list that
 * changes a lineup decision, and what that list *is* is decided in
 * core/startsit/weekCard.ts, not here: this file is layout.
 *
 * It fits in a screen and a bit at 375px, and it is meant to. A sheet that
 * needs three flicks to read is a sheet the reader closes.
 */

import { useState } from 'react';
import type { WeeklyCard } from '../../core/startsit/weekCard.ts';
import { Confidence, PositionBadge } from './common.tsx';
import { Sheet } from './native.tsx';
import {
  InjuryDetail,
  LastSeasonLine,
  NewsletterTakeaway,
  ProfileFlags,
  SeasonOutlook,
  usePlayerDetail,
} from './playerDetail.tsx';

/**
 * The card as a modal sheet, with one way out and one way further in.
 *
 * `onCompare` is the escape hatch to the full comparison — the same sheet the
 * rest of the screen opens — so the concise view never has to grow a second
 * disclosure to answer "but what about the other four components".
 */
export function WeeklyCardSheet({
  card,
  onClose,
  onCompare,
}: {
  card: WeeklyCard;
  onClose: () => void;
  onCompare: () => void;
}) {
  return (
    <Sheet title={card.name} onClose={onClose} testId="weekly-sheet">
      <div className="weekly" data-testid="weekly-card" data-player-id={card.playerId}>
        <div className="weekly-head">
          <PositionBadge position={card.position} team={card.team} />
          <Confidence level={card.confidence} />
          {card.score == null ? null : (
            <span className="metric" data-testid="weekly-score">
              Proj <strong>{card.score.toFixed(1)}</strong>
            </span>
          )}
        </div>

        {/*
          The conclusion, and it is the lineup's conclusion. Loud, because a
          reader who reads nothing else on this sheet should still leave with
          the answer.
        */}
        <div
          className={`verdict verdict-${card.headline.tone === 'take' ? 'take' : card.headline.tone === 'warn' ? 'avoid' : 'calm'}`}
          data-testid="weekly-verdict"
          data-verdict={card.headline.verdict}
        >
          <div className="verdict-label">{card.headline.label}</div>
          {card.headline.detail ? <div className="verdict-detail">{card.headline.detail}</div> : null}
        </div>

        {/*
          The lines that changed the decision, at most five, each one a label
          and a reading. Anything unknown is not here at all — see `pending`
          below, which says so once instead of five times.
        */}
        {card.lines.length > 0 ? (
          <dl className="weekly-lines" data-testid="weekly-lines">
            {card.lines.map((line) => (
              <div className="weekly-line" key={line.key} data-line={line.key}>
                <dt>{line.label}</dt>
                <dd>
                  {line.value}
                  {line.detail ? <span className="faint"> · {line.detail}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {/*
          The market's own lines for him. Three at most: this is the number
          behind the projection, not a betting screen.
        */}
        {card.props.length > 0 ? (
          <div className="weekly-props" data-testid="weekly-props">
            {card.props.map((prop) => (
              <span className="metric" key={prop.key}>
                {prop.label} <strong>{prop.value}</strong>
              </span>
            ))}
          </div>
        ) : null}

        {card.drivers.length > 0 ? (
          <div className="faint" data-testid="weekly-drivers">
            {card.drivers.join(' · ')}
          </div>
        ) : null}

        {/*
          Disagreement between two signals is the most useful thing this card
          can carry, so it is stated rather than averaged into silence.
        */}
        {card.conflicts.map((conflict) => (
          <div className="hint hint-caution" key={conflict} data-testid="weekly-conflict">
            {conflict}
          </div>
        ))}

        {/*
          What would change the recommendation — silent until that pass exists,
          and rendered from its own sentences when it does.
        */}
        {card.changes.length > 0 ? (
          <div className="weekly-changes" data-testid="weekly-changes">
            <div className="detail-label">What would change this</div>
            <ul className="reason-list">
              {card.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {card.pending.length > 0 ? (
          <div className="faint" data-testid="weekly-pending">
            Not known yet: {card.pending.join(', ')}.
          </div>
        ) : null}

        {/*
          Everything about the player that is not about *this* week.

          The Team screen now collapses a starter to one line, and the weekly
          card above is the concise expansion of that line: the verdict, the
          handful of readings that produced it, and what would change it. The
          rest of what the app knows about him — the newsletter ledger's
          strongest supported fact, the published outlook, last season, what he
          is coming back from — is real context and belongs to the expanded
          view, but it is not what a lineup decision turns on at 11am on a
          Sunday, so it waits behind one more tap.

          It is drawn by components/playerDetail.tsx, the same module Draft and
          Players read from. There is one expanded-player implementation in this
          app and this is a fifth caller of it, not a fifth copy: the sections
          used to be pasted per screen, and the second paste is where six
          renderers start. Nothing is fetched until the disclosure is actually
          opened — the body is not mounted while it is shut — so a reader who
          only wanted the verdict pays for no request at all.
        */}
        <WeeklyMore card={card} />

        <div className="btn-row" style={{ margin: '10px 0 0' }}>
          <button className="btn" data-testid="weekly-compare" onClick={onCompare}>
            Compare
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * The disclosure itself, holding the one piece of state it needs.
 *
 * A native `<details>` keeps its children in the DOM while it is shut, which
 * would mean fetching every opened player's profile whether or not anybody
 * asked to see it. Tracking `open` and mounting the body only when it is true
 * costs one `useState` and makes the deferral real rather than visual.
 */
function WeeklyMore({ card }: { card: WeeklyCard }) {
  const [open, setOpen] = useState(false);

  return (
    <details
      className="disclosure"
      data-testid="weekly-more"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>More on {card.name}</summary>
      {open ? <WeeklyPlayerDetail playerId={card.playerId} position={card.position} /> : null}
    </details>
  );
}

/**
 * The player behind the week, in the app's one expanded-player rendering.
 *
 * Deliberately a thin wrapper: it adds no section of its own. If a fact about a
 * player ever needs to change how it reads, it changes in playerDetail.tsx and
 * every screen changes with it.
 */
function WeeklyPlayerDetail({ playerId, position }: { playerId: string; position: string }) {
  const { detail, failed } = usePlayerDetail(playerId);

  return (
    <div className="explain" data-testid="player-detail">
      <NewsletterTakeaway detail={detail} />
      <SeasonOutlook detail={detail} failed={failed} />
      <LastSeasonLine detail={detail} failed={failed} position={position} />
      <InjuryDetail detail={detail} />
      <ProfileFlags detail={detail} />
    </div>
  );
}
