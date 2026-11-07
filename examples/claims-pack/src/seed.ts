/**
 * Fills a project with the demo tenant: 30 synthetic claims captures, through the public API.
 *
 *   OVERTURN_API_KEY=ov_live_... pnpm --filter @overturn-ai/example-claims-pack seed
 *
 * Safe to rerun, including after an interrupted run. Refuses a project with captures from the
 * last year that are not from this demo, because these rows would land in that team's scorecard
 * and suite.
 */
import { pathToFileURL } from "node:url";
import { Overturn } from "@overturn-ai/sdk";
import { captures } from "./data.js";

export interface SeedResult {
  created: number;
  skipped: number;
}

export async function seed(ov: Overturn): Promise<SeedResult> {
  const missing: typeof captures = [];
  for (const c of captures) {
    const found = await ov.api.runs.list({ externalId: c.externalId, limit: 1 });
    if (found.items.length === 0) missing.push(c);
  }
  const skipped = captures.length - missing.length;

  const { captures: existing } = await ov.api.corrections.captureStats({ days: 365 });
  // Each demo thread holds one capture, so anything beyond those belongs to the team.
  if (existing > skipped) {
    throw new Error(
      `This project already has captures that are not from this demo (${existing - skipped}). Seed a fresh project instead.`,
    );
  }

  for (const c of missing) await ov.capture(c);
  return { created: missing.length, skipped };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const ov = new Overturn();
  if (!ov.apiKey) {
    console.error("Set OVERTURN_API_KEY to a key from a fresh project (Settings → API keys).");
    process.exit(1);
  }
  seed(ov).then(
    ({ created, skipped }) => {
      console.log(`Seeded ${created} captures, ${skipped} already there. Open Capture in the app.`);
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
