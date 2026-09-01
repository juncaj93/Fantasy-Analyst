/**
 * DIAGNOSTIC ONLY — not a test of anything, and not to be merged.
 *
 * `main` is red on a WebKit-only failure in the compare sheet: a candidate row
 * reports `element is not stable` for a full click budget and is then detached.
 * Two hypotheses have been wrong already, both reasoned from failure logs, and
 * neither reproduces on Chromium — the only engine available where they were
 * formed. The recorded traces live on a host this environment cannot reach.
 *
 * So this asks WebKit directly, through the one channel that does come back:
 * CI job logs. It records who moves the sheet's layer and prints the timeline.
 *
 * The specific claim under test is one `native.tsx` makes in a comment:
 *
 *   "measured directly, bringing a candidate into view scrolls `.sheet-body`
 *    and leaves this alone"
 *
 * If that holds on WebKit, the layer never moves during a candidate click and
 * the cause is elsewhere. If it does not, the layer is being scrolled by
 * something nobody wrote, and `onScroll` reaching nought is a dismissal the
 * reader never asked for.
 *
 * Always passes. A diagnostic that fails tells us nothing we did not know.
 */

import { expect, test, type Page } from '@playwright/test';
import { inSeason } from './helpers.ts';

/** Patch everything that can move a scroller, and say who did it. */
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __probe: unknown[] };
    w.__probe = [];
    const MAX = 400;

    const describe = (el: unknown): string => {
      const node = el as Element | null;
      if (!node || !node.className) return String((node as Element | null)?.tagName ?? 'unknown');
      return `${node.tagName}.${String(node.className).split(' ').join('.')}`;
    };
    const interesting = (el: unknown): boolean => {
      const d = describe(el);
      return d.includes('sheet-scroller') || d.includes('sheet-body') || d.includes('sheet-snap');
    };
    const record = (entry: Record<string, unknown>) => {
      if (w.__probe.length < MAX) w.__probe.push({ t: Math.round(performance.now()), ...entry });
    };
    /** Two frames of caller, which is enough to name the culprit. */
    const where = (): string =>
      (new Error().stack ?? '').split('\n').slice(2, 5).map((l) => l.trim()).join(' | ').slice(0, 300);

    for (const api of ['scrollIntoView', 'scrollTo', 'scroll', 'scrollBy'] as const) {
      const original = (Element.prototype as unknown as Record<string, unknown>)[api];
      if (typeof original !== 'function') continue;
      (Element.prototype as unknown as Record<string, unknown>)[api] = function patched(this: Element, ...args: unknown[]) {
        /*
         * Any element, not just a scroller. The suspect is a click on a
         * candidate row -- which is not itself scrollable, and whose
         * scroll-into-view is free to walk up and move an ancestor that is.
         */
        record({ ev: `call:${api}`, on: describe(this), args: JSON.stringify(args).slice(0, 120), by: where() });
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      };
    }

    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    if (desc?.set && desc.get) {
      Object.defineProperty(Element.prototype, 'scrollTop', {
        configurable: true,
        get: desc.get,
        set(this: Element, value: number) {
          if (interesting(this)) record({ ev: 'set:scrollTop', on: describe(this), value, by: where() });
          desc.set!.call(this, value);
        },
      });
    }

    // `scroll` does not bubble, but it does capture.
    document.addEventListener(
      'scroll',
      (event) => {
        const el = event.target as Element | null;
        if (!el || !interesting(el)) return;
        const box = el as HTMLElement;
        record({
          ev: 'scroll',
          on: describe(el),
          top: Math.round(box.scrollTop),
          detentTop: Math.round(box.scrollHeight - box.clientHeight),
        });
      },
      true,
    );
  });
}

