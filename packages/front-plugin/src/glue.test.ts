import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "./capture";
import { type ConversationView, createController } from "./glue";

const longDraft = `Hi Dana, thanks for the photos. ${"Storm damage is covered. ".repeat(6)}`;
const inbound = { id: "m1", body: "Water came through the ceiling.", isInbound: true };

function setup(opts: { fetch?: typeof fetch; requireReason?: boolean } = {}) {
  let sent: string | null = null;
  const reads = { messages: 0, comments: 0 };
  const view = (draftText: string | null): ConversationView => ({
    id: "cnv_1",
    subject: "Roof",
    recipient: "dana@example.com",
    url: null,
    actor: "ray@carrier.com",
    draftText,
    async listMessages() {
      reads.messages++;
      return sent ? [inbound, { id: "m2", body: sent, isInbound: false }] : [inbound];
    },
    async listComments() {
      reads.comments++;
      return [];
    },
  });
  const okFetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ kind: "edit", changed: true, deduplicated: false, case: { title: "T" } }),
        { status: 200 },
      ),
  ) as unknown as typeof fetch;
  const f = opts.fetch ?? okFetch;
  const controller = createController({
    settings: { ...DEFAULT_SETTINGS, requireReason: opts.requireReason ?? true },
    apiKey: "k",
    fetch: f,
  });
  return {
    controller,
    view,
    reads,
    f,
    send: (t: string) => {
      sent = t;
    },
  };
}

describe("controller", () => {
  it("reads nothing but the composer until a draft appears", async () => {
    const s = setup();
    await s.controller.onConversation(s.view(""));
    await s.controller.onConversation(s.view("Hi"));
    expect(s.reads).toEqual({ messages: 0, comments: 0 });
    expect(s.controller.state().status).toBe("Waiting for a draft");
  });

  it("detects a draft, then posts source=front on send as drafted", async () => {
    const s = setup();
    await s.controller.onConversation(s.view(""));
    await s.controller.onConversation(s.view(longDraft));
    expect(s.controller.state().status).toMatch(/^Draft inserted · \d+ words$/);
    s.send(longDraft);
    await s.controller.onConversation(s.view(null));
    expect(s.f).toHaveBeenCalledTimes(1);
    const [url, init] = (s.f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.overturn.run/v1/capture");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const body = JSON.parse(String(init.body));
    expect(body.source).toBe("front");
    expect(body.externalId).toBe("fr:cnv_1");
    expect(body.context).toHaveLength(2);
  });

  it("holds a changed reply until a reason is picked, then captures", async () => {
    const s = setup();
    await s.controller.onConversation(s.view(""));
    await s.controller.onConversation(s.view(longDraft));
    s.send("A completely different reply.");
    await s.controller.onConversation(s.view(null));
    expect(s.f).not.toHaveBeenCalled();
    expect(s.controller.state().needsReason).toBe(true);
    await s.controller.setReason("wrong_answer", "");
    expect(s.f).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      String(((s.f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body),
    );
    expect(body.reasonCode).toBe("wrong_answer");
    expect(s.controller.state().needsReason).toBe(false);
  });

  it("a failed capture never throws and is reported in the panel", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup({
      fetch: vi.fn(async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
    });
    await s.controller.onConversation(s.view(""));
    await s.controller.onConversation(s.view(longDraft));
    s.send(longDraft);
    await expect(s.controller.onConversation(s.view(null))).resolves.toBeUndefined();
    expect(s.controller.state().note).toContain("could not save");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a non-2xx response is also swallowed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup({
      fetch: vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    await s.controller.onConversation(s.view(""));
    await s.controller.onConversation(s.view(longDraft));
    s.send(longDraft);
    await s.controller.onConversation(s.view(null));
    expect(s.controller.state().note).toContain("could not save");
    warn.mockRestore();
  });
});
