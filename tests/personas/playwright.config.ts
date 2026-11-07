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
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: Object.entries(personas).map(([name, p]) => ({ name, use: p.use })),
});
