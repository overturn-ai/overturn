import { defineConfig } from "tsup";

// Two bundles: the endpoint Gorgias calls and renders the sidebar widget from (main), and the
// integration/widget builders scripts/install.mjs and scripts/package.mjs import.
export default defineConfig({
  entry: { main: "src/main.ts", install: "src/install.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: false,
  clean: true,
  minify: false,
  noExternal: ["@overturn-ai/shared"],
  outDir: "dist",
});
