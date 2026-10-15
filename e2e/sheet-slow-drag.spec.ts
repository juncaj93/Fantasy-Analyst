/**
 * Slow drags on a sheet, measured frame by frame.
 *
 * Alex's phone check of the first swipe round: fast flicks were right, slow
 * drags were not. The card seemed to lag the finger, bounced while he held a
 * steady drag, and the screen sometimes stayed grey after a close or a spring
 * back. These tests drive a finger at about 67 px/s (4 px every 60 ms) and
 * record where the card is drawn on every animation frame, so each of those
 * complaints is a number rather than an impression.
 *
 * The finger is dispatched touch events (see `touchDrag` in `helpers.ts` for
 * why), sent with real time between them; the card's position is read with
 * `getBoundingClientRect`, which includes its transform.
 */

import { expect, test, type Page } from '@playwright/test';

/** One step of a scripted gesture. */
type Step =
  | { kind: 'start'; at: 'grip' | 'header' | 'body' }
  | { kind: 'move'; times: number; dy: number; every: number; unscroll?: number }
  | { kind: 'hold'; ms: number }
  | { kind: 'second'; down: boolean }
  | { kind: 'end' }
  | { kind: 'watch'; ms: number };

/** What one animation frame looked like. */
interface Frame {
  t: number;
  /** Where the primary finger was, in px from the top of the viewport. */
  finger: number;
  /** Where the card's top edge was drawn, or null once it has gone. */
  card: number | null;
  /** The dim layer's opacity, or null once it has gone. */
  scrim: number | null;
  /** Whether a finger was down at this frame. */
  down: boolean;
  /** How far the body was scrolled. */
  bodyTop: number | null;
}

async function openPlayerCard(page: Page, { filler = false } = {}) {
  await page.goto('/');
  await page.getByTestId('tab-players').click();
  const rows = page.getByTestId('player-search-row');
  await expect(rows.first()).toBeVisible();
  await rows.first().click();
  await expect(page.getByTestId('player-sheet')).toBeVisible();
  await expect(page.getByTestId('player-page-metrics')).toBeVisible();
  if (filler) {
    await page.evaluate(() => {
      const filler = document.createElement('div');
      filler.style.height = '1200px';
      document.querySelector('.sheet-body')!.append(filler);
    });
  }
  // Past the rise, so the card starts at rest.
  await page.waitForTimeout(500);
}

/** Run a scripted gesture in the page and record every frame of it. */
async function record(page: Page, steps: Step[]): Promise<{ frames: Frame[]; marks: { t: number; what: string }[] }> {
  return page.evaluate(async (script) => {
    const card = () => document.querySelector('.sheet') as HTMLElement | null;
    const body = () => document.querySelector('.sheet-body') as HTMLElement | null;
    const pick = (where: string) => {
      const sel = where === 'grip' ? '.sheet-grip' : where === 'header' ? '.sheet-title' : '.sheet-body';
      const r = document.querySelector(sel)!.getBoundingClientRect();
      const view = window.innerHeight;
      // The body's visible part: aim a third of the way into what is on screen.
      const top = Math.max(0, r.top);
      const bottom = Math.min(view, r.bottom);
      const y = where === 'body' ? top + Math.min(80, (bottom - top) / 3) : r.top + r.height / 2;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(y) };
    };

    let target: Element = document.body;
    const finger = { x: 0, y: 0 };
    const second = { x: 0, y: 0, down: false };
    let down = false;
    const frames: Frame[] = [];
    const marks: { t: number; what: string }[] = [];
    const t0 = performance.now();
    const now = () => performance.now() - t0;

    const send = (type: string) => {
      const lifted = type === 'touchend' || type === 'touchcancel';
      const mk = (id: number, p: { x: number; y: number }) => ({
        identifier: id,
        target,
        clientX: p.x,
        clientY: p.y,
        pageX: p.x,
        pageY: p.y,
      });
      const on = [...(down || !lifted ? [mk(1, finger)] : []), ...(second.down ? [mk(2, second)] : [])];
      const changed = [mk(1, finger)];
      const pointer = { touchstart: 'pointerdown', touchmove: 'pointermove', touchend: 'pointerup', touchcancel: 'pointercancel' }[type]!;
      target.dispatchEvent(
        new PointerEvent(pointer, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 7,
          pointerType: 'touch',
          isPrimary: true,
          clientX: finger.x,
          clientY: finger.y,
          buttons: lifted ? 0 : 1,
        }),
      );
      const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(event, 'touches', { value: on });
      Object.defineProperty(event, 'targetTouches', { value: on });
      Object.defineProperty(event, 'changedTouches', { value: changed });
      target.dispatchEvent(event);
    };

    let running = true;
    const sample = () => {
      const c = card();
      const s = document.querySelector('.sheet-backdrop') as HTMLElement | null;
      const b = body();
      frames.push({
        t: now(),
        finger: finger.y,
        card: c ? c.getBoundingClientRect().top : null,
        scrim: s ? Number(getComputedStyle(s).opacity) : null,
        down,
        bodyTop: b ? b.scrollTop : null,
      });
      if (running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    for (const step of script) {
      if (step.kind === 'start') {
        const p = pick(step.at);
        finger.x = p.x;
        finger.y = p.y;
        target = document.elementFromPoint(p.x, p.y) ?? document.body;
        down = true;
        marks.push({ t: now(), what: 'start' });
        send('touchstart');
      } else if (step.kind === 'move') {
        for (let i = 0; i < step.times; i += 1) {
          await pause(step.every);
          finger.y += step.dy;
          // A scroller the finger is still pulling back toward its top.
          if (step.unscroll) {
            const b = body();
            if (b) b.scrollTop = Math.max(0, b.scrollTop - step.unscroll);
          }
          send('touchmove');
        }
      } else if (step.kind === 'hold') {
        marks.push({ t: now(), what: 'hold' });
        await pause(step.ms);
        marks.push({ t: now(), what: 'resume' });
      } else if (step.kind === 'second') {
        if (step.down) {
          second.x = finger.x + 60;
          second.y = finger.y;
          second.down = true;
          marks.push({ t: now(), what: 'second-down' });
          send('touchstart');
        } else {
          second.down = false;
          marks.push({ t: now(), what: 'second-up' });
          // The second finger leaving: the primary one is still on the glass.
          const event = new Event('touchend', { bubbles: true, cancelable: true, composed: true });
          const one = [{ identifier: 1, target, clientX: finger.x, clientY: finger.y, pageX: finger.x, pageY: finger.y }];
          Object.defineProperty(event, 'touches', { value: one });
          Object.defineProperty(event, 'targetTouches', { value: one });
          Object.defineProperty(event, 'changedTouches', { value: [{ ...one[0], identifier: 2 }] });
          target.dispatchEvent(event);
        }
      } else if (step.kind === 'end') {
        down = false;
        marks.push({ t: now(), what: 'end' });
        send('touchend');
      } else if (step.kind === 'watch') {
        await pause(step.ms);
      }
    }
    running = false;
    await pause(32);
    return { frames, marks };
  }, steps);
}

