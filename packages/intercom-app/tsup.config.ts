import { defineConfig } from "tsup";

// Server-side Canvas Kit handlers: a plain Node module the host server imports and
// mounts on the initialize / submit webhook URLs — no browser bundle.
export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["esm", "cjs"],
  platform: "node",
  target: "es2022",
  sourcemap: false,
  clean: true,
  minify: false,
  noExternal: ["@overturn-ai/shared"],
  outDir: "dist",
});
