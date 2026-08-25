/**
 * The defence, as one line and one sheet.
 *
 * This is deliberately the smallest surface in the app for the largest module
 * behind it. A defence is worth about eight points a week and costs a roster
 * spot; a screen proportional to the modelling would be a Defense Strategy
 * dashboard, which is precisely what this lane refused to build. So: one row on
 * Team, one row above the Waivers board, the same words on both, and everything
 * else — the arithmetic, the schedule, the bench cost — one tap away.
 *
 * The hierarchy is the app's existing one, applied without exception:
 *
 *   - **the screen is the answer.** `Stream NYJ over BUF · +4.2`;
 *   - **a tap is why.** Two or three sentences the planner wrote;
 *   - **a second tap is the evidence.** The opponent, the implied total, the
 *     next weeks, the bye, the bench spot, the bar it had to clear.
 *
 * Nothing here transacts, and nothing here is drawn when the planner has
 * nothing to say — `surface` is false for a best-ball league, a league with no
 * DEF slot, a season that has not drafted, and a rostered defence with no
 * decision to make. Silence is a state this screen can be in.
 */

import { useState } from 'react';
import type { DstPlan } from '../../core/dst/planner.ts';
import { PlayerIdentity } from './common.tsx';
import { Sheet } from './native.tsx';

/** The tone each decision reads in. Calm by default — this is not urgent news. */
const TONE: Record<DstPlan['decision'], string> = {
  add: 'tag-take',
  stream: 'tag-take',
  stream_and_stash: 'tag-take',
  stash: 'tag-calm',
  hold: 'tag-calm',
  wait: 'tag-calm',
  unknown: 'tag-calm',
};

const SHORT: Record<DstPlan['decision'], string> = {
  add: 'Add',
  stream: 'Stream',
  stream_and_stash: 'Stream + stash',
  stash: 'Stash',
  hold: 'Hold',
  wait: 'Wait',
  unknown: 'Unknown',
};

/**
 * One quiet, actionable line. Renders nothing at all when there is nothing to
 * say, which is most weeks for a reader who is holding a good defence.
 */
export function DstLine({ plan }: { plan: DstPlan | null | undefined }) {
  const [open, setOpen] = useState(false);
  if (!plan || !plan.surface || plan.headline.length === 0) return null;

  /*
   * Which club's mark to show.
   *
   * The defence being recommended, falling back to the one being held — a row
   * headed `Hold BUF` beside Pittsburgh's shield would be the app disagreeing
   * with itself in the space of four words. Absent for `wait`, where there is
   * no club in the sentence at all.
   */
  const badge = plan.target?.team ?? plan.stash?.team ?? plan.current?.team ?? null;

  return (
    <>
      <button
        className="card card-tight dst-line"
        data-testid="dst-line"
        data-decision={plan.decision}
        aria-label={`Defence: ${plan.headline}. Tap for why.`}
        onClick={() => setOpen(true)}
      >
        <PlayerIdentity position="DEF" team={badge} />
        <span className="dst-line-text" data-testid="dst-headline">
          {plan.headline}
        </span>
        <span className={`tag tag-mini ${TONE[plan.decision]}`} data-testid="dst-state">
          {SHORT[plan.decision]}
        </span>
      </button>
      {open ? <DstSheet plan={plan} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Why, and then the evidence behind it. */
export function DstSheet({ plan, onClose }: { plan: DstPlan; onClose: () => void }) {
  const [evidence, setEvidence] = useState(false);
  return (
    <Sheet title="Defence" onClose={onClose} testId="dst-detail">
      <div className="weekly" data-testid="dst-detail-body" data-decision={plan.decision}>
        <div className="weekly-head">
          <PlayerIdentity position="DEF" team={plan.target?.team ?? plan.current?.team ?? null} />
          <span className="metric">{plan.headline}</span>
        </div>

        {plan.temporary ? (
          <div className="faint" data-testid="dst-temporary" style={{ margin: '0 2px 8px' }}>
            One week only — this covers a week without a game and does not replace the defence you hold.
          </div>
        ) : null}

        <ul className="reason-list" data-testid="dst-why">
          {plan.why.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        {/*
          The bench spot, said whether or not it has a number.

          It is on the sheet rather than only inside the evidence because it is
          half the decision: a defence is never worth more than the spot it
          takes, and an unscorable drop candidate says "costs a bench spot" in
          those words instead of a figure the app does not have.
        */}
        <dl className="weekly-lines">
          <div className="weekly-line" data-testid="dst-cost">
            <dt>Roster cost</dt>
            <dd>{plan.cost.label}</dd>
          </div>
        </dl>

        {plan.evidence.length > 0 ? (
          <>
            <button className="btn btn-sm" data-testid="dst-evidence-toggle" onClick={() => setEvidence((v) => !v)}>
              {evidence ? 'Hide evidence' : 'Show evidence'}
            </button>
            {evidence ? (
              <dl className="weekly-lines" data-testid="dst-evidence">
                {plan.evidence.map((item) => (
                  <div className="weekly-line" key={item.key}>
                    <dt>{item.label}</dt>
                    <dd>{item.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </>
        ) : null}

        {plan.notes.length > 0 ? (
          <div className="faint" data-testid="dst-notes" style={{ marginTop: 8 }}>
            {plan.notes.join(' · ')}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
