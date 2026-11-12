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
    const MIN = 44;
    const els = Array.from(document.querySelectorAll<HTMLElement>("a,button,[role=button],input,select"));
    const hidden = (e: HTMLElement) => {
      if (!e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true;
      const cs = getComputedStyle(e);
      // Screen-reader-only and skip links: clipped to nothing until focused.
      if (cs.clipPath !== "none" || cs.clip !== "auto") return true;
      const r = e.getBoundingClientRect();
      return r.width <= 1 || r.height <= 1 || r.right <= 0 || r.bottom + window.scrollY <= 0;
    };
    // WCAG 2.5.8 exempts links inside a sentence: their size is set by the line of text they sit in.
    const inlineInText = (e: HTMLElement) => {
      if (e.tagName !== "A" || getComputedStyle(e).display !== "inline") return false;
      const p = e.parentElement;
      if (!p) return false;
      return Array.from(p.childNodes).some(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 0,
      );
    };
    return els
      .filter((e) => {
        if (hidden(e) || inlineInText(e)) return false;
        const r = e.getBoundingClientRect();
        return r.width < MIN || r.height < MIN;
      })
      .map((e) => {
        const r = e.getBoundingClientRect();
        return `${Math.round(r.width)}x${Math.round(r.height)} ${e.outerHTML.replace(/\s+/g, " ").slice(0, 70)}`;
      });
  });
  if (small.length)
    throw new Error(`${small.length} tap targets under 44px: ${small.slice(0, 12).join(" | ")}`);
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
