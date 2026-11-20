import path from "node:path";
import base from "../../../rspack.config.mjs";
import { rspack } from "@rspack/core";
export default {
  ...base,
  mode: "development",
  entry: { auth: "./tests/features/auth/harness.tsx" },
  output: { ...base.output, path: path.join(base.context, "node_modules/.cache/xk-auth") },
  plugins: [
    new rspack.HtmlRspackPlugin({ filename: "index.html", template: "./src/template.html", chunks: ["auth"] }),
    base.plugins.at(-1),
  ],
};
