import { loadDotEnv } from "./env";
import { initSentry } from "./sentry";

loadDotEnv();
initSentry();

// biome-ignore lint/correctness/noUnusedImports: order matters — Sentry must initialise before the app modules load
import { startApp } from "./app";
import { loadConfig } from "./config";

startApp(loadConfig()).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
