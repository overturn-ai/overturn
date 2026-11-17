import { defineConfig } from "tsup";

// One self-contained script for the Front sidebar page: no module loader, no externals.
// The Zendesk app's capture logic and the Front plugin SDK are bundled in.
export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["iife"],
  globalName: "OverturnFront",
  platform: "browser",
  target: "es2020",
  sourcemap: false,
  clean: true,
  minify: true,
  noExternal: ["@overturn-ai/shared", "@overturn-ai/zendesk-app", "@frontapp/plugin-sdk"],
  outDir: "dist",
});
