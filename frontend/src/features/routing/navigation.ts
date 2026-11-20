import { useLayoutEffect, useRef } from "react";
import { navigateHash, registerHashRouteGuard } from "../../app/navigation";

function browserEntryIndex(): number | undefined {
  const browser = window as Window & { navigation?: { currentEntry?: { index: number } } };
  return browser.navigation?.currentEntry?.index;
}

export function useRoutingNavigation(
  hash: string,
  dirty: boolean,
  busy: boolean,
  ask: (leave: () => void) => void,
  clear: () => void,
) {
  const current = useRef({ hash, dirty, busy, ask, clear });
  current.current = { hash, dirty, busy, ask, clear };
  const approved = useRef(false);
  function visit(target: string, replace = false) {
    const parent = history.state?.xkRouting;
    const index = parent?.index ?? 0;
    approved.current = true;
    navigateHash(target, {
      replace,
      state: { xkRouting: replace ? parent : { index: index + 1, parentHash: hash, parentIndex: index } },
    });
    approved.current = false;
  }
  function guard(action: () => void) {
    if (busy) return;
    if (dirty)
      ask(() => {
        clear();
        action();
      });
    else action();
  }
  useLayoutEffect(() => {
    if (!Number.isInteger(history.state?.xkRouting?.index)) {
      history.replaceState({ ...history.state, xkRouting: { ...history.state?.xkRouting, index: 0 } }, "");
    }
    const originalState = history.state;
    const index = originalState.xkRouting.index;
    const entry = browserEntryIndex();
    let rollingBack = false;
    let destination = 0;
    function intercept(event: Event) {
      const state = current.current;
      if (rollingBack) {
        event.stopImmediatePropagation();
        if (location.hash === hash) {
          rollingBack = false;
          if (!state.busy)
            state.ask(() => {
              state.clear();
              approved.current = true;
              history.go(destination);
            });
        }
        return false;
      }
      if (location.hash === hash) return true;
      if (approved.current || (!state.dirty && !state.busy)) return true;
      event.stopImmediatePropagation();
      const nextIndex = history.state?.xkRouting?.index;
      const nextEntry = browserEntryIndex();
      const distance =
        entry !== undefined && nextEntry !== undefined
          ? nextEntry - entry
          : Number.isInteger(nextIndex)
            ? nextIndex - index
            : 0;
      if (distance) {
        destination = distance;
        rollingBack = true;
        history.go(-destination);
      } else {
        const target = location.hash;
        history.replaceState(
          originalState,
          "",
          hash,
        );
        if (!state.busy)
          state.ask(() => {
            state.clear();
            visit(target);
          });
      }
      return false;
    }
    function beforeUnload(event: BeforeUnloadEvent) {
      if (current.current.dirty) event.preventDefault();
    }
    approved.current = false;
    const unregister = registerHashRouteGuard(intercept);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      unregister();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [hash]);
  function closePanel() {
    const entry = history.state?.xkRouting;
    guard(() => {
      clear();
      if (entry?.parentHash === "#routing" && entry.parentIndex === entry.index - 1) {
        approved.current = true;
        history.back();
      } else visit("#routing", true);
    });
  }
  return { visit, guard, closePanel };
}
