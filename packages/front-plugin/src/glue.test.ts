import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import { type FrontComment, type FrontMessage, settingsFrom } from "./capture";
import {
  type CaptureController,
  type ControllerView,
  createCaptureController,
  type FrontContext,
  type FrontDraft,
} from "./controller";

// Mocks shaped after the official Plugin SDK types (@frontapp/plugin-sdk
// 1.8.1): the context carries listMessages/listComments, a message has a
// `status` of "inbound" | "outbound" (no is_inbound flag), the draft lives on
// the conversation as draftId and is read with fetchDraft, and a message's
// content can be undefined until Front has loaded it.

const draftText = "The adjuster will contact you within five business days about the roof claim.";
const changedText = "The adjuster will contact you within two business days about the roof claim.";

class FakeView implements ControllerView {
  status = "";
  hint = "";
  feedback = "";
  note = "";
  selected: string | null = null;
  render(status: string, hint: string): void {
    this.status = status;
    this.hint = hint;
  }
  showFeedback(text: string): void {
    this.feedback = text;
  }
  readNote(): string {
    return this.note;
  }
  writeNote(text: string): void {
    this.note = text;
  }
  selectReason(code: string | null): void {
    this.selected = code;
  }
}

class FakeSdk {
  drafts = new Map<string, FrontDraft>();
  fetchCalls: string[] = [];
  async fetchDraft(id: string): Promise<FrontDraft | undefined> {
    this.fetchCalls.push(id);
    return this.drafts.get(id);
  }
}

class FakeContext implements FrontContext {
  type = "singleConversation";
  teammate = { email: "ray@example.com" };
  messages: FrontMessage[] = [];
  comments: FrontComment[] = [];
  listMessagesCalls = 0;
  listCommentsCalls = 0;
  constructor(public conversation: { id: string; subject?: string; draftId?: string }) {}
  async listMessages(): Promise<{ results: FrontMessage[] }> {
    this.listMessagesCalls++;
    return { results: this.messages };
  }
  async listComments(): Promise<{ results: FrontComment[] }> {
    this.listCommentsCalls++;
    return { results: this.comments };
  }
}

