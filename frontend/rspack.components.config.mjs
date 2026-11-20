import path from "node:path";
import { rspack } from "@rspack/core";
import base from "./rspack.config.mjs";
export default {
  ...base,
  mode: "development",
  entry: { components: "./tests/components/harness.tsx", catalog: "./src/catalog.tsx" },
  output: { ...base.output, path: path.join(base.context, "node_modules/.cache/xk-components") },
  plugins: [
    new rspack.HtmlRspackPlugin({
      filename: "components.html",
      template: "./src/template.html",
      chunks: ["components"],
    }),
    new rspack.HtmlRspackPlugin({
      filename: "catalog.html",
      template: "./src/catalog.html",
      chunks: ["catalog"],
    }),
    new rspack.CopyRspackPlugin({
      patterns: [
        "theme-boot.js",
        "icon-light.svg",
        "icon-dark.svg",
        "mobile-icons.svg",
        "manifest.webmanifest",
        "apple-touch-icon.png",
      ].map((file) => ({
        from: path.join(base.context, "../src/xk_switcher/static", file),
        to: file,
      })),
    }),
  ],
  devServer: {
    host: "127.0.0.1",
    port: Number(process.env.UI_COMPONENT_PORT || 8768),
    hot: false,
    liveReload: false,
    historyApiFallback: false,
  },
};
