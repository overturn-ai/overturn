import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  transpilePackages: ["@overturn-ai/shared"],
};

// Sentry is a no-op until SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN are set; source maps upload only with SENTRY_AUTH_TOKEN.
export default withSentryConfig(config, {
  org: process.env.SENTRY_ORG ?? "fluorine-nf",
  project: process.env.SENTRY_PROJECT ?? "overturn-web",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  telemetry: false,
});