/** The step 1 numbers for one recorded gesture. */
function analyse(frames: Frame[], marks: { t: number; what: string }[]) {
  const end = marks.find((m) => m.what === 'end')?.t ?? Infinity;
  const live = frames.filter((f) => f.down && f.t <= end && f.card != null);
  const rest = live[0]?.card ?? 0;
  const fingerStart = live[0]?.finger ?? 0;
  let maxFrameDiff = 0;
  let jumps = 0;
  let bounces = 0;
  let engagedAt: number | null = null;
  let engageJump = 0;
  let resistanceAt: number | null = null;
  for (let i = 1; i < live.length; i += 1) {
    const a = live[i - 1]!;
    const b = live[i]!;
    const dFinger = b.finger - a.finger;
    const dCard = b.card! - a.card!;
    if (engagedAt == null && Math.abs(b.card! - rest) > 0.5) {
      engagedAt = b.finger - fingerStart;
      engageJump = Math.round((dCard - dFinger) * 10) / 10;
      continue;
    }
    if (engagedAt == null) continue;
    const diff = Math.abs(dFinger - dCard);
    maxFrameDiff = Math.max(maxFrameDiff, diff);
    if (diff > 2) jumps += 1;
    if (dCard < -0.5 && dFinger >= 0) bounces += 1;
    const lag = b.finger - fingerStart - (b.card! - rest);
    if (resistanceAt == null && lag > 8) resistanceAt = Math.round(b.finger - fingerStart);
  }
  const fingerTravel = live.length ? live[live.length - 1]!.finger - fingerStart : 0;
  const cardTravel = live.length ? live[live.length - 1]!.card! - rest : 0;
  return {
    frames: live.length,
    maxFrameDiff: Math.round(maxFrameDiff * 10) / 10,
    jumpsOver2px: jumps,
    engagedAtFingerPx: engagedAt == null ? null : Math.round(engagedAt),
    jumpAtEngage: engageJump,
    resistanceFromFingerPx: resistanceAt,
    fingerTravel: Math.round(fingerTravel),
    cardTravel: Math.round(cardTravel),
    bounces,
  };
}

/** How long after the lift the dim layer took to reach `value` (or to go). */
function scrimSettledAfterLift(frames: Frame[], marks: { t: number; what: string }[], value: 0 | 1): number | null {
  const end = marks.find((m) => m.what === 'end')!.t;
  for (const f of frames) {
    if (f.t < end) continue;
    if (value === 0 && (f.scrim == null || f.scrim <= 0.01)) return Math.round(f.t - end);
    if (value === 1 && f.scrim != null && f.scrim >= 0.99) return Math.round(f.t - end);
  }
  return null;
}

