import path from "node:path";
import { fileURLToPath } from "node:url";
import { alias } from "./rsbuild.shared.mjs";
import { rspack } from "@rspack/core";
const directory = path.dirname(fileURLToPath(import.meta.url));
const shared = [
  "theme-boot.js",
  "icon-light.svg",
  "icon-dark.svg",
  "mobile-icons.svg",
  "apple-touch-icon.png",
  "manifest.webmanifest",
];
export default {
  context: directory,
  mode: "production",
  entry: { app: "./src/main.tsx", catalog: "./src/catalog.tsx" },
  output: {
    path: path.join(directory, "dist"),
    publicPath: "/",
    filename: "ui-assets/[name].[contenthash:16].js",
    assetModuleFilename: "ui-assets/[name].[contenthash:16][ext]",
    clean: true,
  },
  devtool: false,
  resolve: { alias, extensions: [".tsx", ".ts", ".js"] },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: {
          loader: "builtin:swc-loader",
          options: {
            jsc: {
              parser: { syntax: "typescript", tsx: true },
              transform: { react: { runtime: "automatic" } },
              target: "es2022",
            },
          },
        },
      },
      { test: /\.css$/, type: "css" },
      { test: /\.(svg|png)$/, type: "asset/resource" },
    ],
  },
  optimization: { splitChunks: false, runtimeChunk: false },
  plugins: [
    ...["app", "catalog"].map(
      (name) =>
        new rspack.HtmlRspackPlugin({
          filename: name === "app" ? "index.html" : "catalog.html",
          template: name === "catalog" ? "./src/catalog.html" : "./src/template.html",
          chunks: [name],
          scriptLoading: "defer",
        }),
    ),
    new rspack.CopyRspackPlugin({
      patterns: shared.map((file) => ({
        from: path.join(directory, "../src/xk_switcher/static", file),
        to: file,
      })),
    }),
  ],
  devServer: {
    host: "127.0.0.1",
    port: Number(process.env.UI_DEV_PORT || 8766),
    allowedHosts: ["127.0.0.1"],
    hot: false,
    liveReload: false,
    historyApiFallback: false,
    proxy: [
      {
        context: ["/api"],
        target: `http://127.0.0.1:${Number(process.env.UI_BACKEND_PORT || 8765)}`,
        changeOrigin: false,
      },
    ],
  },
};
