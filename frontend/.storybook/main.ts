import type { StorybookConfig } from "storybook-react-rsbuild";
import { alias } from "../rsbuild.shared.mjs";
const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx"],
  framework: { name: "storybook-react-rsbuild", options: { strictMode: true } },
  staticDirs: [{ from: "../../src/xk_switcher/static", to: "/" }],
  rsbuildFinal: (config) => ({
    ...config,
    source: { ...config.source, alias: { ...config.source?.alias, ...alias } },
  }),
};
export default config;
