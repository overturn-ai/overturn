import { defineConfig } from "tsup";
export default defineConfig({
  entry: { main: "src/main.ts", background: "src/background.ts", options: "src/options.ts" },
  format: ["iife"], platform: "browser", target: "es2020", minify: true, clean: true,
  noExternal: ["@overturn-ai/shared"], outDir: "dist",
});