function harness() {
  const view = new FakeView();
  const sdk = new FakeSdk();
  const posts: CaptureCreate[] = [];
  let attempts = 0;
  let failPost = false;
  let clock = 1_000_000;
  const controller: CaptureController = createCaptureController({
    sdk,
    view,
    settings: settingsFrom({ min_draft_chars: 20 }),
    now: () => clock,
    logError: () => {},
    postCapture: async (_url: string, body: CaptureCreate): Promise<CaptureResult> => {
      attempts++;
      if (failPost) throw new Error("HTTP 500");
      posts.push(body);
      return {
        changed: body.sent.text !== body.draft.text,
        deduplicated: false,
      } as unknown as CaptureResult;
    },
  });
  return {
    view,
    sdk,
    posts,
    controller,
    attempts: () => attempts,
    setFailPost: (value: boolean) => {
      failPost = value;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    at: (ms: number) => new Date(ms).toISOString(),
  };
}

type Harness = ReturnType<typeof harness>;

const inbound = (at: string): FrontMessage => ({
  id: "msg_1",
  status: "inbound",
  from: { handle: "dana@example.com" },
  date: at,
  content: { body: "Water came through the roof.", type: "text" },
});

const note: FrontComment = {
  id: "cmt_1",
  author: { name: "Ray", email: "ray@example.com" },
  createdAt: "2026-11-16T10:02:00Z",
  content: { body: "HO-3 policy, deductible $1,000." },
};

function openConversation(h: Harness, id: string): FakeContext {
  const ctx = new FakeContext({ id, subject: "Roof claim" });
  ctx.messages = [inbound(h.at(900_000))];
  ctx.comments = [note];
  h.controller.onContext(ctx);
  return ctx;
}

async function detectDraft(h: Harness, ctx: FakeContext, text = draftText): Promise<void> {
  ctx.conversation.draftId = "dra_1";
  h.sdk.drafts.set("dra_1", { id: "dra_1", content: { body: text, type: "text" } });
  h.controller.onContext(ctx);
  await h.controller.poll();
}

function sendReply(h: Harness, ctx: FakeContext, sent: FrontMessage): void {
  ctx.conversation.draftId = undefined;
  h.sdk.drafts.delete("dra_1");
  ctx.messages = [...ctx.messages, sent];
  h.controller.onContext(ctx);
}

const sentBy = (h: Harness, id: string, text: string, handle = "ray@example.com"): FrontMessage => ({
  id,
  status: "outbound",
  from: { handle },
  date: h.at(1_100_000),
  content: { body: text, type: "text" },
});

describe("Front controller", () => {
  it("reads nothing — no messages, no comments, no draft — until a draft appears", async () => {
    const h = harness();
    const ctx = openConversation(h, "cnv_1");
    await h.controller.poll();
    await h.controller.poll();
    expect(ctx.listMessagesCalls).toBe(0);
    expect(ctx.listCommentsCalls).toBe(0);
    expect(h.sdk.fetchCalls).toEqual([]);
    expect(h.view.status).toBe("Waiting for a draft");
  });

  it("detects a draft that arrives while watching as inserted, and snapshots the thread", async () => {
    const h = harness();
    const ctx = openConversation(h, "cnv_1");
    await h.controller.poll(); // empty composer observed first
    await detectDraft(h, ctx);
    expect(h.view.status).toBe("Draft inserted · 13 words");
    expect(ctx.listMessagesCalls).toBeGreaterThan(0);
    expect(ctx.listCommentsCalls).toBeGreaterThan(0);
    expect(h.controller.inspect().draftId).toBe("dra_1");
  });

  it("holds a changed send until a reason is picked, then captures it without the sent reply in context", async () => {
    const h = harness();
    const ctx = openConversation(h, "cnv_1");
    await h.controller.poll();
    await detectDraft(h, ctx);
    sendReply(h, ctx, sentBy(h, "msg_2", changedText));
    await h.controller.poll();
    expect(h.posts).toEqual([]);
    expect(h.controller.inspect().pendingId).toBe("msg_2");
    expect(h.view.hint).toBe("Sent reply found. Pick a reason to save the correction.");

    h.view.note = "Storm claims have a two-day SLA.";
    await h.controller.toggleReason("wrong_amount_or_date");
    expect(h.posts).toHaveLength(1);
    const body = h.posts[0]!;
    expect(body.source).toBe("front");
    expect(body.externalId).toBe("fr:cnv_1");
    expect(body.reasonCode).toBe("wrong_amount_or_date");
    expect(body.reason).toBe("Storm claims have a two-day SLA.");
    expect(body.context.map((m) => m.role)).toEqual(["customer", "note"]);
    expect(body.metadata).toMatchObject({ frontMessageId: "msg_2" });
    expect(h.view.feedback).toBe("Captured · edit saved as a case");
    expect(h.controller.inspect().pendingId).toBeNull();
  });

  it("a capture failure is shown, never blocks the send, and is not retried", async () => {
    const h = harness();
    const ctx = openConversation(h, "cnv_1");
    await h.controller.poll();
    await detectDraft(h, ctx);
    h.setFailPost(true);
    sendReply(h, ctx, sentBy(h, "msg_2", draftText));
    await h.controller.poll();
    expect(h.attempts()).toBe(1);
    expect(h.view.feedback).toBe("Overturn could not save this reply. Your Front send was unaffected.");
    await h.controller.poll();
    expect(h.attempts()).toBe(1);
  });

  it("never captures the same send twice", async () => {
    const h = harness();
    const ctx = openConversation(h, "cnv_1");
    await h.controller.poll();
    await detectDraft(h, ctx);
    sendReply(h, ctx, sentBy(h, "msg_2", draftText));
    await h.controller.poll();
    await h.controller.poll();
    expect(h.attempts()).toBe(1);
    expect(h.view.feedback).toBe("Sent as drafted · approved");
  });

  it("keeps a held capture whose body has not loaded yet, and captures it when it arrives", async () => {
    const h = harness();
    const ctx = openConversation(h, "cnv_1");
    await h.controller.poll();
    await detectDraft(h, ctx);
    sendReply(h, ctx, {
      id: "msg_2",
      status: "outbound",
      from: { handle: "ray@example.com" },
      date: h.at(1_100_000),
    });
    await h.controller.poll();
    expect(h.posts).toEqual([]);
    expect(h.controller.inspect().pendingId).toBe("msg_2");

    ctx.messages = ctx.messages.map((m) =>
      m.id === "msg_2" ? { ...m, content: { body: draftText, type: "text" as const } } : m,
    );
    await h.controller.poll();
    expect(h.posts).toHaveLength(1);
    expect(h.view.feedback).toBe("Sent as drafted · approved");
  });

  it("drops a deleted draft instead of capturing anything", async () => {
    const h = harness();
    const ctx = openConversation(h, "cnv_1");
    await h.controller.poll();
    await detectDraft(h, ctx);
    ctx.conversation.draftId = undefined;
    h.sdk.drafts.delete("dra_1");
    h.controller.onContext(ctx);
    await h.controller.poll();
    expect(h.posts).toEqual([]);
    expect(h.controller.inspect().draftId).toBe("dra_1");
    h.advance(31_000);
    await h.controller.poll();
    expect(h.controller.inspect().draftId).toBeNull();
    expect(h.view.status).toBe("Waiting for a draft");
  });

  it("a note alone does not release a held capture", async () => {
    const h = harness();
    const ctx = openConversation(h, "cnv_1");
    await h.controller.poll();
    await detectDraft(h, ctx);
    sendReply(h, ctx, sentBy(h, "msg_2", changedText));
    await h.controller.poll();
    h.view.note = "Just a note, no code.";
    await h.controller.poll();
    expect(h.posts).toEqual([]);
    await h.controller.toggleReason("tone_wording");
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.reason).toBe("Just a note, no code.");
  });

  it("does not mistake another teammate's reply for the draft author's send", async () => {
    const h = harness();
    const ctx = openConversation(h, "cnv_1");
    await h.controller.poll();
    await detectDraft(h, ctx);
    const sam = sentBy(h, "msg_sam", "Sam jumped in with a holding reply.", "sam@example.com");
    sam.date = h.at(1_050_000);
    sendReply(h, ctx, sam);
    ctx.messages = [...ctx.messages, sentBy(h, "msg_ray", draftText)];
    await h.controller.poll();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.metadata).toMatchObject({ frontMessageId: "msg_ray" });
  });
});

