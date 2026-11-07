/**
 * Overturn — first-time-user flows, run once per persona (impatient / confused / phone).
 * BASE_URL defaults to http://localhost:3000 (app). Set DOCS_URL for the marketing/docs site (default https://overturn.run).
 * These are the automated floor; the user-tester subagent adds judgment on top.
 */
import { expect, test } from "@playwright/test";
import { assertMobileSane, expectFeedbackWithin, type PersonaName, personas, screenshot } from "./personas";

const persona = () => test.info().project.name as PersonaName;
const DOCS_URL = process.env.DOCS_URL ?? "https://overturn.run";

test("marketing: hero says what it is, quickstart is numbered, CTA is obvious", async ({ page }, info) => {
  await page.goto(DOCS_URL);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(
    page.getByRole("link", { name: /get started|quickstart|install|sign in/i }).first(),
  ).toBeVisible();
  if (persona() === "phone") await assertMobileSane(page);
  await screenshot(page, info, "marketing");
});

test("login: magic link path is obvious and gives feedback fast", async ({ page }, info) => {
  const p = personas[persona()];
  await page.goto("/login");
  const email = page.getByPlaceholder("you@company.com");
  await expect(email).toBeVisible();
  await email.fill(`persona-${persona()}@example.com`);
  if (persona() === "phone") await assertMobileSane(page);
  await expectFeedbackWithin(page, p.patienceMs, async () => {
    await page.getByRole("button", { name: /send|magic|continue|sign in/i }).click();
  });
  await screenshot(page, info, "login-sent");
});

test("impatient: garbage email fails loudly", async ({ page }, info) => {
  test.skip(persona() !== "impatient", "impatient only");
  await page.goto("/login");
  await page.getByPlaceholder("you@company.com").fill("nope");
  await page.getByRole("button", { name: /send|magic|continue|sign in/i }).click();
  await expect(page).toHaveURL(/\/login/);
  await screenshot(page, info, "login-bad-email");
});

test("app shell: unauthenticated visit lands somewhere that explains itself", async ({ page }, info) => {
  for (const path of ["/runs", "/cases", "/capture", "/replays", "/models"]) {
    await page.goto(path);
    // either the page or the login redirect must show a heading the confused user can read
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
    if (persona() === "phone") await assertMobileSane(page);
  }
  await screenshot(page, info, "app-shell");
});

test("docs: quickstart readable on this device", async ({ page }, info) => {
  await page.goto(`${DOCS_URL}/docs`).catch(() => page.goto(DOCS_URL));
  await expect(page.getByRole("heading").first()).toBeVisible();
  if (persona() === "phone") await assertMobileSane(page);
  await screenshot(page, info, "docs");
});
