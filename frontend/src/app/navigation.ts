import { useCallback, useRef, useSyncExternalStore } from "react";

type RouteGuard = (event: Event) => boolean;
let routeGuard: RouteGuard | undefined;

/** Register the mounted editor before the shell can publish a traversal. */
export function registerHashRouteGuard(guard: RouteGuard) {
  routeGuard = guard;
  return () => {
    if (routeGuard === guard) routeGuard = undefined;
  };
}

/** Only publish admitted navigation. During native traversal location.hash can
 * already be the destination while a dirty screen is still restoring history. */
export function useHashRoute() {
  const admitted = useRef(location.hash);
  const subscribe = useCallback((listener: () => void) => {
    function publish(event?: Event) {
      if (event && routeGuard && !routeGuard(event)) return;
      admitted.current = location.hash;
      listener();
    }
    window.addEventListener("hashchange", publish);
    window.addEventListener("popstate", publish);
    publish();
    return () => {
      window.removeEventListener("hashchange", publish);
      window.removeEventListener("popstate", publish);
    };
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => admitted.current,
    () => "",
  );
}
/** Routing owns its guard and xkRouting index. Never discard unrelated history keys. */
export function navigateHash(
  hash: string,
  { replace = false, state = {} }: { replace?: boolean; state?: Record<string, unknown> } = {},
) {
  const next = hash && hash[0] !== "#" ? "#" + hash : hash;
  history[replace ? "replaceState" : "pushState"](
    { ...history.state, ...state },
    "",
    location.pathname + location.search + next,
  );
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
export function isRoutingHash(hash: string) {
  return hash === "#routing" || hash.startsWith("#routing/");
}

/** Mark both sides of the first Routing transition for engines without the Navigation API. */
export function openRouting() {
  const previous = history.state?.xkRouting;
  const index = Number.isInteger(previous?.index) ? previous.index : -1;
  history.replaceState({ ...history.state, xkRouting: { ...previous, index } }, "");
  navigateHash("routing", {
    state: { xkRouting: { index: index + 1, parentIndex: index, parentHash: location.hash } },
  });
}
