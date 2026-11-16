import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import { describe, expect, it, vi } from "vitest";
import { type CaptureTransport, handleCanvasRequest } from "./app";
import { buildCanvas, type CanvasComponent, COMPONENT } from "./canvas";
import { DEFAULT_SETTINGS, type IntercomConversation } from "./capture";

const draftText =
  "Hi Dana, thanks for waiting. Your refund was approved and will land on your card within 5 business days.";

const conversation: IntercomConversation = {
  id: "conv_123",
  title: "Where is my refund?",
  source: {
    type: "conversation",
    body: "<p>Where is my refund?</p>",
    author: { type: "user", email: "dana@example.com" },
    created_at: 1_760_000_000,
  },
  conversation_parts: { conversation_parts: [] },
};

const result = {
  kind: "edit",
  changed: true,
  deduplicated: false,
  case: { title: "Refund timing" },
} as unknown as CaptureResult;

function textComponents(components: CanvasComponent[]): string[] {
  return components.flatMap((c) => (c.type === "text" ? [c.text] : []));
}

describe("Canvas Kit view", () => {
  it("shows the required draft line and a reason picker", () => {
    const canvas = buildCanvas({
      draft: { text: "one two three", origin: "ai", at: 1 },
      reasonCode: null,
      settings: DEFAULT_SETTINGS,
    });
    expect(textComponents(canvas.canvas.content.components)).toContain("Draft inserted · 3 words");
    const reason = canvas.canvas.content.components.find((c) => c.type === "dropdown");
    expect(reason?.type).toBe("dropdown");
    if (reason?.type === "dropdown") {
      expect(reason.id).toBe(COMPONENT.reason);
      expect(reason.options.map((o) => o.id)).toContain("wrong_answer");
    }
  });
});

describe("handleCanvasRequest", () => {
  it("takes an explicitly AI-authored draft from the initialize request", async () => {
    const capture = { capture: vi.fn() } satisfies CaptureTransport;
    const canvas = await handleCanvasRequest(
      { conversation, composer: { text: draftText, origin: "ai" } },
      { settings: DEFAULT_SETTINGS, capture },
    );
    expect(textComponents(canvas.canvas.content.components)).toContain("Draft inserted · 19 words");
    const stored = canvas.canvas.stored_data.draft as { origin: string };
    expect(stored.origin).toBe("ai");
    expect(capture.capture).not.toHaveBeenCalled();
  });

  it("shows unknown when nobody told the app who wrote the draft", async () => {
    const capture = { capture: vi.fn() } satisfies CaptureTransport;
    const canvas = await handleCanvasRequest(
      { conversation, composer: draftText },
      { settings: DEFAULT_SETTINGS, capture },
    );
    const stored = canvas.canvas.stored_data.draft as { origin: string };
    expect(stored.origin).toBe("unknown");
  });

  it("lets a teammate mark a pasted draft with an explicit origin", async () => {
    const capture = { capture: vi.fn() } satisfies CaptureTransport;
    const canvas = await handleCanvasRequest(
      {
        conversation,
        component_id: COMPONENT.markDraft,
        input_values: { [COMPONENT.draftText]: draftText, [COMPONENT.draftOrigin]: "manual" },
      },
      { settings: DEFAULT_SETTINGS, capture },
    );
    const stored = canvas.canvas.stored_data.draft as { origin: string };
    expect(stored.origin).toBe("manual");
  });

  it("honours require_reason without blocking Intercom's send", async () => {
    const capture = { capture: vi.fn() } satisfies CaptureTransport;
    const changed = draftText.replace("5 business days", "2 business days");
    const canvas = await handleCanvasRequest(
      {
        conversation,
        component_id: COMPONENT.capture,
        stored_data: { draft: { text: draftText, origin: "ai", at: 1 } },
        input_values: { [COMPONENT.sentText]: changed, [COMPONENT.note]: "SLA is two days" },
      },
      { settings: { ...DEFAULT_SETTINGS, requireReason: true }, capture },
    );
    expect(capture.capture).not.toHaveBeenCalled();
    expect(textComponents(canvas.canvas.content.components)).toContain(
      "Pick why you changed it before capturing this correction.",
    );
    // The canvas still renders normally, so nothing about Intercom's own send is held.
    expect(canvas.canvas.content.components.some((c) => c.type === "button")).toBe(true);
  });

  it("posts the captured send with the intercom source and the draft origin tag", async () => {
    const sent: CaptureCreate[] = [];
    const capture: CaptureTransport = {
      capture: vi.fn(async (body: CaptureCreate) => {
        sent.push(body);
        return result;
      }),
    };
    const changed = draftText.replace("5 business days", "2 business days");
    const canvas = await handleCanvasRequest(
      {
        conversation,
        component_id: COMPONENT.capture,
        stored_data: { draft: { text: draftText, origin: "manual", at: 1 } },
        input_values: {
          [COMPONENT.sentText]: changed,
          [COMPONENT.reason]: "wrong_amount_or_date",
          [COMPONENT.note]: "Refunds are two days now",
        },
      },
      { settings: DEFAULT_SETTINGS, capture },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.source).toBe("intercom");
    expect(sent[0]?.externalId).toBe("ic:conv_123");
    expect(sent[0]?.tags).toEqual(["draft:manual"]);
    expect(sent[0]?.reasonCode).toBe("wrong_amount_or_date");
    expect(textComponents(canvas.canvas.content.components)).toContain("✅ Captured · edit saved as a case");
  });

  it("never throws when the capture fails; it says so and gets out of the way", async () => {
    const logger = { error: vi.fn() };
    const capture: CaptureTransport = {
      capture: vi.fn(async () => {
        throw new Error("network down");
      }),
    };
    const canvas = await handleCanvasRequest(
      {
        conversation,
        component_id: COMPONENT.capture,
        stored_data: { draft: { text: draftText, origin: "ai", at: 1 } },
        input_values: { [COMPONENT.reason]: "wrong_answer" },
      },
      { settings: { ...DEFAULT_SETTINGS, requireReason: true }, capture, logger },
    );
    expect(logger.error).toHaveBeenCalled();
    expect(textComponents(canvas.canvas.content.components)).toContain(
      "Overturn could not save this correction. The send was not blocked.",
    );
  });

  it("reads state from current_canvas.stored_data on the next canvas", async () => {
    const sent: CaptureCreate[] = [];
    const capture: CaptureTransport = {
      capture: vi.fn(async (body: CaptureCreate) => {
        sent.push(body);
        return { ...result, changed: false, kind: "approve" } as unknown as CaptureResult;
      }),
    };
    await handleCanvasRequest(
      {
        conversation,
        component_id: COMPONENT.capture,
        current_canvas: { stored_data: { draft: { text: draftText, origin: "ai", at: 1 } } },
        input_values: {},
      },
      { settings: { ...DEFAULT_SETTINGS, requireReason: false }, capture },
    );
    expect(sent[0]?.sent.text).toBe(draftText);
    expect(sent[0]?.tags).toEqual(["draft:ai"]);
  });
});
