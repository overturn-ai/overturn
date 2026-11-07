/** Vitest global setup: a dedicated test database so this package can run in parallel with the others. */
const api = await import("../../../apps/api/dist/test/global-setup.js");

export default async function setup(): Promise<void> {
  const url = (process.env.TEST_DATABASE_URL ?? api.DEFAULT_TEST_DATABASE_URL).replace(
    /\/([^/]+)$/,
    "/$1_claims",
  );
  process.env.TEST_DATABASE_URL = url;
  await api.prepareTestDatabase(url);
}
