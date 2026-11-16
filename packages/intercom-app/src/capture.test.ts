import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formCanvas } from "./canvas";
import {
  type AppSettings,
  type ConversationSnapshot,
  contextFrom,
  DEFAULT_SETTINGS,
  type DraftState,
  decideOnSend,
  draftOriginFrom,
  draftTags,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";
import { conversationFrom, handle, validSignature } from "./server";

const draftText =
  "<p>Hi Dana,</p><p>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

const conversation: ConversationSnapshot = {
  id: "215",
  subject: "Roof leak after storm",
  contactEmail: "dana@example.com",
  contactName: "Dana",
  parts: [
    {
      id: "1",
      body: "<div>Water came through the ceiling.<br>Photos attached.</div>",
      partType: "comment",
      authorType: "user",
      authorEmail: "dana@example.com",
      createdAt: "2026-10-01T10:00:00.000Z",
    },
    { id: "2", body: "HO-3, no prior claims.", partType: "note", authorType: "admin", authorName: "Ray" },
    { id: "3", body: "<p>   </p>", partType: "comment", authorType: "bot" },
  ],
  url: "https://app.intercom.com/a/inbox/x/conversation/215",
};

const draft = (over: Partial<DraftState> = {}): DraftState => ({
  text: draftText,
  origin: "ai",
  at: 1_000_000,
  ...over,
});

const base = {
  conversation,
  draft: draft(),
  send: { text: draftText, type: "comment" },
  reasonCode: null,
  reason: "",
  actor: "ray@carrier.com",
  settings: DEFAULT_SETTINGS,
  now: 1_012_300,
};

describe("settings", () => {
  it("defaults to the support pack and requires a reason", () => {
    const s = settingsFrom({});
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(s.reasonPack).toBe("support");
    expect(s.requireReason).toBe(true);
  });
  it("parses strings and trims the base url", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      agent: "claims-reply",
      require_reason: "false",
      capture_internal_notes: "1",
      reason_pack: "claims",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.agent).toBe("claims-reply");
    expect(s.requireReason).toBe(false);
    expect(s.captureInternalNotes).toBe(true);
    expect(s.reasonPack).toBe("claims");
  });
  it("quick reasons follow the pack", () => {
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("wrong_answer");
    expect(quickReasons(settingsFrom({ reason_pack: "claims" })).map((r) => r.code)).toContain(
      "reserve_too_low",
    );
  });
});

describe("context", () => {
  it("maps roles, strips html and drops empty parts", () => {
    expect(contextFrom(conversation)).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Water came through the ceiling.\nPhotos attached.",
        at: "2026-10-01T10:00:00.000Z",
      },
      { role: "note", author: "Ray", content: "HO-3, no prior claims.", at: null },
    ]);
  });
  it("decodes entities once", () => {
    expect(stripHtml("<p>Tom &amp;amp; Jerry &lt;3&nbsp;you</p>")).toBe("Tom &amp; Jerry <3 you");
  });
});

describe("draft origin", () => {
  it("only an origin we were told becomes a tag", () => {
    expect(draftTags("ai")).toEqual(["draft:ai"]);
    expect(draftTags("manual")).toEqual(["draft:manual"]);
    expect(draftTags("unknown")).toEqual([]);
  });
  it("anything unrecognised is unknown", () => {
    expect(draftOriginFrom("ai")).toBe("ai");
    expect(draftOriginFrom("manual")).toBe("manual");
    expect(draftOriginFrom(undefined)).toBe("unknown");
    expect(draftOriginFrom("fin")).toBe("unknown");
  });
  it("status line counts words", () => {
    expect(statusLine(null)).toBe("Waiting for a draft");
    expect(statusLine(draft({ text: "one two three" }))).toBe("Draft inserted · 3 words");
  });
});