/** Printed so CI logs carry the numbers; one JSON line per gesture. */
function report(name: string, data: unknown) {
  const project = test.info().project.name;
  // eslint-disable-next-line no-console
  console.log(`SLOWDRAG ${project} ${name} ${JSON.stringify(data)}`);
}

const slow = (times: number) => ({ kind: 'move', times, dy: 4, every: 60 }) as const;

test.describe('a slow drag on a sheet, frame by frame', () => {
  for (const at of ['grip', 'header', 'body'] as const) {
    test(`from the ${at}`, async ({ page }) => {
      await openPlayerCard(page);
      const { frames, marks } = await record(page, [{ kind: 'start', at }, slow(65), { kind: 'hold', ms: 150 }, { kind: 'end' }, { kind: 'watch', ms: 600 }]);
      const numbers = analyse(frames, marks);
      report(at, numbers);
      expect(numbers.frames).toBeGreaterThan(20);
    });
  }

  test('from the body, scrolled back to its top mid-gesture', async ({ page }) => {
    await openPlayerCard(page, { filler: true });
    await page.evaluate(() => {
      (document.querySelector('.sheet-body') as HTMLElement).scrollTop = 40;
    });
    const { frames, marks } = await record(page, [
      { kind: 'start', at: 'body' },
      // The first ten steps are the scroll coming back to the top; the rest is past it.
      { kind: 'move', times: 10, dy: 4, every: 60, unscroll: 4 },
      slow(45),
      { kind: 'hold', ms: 150 },
      { kind: 'end' },
      { kind: 'watch', ms: 600 },
    ]);
    const numbers = analyse(frames, marks);
    report('handoff', { ...numbers, bodyTopAtEnd: frames.at(-1)?.bodyTop });
    expect(numbers.frames).toBeGreaterThan(20);
  });

  test('held still for 300 ms in the middle, then continued', async ({ page }) => {
    await openPlayerCard(page);
    const { frames, marks } = await record(page, [
      { kind: 'start', at: 'grip' },
      slow(15),
      { kind: 'hold', ms: 300 },
      slow(5),
      { kind: 'hold', ms: 150 },
      { kind: 'end' },
      { kind: 'watch', ms: 600 },
    ]);
    const hold = marks.find((m) => m.what === 'hold')!.t;
    const resume = marks.find((m) => m.what === 'resume')!.t;
    const still = frames.filter((f) => f.t > hold + 20 && f.t < resume && f.card != null).map((f) => f.card!);
    const drift = still.length ? Math.max(...still) - Math.min(...still) : 0;
    const numbers = analyse(frames, marks);
    report('hold', { ...numbers, driftWhileStill: Math.round(drift * 10) / 10 });
    expect(numbers.frames).toBeGreaterThan(20);
  });

  test('released short of the line, springs back and the dim comes back', async ({ page }) => {
    await openPlayerCard(page);
    const { frames, marks } = await record(page, [
      { kind: 'start', at: 'grip' },
      slow(20),
      { kind: 'hold', ms: 150 },
      { kind: 'end' },
      { kind: 'watch', ms: 800 },
    ]);
    const numbers = analyse(frames, marks);
    const last = frames.at(-1)!;
    report('below', { ...numbers, scrimFullAfterMs: scrimSettledAfterLift(frames, marks, 1), cardAtEnd: last.card, scrimAtEnd: last.scrim });
    await expect(page.getByTestId('player-sheet')).toBeVisible();
  });

  test('released past the line, closes and the dim goes', async ({ page }) => {
    await openPlayerCard(page);
    const { frames, marks } = await record(page, [
      { kind: 'start', at: 'grip' },
      slow(45),
      { kind: 'hold', ms: 150 },
      { kind: 'end' },
      { kind: 'watch', ms: 800 },
    ]);
    const numbers = analyse(frames, marks);
    report('past', { ...numbers, scrimGoneAfterMs: scrimSettledAfterLift(frames, marks, 0) });
    await expect(page.getByTestId('player-sheet')).toHaveCount(0);
  });

  test('interrupted by a second finger', async ({ page }) => {
    await openPlayerCard(page);
    const { frames, marks } = await record(page, [
      { kind: 'start', at: 'grip' },
      slow(15),
      { kind: 'second', down: true },
      slow(10),
      { kind: 'second', down: false },
      slow(10),
      { kind: 'hold', ms: 150 },
      { kind: 'end' },
      { kind: 'watch', ms: 800 },
    ]);
    const numbers = analyse(frames, marks);
    report('second', numbers);
    expect(numbers.frames).toBeGreaterThan(20);
  });
});
