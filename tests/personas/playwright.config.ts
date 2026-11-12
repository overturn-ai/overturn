import { defineConfig } from "@playwright/test";
import { personas } from "./personas";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  retries: 0,
  outputDir: "__screens__",
  reporter: [["list"], ["html", { open: "never", outputFolder: "__report__" }]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    // CI installs the browser; a sandbox with a preinstalled one points at it (same switch as apps/web e2e).
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: Object.entries(personas).map(([name, p]) => ({ name, use: p.use })),
});
