import type { CaptureCreate } from "@overturn-ai/shared";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type DraftState } from "./capture";
import {
  type GorgiasTicket,
  handleMessageCreated,
  recordDraft,
  snapshotFromTicket,
  widgetData,
} from "./main";

const draftText =
  "Hi Dana, Your order #1042 is on its way. The replacement will arrive within 5 business days, and the refund for the damaged item is already processing.";

const ticket: GorgiasTicket = {
  id: 90210,
  subject: "Damaged item in order #1042",
  customer: { email: "dana@example.com", name: "Dana" },
  assignee_user: { email: "ray@shop.com", name: "Ray" },
  messages: [
    {
      id: 1,
      body_text: "The mug arrived cracked. Photo attached.",
      body_html: "<p>The mug arrived cracked. Photo attached.</p>",
      from_agent: false,
      channel: "email",
      created_datetime: "2026-10-01T10:00:00Z",
      sender: { email: "dana@example.com", name: "Dana" },
    },
  ],
};

function makeDeps() {
  const store = new Map<string, DraftState | null>();
  const postCapture = vi.fn(async (body: CaptureCreate) => ({
    kind: body.draft.text === body.sent.text ? "approve" : "edit",
    changed: body.draft.text !== body.sent.text,
    deduplicated: false,
  }));
  const deps = {
    settings: DEFAULT_SETTINGS,
    postCapture,
    drafts: {
      get: async (id: string) => store.get(id) ?? null,
      set: async (id: string, d: DraftState | null) => {
        store.set(id, d);
      },
    },
  };
  return { deps, postCapture, store };
}

describe("snapshotFromTicket", () => {
  it("maps the API ticket into a snapshot, decision fields included", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      decisionFields: [{ id: "refund_amount", label: "refund" }],
    };
    const snap = snapshotFromTicket(
      { ...ticket, custom_fields: [{ id: "refund_amount", value: 24 }] },
      settings,
    );
    expect(snap.id).toBe(90210);
    expect(snap.customerEmail).toBe("dana@example.com");
    expect(snap.fields).toEqual({ refund: 24 });
    expect(snap.messages[0]?.fromAgent).toBe(false);
  });
});

describe("widgetData + recordDraft", () => {
  it("waits, then shows the spec's status line once a draft is recorded", async () => {
    const { deps } = makeDeps();
    expect(await widgetData(ticket, deps)).toEqual({
      status: "Waiting for a draft",
      state: "waiting",
      has_draft: false,
      draft_words: 0,
    });
    const draft = await recordDraft(ticket, { text: draftText, origin: "ai" }, deps);
    expect(draft?.origin).toBe("ai");
    const data = await widgetData(ticket, deps);
    expect(data.state).toBe("draft");
    expect(data.status).toBe(`Draft inserted · ${draftText.split(/\s+/).length} words`);
  });

  it("an unstated origin is stored as unknown, never guessed", async () => {
    const { deps } = makeDeps();
    const draft = await recordDraft(ticket, { text: draftText }, deps);
    expect(draft?.origin).toBe("unknown");
    expect((await widgetData(ticket, deps)).status).toBe(`Draft · ${draftText.split(/\s+/).length} words`);
  });

  it("short texts are not drafts", async () => {
    const { deps } = makeDeps();
    expect(await recordDraft(ticket, { text: "Thanks!" }, deps)).toBeNull();
  });
});

describe("handleMessageCreated", () => {
  const sentTicket = (body: string): GorgiasTicket => ({
    ...ticket,
    messages: [
      ...(ticket.messages ?? []),
      {
        id: 2,
        body_text: body,
        body_html: null,
        from_agent: true,
        channel: "email",
        sender: { email: "ray@shop.com", name: "Ray" },
      },
    ],
  });

  it("captures the send against the recorded draft and clears it", async () => {
    const { deps, postCapture } = makeDeps();
    await recordDraft(ticket, { text: draftText, origin: "ai" }, deps);
    const outcome = await handleMessageCreated(sentTicket(draftText), deps);
    expect(outcome).toEqual({ action: "captured", changed: false, kind: "approve" });
    expect(postCapture).toHaveBeenCalledTimes(1);
    const body = postCapture.mock.calls[0]![0];
    expect(body.source).toBe("gorgias");
    expect(body.externalId).toBe("gr:90210");
    expect(body.tags).toEqual(["draft:ai", "public-reply"]);
    expect(body.actor).toBe("ray@shop.com");
    // Draft cleared: a second send has nothing to capture against.
    expect(await handleMessageCreated(sentTicket(draftText), deps)).toEqual({
      action: "ignored",
      why: "no-draft",
    });
  });

  it("holds a changed capture until the reason arrives, then completes it", async () => {
    const { deps, postCapture } = makeDeps();
    await recordDraft(ticket, { text: draftText, origin: "ai" }, deps);
    const edited = draftText.replace("5 business days", "2 business days");
    expect(await handleMessageCreated(sentTicket(edited), deps)).toEqual({
      action: "need-reason",
      changedFields: [],
    });
    expect(postCapture).not.toHaveBeenCalled();
    const done = await handleMessageCreated(sentTicket(edited), deps, {
      reasonCode: "wrong_amount_or_date",
      reason: "Express replacement is 2 days",
    });
    expect(done).toEqual({ action: "captured", changed: true, kind: "edit" });
    expect(postCapture.mock.calls[0]![0].reasonCode).toBe("wrong_amount_or_date");
  });

  it("ignores customer messages, internal notes, and tickets with no draft", async () => {
    const { deps, postCapture } = makeDeps();
    await recordDraft(ticket, { text: draftText, origin: "ai" }, deps);
    // The base ticket's newest message is the customer's: not a send.
    expect(await handleMessageCreated(ticket, deps)).toEqual({ action: "ignored", why: "not-a-send" });
    const noted: GorgiasTicket = {
      ...ticket,
      messages: [
        ...(ticket.messages ?? []),
        { id: 2, body_text: "internal: checking stock", from_agent: true, channel: "internal-note" },
      ],
    };
    expect(await handleMessageCreated(noted, deps)).toEqual({ action: "ignored", why: "internal-note" });
    const { deps: fresh } = makeDeps();
    expect(await handleMessageCreated(sentTicket(draftText), fresh)).toEqual({
      action: "ignored",
      why: "no-draft",
    });
    expect(postCapture).not.toHaveBeenCalled();
  });

  it("a run the drafting agent recorded with the SDK is found by externalId", async () => {
    const { deps, postCapture } = makeDeps();
    const withFinder = {
      ...deps,
      findRecordedDraft: async (externalId: string) =>
        externalId === "gr:90210"
          ? {
              text: draftText,
              origin: "recorded" as const,
              runId: "0199a0d0-0000-7000-8000-000000000000",
              at: 1,
            }
          : null,
    };
    const outcome = await handleMessageCreated(sentTicket(draftText), withFinder);
    expect(outcome.action).toBe("captured");
    const body = postCapture.mock.calls[0]![0];
    expect(body.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
    expect(body.tags).toEqual(["draft:ai", "public-reply"]);
  });
});
