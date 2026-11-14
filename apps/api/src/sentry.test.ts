import { describe, expect, it } from "vitest";
import { scrubErrorMessage } from "./sentry";

describe("scrubErrorMessage", () => {
  it("drops the bound parameters Drizzle appends to a failed query", () => {
    const msg = 'Failed query: select "id" from "users" where "email" = $1\nparams: dana@example.com,42';
    const out = scrubErrorMessage(msg);
    expect(out).toContain('where "email" = $1');
    expect(out).not.toContain("dana@example.com");
    expect(out).toContain("params: [redacted]");
  });

  it("drops the row values Postgres names in a constraint error", () => {
    const out = scrubErrorMessage("duplicate key: Key (email)=(dana@example.com) already exists.");
    expect(out).toBe("duplicate key: Key (email)=([redacted]) already exists.");
  });

  it("leaves an ordinary message alone", () => {
    expect(scrubErrorMessage("fetch failed")).toBe("fetch failed");
  });
});
