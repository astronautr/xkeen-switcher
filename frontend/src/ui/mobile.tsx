import { useSyncExternalStore } from "react";

const mobile = () => window.matchMedia("(max-width: 640px)");
function subscribe(listener: () => void) {
  const media = mobile();
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
export const useMobile = () => useSyncExternalStore(subscribe, () => mobile().matches);
export function MobileIcon({ name }: { name: string }) {
  return (
    <svg className="mobile-ui-icon" aria-hidden="true">
      <use href={"/mobile-icons.svg#ico-" + name} />
    </svg>
  );
}
