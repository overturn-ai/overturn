import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: false,
  clean: true,
  minify: true,
  noExternal: ["@overturn-ai/shared"],
  outDir: "dist",
});
