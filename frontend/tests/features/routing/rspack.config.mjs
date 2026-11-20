import path from "node:path";
import { rspack } from "@rspack/core";
import base from "../../../rspack.config.mjs";
export default {
  ...base,
  mode: "development",
  entry: {
    routing: process.env.ROUTING_RED ? "./src/main.tsx" : "./tests/features/routing/harness.tsx",
  },
  output: { ...base.output, path: path.join(base.context, "node_modules/.cache/routing") },
  plugins: [
    new rspack.HtmlRspackPlugin({ template: "./src/template.html" }),
    new rspack.CopyRspackPlugin({
      patterns: [
        "theme-boot.js",
        "icon-light.svg",
        "icon-dark.svg",
        "mobile-icons.svg",
        "apple-touch-icon.png",
        "manifest.webmanifest",
      ].map((file) => ({
        from: path.join(base.context, "../src/xk_switcher/static", file),
        to: file,
      })),
    }),
  ],
  devServer: {
    ...(process.env.ROUTING_GATEWAY ? base.devServer : {}),
    host: "127.0.0.1",
    port: Number(process.env.ROUTING_PORT || 18791),
    hot: false,
    liveReload: false,
  },
};
