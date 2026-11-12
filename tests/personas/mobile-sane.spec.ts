/**
 * The phone tap-target check itself. Runs on page.setContent, so it needs no deployment.
 * Rule: WCAG 2.5.5 target size (44px) with its own exceptions — links inside a sentence,
 * and controls the user cannot see (skip links, a closed menu) are not tap targets.
 */
import { expect, test } from "@playwright/test";
import { assertMobileSane } from "./personas";

test.beforeEach(() => test.skip(test.info().project.name !== "phone", "phone only"));

test("mobile check: a small standalone button fails", async ({ page }) => {
  await page.setContent(`<button style="width:8px;height:8px;padding:0;border:0">x</button>`);
  await expect(assertMobileSane(page)).rejects.toThrow(/tap targets under 44px/);
});

test("mobile check: a link inside a sentence, a skip link and a closed menu pass", async ({ page }) => {
  await page.setContent(`
    <a href="#main" style="position:fixed;clip:rect(0 0 0 0);width:120px;height:28px">Skip to content</a>
    <nav style="visibility:hidden"><a href="/a" style="display:block;height:20px">Hidden nav</a></nav>
    <p>Read the <a href="/q">quickstart</a> first.</p>
    <a href="/big" style="display:block;height:48px">Big enough</a>`);
  await assertMobileSane(page);
});
