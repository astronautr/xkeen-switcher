import { useCallback, useEffect, useState } from "react";
import { browserPreferences, type Theme } from "../browser/preferences";
const COLORS = { light: "#f5f4ef", dark: "#141414" };
export function applyTheme(theme: Theme) {
  document.documentElement.classList.remove("theme-light", "theme-dark");
  if (theme !== "auto") document.documentElement.classList.add("theme-" + theme);
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    const scheme = theme === "auto" ? (meta.media.includes("dark") ? "dark" : "light") : theme;
    meta.content = COLORS[scheme];
  });
  document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]').forEach((link) => {
    const scheme = theme === "auto" ? (link.media.includes("dark") ? "dark" : "light") : theme;
    link.href = "/icon-" + scheme + ".svg";
  });
}
export function useTheme() {
  const [theme, setValue] = useState(() => browserPreferences.theme());
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const setTheme = useCallback((value: Theme) => {
    browserPreferences.setTheme(value);
    applyTheme(value);
    setValue(value);
  }, []);
  return { theme, setTheme };
}
