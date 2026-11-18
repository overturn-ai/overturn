import { defineConfig } from "tsup";

// The Gorgias app answers the HTTP integration Gorgias calls, so the bundle is a server
// build: one ESM file with the routes, the payload builder and the two API clients.
export default defineConfig({
  entry: { index: "src/server.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: false,
  clean: true,
  minify: false,
  noExternal: ["@overturn-ai/shared"],
  outDir: "dist",
});
