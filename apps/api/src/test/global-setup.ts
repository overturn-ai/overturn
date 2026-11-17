import postgres from "postgres";
import { runMigrations } from "../db/migrate";

export const DEFAULT_TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/overturn_test";

/** Creates the database named in `url` if it does not exist (needs a server the user can reach). */
export async function ensureDatabase(url: string): Promise<void> {
  const u = new URL(url);
  const dbName = u.pathname.replace(/^\//, "");
  u.pathname = "/postgres";
  const sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  try {
    // Several packages create their test databases at the same time in CI; Postgres refuses
    // concurrent CREATE DATABASE from the same template, so retry with a short backoff.
    for (let attempt = 0; ; attempt++) {
      const rows = await sql`select 1 from pg_database where datname = ${dbName}`;
      if (rows.length > 0) return;
      try {
        await sql.unsafe(`create database "${dbName}"`);
        return;
      } catch (err) {
        if (attempt >= 20) throw err;
        await new Promise((r) => setTimeout(r, 250 + Math.random() * 500));
      }
    }
  } finally {
    await sql.end();
  }
}

export async function prepareTestDatabase(url: string): Promise<void> {
  await ensureDatabase(url);
  await runMigrations(url);
}

/** Provider keys a developer may have exported; tests that need one set a fake one themselves. */
const REAL_MODEL_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
  "TOGETHER_API_KEY",
];

export default async function setup(): Promise<void> {
  // Runs before the workers start, so they inherit this env. Without it an exported
  // ANTHROPIC_API_KEY turns the default (Claude) judge into real, billed, non-deterministic calls.
  for (const key of REAL_MODEL_KEYS) delete process.env[key];
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  process.env.TEST_DATABASE_URL = url;
  await prepareTestDatabase(url);
}
