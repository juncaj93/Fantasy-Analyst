/**
 * A reading of one sheet dismissal, taken on the phone it goes wrong on.
 *
 * **Why this exists at all.** The dismissal defect this is here to settle is
 * visible only on iOS Safari, and nothing in this repository can run iOS
 * Safari: the CI shards are Playwright's WebKit on Linux, the sandbox cannot
 * download WebKit at all, and `page.mouse` is not a finger. Two rounds of
 * fixes have now been reasoned from Chromium traces and shipped, and the
 * reader's answer both times was that nothing changed. So the next change is
 * made from a number measured on the device, and this is what measures it.
 *
 * **It is off unless it is asked for.** Everything below is behind
 * {@link tracing}, which reads one query parameter once. With the parameter
 * absent — which is every ordinary visit, every test, and the Home Screen app —
 * the cost is a boolean already in a register, and this file adds nothing to
 * the page but its own bytes. That matters on the scroll handler in particular,
 * where this file's neighbour records what per-frame work does to WebKit.
 *
 * **It draws itself outside React.** The panel is appended to `document.body`
 * rather than rendered, because the thing being measured ends with the sheet
 * unmounting and a panel inside the sheet would leave with it — taking the
 * reading with it at the exact moment the reading is complete.
 */

/** One thing that happened, and what the layer looked like when it did. */
interface Moment {
  /** Milliseconds since the trace was reset. */
  at: number;
  what: string;
  /** How many fingers the layer believed were on it. */
  touching: number;
  /** Where the layer was scrolled to. */
  top: number;
  note?: string;
}

const PARAM = 'gesture=trace';
/** Enough to hold a long deliberate push without growing without bound. */
const KEEP = 200;

let armed: boolean | null = null;
let moments: Moment[] = [];
let started = 0;
let panel: HTMLPreElement | null = null;
let queued = 0;

/**
 * Whether this visit asked to be measured.
 *
 * Read once and remembered, so the hot paths that guard on it are not parsing
 * a query string per scroll event.
 */
export function tracing(): boolean {
  if (armed === null) {
    armed = typeof location !== 'undefined' && location.search.includes(PARAM);
  }
  return armed;
}

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());

/** Begin a fresh reading. Called when a sheet opens, so each card is its own. */
export function traceReset(): void {
  if (!tracing()) return;
  moments = [];
  started = now();
}

/** Record one thing, with the two numbers that say what the layer thought. */
export function trace(what: string, touching: number, top: number, note?: string): void {
  if (!tracing()) return;
  if (!started) started = now();
  moments.push({ at: Math.round(now() - started), what, touching, top: Math.round(top), note });
  if (moments.length > KEEP) moments.shift();
  /*
   * Drawn on the next frame rather than on the event, so a run of scroll
   * events costs one repaint between them instead of one each. The reading is
   * about timing, and a tracer that itself stalls the layer would be measuring
   * its own weight.
   */
  if (!queued && typeof requestAnimationFrame === 'function') {
    queued = requestAnimationFrame(() => {
      queued = 0;
      draw();
    });
  }
}

/** How many of a kind of thing happened. */
const count = (kind: string): number => moments.filter((m) => m.what === kind).length;
const first = (kind: string): Moment | undefined => moments.find((m) => m.what === kind);
const last = (kind: string): Moment | undefined => [...moments].reverse().find((m) => m.what === kind);

/** A gap between two moments, or a dash when one of them never happened. */
function gap(from: Moment | undefined, to: Moment | undefined): string {
  if (!from || !to) return '   —';
  return `${String(to.at - from.at).padStart(4)}ms`;
}

/**
 * The four numbers the next fix depends on, and the counts that say why.
 *
 * Written as a summary rather than left as a log because the person reading it
 * is holding a phone and is not a developer: what is wanted back is one
 * screenshot, not a transcript to interpret.
 */
function summary(): string {
  const down = first('touchstart');
  const up = last('touchend');
  const decision = first('DECIDE');
  const gone = first('GONE');
  const exit = first('EXIT');

  /*
   * The coasting after the hand comes off, which is the thing under suspicion:
   * every one of these scrolls re-arms the settle's debounce, so the dismissal
   * cannot begin until they stop.
   */
  const afterLift = up ? moments.filter((m) => m.what === 'scroll' && m.at > up.at) : [];
  const tail = afterLift.length ? afterLift[afterLift.length - 1]!.at - up!.at : 0;

  /*
   * The lowest finger count seen on a `touchmove`, which is the single number
   * that says whether the guard added in "The card waits for the hand" is doing
   * anything on this device.
   *
   * Moves only, and deliberately: `touchend` reports the finger that has just
   * left, so a reading that included it would say nought on every healthy drag
   * and answer nothing. A `touchmove` is the engine stating that a finger is on
   * the glass *now*, so a nought here means the layer lost count of a finger
   * that was demonstrably still there — which would make the guard inert and is
   * the first thing to rule out.
   */
  const moves = moments.filter((m) => m.what === 'touchmove');
  const lowest = moves.length ? Math.min(...moves.map((m) => m.touching)) : -1;

  return [
    '==== ONE SWIPE, MEASURED ====',
    `finger down -> up     ${gap(down, up)}`,
    `up -> decision        ${gap(up, decision)}   <-- the wait`,
    `decision -> gone      ${gap(decision, gone)}`,
    `lift -> gone          ${gap(up, gone)}   <-- what it feels like`,
    '',
    `coasting after lift   ${String(tail).padStart(4)}ms over ${afterLift.length} scrolls`,
    '',
    `touchstart ${count('touchstart')}  move ${count('touchmove')}  end ${count('touchend')}  CANCEL ${count('touchcancel')}`,
    `pointercancel ${count('pointercancel')}`,
    `fingers on a move: lowest ${lowest} of ${moves.length}`,
    `fingers at decision: ${decision ? decision.touching : '—'}`,
    `sprang home: ${count('SPRING') ? 'YES ' + count('SPRING') + 'x' : 'no'}`,
    `verdict: ${decision?.note ?? (exit ? 'dismiss' : '—')}`,
    '============================',
  ].join('\n');
}

function draw(): void {
  if (!tracing() || typeof document === 'undefined' || !document.body) return;
  if (!panel) {
    panel = document.createElement('pre');
    panel.setAttribute('data-testid', 'gesture-trace');
    panel.style.cssText = [
      'position:fixed',
      'inset:0 0 auto 0',
      'max-height:70vh',
      'overflow:auto',
      'margin:0',
      'padding:8px 10px',
      'background:rgba(0,0,0,.92)',
      'color:#6f6',
      'font:11px/1.35 ui-monospace,Menlo,monospace',
      'white-space:pre',
      'z-index:2147483647',
      '-webkit-user-select:text',
      'user-select:text',
    ].join(';');
    // Tap it to get the card back. The panel covers the top of the screen,
    // which is where the sheet's own dismiss gap is.
    panel.addEventListener('click', () => {
      if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
    document.body.appendChild(panel);
  }
  const log = moments
    .map(
      (m) =>
        `${String(m.at).padStart(5)} ${m.what.padEnd(13)} f=${m.touching} top=${String(m.top).padEnd(5)}${m.note ? ' ' + m.note : ''}`,
    )
    .join('\n');
  panel.textContent = `${summary()}\n\n(tap to hide)\n\n${log}`;
}
