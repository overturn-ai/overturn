/**
 * Which PostHog project a page reports to. Preview and localhost traffic must never land in
 * the production project unless someone sets NEXT_PUBLIC_POSTHOG_KEY on purpose.
 */
import { describe, expect, it } from "vitest";
import { POSTHOG_PROD_KEY, posthogKey } from "../components/analytics/posthog-key";

describe("posthogKey", () => {
  it("uses the env key when set, on any host", () => {
    expect(posthogKey("app.overturn.run", "phc_override")).toBe("phc_override");
    expect(posthogKey("localhost", "phc_override")).toBe("phc_override");
    expect(posthogKey(undefined, "phc_override")).toBe("phc_override");
  });

  it("gives the production host the production key", () => {
    expect(posthogKey("app.overturn.run", undefined)).toBe(POSTHOG_PROD_KEY);
    expect(posthogKey("www.app.overturn.run", undefined)).toBe(POSTHOG_PROD_KEY);
  });

  it("treats an empty env value as unset", () => {
    expect(posthogKey("app.overturn.run", "")).toBe(POSTHOG_PROD_KEY);
    expect(posthogKey("localhost", "")).toBeUndefined();
  });

  it("gives localhost and preview hosts no key", () => {
    expect(posthogKey("localhost", undefined)).toBeUndefined();
    expect(posthogKey("127.0.0.1", undefined)).toBeUndefined();
    expect(posthogKey("overturn-web-pr-12.up.railway.app", undefined)).toBeUndefined();
    expect(posthogKey("app.overturn.run.evil.example", undefined)).toBeUndefined();
  });

  it("gives no key when there is no hostname (server render)", () => {
    expect(posthogKey(undefined, undefined)).toBeUndefined();
  });
});
