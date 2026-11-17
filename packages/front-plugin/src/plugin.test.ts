import type { CaptureCreate } from "@overturn-ai/shared";
import { describe, expect, it, vi } from "vitest";
import type { FrontComment, FrontMessage } from "./capture";
import { settingsFrom } from "./capture";
import { createPlugin, type FrontSdk, type PanelState, type RelayResponse } from "./plugin";

const AI =
  "Hi Dana, thanks for the photos. Your policy covers storm damage to the roof, so we are approving the claim with a reserve of $4,200.";
const RUN_ID = "8c9f8a8e-6a43-4a5e-9d0e-6b2f0c1d2e3f";

/** A mocked Front plugin SDK: one or more conversations, each with a composer and a message list. */
function mockFront(
  opts: { runs?: Record<string, { id: string; output: string }>; capture?: () => RelayResponse } = {},
) {
  const drafts = new Map<string, string>();
  const messages = new Map<string, FrontMessage[]>();
  let open = "";
  const posted: CaptureCreate[] = [];
  const front = {
    fetchDraft: vi.fn(async (id: string) => {
      const body = drafts.get(id);
      return body === undefined ? undefined : { content: { body, type: "html" } };
    }),
    listMessages: vi.fn(async () => ({ results: messages.get(open) ?? [], nextPageToken: undefined })),
    listComments: vi.fn(async () => ({ results: [] as FrontComment[], nextPageToken: undefined })),
    relayHttp: vi.fn(async (req: Parameters<FrontSdk["relayHttp"]>[0]): Promise<RelayResponse> => {
      if (req.verb === "GET") {
        const ext = new URL(req.url).searchParams.get("externalId") ?? "";
        const run = opts.runs?.[ext];
        return { status: 200, body: { items: run ? [run] : [] } };
      }
      posted.push(req.body as CaptureCreate);
      if (opts.capture) return opts.capture();
      const b = req.body as CaptureCreate;
      const changed = b.draft.text !== b.sent.text;
      return {
        status: 201,
        body: {
          kind: changed ? "edit" : "approve",
          changed,
          deduplicated: false,
          case: changed ? { title: b.reason ?? "Changed" } : null,
        },
      };
    }),
  } satisfies FrontSdk;
  return {
    front,
    posted,
    open: (id: string) => {
      open = id;
    },
    type: (draftId: string, text: string) => drafts.set(draftId, text),
    closeDraft: (draftId: string) => drafts.delete(draftId),
    setMessages: (cnv: string, list: FrontMessage[]) => messages.set(cnv, list),
  };
}

const inbound: FrontMessage = {
  id: "msg_1",
  status: "inbound",
  date: new Date("2026-11-16T10:00:00Z"),
  from: { handle: "dana@example.com", name: "Dana" },
  content: { body: "<p>Storm took part of the roof.</p>", type: "html" },
};
const sentMsg = (id: string, body: string): FrontMessage => ({
  id,
  status: "outbound",
  date: new Date("2026-11-16T10:30:00Z"),
  from: { handle: "claims@insurer.example" },
  content: { body, type: "html" },
});
const ctx = (id: string, draftId?: string, tags: string[] = []) => ({
  type: "singleConversation",
  teammate: { email: "adjuster@insurer.example" },
  conversation: { id, type: "email", subject: `Claim ${id}`, tags: tags.map((name) => ({ name })), draftId },
});

function setup(raw: Record<string, unknown> = {}, opts: Parameters<typeof mockFront>[0] = {}) {
  const m = mockFront(opts);
  const views: PanelState[] = [];
  let t = 0;
  const sleep = vi.fn(async (ms: number) => {
    t += ms;
  });
  const log = vi.fn();
  const plugin = createPlugin({
    front: m.front,
    settings: settingsFrom(raw),
    render: (s) => views.push(s),
    now: () => t,
    sleep,
    log,
    sentWaitMs: 9_000,
    sentPollMs: 3_000,
  });
  const last = () => views[views.length - 1]!;
  const tick = (ms = 1_000) => {
    t += ms;
    return plugin.poll();
  };
  return { m, plugin, last, tick, sleep, log };
}

/** Open a conversation, let an AI draft land in its composer, and return. */
async function withDraft(env: ReturnType<typeof setup>, cnv = "cnv_1", draftId = "dft_1") {
  env.m.open(cnv);
  env.m.setMessages(cnv, [inbound]);
  env.m.type(draftId, "");
  await env.plugin.onContext(ctx(cnv, draftId));
  await env.tick();
  env.m.type(draftId, `<p>${AI}</p>`);
  await env.tick();
}

