import * as Sentry from "@sentry/node";

const PROD_DSN =
  "https://fe08aff88b3e93aa88e8eaadad395759@o4511968691421184.ingest.us.sentry.io/4512387898212352";

/**
 * Sentry for the API. Must run before any other import that we want instrumented, so main.ts calls it first.
 * No-op outside Railway production unless SENTRY_DSN is set. Request bodies, headers and cookies are stripped:
 * runs and corrections are customer content and never leave the box.
 */
export function initSentry(): void {
  const dsn =
    process.env.SENTRY_DSN || (process.env.RAILWAY_ENVIRONMENT_NAME === "production" ? PROD_DSN : undefined);
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "development",
    release: process.env.RAILWAY_GIT_COMMIT_SHA,
    tracesSampleRate: 0.1,
    beforeSend(event) {
      if (event.request) {
        event.request.data = undefined;
        event.request.headers = undefined;
        event.request.cookies = undefined;
      }
      return event;
    },
  });
}
