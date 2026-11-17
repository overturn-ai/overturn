import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    main: "src/capture.ts",
  },
  format: ["esm"],
  platform: "neutral",
  target: "es2022",
  dts: true,
  sourcemap: false,
  clean: true,
  outDir: "dist",
});
