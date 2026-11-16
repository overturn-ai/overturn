import { defineConfig } from "tsup";

// One self-contained Node script: the Canvas Kit server has nothing to install at runtime.
export default defineConfig({
  entry: { server: "src/server.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: false,
  clean: true,
  noExternal: ["@overturn-ai/shared"],
  outDir: "dist",
});