describe("decideOnSend", () => {
  it("builds the intercom payload for an edit", () => {
    const d = decideOnSend({
      ...base,
      send: { text: draftText.replace("5 business", "2 business"), type: "comment" },
      reasonCode: "wrong_answer",
      reason: " 2-day SLA for storm claims ",
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.changed).toBe(true);
    expect(d.body).toMatchObject({
      source: "intercom",
      externalId: "ic:215",
      agent: "support-reply",
      actor: "ray@carrier.com",
      subject: "Roof leak after storm",
      reason: "2-day SLA for storm claims",
      reasonCode: "wrong_answer",
      secondsToSend: 12.3,
      url: conversation.url,
      tags: ["draft:ai", "public-reply"],
      metadata: { requester: "dana@example.com" },
    });
    expect(d.body.draft.text).toContain("within 5 business days");
    expect(d.body.sent.text).toContain("within 2 business days");
    expect(d.body.context).toHaveLength(2);
  });
  it("sent as drafted is an approve with no reason code", () => {
    const d = decideOnSend({ ...base, reasonCode: "wrong_answer" });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.changed).toBe(false);
    expect(d.body.reasonCode).toBeNull();
  });
  it("tags a hand-written draft draft:manual and an unknown one with no draft tag", () => {
    const tags = (origin: DraftState["origin"]) => {
      const d = decideOnSend({ ...base, draft: draft({ origin }) });
      if (d.action !== "capture") throw new Error(d.action);
      return d.body.tags;
    };
    expect(tags("manual")).toEqual(["draft:manual", "public-reply"]);
    expect(tags("unknown")).toEqual(["public-reply"]);
  });
  it("carries the recorded run", () => {
    const d = decideOnSend({
      ...base,
      draft: draft({ runId: "0b9d7a54-5d4c-4f1e-9d0c-111111111111", model: "gpt-4.1" }),
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.draftRunId).toBe("0b9d7a54-5d4c-4f1e-9d0c-111111111111");
    expect(d.body.draftModel).toBe("gpt-4.1");
  });
  const edited = { text: "<p>Totally different reply.</p>", type: "comment" };
  it("a changed reply needs a reason when require_reason is on", () => {
    expect(decideOnSend({ ...base, send: edited }).action).toBe("need-reason");
  });
  it("a changed reply goes through when require_reason is off", () => {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, requireReason: false };
    expect(decideOnSend({ ...base, send: edited, settings }).action).toBe("capture");
  });
  it("skips with no draft, an empty reply and internal notes", () => {
    expect(decideOnSend({ ...base, draft: null })).toEqual({ action: "skip", why: "no-draft" });
    expect(decideOnSend({ ...base, send: { text: "<p> </p>", type: "comment" } })).toEqual({
      action: "skip",
      why: "empty",
    });
    expect(decideOnSend({ ...base, send: { text: "fyi", type: "note" } })).toEqual({
      action: "skip",
      why: "internal-note",
    });
  });
  it("captures internal notes when asked", () => {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, captureInternalNotes: true, requireReason: false };
    const d = decideOnSend({ ...base, send: { text: "fyi", type: "note" }, settings });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.tags).toContain("internal-note");
  });
});

describe("canvas", () => {
  it("shows the draft status and the reasons of the installed pack", () => {
    const { canvas } = formCanvas({
      settings: settingsFrom({ reason_pack: "claims" }),
      form: { draftText: "one two", origin: "unknown", reasonCode: null, note: "", draftAt: 5 },
    });
    const parts = canvas.content.components;
    expect(parts[0]).toMatchObject({ text: "Draft inserted · 2 words" });
    const select = parts.find((c) => c.type === "single-select" && c.id === "reason_code");
    expect(select?.type === "single-select" && select.options.map((o) => o.id)).toContain("reserve_too_low");
    expect(canvas.stored_data).toEqual({ draftAt: 5 });
  });
});

describe("conversationFrom", () => {
  it("maps the intercom conversation", () => {
    const c = conversationFrom(
      {
        created_at: 1_790_000_000,
        source: {
          body: "<p>Help</p>",
          subject: "Hi",
          url: "https://x/y",
          author: { type: "user", name: "Dana" },
        },
        contacts: { contacts: [{ email: "dana@example.com", name: "Dana" }] },
        conversation_parts: {
          conversation_parts: [
            {
              id: "9",
              part_type: "comment",
              body: "Sure",
              created_at: 1_790_000_100,
              author: { type: "admin", email: "ray@c.com" },
            },
            { id: "10", part_type: "assignment", body: null, author: { type: "admin" } },
          ],
        },
      },
      "215",
    );
    expect(c.contactEmail).toBe("dana@example.com");
    expect(c.subject).toBe("Hi");
    expect(c.parts.map((p) => p.authorType)).toEqual(["user", "admin"]);
  });
});

