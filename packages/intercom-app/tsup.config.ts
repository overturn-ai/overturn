import { defineConfig } from "tsup";

// The Canvas Kit endpoints and the pure capture logic, bundled for a Node server.
export default defineConfig({
  entry: { index: "src/index.ts", capture: "src/capture.ts", bin: "src/bin.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: false,
  clean: true,
  minify: false,
  splitting: false,
  noExternal: ["@overturn-ai/shared"],
  outDir: "dist",
});