async function dump(page: Page, label: string) {
  const probe = await page.evaluate(() => {
    const w = window as unknown as { __probe: unknown[] };
    const out = w.__probe.slice();
    w.__probe.length = 0;
    return out;
  });
  const sheet = await page.evaluate(() => {
    const layer = document.querySelector('.sheet-scroller') as HTMLElement | null;
    const body = document.querySelector('.sheet-body') as HTMLElement | null;
    const box = (el: HTMLElement | null) =>
      el ? { top: Math.round(el.scrollTop), detentTop: Math.round(el.scrollHeight - el.clientHeight) } : null;
    return { layer: box(layer), body: box(body), sheetPresent: Boolean(layer) };
  });
  // One line per record: CI logs are what has to carry this back.
  console.log(`PROBE[${label}] state=${JSON.stringify(sheet)}`);
  for (const entry of probe) console.log(`PROBE[${label}] ${JSON.stringify(entry)}`);
}

test('probe: what moves the sheet layer while candidates are chosen', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await instrument(page);
  await page.goto('/');
  await inSeason(page);
  await page.reload();
  await page.getByTestId('tab-team').click();
  await expect(page.getByTestId('team-controls')).toBeVisible();

  /*
   * Several rounds, because the failure is one width in four and roughly one
   * run in three. A single pass would very likely come back clean and prove
   * nothing at all.
   */
  for (let round = 1; round <= 14; round++) {
    const tag = `${testInfo.project.name} r${round}`;
    await page.getByTestId('compare-open').click();
    await expect(page.getByTestId('compare-sheet')).toBeVisible();
    await dump(page, `${tag} opened`);

    const rows = page.getByTestId('compare-candidate');
    await expect(rows.first()).toBeVisible();
    await dump(page, `${tag} listed`);

    /*
     * The decisive comparison: does the layer move for a *real* click, or only
     * for the synthetic scrolling Playwright does before one?
     *
     *   - `locator.click()` scrolls the target into view first, through the
     *     protocol, which no page script can see.
     *   - `el.click()` inside the page dispatches the same event with no
     *     scrolling at all, and still focuses.
     *
     * If only the first moves the layer it is a test artefact. If both do, the
     * cause is focus and a reader's thumb reaches it too.
     */
    /*
     * Three ways in, because they exercise different machinery:
     *
     *   playwright   protocol scroll-into-view, then real input events
     *   click        the event only -- `HTMLElement.click()` does not focus
     *   focus+click  focus first, which is what a real tap does, and focus is
     *                allowed to scroll an element into view
     *
     * If only `playwright` moves the layer it is a harness artefact. If
     * `focus+click` moves it too, a thumb reaches it and so does a reader.
     */
    const modes = ['playwright', 'click', 'focus+click'] as const;
    const mode = modes[(round - 1) % modes.length]!;
    const layerTop = () =>
      page.evaluate(() => {
        const el = document.querySelector('.sheet-scroller') as HTMLElement | null;
        return el ? Math.round(el.scrollTop) : -1;
      });

    /*
     * Two candidates in quick succession, which is what the failing specs do
     * and what the earlier reproductions had in common. Choosing the first one
     * adds the selection chips and grows `.sheet-body` (966 -> 1018 observed),
     * so the second click lands into a card that is relaying out.
     */
    for (const nth of [0, 3]) {
      const row = rows.nth(nth);
      const id = await row.getAttribute('data-player-id').catch(() => null);
      const before = await layerTop();
      let failed = '';
      try {
        if (mode === 'playwright') await row.click({ timeout: 8_000 });
        else if (mode === 'click') await row.evaluate((el) => (el as HTMLElement).click());
        else await row.evaluate((el) => { (el as HTMLElement).focus(); (el as HTMLElement).click(); });
      } catch (err) {
        failed = String(err).split('\n')[0] ?? 'failed';
      }
      const after = await layerTop();
      console.log(
        `PROBE VERDICT mode=${mode} nth=${nth} id=${id} before=${before} after=${after} ` +
          `moved=${before !== after && after !== -1} gone=${after === -1}${failed ? ` FAILED=${failed}` : ''}`,
      );
    }
    await dump(page, `${tag} ${mode}`);

    const stillOpen = await page.getByTestId('compare-sheet').count();
    console.log(`PROBE[${tag}] sheetStillOpen=${stillOpen}`);
    if (stillOpen > 0) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(400);
    }
    await page.getByTestId('tab-team').click().catch(() => {});
    await page.waitForTimeout(200);
  }

  expect(true).toBe(true);
});
