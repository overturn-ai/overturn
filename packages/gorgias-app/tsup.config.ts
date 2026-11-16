import { defineConfig } from "tsup";

// One self-contained widget bundle for the Gorgias iframe: no module loader, no externals.
export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["iife"],
  globalName: "OverturnGorgias",
  platform: "browser",
  target: "es2020",
  sourcemap: false,
  clean: true,
  minify: true,
  noExternal: ["@overturn-ai/shared"],
  outDir: "dist",
});
