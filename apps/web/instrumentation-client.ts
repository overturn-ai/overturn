import * as Sentry from "@sentry/nextjs";

// DSNs are public client keys. Production default below; set NEXT_PUBLIC_SENTRY_DSN to override or capture from previews.
const PROD_HOSTS = ["app.overturn.run"];
const dsn =
  process.env.NEXT_PUBLIC_SENTRY_DSN ||
  (PROD_HOSTS.includes(window.location.hostname)
    ? "https://06449ec05ae1139cc2c96eefdac9a958@o4511968691421184.ingest.us.sentry.io/4512387898146816"
    : undefined);
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV,
    tracesSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0,
    integrations: [Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true })],
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
