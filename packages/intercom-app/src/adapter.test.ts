import { describe, expect, it } from "vitest";
import { createAdapter, type BridgeConversation } from "./adapter.js";

const settings = { overturn_base_url: "https://api.overturn.run", require_reason: true };
const conversation: BridgeConversation = { id: "123", subject: "Question", messages: [{ role: "customer", content: "Hello" }] };
const adapter = () => createAdapter({ apiKey: "secret", bridgeToken: "bridge-secret", clientSecret: "intercom-secret", settings, postCapture: async () => ({ ok: true }) });

describe("Canvas adapter", () => {
  it("registers an explicit assist, shows word count, and captures after send", async () => {
    const app = adapter();
    expect((await app.draft({ conversation, text: "A suggested reply", origin: "fin_assist" }, "bridge-secret")).ok).toBe(true);
    const canvas = app.canvas("123");
    expect(JSON.stringify(canvas)).toContain("Draft inserted · 3 words");
    const calls: unknown[] = [];
    const withPost = createAdapter({ apiKey: "secret", bridgeToken: "bridge-secret", clientSecret: "intercom-secret", settings, postCapture: async (body) => { calls.push(body); return { ok: true }; } });
    await withPost.draft({ conversation, text: "A suggested reply", origin: "fin_assist" }, "bridge-secret");
    expect((await withPost.sent({ conversation, text: "A suggested reply" }, "bridge-secret")).ok).toBe(true);
    expect(calls).toMatchObject([{ source: "intercom", externalId: "ic:123", tags: ["draft:ai"] }]);
    expect(JSON.stringify(withPost.canvas("123"))).toContain("Waiting for a draft");
  });
  it("keeps native send independent when a required reason is missing or capture fails", async () => {
    const app = createAdapter({ apiKey: "secret", bridgeToken: "bridge-secret", clientSecret: "intercom-secret", settings, postCapture: async () => { throw Error("offline"); } });
    await app.draft({ conversation, text: "AI reply", origin: "fin_assist" }, "bridge-secret");
    expect((await app.sent({ conversation, text: "Edited reply" }, "bridge-secret"))).toMatchObject({ ok: true, status: "reason-required" });
    expect(JSON.stringify(app.canvas("123"))).toContain("Select a reason");
    await app.submit({ conversation, component_id: "save_reason", input_values: { reason_code: "wrong_answer", reason_note: "Bad answer" } });
    expect((await app.sent({ conversation, text: "Edited reply" }, "bridge-secret"))).toMatchObject({ ok: true, status: "capture-failed" });
  });
  it("captures the already-sent edited reply after the teammate saves a required reason", async () => {
    const captures: unknown[] = [];
    const app = createAdapter({ apiKey: "secret", bridgeToken: "bridge-secret", clientSecret: "intercom-secret", settings, postCapture: async (body) => { captures.push(body); return { ok: true }; } });
    await app.draft({ conversation, text: "AI reply", origin: "fin_assist" }, "bridge-secret");
    expect((await app.sent({ conversation, text: "Corrected reply" }, "bridge-secret")).status).toBe("reason-required");
    await app.submit({ conversation, component_id: "save_reason", input_values: { reason_code: "wrong_answer" } });
    expect(captures).toMatchObject([{ sent: { text: "Corrected reply" }, reasonCode: "wrong_answer" }]);
    expect(JSON.stringify(app.canvas("123"))).toContain("Waiting for a draft");
  });
  it("rejects unauthorized bridge updates", async () => {
    const app = adapter();
    expect((await app.draft({ conversation, text: "hello", origin: "fin_assist" }, "bad")).ok).toBe(false);
    expect((await app.sent({ conversation, text: "hello" }, "bad")).ok).toBe(false);
    expect(JSON.stringify(app.canvas("123"))).toContain("Waiting for a draft");
  });
});
