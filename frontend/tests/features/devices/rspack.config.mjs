import path from "node:path";
import { rspack } from "@rspack/core";
import base from "../../../rspack.config.mjs";
export default {
  ...base,
  mode: "development",
  entry: {
    devices: process.env.DEVICES_RED ? "./src/main.tsx" : "./tests/features/devices/harness.tsx",
  },
  output: { ...base.output, path: path.join(base.context, "node_modules/.cache/devices") },
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
    ...(process.env.DEVICES_GATEWAY ? base.devServer : {}),
    host: "127.0.0.1",
    port: 18785,
    hot: false,
    liveReload: false,
  },
};