describe("server", () => {
  const secret = "shh";
  const sign = (raw: string) => createHmac("sha256", secret).update(raw).digest("hex");
  const config = {
    settings: DEFAULT_SETTINGS,
    clientSecret: secret,
    intercomToken: "ic-token",
    overturnApiKey: "ov-key",
  };
  const intercomConversation = {
    created_at: 1_790_000_000,
    source: { body: "Water came through the ceiling.", subject: "Roof", author: { type: "user" } },
    contacts: { contacts: [{ email: "dana@example.com" }] },
    conversation_parts: {
      conversation_parts: [
        { id: "9", part_type: "comment", body: "Final reply", author: { type: "admin", email: "ray@c.com" } },
      ],
    },
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const submit = (extra: Record<string, unknown> = {}) => {
    const rawBody = JSON.stringify({
      component_id: "capture",
      conversation: { id: 215 },
      admin: { email: "ray@c.com" },
      input_values: { draft_text: "The AI draft", draft_origin: "ai", reason_code: "wrong_answer", ...extra },
      current_canvas: { stored_data: { draftAt: 1000 } },
    });
    return { method: "POST", path: "/submit", rawBody, signature: sign(rawBody) };
  };

  it("checks the signature", () => {
    expect(validSignature("{}", sign("{}"), secret)).toBe(true);
    expect(validSignature("{}", "nope", secret)).toBe(false);
    expect(validSignature("{}", undefined, secret)).toBe(false);
    expect(validSignature("{}", sign("{}"), "")).toBe(false);
  });
  it("rejects a bad signature with 401", async () => {
    const r = await handle(
      { method: "POST", path: "/submit", rawBody: "{}", signature: "bad" },
      { config, fetch },
    );
    expect(r.status).toBe(401);
  });
  it("initialize prefills a recorded draft and marks it ai", async () => {
    const rawBody = JSON.stringify({ conversation: { id: "215" } });
    const fetcher = (async () =>
      json({ items: [{ id: "run1", output: "Recorded draft", model: "gpt-4.1" }] })) as typeof fetch;
    const r = await handle(
      { method: "POST", path: "/initialize", rawBody, signature: sign(rawBody) },
      { config, fetch: fetcher, now: () => 7 },
    );
    const body = JSON.stringify(r.body);
    expect(r.status).toBe(200);
    expect(body).toContain("Recorded draft");
    expect(body).toContain('"value":"ai"');
    expect(body).toContain('"runId":"run1"');
  });
  it("initialize without a recorded run leaves the origin unknown", async () => {
    const rawBody = JSON.stringify({ conversation: { id: "215" } });
    const fetcher = (async () => json({ items: [] })) as typeof fetch;
    const r = await handle(
      { method: "POST", path: "/initialize", rawBody, signature: sign(rawBody) },
      { config, fetch: fetcher },
    );
    expect(JSON.stringify(r.body)).toContain('"value":"unknown"');
  });
  it("submit posts the capture with the bearer key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.startsWith("https://api.intercom.io/")) return json(intercomConversation);
      return json({ kind: "edit", changed: true, deduplicated: false, case: { title: "Wrong answer" } });
    }) as unknown as typeof fetch;
    const r = await handle(submit(), { config, fetch: fetcher, now: () => 3000 });
    expect(r.status).toBe(200);
    const post = calls.find((c) => c.url.endsWith("/v1/capture"));
    expect(post?.init?.headers).toMatchObject({ Authorization: "Bearer ov-key" });
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      source: "intercom",
      externalId: "ic:215",
      sent: { text: "Final reply" },
      draft: { text: "The AI draft" },
      tags: ["draft:ai", "public-reply"],
      secondsToSend: 2,
    });
    expect(JSON.stringify(r.body)).toContain("Case: Wrong answer");
  });
  it("asks for a reason instead of capturing when require_reason is on", async () => {
    const fetcher = (async () => json(intercomConversation)) as unknown as typeof fetch;
    const r = await handle(submit({ reason_code: "" }), { config, fetch: fetcher });
    expect(JSON.stringify(r.body)).toContain("Pick why");
  });
  it("never blocks: a failing network still answers 200 with an error canvas", async () => {
    const fetcher = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const r = await handle(submit(), { config, fetch: fetcher });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain("could not save");
  });
  it("a failing Overturn answers 200 and keeps the form", async () => {
    const fetcher = (async (url: string) =>
      url.startsWith("https://api.intercom.io/")
        ? json(intercomConversation)
        : json({}, 500)) as unknown as typeof fetch;
    const r = await handle(submit(), { config, fetch: fetcher });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain("(500)");
    expect(JSON.stringify(r.body)).toContain("The AI draft");
  });
});
