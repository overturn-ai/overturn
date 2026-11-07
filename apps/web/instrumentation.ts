import * as Sentry from "@sentry/nextjs";

export async function register() {
  // Production default (Railway production env only); SENTRY_DSN overrides.
  const dsn =
    process.env.SENTRY_DSN ||
    (process.env.RAILWAY_ENVIRONMENT_NAME === "production"
      ? "https://06449ec05ae1139cc2c96eefdac9a958@o4511968691421184.ingest.us.sentry.io/4512387898146816"
      : undefined);
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV,
    tracesSampleRate: 0.2,
  });
}

export const onRequestError = Sentry.captureRequestError;
