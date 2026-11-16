import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    main: "src/main.ts",
    capture: "src/capture.ts",
  },
  format: ["esm", "cjs"],
  platform: "node",
  target: "es2022",
  sourcemap: false,
  clean: true,
  minify: false,
  splitting: false,
  dts: true,
  noExternal: ["@overturn-ai/shared"],
  outDir: "dist",
});
