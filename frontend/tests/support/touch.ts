import type { Locator } from "@playwright/test";

type Move = [type: string, y: number, x?: number, options?: { fingers?: number; cancelable?: boolean }];

// Firefox desktop and WebKit do not expose a constructible Touch object.
// Dispatch the same coordinates and touch lists to each engine's DOM listeners.
export async function touchSequence(target: Locator, moves: Move[]) {
  return target.evaluate((node, events) => {
    return events.map(([type, y, x = 80, options = {}]) => {
      const finger = { identifier: 1, target: node, clientX: x, clientY: y };
      const released = type === "touchend" || type === "touchcancel";
      const touches = Array.from({ length: options.fingers ?? (released ? 0 : 1) },
        (_, index) => ({ ...finger, identifier: index + 1 }));
      const event = Object.assign(new Event(type, { bubbles: true, cancelable: options.cancelable ?? true }), {
        touches,
        changedTouches: [finger],
      });
      node.dispatchEvent(event);
      return event.defaultPrevented;
    });
  }, moves);
}
