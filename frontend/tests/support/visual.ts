import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { expectExactScreenshot } from './exact-screenshot';
const OVERLAP = 128;
const manifest = JSON.parse(
  readFileSync(new URL('../visual/baselines/capture-layout.json', import.meta.url), 'utf8'),
);
type Plane = {
  selector: string;
  height: number;
  clientHeight: number;
  width: number;
  offsets: number[];
};
function offsets(height: number, visible: number) {
  const last = Math.max(0, height - visible),
    step = visible - OVERLAP;
  if (last && step <= 0)
    throw new Error('Capture scroll root is too short for the required overlap');
  const result = [0];
  for (let y = step; last && y < last; y += step) result.push(y);
  if (last) result.push(last);
  return result;
}
/** Ordinary viewport screenshots only. The legacy manifest fixes framing for both targets. */
export async function expectVisualTiles(page: Page, filename: string) {
  await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.decode()));
    // Match Playwright's disabled-animation policy before measuring the manifest.
    // Otherwise a toast's entering transform can temporarily enlarge a clipped stack.
    for (const animation of document.getAnimations()) {
      const endTime = animation.effect?.getComputedTiming().endTime;
      if (typeof endTime === 'number' && Number.isFinite(endTime)) animation.finish();
    }
  });
  await page.clock.runFor(16); // Flush finite-animation completion callbacks before layout.
  const initial = await page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect(),
        s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !el.closest('[inert]');
    };
    const selector = (el: Element) =>
      el.getAttribute('data-marker')
        ? `[data-marker="${el.getAttribute('data-marker')}"]`
        : el.id
          ? `#${CSS.escape(el.id)}`
          : '.' + [...el.classList].map(CSS.escape).join('.');
    const popovers = [...document.querySelectorAll(':popover-open')].filter(visible);
    const modals = [...document.querySelectorAll('dialog:modal')].filter(visible);
    const drawer = document.querySelector('[data-marker="settings-drawer"]');
    const overlay = modals.at(-1) || (drawer && visible(drawer) ? drawer : null);
    const scope = overlay ? selector(overlay) : 'document';
    const documentSize = {
      width: document.documentElement.scrollWidth,
      height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    };
    const controls = [
      ...(overlay || document).querySelectorAll(
        'button,input,select,textarea,a[href],[role="button"],[role="option"],[role="menuitem"]',
      ),
    ].filter(visible);

    // Only the active document/modal/drawer plane is tiled. Popovers do not replace the underlying plane.
    const known = overlay
      ? [...overlay.querySelectorAll('.drawer-body,.panel-body,.history-content')].filter(visible)
      : [];
    const active =
      known.find((el) => /auto|scroll/.test(getComputedStyle(el).overflowY)) ||
      (overlay &&
      /auto|scroll/.test(getComputedStyle(overlay).overflowY) &&
      overlay.scrollHeight > overlay.clientHeight + 1
        ? overlay
        : null);
    if (active) {
      const r = active.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth)
        throw new Error('Active scroll plane must fit entirely within the fixed viewport');
    }
    const planeSelector = active
      ? active === overlay
        ? scope
        : scope + ' ' + selector(active)
      : null;
    if (planeSelector && document.querySelectorAll(planeSelector).length !== 1)
      throw new Error('Capture scroll plane selector is not unique');
    const planes = overlay
      ? active
        ? [
            {
              selector: planeSelector!,
              height: active.scrollHeight,
              clientHeight: active.clientHeight,
              width: active.clientWidth,
            },
          ]
        : []
      : [
          {
            selector: 'document',
            height: documentSize.height,
            clientHeight: innerHeight,
            width: documentSize.width,
          },
        ];
    const clipped = [...(overlay || document).querySelectorAll('*')].filter(
      (el) =>
        visible(el) &&
        el !== active &&
        el !== document.body &&
        el !== document.documentElement &&
        /auto|scroll|hidden/.test(getComputedStyle(el).overflowY) &&
        el.scrollHeight > el.clientHeight + 1,
    );
    const clips = clipped.map((el) => ({
      key: el.getAttribute('data-marker') || el.id || el.className || el.tagName,
      height: el.scrollHeight,
      clientHeight: el.clientHeight,
      width: el.clientWidth,
      scrollTop: el.scrollTop,
    }));
    const controlKeys = controls.flatMap((el, i) => {
      const r = el.getBoundingClientRect();
      return clipped.some(
        (parent) =>
          parent !== el &&
          parent.contains(el) &&
          getComputedStyle(el).position !== 'fixed' &&
          (r.top < parent.getBoundingClientRect().top ||
            r.bottom > parent.getBoundingClientRect().bottom),
      )
        ? []
        : [`${el.getAttribute('data-marker') || el.id || el.tagName}:${i}`];
    });
    return {
      scope,
      popovers: popovers.map(selector),
      document: documentSize,
      documentOffset: { x: scrollX, y: scrollY },
      viewport: { width: innerWidth, height: innerHeight },
      planes,
      controlKeys,
      clips,
    };
  });
  const planes: Plane[] = initial.planes.map((plane) => ({
    ...plane,
    offsets: offsets(plane.height, plane.clientHeight),
  }));
  const sequence = planes.length
    ? planes.flatMap((plane, index) => plane.offsets.map((y) => ({ plane: index, y })))
    : [{ plane: -1, y: 0 }];
  const layout = {
    schemaVersion: 1,
    scope: initial.scope,
    popovers: initial.popovers,
    document: initial.document,
    documentOffset: initial.documentOffset,
    preservedClips: initial.clips,
    viewport: initial.viewport,
    overlap: OVERLAP,
    planes,
    tileCount: sequence.length,
    sequence,
  };
  expect(layout, `Legacy capture geometry for ${filename}`).toEqual(manifest[filename]);
  expect(initial.documentOffset).toEqual({ x: 0, y: 0 });
  const covered = new Set<string>();
  const stateFingerprint = () =>
    page.evaluate(() =>
      JSON.stringify({
        dialogs: [...document.querySelectorAll('dialog[open]')].map((el) =>
          el.getAttribute('data-marker'),
        ),
        popovers: [...document.querySelectorAll(':popover-open')].map((el) =>
          el.getAttribute('data-marker'),
        ),
        phases: [...document.querySelectorAll('[data-phase]')].map((el) =>
          el.getAttribute('data-phase'),
        ),
        toasts: [...document.querySelectorAll('[data-marker="toast"]')].map((el) => el.textContent),
      }),
    );
  const state = await stateFingerprint();
  for (let i = 0; i < sequence.length; i++) {
    const tile = sequence[i]!,
      plane = planes[tile.plane];
    if (plane)
      await page.evaluate(
        ({ selector, y }) => {
          if (selector === 'document') window.scrollTo({ top: y, left: 0, behavior: 'instant' });
          else {
            if (document.querySelectorAll(selector).length !== 1)
              throw new Error('Capture scroll plane must remain unique');
            (document.querySelector(selector) as HTMLElement).scrollTo({
              top: y,
              left: 0,
              behavior: 'instant',
            });
          }
        },
        { selector: plane.selector, y: tile.y },
      );
    await page.clock.runFor(32);
    const observed = await page.evaluate(
      ({ scope, selector }) => {
        const root = scope === 'document' ? document : document.querySelector(scope)!;
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect(),
            s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !el.closest('[inert]');
        };
        const controls = [
          ...root.querySelectorAll(
            'button,input,select,textarea,a[href],[role="button"],[role="option"],[role="menuitem"]',
          ),
        ].filter(visible);
        const complete = controls.flatMap((el, i) => {
          const r = el.getBoundingClientRect();
          let top = 0,
            bottom = innerHeight;
          if (getComputedStyle(el).position !== 'fixed')
            for (
              let parent = el.parentElement;
              parent && parent !== document.body;
              parent = parent.parentElement
            ) {
              const style = getComputedStyle(parent);
              if (/auto|scroll|hidden/.test(style.overflowY)) {
                const box = parent.getBoundingClientRect();
                top = Math.max(top, box.top);
                bottom = Math.min(bottom, box.bottom);
              }
              if (style.position === 'fixed') break;
            }
          return r.top >= top && r.bottom <= bottom && r.left >= 0 && r.right <= innerWidth
            ? [`${el.getAttribute('data-marker') || el.id || el.tagName}:${i}`]
            : [];
        });
        const scroll =
          selector && selector !== 'document' ? document.querySelector(selector) : null;
        const clips = [...root.querySelectorAll('*')]
          .filter(
            (el) =>
              visible(el) &&
              el !== scroll &&
              el !== document.body &&
              el !== document.documentElement &&
              /auto|scroll|hidden/.test(getComputedStyle(el).overflowY) &&
              el.scrollHeight > el.clientHeight + 1,
          )
          .map((el) => ({
            key: el.getAttribute('data-marker') || el.id || el.className || el.tagName,
            height: el.scrollHeight,
            clientHeight: el.clientHeight,
            width: el.clientWidth,
            scrollTop: el.scrollTop,
          }));
        return {
          clips,
          document: {
            width: document.documentElement.scrollWidth,
            height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
          },
          viewport: { width: innerWidth, height: innerHeight },
          documentOffset: { x: scrollX, y: scrollY },
          offset: scroll ? scroll.scrollTop : window.scrollY,
          plane: scroll
            ? {
                height: scroll.scrollHeight,
                clientHeight: scroll.clientHeight,
                width: scroll.clientWidth,
              }
            : null,
          complete,
        };
      },
      { scope: initial.scope, selector: plane?.selector || null },
    );
    expect(observed.document, 'Document dimensions must not change while tiling').toEqual(
      initial.document,
    );
    expect(observed.viewport).toEqual(initial.viewport);
    expect(observed.clips, 'Existing independently clipped content must remain unchanged').toEqual(
      initial.clips,
    );
    if (plane?.selector !== 'document')
      expect(
        observed.documentOffset,
        'Overlay capture must not scroll the occluded background',
      ).toEqual(initial.documentOffset);
    if (plane) {
      expect(observed.offset, 'Actual public scroll offset').toBe(tile.y);
      if (observed.plane)
        expect(observed.plane).toEqual({
          height: plane.height,
          clientHeight: plane.clientHeight,
          width: plane.width,
        });
    }
    expect(await stateFingerprint(), 'Scrolling must preserve the scenario state').toBe(state);
    observed.complete.forEach((key) => covered.add(key));
    const name = filename.replace(/\.png$/, `-tile-${String(i + 1).padStart(2, '0')}.png`);
    await expectExactScreenshot(page, name);
  }
  for (const plane of planes) {
    expect(plane.offsets[0]).toBe(0);
    expect(plane.offsets.at(-1)! + plane.clientHeight).toBeGreaterThanOrEqual(plane.height);
    for (let i = 1; i < plane.offsets.length; i++)
      expect(plane.offsets[i]).toBeLessThanOrEqual(
        plane.offsets[i - 1]! + plane.clientHeight - OVERLAP,
      );
  }
  expect(
    initial.controlKeys.filter((key) => !covered.has(key)),
    'Every visible primary/control must fit in a covering tile',
  ).toEqual([]);
}
