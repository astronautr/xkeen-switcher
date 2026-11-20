import { useEffect, useState } from "react";
import { browserPreferences } from "../../browser/preferences";
import { STORAGE_KEYS } from "../../browser/storage";
import { Button, IconButton } from "../../ui/Button";
import { titles, type Offer } from "./model";

const pair = ({ component, version }: Offer) => component + ":" + version;

export function RouterUpdateNotice({ available, open }: { available: Offer[]; open: () => void }) {
  const [dismissed, setDismissed] = useState(() => browserPreferences.dismissedRouterUpdates());
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === STORAGE_KEYS.dismissedRouterUpdates || event.key === null) {
        setDismissed(browserPreferences.dismissedRouterUpdates());
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const offers = available.filter(offer => !dismissed.includes(pair(offer)));
  if (!offers.length) return null;
  return <div role="status" className="banner router-update-notice" data-marker="router-update-notice">
    <div><strong>Router updates available</strong>
      <span>{offers.map(offer => titles[offer.component] + " " + offer.version).join(" · ")}</span>
    </div>
    <Button marker="router-updates-open" onClick={open}>view updates</Button>
    <IconButton marker="router-updates-dismiss" label="Dismiss these releases" icon="close" onClick={() => {
      setDismissed(browserPreferences.dismissRouterUpdates(offers.map(pair)));
    }} />
  </div>;
}
