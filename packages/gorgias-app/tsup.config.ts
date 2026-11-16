import { defineConfig } from "tsup";

// Server-side HTTP-integration handlers: a plain Node module the host server imports
// and mounts on the endpoint the Gorgias integration calls — no browser bundle.
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
