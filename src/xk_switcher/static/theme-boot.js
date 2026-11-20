/* Runs before CSS and app.js: apply the saved theme, browser chrome colour and icons
   so an explicit choice never flashes the system theme first. */
(function () {
  "use strict";
  var COLORS = { light: "#f5f4ef", dark: "#141414" };
  var theme = null;
  try { theme = window.localStorage.getItem("xk_theme"); } catch (_) { theme = null; }
  if (theme !== "light" && theme !== "dark") return;
  document.documentElement.classList.add("theme-" + theme);
  document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
    meta.setAttribute("content", COLORS[theme]);
  });
  document.querySelectorAll('link[rel="icon"]').forEach(function (link) {
    link.setAttribute("href", "/icon-" + theme + ".svg");
  });
})();