describe("per-conversation state isolation", () => {
  it("a reason and note picked in A never leak into B, and A's own state is restored on return", async () => {
    const h = harness();
    const a = openConversation(h, "cnv_a");
    await h.controller.poll();
    await detectDraft(h, a);
    await h.controller.toggleReason("wrong_answer");
    h.view.note = "A note meant for A only.";

    const b = openConversation(h, "cnv_b");
    expect(h.controller.inspect().reasonCode).toBeNull();
    expect(h.view.selected).toBeNull();
    expect(h.view.note).toBe("");
    await h.controller.poll();
    await detectDraft(h, b);
    sendReply(h, b, sentBy(h, "msg_b2", changedText));
    await h.controller.poll();
    // B's changed send is held: had A's reason leaked, it would have posted.
    expect(h.posts).toEqual([]);
    expect(h.controller.inspect().pendingId).toBe("msg_b2");
    await h.controller.toggleReason("missing_information");
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.externalId).toBe("fr:cnv_b");
    expect(h.posts[0]!.reasonCode).toBe("missing_information");
    expect(h.posts[0]!.reason).toBeNull();

    h.controller.onContext(a);
    expect(h.controller.inspect().reasonCode).toBe("wrong_answer");
    expect(h.view.selected).toBe("wrong_answer");
    expect(h.view.note).toBe("A note meant for A only.");
  });

  it("a held capture in A survives a round trip to B and back", async () => {
    const h = harness();
    const a = openConversation(h, "cnv_a");
    await h.controller.poll();
    await detectDraft(h, a);
    sendReply(h, a, sentBy(h, "msg_a2", changedText));
    await h.controller.poll();
    expect(h.controller.inspect().pendingId).toBe("msg_a2");

    openConversation(h, "cnv_b");
    expect(h.controller.inspect().pendingId).toBeNull();
    h.controller.onContext(a);
    expect(h.controller.inspect().pendingId).toBe("msg_a2");
    await h.controller.toggleReason("tone_wording");
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.externalId).toBe("fr:cnv_a");
  });
});

