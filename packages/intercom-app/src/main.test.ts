import { describe, expect, it, vi } from "vitest";
import { handleCanvasRequest, handleRequest, handleWebhookEvent } from "./main.js";

describe("handleCanvasRequest", () => {
  it("initializes canvas with 'Waiting for a draft' when no draft exists", async () => {
    const res = await handleCanvasRequest({
      workspace_id: "ws_123",
      conversation: { id: "ic_100" },
    });
    const first = res.canvas.content.components[0];
    expect(first?.type).toBe("text");
    if (first?.type === "text") {
      expect(first.text).toBe("Waiting for a draft");
    }
  });

  it("restores draft and selected reason from stored_data", async () => {
    const res = await handleCanvasRequest({
      workspace_id: "ws_123",
      conversation: { id: "ic_100" },
      stored_data: {
        draft: { text: "Fin assist draft text here.", origin: "ai", at: Date.now() },
        reasonCode: "wrong_answer",
        reasonNote: "Fix details",
      },
    });
    const first = res.canvas.content.components[0];
    expect(first?.type).toBe("text");
    if (first?.type === "text") {
      expect(first.text).toContain("Draft inserted · 5 words");
    }
    const dropdown = res.canvas.content.components.find((c) => c.id === "reason_code");
    if (dropdown?.type === "dropdown") {
      expect(dropdown.value).toBe("wrong_answer");
    }
  });

  it("updates reason code on submit", async () => {
    const res = await handleCanvasRequest({
      workspace_id: "ws_123",
      conversation: { id: "ic_100" },
      component_id: "save_reason",
      input_values: {
        reason_code: "tone_wording",
        reason_note: "Polished greeting",
      },
      stored_data: {
        draft: { text: "Hello customer", origin: "ai", at: Date.now() },
      },
    });
    expect(res.canvas.stored_data?.reasonCode).toBe("tone_wording");
    expect(res.canvas.stored_data?.reasonNote).toBe("Polished greeting");
  });

  it("marks current text as manual draft on mark_draft button click", async () => {
    const res = await handleCanvasRequest({
      workspace_id: "ws_123",
      conversation: {
        id: "ic_100",
        conversation_parts: {
          conversation_parts: [{ part_type: "comment", body: "Manual draft from agent" }],
        },
      },
      component_id: "mark_draft",
    });
    const first = res.canvas.content.components[0];
    expect(first?.type).toBe("text");
    if (first?.type === "text") {
      expect(first.text).toContain("Draft marked by you · 4 words");
    }
    expect(res.canvas.stored_data?.draft?.origin).toBe("manual");
  });

  it("finds recorded SDK draft for the conversation", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "run_123",
            output: "Recorded draft from SDK agent",
            model: "gpt-4.1-mini",
          },
        ],
      }),
    });

    const res = await handleCanvasRequest(
      {
        workspace_id: "ws_123",
        conversation: { id: "ic_456" },
      },
      {
        apiKey: "ov_live_key",
        fetchFn: mockFetch as unknown as typeof fetch,
      },
    );

    const first = res.canvas.content.components[0];
    expect(first?.type).toBe("text");
    if (first?.type === "text") {
      expect(first.text).toContain("Draft inserted · 5 words");
    }
    expect(res.canvas.stored_data?.draft?.runId).toBe("run_123");
    expect(res.canvas.stored_data?.draft?.model).toBe("gpt-4.1-mini");
  });
});

describe("handleWebhookEvent", () => {
  it("ignores webhooks when no item or conversation parts exist", async () => {
    const res = await handleWebhookEvent({}, { apiKey: "ov_key" });
    expect(res.captured).toBe(false);
  });

  it("captures on send when a draft was recorded", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/v1/runs")) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: "run_sdk",
                output: "Draft reply from AI assist",
              },
            ],
          }),
        };
      }
      if (url.includes("/v1/capture")) {
        return {
          ok: true,
          json: async () => ({
            kind: "approve",
            changed: false,
            deduplicated: false,
          }),
        };
      }
      return { ok: false };
    });

    const res = await handleWebhookEvent(
      {
        topic: "conversation.admin.replied",
        data: {
          item: {
            id: "ic_789",
            conversation_parts: {
              conversation_parts: [
                {
                  part_type: "comment",
                  body: "Draft reply from AI assist",
                  author: { type: "admin", email: "agent@corp.com" },
                },
              ],
            },
          },
        },
      },
      {
        apiKey: "ov_key",
        fetchFn: mockFetch as unknown as typeof fetch,
      },
    );

    expect(res.captured).toBe(true);
    expect(res.result?.kind).toBe("approve");
  });
});

describe("handleRequest", () => {
  it("rejects non-POST methods with 405", async () => {
    const req = new Request("https://api.internal/intercom/initialize", { method: "GET" });
    const res = await handleRequest(req);
    expect(res.status).toBe(405);
  });

  it("handles Canvas Kit POST request and returns JSON", async () => {
    const req = new Request("https://api.internal/intercom/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "ws_123",
        conversation: { id: "ic_100" },
      }),
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { canvas: { content: { components: Array<{ text?: string }> } } };
    expect(data.canvas.content.components[0]?.text).toBe("Waiting for a draft");
  });
});
