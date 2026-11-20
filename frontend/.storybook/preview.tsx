import type { Preview } from "@storybook/react";
import "../src/styles";
const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Preview theme",
      toolbar: { items: ["light", "dark"], dynamicTitle: true },
    },
  },
  initialGlobals: { theme: "light" },
  decorators: [
    (Story, context) => {
      document.documentElement.classList.remove("theme-light", "theme-dark");
      document.documentElement.classList.add("theme-" + context.globals.theme);
      return (
        <main className="styleguide">
          <Story />
        </main>
      );
    },
  ],
  parameters: { layout: "fullscreen" },
};
export default preview;
