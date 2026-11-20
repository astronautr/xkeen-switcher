import type { ReactNode } from "react";
import { OverlayProvider } from "../ui/overlays";
import { isRoutingHash, useHashRoute } from "./navigation";
import { useTheme } from "./theme";
export type AppSlots = {
  header?: ReactNode;
  main?: ReactNode;
  routing?: (hash: string) => ReactNode;
  gate?: ReactNode;
  settings?: ReactNode;
  overlays?: ReactNode;
};
/** Session/provider ownership remains above navigation. Features own all screen decisions. */
export function App({ header, main, routing, gate, settings, overlays }: AppSlots) {
  const hash = useHashRoute();
  useTheme();
  return (
    <OverlayProvider overlay={overlays}>
      <div data-marker="react-shell">
        {gate ?? (
          <>
            {header}
            {isRoutingHash(hash) ? routing?.(hash) : main}
            {settings}
          </>
        )}
      </div>
    </OverlayProvider>
  );
}
