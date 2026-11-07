import { loadDotEnv } from "./env";
import { initSentry } from "./sentry";

loadDotEnv();
initSentry();

import { startApp } from "./app";
import { loadConfig } from "./config";

startApp(loadConfig()).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
