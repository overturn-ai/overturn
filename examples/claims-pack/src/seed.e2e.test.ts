/**
 * End to end: the demo data -> SDK -> real API -> Postgres -> the scorecard a buyer reads.
 * Needs TEST_DATABASE_URL (defaults to the local overturn_test database) and the API built.
 */
import { Overturn } from "@overturn-ai/sdk";
import {
  type Case,
  CLAIMS_DECISION_FIELDS,
  CLAIMS_REASON_CODES,
  type Page,
  SUITE_EXCLUDED_REASON_CODES,
} from "@overturn-ai/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captures, DEMO_TAG } from "./data.js";
import { seed } from "./seed.js";

// The API is CommonJS; import its test harness through the built output.
const harness = await import("../../../apps/api/dist/test/harness.js");

let ctx: Awaited<ReturnType<typeof harness.startTestApp>>;
let ov: Overturn;

beforeAll(async () => {
  ctx = await harness.startTestApp();
  ov = new Overturn({ apiKey: ctx.apiKey, baseUrl: ctx.baseUrl });
});
afterAll(async () => {
  await ctx.close();
});

describe("the demo data", () => {
  it("is 30 captures with unique threads, every reason code used and every fix explained", () => {
    expect(captures).toHaveLength(30);
    expect(new Set(captures.map((c) => c.externalId)).size).toBe(30);
    const used = new Set(captures.map((c) => c.reasonCode).filter(Boolean));
    expect([...used].sort()).toEqual(CLAIMS_REASON_CODES.map((r) => r.code).sort());
    for (const c of captures) {
      const edited =
        c.sent.text !== c.draft.text || JSON.stringify(c.sent.fields) !== JSON.stringify(c.draft.fields);
      expect(Boolean(c.reasonCode), c.externalId).toBe(edited);
      expect(c.tags, c.externalId).toContain(DEMO_TAG);
      expect(c.metadata?.synthetic, c.externalId).toBe(true);
    }
  });
});

describe("seeding a fresh project", () => {
  it("fills every part of the scorecard", async () => {
    const result = await seed(ov);
    expect(result).toEqual({ created: 30, skipped: 0 });

    const stats = await ov.api.corrections.captureStats({ days: 30 });
    expect(stats.captures).toBe(30);
    expect(stats.untouched).toBe(18);
    expect(stats.edited).toBe(12);
    expect(stats.untouchedRate).toBeCloseTo(0.6);
    expect(stats.experts).toBe(4);
    expect(stats.bySource).toEqual([{ source: "zendesk", count: 30 }]);
    expect(stats.byAgent.map((a) => a.agent).sort()).toEqual(["claims-reply", "coverage-decision"]);
    expect(stats.timeToSend.timed).toBe(18);
    expect(stats.byReason.map((r) => r.reason).sort()).toEqual(CLAIMS_REASON_CODES.map((r) => r.code).sort());
    expect(stats.byReason.filter((r) => r.excluded).map((r) => r.reason)).toEqual([
      ...SUITE_EXCLUDED_REASON_CODES,
    ]);
    // Credit stays off by default: the demo must not teach a per-person view.
    expect(stats.byExpert).toEqual([]);
  });

  it("makes a suite: tone fixes stay out, decision fields are scored exactly and prose is not", async () => {
    const active = await harness.api<Page<Case>>(ctx, "GET", "/v1/cases?limit=100");
    expect(active.body.items).toHaveLength(29);
    const archived = await harness.api<Page<Case>>(ctx, "GET", "/v1/cases?limit=100&status=archived");
    expect(archived.body.items).toHaveLength(1);

    const decisions = active.body.items.filter((c) => c.agent === "coverage-decision");
    expect(decisions.length).toBeGreaterThan(0);
    for (const c of decisions) {
      expect(c.scorer, c.title).toBe("json_match");
      const fields = (c.scorerConfig as { fields: string[] }).fields;
      expect([...fields].sort(), c.title).toEqual([...CLAIMS_DECISION_FIELDS].sort());
    }
  });

  it("is safe to run twice: the scorecard does not move", async () => {
    expect(await seed(ov)).toEqual({ created: 0, skipped: 30 });
    expect((await ov.api.corrections.captureStats({ days: 30 })).captures).toBe(30);
  });

  it("refuses a project that already has real captures", async () => {
    await ctx.close();
    ctx = await harness.startTestApp();
    const fresh = new Overturn({ apiKey: ctx.apiKey, baseUrl: ctx.baseUrl });
    await fresh.capture({
      source: "zendesk",
      externalId: "zd:real-1",
      agent: "claims-reply",
      context: [],
      draft: { text: "A real draft." },
      sent: { text: "A real draft." },
    });
    await expect(seed(fresh)).rejects.toThrow(/already has captures/);
    expect((await fresh.api.corrections.captureStats({ days: 30 })).captures).toBe(1);
  });
});