describe("sent attribution rules", () => {
  const outbound = (h: Harness, id: string, handle: string, atMs: number, text?: string): FrontMessage => ({
    id,
    status: "outbound",
    from: { handle },
    date: h.at(atMs),
    ...(text !== undefined ? { content: { body: text, type: "text" as const } } : {}),
  });

  function vanishDraft(h: Harness, ctx: FakeContext, fresh: FrontMessage[]): void {
    ctx.conversation.draftId = undefined;
    h.sdk.drafts.delete("dra_1");
    ctx.messages = [...ctx.messages, ...fresh];
    h.controller.onContext(ctx);
  }

  it("locks onto the earliest own send and waits for its body instead of capturing a later loaded send", async () => {
    const h = harness();
    const ctx = openConversation(h, "cnv_1");
    await h.controller.poll();
    await detectDraft(h, ctx);
    // The reply that consumed the draft is the earliest new send; its body
    // has not loaded yet. A later send whose body already loaded must never
    // be substituted for it.
    vanishDraft(h, ctx, [
      outbound(h, "msg_2", "ray@example.com", 1_100_000),
      outbound(h, "msg_3", "ray@example.com", 1_200_000, draftText),
    ]);
    await h.controller.poll();
    expect(h.posts).toEqual([]);
    expect(h.controller.inspect().pendingId).toBe("msg_2");

    ctx.messages = ctx.messages.map((m) =>
      m.id === "msg_2" ? { ...m, content: { body: draftText, type: "text" as const } } : m,
    );
    await h.controller.poll();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.metadata).toMatchObject({ frontMessageId: "msg_2" });
    expect(h.attempts()).toBe(1);
  });

  it("shared inbox rule: a lone new send under a different address is still captured — an address mismatch alone never rejects it", async () => {
    const h = harness();
    const ctx = openConversation(h, "cnv_1");
    await h.controller.poll();
    await detectDraft(h, ctx);
    vanishDraft(h, ctx, [outbound(h, "msg_sam", "sam@example.com", 1_100_000, draftText)]);
    await h.controller.poll();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.metadata).toMatchObject({ frontMessageId: "msg_sam" });
  });

  it("shared inbox rule: several new sends with none of them the teammate's own are ambiguous — nothing is captured or held", async () => {
    const h = harness();
    const ctx = openConversation(h, "cnv_1");
    await h.controller.poll();
    await detectDraft(h, ctx);
    vanishDraft(h, ctx, [
      outbound(h, "msg_sam", "sam@example.com", 1_100_000, "Sam's own reply, not the draft."),
      outbound(h, "msg_jo", "jo@example.com", 1_200_000, "Jo's own reply, not the draft."),
    ]);
    await h.controller.poll();
    expect(h.posts).toEqual([]);
    expect(h.controller.inspect().pendingId).toBeNull();
    await h.controller.poll();
    expect(h.posts).toEqual([]);
    expect(h.controller.inspect().pendingId).toBeNull();
  });

  it("a teammate's still-loading reply does not block the draft author's own loaded send", async () => {
    const h = harness();
    const ctx = openConversation(h, "cnv_1");
    await h.controller.poll();
    await detectDraft(h, ctx);
    vanishDraft(h, ctx, [
      outbound(h, "msg_sam", "sam@example.com", 1_050_000),
      outbound(h, "msg_ray", "ray@example.com", 1_100_000, draftText),
    ]);
    await h.controller.poll();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.metadata).toMatchObject({ frontMessageId: "msg_ray" });
  });
});