/** The teammate hits Send: the draft closes and the message shows up in the conversation. */
async function send(
  env: ReturnType<typeof setup>,
  body: string,
  cnv = "cnv_1",
  draftId = "dft_1",
  msgId = "msg_2",
) {
  env.m.closeDraft(draftId);
  env.m.setMessages(cnv, [inbound, sentMsg(msgId, body)]);
  await env.plugin.onContext(ctx(cnv));
}

describe("Front plugin glue (mocked Front SDK)", () => {
  it("is idle outside a single conversation and respects the scope tag", async () => {
    const env = setup({ scope_tag: "ai_drafted" });
    await env.plugin.onContext({ type: "multiConversations" });
    expect(env.last().mode).toBe("idle");
    await env.plugin.onContext(ctx("cnv_1", "dft_1", ["billing"]));
    expect(env.last()).toMatchObject({ mode: "out-of-scope", status: 'Not watching: no "ai_drafted" tag' });
    await env.tick();
    expect(env.m.front.fetchDraft).not.toHaveBeenCalled();
  });

  it("shows Draft inserted · N words, and reads the conversation only once a draft appears", async () => {
    const env = setup();
    env.m.open("cnv_1");
    env.m.type("dft_1", "");
    await env.plugin.onContext(ctx("cnv_1", "dft_1"));
    await env.tick();
    expect(env.last().status).toBe("Waiting for a draft");
    expect(env.m.front.listMessages).not.toHaveBeenCalled();
    env.m.type("dft_1", `<p>${AI}</p>`);
    await env.tick();
    expect(env.last().status).toBe(`Draft inserted · ${AI.split(/\s+/).length} words`);
    expect(env.m.front.listMessages).toHaveBeenCalledTimes(1);
    expect(env.last().reasons).toHaveLength(8);
  });

  it("sent as drafted: POST /v1/capture with source front and fr:<conversation id>", async () => {
    const env = setup();
    await withDraft(env);
    await send(env, `<p>${AI}</p>`);
    expect(env.m.posted).toHaveLength(1);
    const body = env.m.posted[0]!;
    expect(body).toMatchObject({
      source: "front",
      externalId: "fr:cnv_1",
      agent: "claims-reply",
      actor: "adjuster@insurer.example",
      draft: { text: AI },
      sent: { text: AI },
      reasonCode: null,
    });
    expect(body.context).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Storm took part of the roof.",
        at: "2026-11-16T10:00:00.000Z",
      },
    ]);
    const call = env.m.front.relayHttp.mock.calls.find(([r]) => r.verb === "POST")![0];
    expect(call.url).toBe("https://api.overturn.run/v1/capture");
    // The key is attached by the Front app's Server, never by this page.
    expect(JSON.stringify(call)).not.toMatch(/Bearer|api_key/i);
    expect(env.last().status).toBe("Sent as drafted · approved");
  });

  it("warns before the send when the reply changed and no reason is picked (soft gate)", async () => {
    const env = setup();
    await withDraft(env);
    env.m.type("dft_1", `<p>${AI} Inspection needed first.</p>`);
    await env.tick();
    expect(env.last().hint).toBe("Changed from the draft · pick why before you send");
    await env.plugin.pickReason("missing_required_step");
    expect(env.last().hint).toBe("");
  });

  it("require_reason: a changed reply sent without a reason is held until one is picked", async () => {
    const env = setup();
    await withDraft(env);
    await send(env, "<p>We need the adjuster's report before we can decide on coverage.</p>");
    expect(env.m.posted).toHaveLength(0);
    expect(env.last()).toMatchObject({ pending: true, status: "Sent · waiting for a reason" });
    env.plugin.setReasonNote("Inspection first");
    await env.plugin.pickReason("missing_required_step");
    expect(env.m.posted).toHaveLength(1);
    expect(env.m.posted[0]).toMatchObject({
      externalId: "fr:cnv_1",
      reasonCode: "missing_required_step",
      reason: "Inspection first",
      sent: { text: "We need the adjuster's report before we can decide on coverage." },
    });
    expect(env.last()).toMatchObject({
      pending: false,
      status: "Captured · edit saved as a case",
      reasonCode: null,
    });
  });

  it("a reason picked before the send goes out with the capture", async () => {
    const env = setup();
    await withDraft(env);
    await env.plugin.pickReason("tone_wording");
    await send(env, `<p>${AI} Kind regards.</p>`);
    expect(env.m.posted[0]?.reasonCode).toBe("tone_wording");
  });

  it("fails open: a failed capture is logged and shown, never thrown, and the next draft still works", async () => {
    const env = setup({}, { capture: () => ({ status: 503, body: null }) });
    await withDraft(env);
    await expect(send(env, `<p>${AI}</p>`)).resolves.toBeUndefined();
    expect(env.last().note).toBe("Overturn could not save this correction (503).");
    expect(env.log).toHaveBeenCalledWith("capture failed", expect.anything());

    const env2 = setup();
    env2.m.front.relayHttp.mockRejectedValueOnce(new Error("offline")); // recorded-run lookup
    env2.m.front.relayHttp.mockRejectedValueOnce(new Error("offline")); // capture
    await withDraft(env2);
    await send(env2, `<p>${AI}</p>`);
    expect(env2.last().note).toBe("Overturn could not save this correction (network).");
    // A new draft on the same conversation is detected again.
    env2.m.type("dft_2", "");
    await env2.plugin.onContext(ctx("cnv_1", "dft_2"));
    await env2.tick();
    env2.m.type("dft_2", `<p>${AI}</p>`);
    await env2.tick();
    expect(env2.last().status).toMatch(/^Draft inserted/);
  });

  it("waits for the sent message (Undo send), and captures nothing for a discarded draft", async () => {
    const env = setup();
    await withDraft(env);
    env.m.closeDraft("dft_1");
    // The message appears only on the second look.
    env.m.front.listMessages.mockResolvedValueOnce({ results: [inbound], nextPageToken: undefined });
    env.m.setMessages("cnv_1", [inbound, sentMsg("msg_2", `<p>${AI}</p>`)]);
    await env.plugin.onContext(ctx("cnv_1"));
    expect(env.sleep).toHaveBeenCalledWith(3_000);
    expect(env.m.posted).toHaveLength(1);

    const env2 = setup();
    await withDraft(env2);
    env2.m.closeDraft("dft_1");
    await env2.plugin.onContext(ctx("cnv_1"));
    expect(env2.m.posted).toHaveLength(0);
    expect(env2.sleep).toHaveBeenCalledTimes(3);
    expect(env2.last().note).toBe("Draft closed without sending · nothing captured");
  });

  it("keeps each conversation's held correction and reason to itself", async () => {
    const env = setup();
    await withDraft(env, "cnv_A", "dft_A");
    await send(
      env,
      "<p>A completely different answer for conversation A, long enough.</p>",
      "cnv_A",
      "dft_A",
      "msg_A",
    );
    expect(env.last().pending).toBe(true);

    await withDraft(env, "cnv_B", "dft_B");
    expect(env.last().pending).toBe(false);
    await env.plugin.pickReason("tone_wording");
    expect(env.m.posted).toHaveLength(0);
    await send(env, `<p>${AI}</p>`, "cnv_B", "dft_B", "msg_B");
    expect(env.m.posted.map((p) => [p.externalId, p.reasonCode])).toEqual([["fr:cnv_B", null]]);

    env.m.open("cnv_A");
    await env.plugin.onContext(ctx("cnv_A"));
    expect(env.last().pending).toBe(true);
    await env.plugin.pickReason("wrong_coverage_decision");
    expect(env.m.posted.map((p) => [p.externalId, p.reasonCode])).toEqual([
      ["fr:cnv_B", null],
      ["fr:cnv_A", "wrong_coverage_decision"],
    ]);
  });

  it("uses a draft the drafting agent recorded with the SDK under fr:<conversation id>", async () => {
    const env = setup({}, { runs: { "fr:cnv_1": { id: RUN_ID, output: AI } } });
    env.m.open("cnv_1");
    env.m.setMessages("cnv_1", [inbound]);
    env.m.type("dft_1", `<p>${AI}</p>`);
    await env.plugin.onContext(ctx("cnv_1", "dft_1"));
    await env.tick();
    expect(env.last().status).toBe(`Draft recorded by your agent · ${AI.split(/\s+/).length} words`);
    await send(env, `<p>${AI}</p>`);
    expect(env.m.posted[0]).toMatchObject({
      draftRunId: RUN_ID,
      tags: ["draft:recorded", "reply", "channel:email"],
    });
  });

  it("marks the current composer text as the draft by hand", async () => {
    const env = setup();
    env.m.open("cnv_1");
    env.m.setMessages("cnv_1", [inbound]);
    env.m.type("dft_1", "Short typed reply");
    await env.plugin.onContext(ctx("cnv_1", "dft_1"));
    await env.tick();
    await env.plugin.markCurrent();
    expect(env.last().status).toBe("Draft marked by you · 3 words");
    await send(env, "<p>Short typed reply</p>");
    expect(env.m.posted[0]?.tags?.[0]).toBe("draft:manual");
  });
});
