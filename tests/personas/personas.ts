import { devices, type Page, type TestInfo } from "@playwright/test";

/** The three first-time users. Flows live in flows.ts per repo. */
export const personas = {
  impatient: {
    use: { viewport: { width: 1440, height: 900 } },
    /** The impatient user gives any step this long before leaving. */
    patienceMs: 3000,
    readsCopy: false,
  },
  confused: {
    use: { viewport: { width: 1440, height: 900 } },
    patienceMs: 15000,
    readsCopy: true,
  },
  phone: {
    // iPhone viewport/UA but on Chromium: CI only installs chromium, and the layout checks are what matter.
    use: { ...devices["iPhone 14"], defaultBrowserType: "chromium" },
    patienceMs: 6000,
    readsCopy: false,
  },
} as const;

export type PersonaName = keyof typeof personas;

export async function screenshot(page: Page, info: TestInfo, label: string) {
  const file = info.outputPath(`${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await info.attach(label, { path: file, contentType: "image/png" });
}

/** Phone-specific checks every screen must pass. */
export async function assertMobileSane(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) throw new Error("horizontal scroll on phone");
  const small = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("a,button,[role=button],input,select"));
    return els
      .filter((e) => {
        const r = (e as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44);
      })
      .slice(0, 5)
      .map((e) => (e as HTMLElement).outerHTML.slice(0, 80));
  });
  if (small.length) throw new Error(`tap targets under 44px: ${small.join(" | ")}`);
}

/** Impatient: a step must give feedback within patienceMs. */
export async function expectFeedbackWithin(page: Page, ms: number, action: () => Promise<void>) {
  const before = await page.content();
  await action();
  const start = Date.now();
  while (Date.now() - start < ms) {
    if ((await page.content()) !== before) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`no visible feedback within ${ms}ms`);
}
