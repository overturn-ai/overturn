import { describe, expect, it } from "vitest";
import { parseRedactSpec, redactString, redactValue } from "./redact";

const all = { presets: ["email", "phone", "ssn", "card"] as const, patterns: [] };

describe("redact", () => {
  it("replaces identifiers with typed markers", () => {
    const s = "Dana (dana@example.com, 555-123-4567, SSN 123-45-6789, card 4111 1111 1111 1111) called.";
    expect(redactString(s, { presets: [...all.presets], patterns: [] })).toBe(
      "Dana ([EMAIL], [PHONE], SSN [SSN], card [CARD]) called.",
    );
  });
  it("leaves claim numbers, dates and amounts alone", () => {
    const s = "Claim 48213 opened 2026-10-03, reserve $6,500, policy HO-3.";
    expect(redactString(s, { presets: [...all.presets], patterns: [] })).toBe(s);
  });
  it("applies custom patterns and skips invalid ones", () => {
    expect(redactString("policy HO3-99812 and HO3-1", { presets: [], patterns: ["HO3-\\d+", "("] })).toBe(
      "policy [REDACTED] and [REDACTED]",
    );
  });
  it("walks nested values and keeps keys and non-strings", () => {
    const row = {
      messages: [{ role: "user", content: "from dana@example.com" }],
      meta: { caseId: "c1", n: 3 },
    };
    expect(redactValue(row, { presets: ["email"], patterns: [] })).toEqual({
      messages: [{ role: "user", content: "from [EMAIL]" }],
      meta: { caseId: "c1", n: 3 },
    });
    expect(redactValue(row, { presets: [], patterns: [] })).toBe(row);
  });
  it("parses the query form with a fallback and none", () => {
    const fb = { presets: ["email" as const], patterns: [] };
    expect(parseRedactSpec(undefined, fb)).toBe(fb);
    expect(parseRedactSpec("none", fb)).toEqual({ presets: [], patterns: [] });
    expect(parseRedactSpec("phone, ssn, custom:HO3-\\d+, bogus", fb)).toEqual({
      presets: ["phone", "ssn"],
      patterns: ["HO3-\\d+"],
    });
  });
});
