import { defineConfig } from "tsup";

// Self-contained ES modules: the handler runs anywhere with web fetch, server.js is its Node
// entry, setup.js builds the Gorgias integration and widget JSON. No externals but node:*.
export default defineConfig({
  entry: { handler: "src/handler.ts", server: "src/server.ts", setup: "src/setup.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: false,
  clean: true,
  splitting: false,
  noExternal: ["@overturn-ai/shared"],
  outDir: "dist",
});
