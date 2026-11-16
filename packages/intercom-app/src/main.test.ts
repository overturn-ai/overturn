import type { CaptureCreate } from "@overturn-ai/shared";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, stripHtml } from "./capture";
import {
  type CanvasKitRequest,
  type CanvasKitSubmitRequest,
  handleInitialize,
  handleSubmit,
  snapshotFrom,
} from "./main";

const finDraft =
  "<p>Hi Dana,</p><p>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

function request(parts: unknown[], extra: Partial<CanvasKitRequest> = {}): CanvasKitRequest {
  return {
    workspace_id: "ws_1",
    admin: { id: "admin_1", email: "ray@carrier.com", name: "Ray" },
    contact: { id: "contact_1", email: "dana@example.com", name: "Dana" },
    conversation: {
      id: "conv_48213",
      title: "Roof leak after storm",
      source: {
        body: "<p>Water came through the ceiling. Photos attached.</p>",
        author: { type: "user", id: "contact_1", email: "dana@example.com", name: "Dana" },
        created_at: 1790848800,
      },
      conversation_parts: { conversation_parts: parts as never[] },
    },
    ...extra,
  };
}

const finPart = {
  id: "part_9",
  part_type: "comment",
  body: finDraft,
  created_at: 1790849100,
  author: { type: "bot", id: "fin", name: "Fin" },
};

const deps = (
  postCapture = vi.fn(async (_body: CaptureCreate) => ({
    kind: "approve",
    changed: false,
    deduplicated: false,
  })),
) => ({
  settings: DEFAULT_SETTINGS,
  postCapture,
});

function texts(res: {
  canvas: { content: { components: Array<{ type: string; text?: string }> } };
}): string[] {
  return res.canvas.content.components.flatMap((c) => (c.type === "text" && c.text ? [c.text] : []));
}

describe("snapshotFrom", () => {
  it("maps the webhook conversation into a snapshot", () => {
    const snap = snapshotFrom(request([finPart]), DEFAULT_SETTINGS);
    expect(snap?.id).toBe("conv_48213");
    expect(snap?.subject).toBe("Roof leak after storm");
    expect(snap?.contactEmail).toBe("dana@example.com");
    expect(snap?.parts).toHaveLength(2);
    expect(snap?.parts[0]?.authorType).toBe("user");
    expect(snap?.parts[1]?.authorType).toBe("bot");
    expect(snap?.parts[0]?.createdAt).toBe("2026-10-01T10:00:00.000Z");
  });

  it("is null without a conversation", () => {
    expect(snapshotFrom({ workspace_id: "ws_1" }, DEFAULT_SETTINGS)).toBeNull();
  });
});

describe("handleInitialize", () => {
  it("shows the spec's status line when Fin's draft is waiting", () => {
    const words = stripHtml(finDraft).split(/\s+/).length;
    const res = handleInitialize(request([finPart]), deps());
    expect(texts(res)[0]).toBe(`Draft inserted · ${words} words`);
    // The draft rides to the submit request in stored_data.
    const stored = res.canvas.stored_data?.overturn_draft;
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!).origin).toBe("ai");
  });

  it("waits when there is no draft, and stores nothing", () => {
    const res = handleInitialize(request([]), deps());
    expect(texts(res)[0]).toBe("Waiting for a draft");
    expect(res.canvas.stored_data).toBeUndefined();
  });
});

