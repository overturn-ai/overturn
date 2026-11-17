import { defineConfig } from "tsup";

// Canvas Kit is a server-side webhook protocol, not an iframe/browser SDK.
export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  clean: true,
  sourcemap: false,
  noExternal: ["@overturn-ai/shared"],
  outDir: "dist",
});
