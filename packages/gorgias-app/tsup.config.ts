import { defineConfig } from "tsup";

// One self-contained Node script: the HTTP integration + widget endpoint Gorgias calls.
export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: false,
  clean: true,
  minify: false,
  noExternal: ["@overturn-ai/shared"],
  outDir: "dist",
});