describe("handleSubmit", () => {
  it("captures the send once the expert's reply is on the thread", async () => {
    const postCapture = vi.fn(async (_body: CaptureCreate) => ({
      kind: "approve",
      changed: false,
      deduplicated: false,
    }));
    const init = handleInitialize(request([finPart]), deps(postCapture));
    const submit: CanvasKitSubmitRequest = {
      ...request([
        finPart,
        {
          id: "part_10",
          part_type: "comment",
          body: finDraft,
          created_at: 1790849400,
          author: { type: "admin", id: "admin_1", email: "ray@carrier.com" },
        },
      ]),
      component_id: "capture",
      input_values: {},
      current_canvas: { stored_data: init.canvas.stored_data },
    };
    const res = await handleSubmit(submit, deps(postCapture));
    expect(postCapture).toHaveBeenCalledTimes(1);
    const body = postCapture.mock.calls[0]![0];
    expect(body.source).toBe("intercom");
    expect(body.externalId).toBe("ic:conv_48213");
    expect(body.tags).toEqual(["draft:ai", "public-reply"]);
    expect(body.actor).toBe("ray@carrier.com");
    expect(texts(res)[0]).toBe("Sent as drafted · approved");
  });

  it("holds a changed capture until a reason is picked, then posts it with the reason", async () => {
    const postCapture = vi.fn(async (_body: CaptureCreate) => ({
      kind: "edit",
      changed: true,
      deduplicated: false,
    }));
    const init = handleInitialize(request([finPart]), deps(postCapture));
    const edited = finDraft.replace("5 business days", "2 business days");
    const base: CanvasKitSubmitRequest = {
      ...request([
        finPart,
        {
          id: "part_10",
          part_type: "comment",
          body: edited,
          created_at: 1790849400,
          author: { type: "admin", id: "admin_1", email: "ray@carrier.com" },
        },
      ]),
      component_id: "capture",
      current_canvas: { stored_data: init.canvas.stored_data },
    };
    const held = await handleSubmit({ ...base, input_values: {} }, deps(postCapture));
    expect(postCapture).not.toHaveBeenCalled();
    expect(texts(held).join(" ")).toContain("Pick why you changed it");
    const done = await handleSubmit(
      { ...base, input_values: { reason_code: "wrong_amount_or_date", reason_note: "Storm SLA is 2 days" } },
      deps(postCapture),
    );
    expect(postCapture).toHaveBeenCalledTimes(1);
    expect(postCapture.mock.calls[0]![0].reasonCode).toBe("wrong_amount_or_date");
    expect(texts(done)[0]).toBe("Captured · edit saved as a case");
  });

  it("a draft marked by hand in the canvas is captured as draft:manual", async () => {
    const postCapture = vi.fn(async (_body: CaptureCreate) => ({
      kind: "approve",
      changed: false,
      deduplicated: false,
    }));
    const marked = await handleSubmit(
      { ...request([]), component_id: "mark_draft", input_values: { draft_text: finDraft } },
      deps(postCapture),
    );
    const stored = marked.canvas.stored_data?.overturn_draft;
    expect(JSON.parse(stored!).origin).toBe("manual");
    const res = await handleSubmit(
      {
        ...request([
          {
            id: "part_10",
            part_type: "comment",
            body: finDraft,
            created_at: 1790849400,
            author: { type: "admin", id: "admin_1", email: "ray@carrier.com" },
          },
        ]),
        component_id: "capture",
        input_values: {},
        current_canvas: { stored_data: marked.canvas.stored_data },
      },
      deps(postCapture),
    );
    expect(postCapture.mock.calls[0]![0].tags).toEqual(["draft:manual", "public-reply"]);
    expect(texts(res)[0]).toBe("Sent as drafted · approved");
  });

  it("says so, and captures nothing, while the reply has not gone out", async () => {
    const postCapture = vi.fn(async (_body: CaptureCreate) => ({
      kind: "approve",
      changed: false,
      deduplicated: false,
    }));
    const init = handleInitialize(request([finPart]), deps(postCapture));
    const res = await handleSubmit(
      {
        ...request([finPart]),
        component_id: "capture",
        input_values: {},
        current_canvas: { stored_data: init.canvas.stored_data },
      },
      deps(postCapture),
    );
    expect(postCapture).not.toHaveBeenCalled();
    expect(texts(res).join(" ")).toContain("send it in Intercom first");
  });
});
