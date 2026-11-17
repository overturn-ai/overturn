import { captureCreateSchema } from "@overturn-ai/shared";
import { CLAIMS_REASON_CODES, SUPPORT_REASON_CODES } from "@overturn-ai/shared/capture";
import { describe, expect, it } from "vitest";
import {
  bodyText,
  composerChanged,
  createDraftDetector,
  DEFAULT_SETTINGS,
  type DraftState,
  decideOnFrontSend,
  decisionFieldsFrom,
  externalIdFor,
  type FrontConversation,
  type FrontMessage,
  findSentMessage,
  quickReasons,
  settingsFrom,
  settingsFromQuery,
  snapshotFrom,
  statusLine,
} from "./capture";

const AI =
  "Hi Dana, thanks for the photos. Your policy covers storm damage to the roof, so we are approving the claim with a reserve of $4,200.";

const conversation: FrontConversation = {
  id: "cnv_55",
  type: "email",
  subject: "Roof damage claim",
  recipient: { handle: "dana@example.com", name: "Dana" },
  tags: [{ name: "claims" }],
  customFieldAttributes: [
    { name: "Coverage", value: "covered" },
    { name: "Reserve", value: 4200 },
  ],
  draftId: "dft_1",
};

const messages: FrontMessage[] = [
  {
    id: "msg_1",
    status: "inbound",
    date: new Date("2026-11-16T10:00:00Z"),
    from: { handle: "dana@example.com", name: "Dana" },
    content: {
      body: "<p>Storm took part of the roof.</p><p>Photos attached &amp; the estimate.</p>",
      type: "html",
    },
  },
  {
    id: "msg_2",
    status: "outbound",
    date: new Date("2026-11-16T10:05:00Z"),
    from: { handle: "claims@insurer.example", name: "Claims" },
    content: { body: "We got your photos.", type: "text" },
  },
];

const draft: DraftState = { text: AI, origin: "inserted", at: 1_000 };

const decide = (over: Partial<Parameters<typeof decideOnFrontSend>[0]> = {}) => {
  const settings = over.settings ?? DEFAULT_SETTINGS;
  return decideOnFrontSend({
    conversation,
    snapshot: snapshotFrom({ conversation, messages, settings }),
    draft,
    draftFields: {},
    sentText: `<p>${AI}</p>`,
    reasonCode: null,
    reason: "",
    actor: "adjuster@insurer.example",
    settings,
    now: 31_000,
    ...over,
  });
};

describe("settings", () => {
  it("defaults to the claims pack and the claims reply workflow", () => {
    const s = settingsFrom({});
    expect(s.reasonPack).toBe("claims");
    expect(s.agent).toBe("claims-reply");
    expect(s.requireReason).toBe(true);
    expect(quickReasons(s)).toBe(CLAIMS_REASON_CODES);
    expect(quickReasons(s)).toHaveLength(8);
  });
  it("still supports the support pack, with the support workflow unless one is named", () => {
    const s = settingsFrom({ reason_pack: "support" });
    expect(s.reasonPack).toBe("support");
    expect(s.agent).toBe("support-reply");
    expect(quickReasons(s)).toBe(SUPPORT_REASON_CODES);
    expect(settingsFrom({ reason_pack: "support", agent: "billing-reply" }).agent).toBe("billing-reply");
  });
  it("reads the plugin URL's query string with the Zendesk app's setting names", () => {
    const s = settingsFromQuery(
      "?overturn_base_url=https://ov.internal/&require_reason=false&min_draft_chars=120&decision_fields=Coverage:coverage,Reserve:reserve&scope_tag=ai&auth_secret=x",
    );
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.requireReason).toBe(false);
    expect(s.minDraftChars).toBe(120);
    expect(s.scopeTag).toBe("ai");
    expect(s.decisionFields).toEqual([
      { id: "Coverage", label: "coverage" },
      { id: "Reserve", label: "reserve" },
    ]);
  });
});

describe("draft detection and status (reused from the Zendesk app)", () => {
  it("a reply-sized jump in the composer is the draft: Draft inserted · N words", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer("", 0)).toBeNull();
    expect(d.onComposer("Hi", 100)).toBeNull();
    const got = d.onComposer(AI, 200);
    expect(got?.origin).toBe("inserted");
    expect(statusLine(d.current(), null)).toBe(`Draft inserted · ${AI.split(/\s+/).length} words`);
  });
  it("typing a reply by hand is not a draft", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    let text = "";
    for (const [i, ch] of [...AI].entries()) {
      text += ch;
      expect(d.onComposer(text, i * 50)).toBeNull();
    }
  });
  it("knows when the composer no longer matches the draft", () => {
    expect(composerChanged(draft, `<p>${AI}</p>`)).toBe(false);
    expect(composerChanged(draft, `${AI} Thanks!`)).toBe(true);
    expect(composerChanged(null, "anything")).toBe(false);
  });
});

describe("conversation mapping", () => {
  it("maps messages and comments to capture context, oldest first", () => {
    const snap = snapshotFrom({
      conversation,
      messages: [messages[1]!, messages[0]!],
      comments: [
        {
          id: "com_1",
          author: { name: "Lee", email: "lee@insurer.example" },
          content: { body: "Check the exclusion for wear & tear" },
          createdAt: new Date("2026-11-16T10:02:00Z"),
        },
      ],
      settings: DEFAULT_SETTINGS,
      url: null,
    });
    expect(snap.id).toBe("cnv_55");
    expect(snap.requesterEmail).toBe("dana@example.com");
    expect(snap.comments.map((c) => [c.id, c.type, c.isAgent])).toEqual([
      ["msg_1", "publicReply", false],
      ["com_1", "internalNote", true],
      ["msg_2", "publicReply", true],
    ]);
    expect(snap.comments[0]!.value).toBe("Storm took part of the roof.\nPhotos attached & the estimate.");
  });
  it("reads decision fields from the conversation's custom fields by name", () => {
    const s = settingsFrom({ decision_fields: "Coverage:coverage, reserve:reserve, Missing:missing" });
    expect(decisionFieldsFrom(conversation, s)).toEqual({
      coverage: "covered",
      reserve: 4200,
      missing: null,
    });
    expect(decisionFieldsFrom(conversation, DEFAULT_SETTINGS)).toEqual({});
  });
  it("html and text bodies both become plain text", () => {
    expect(bodyText({ body: "<div>a<br>b</div>", type: "html" })).toBe("a\nb");
    expect(bodyText({ body: "plain  text \n", type: "text" })).toBe("plain text");
    expect(bodyText(undefined)).toBe("");
  });
});

describe("finding the sent message", () => {
  it("is the newest outbound message that was not there when the draft appeared", () => {
    const sent: FrontMessage = { id: "msg_9", status: "outbound", date: new Date("2026-11-16T11:00:00Z") };
    const known = new Set(["msg_1", "msg_2"]);
    expect(findSentMessage(known, messages)).toBeNull();
    expect(findSentMessage(known, [...messages, { id: "msg_3", status: "inbound" }, sent])?.id).toBe("msg_9");
  });
});

describe("decideOnFrontSend: the payload builder", () => {
  it("sent as drafted → approve capture with source front and fr:<conversation id>", () => {
    const d = decide();
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("front");
    expect(d.body.externalId).toBe("fr:cnv_55");
    expect(externalIdFor("cnv_55")).toBe("fr:cnv_55");
    expect(d.body.agent).toBe("claims-reply");
    expect(d.body.actor).toBe("adjuster@insurer.example");
    expect(d.body.subject).toBe("Roof damage claim");
    expect(d.body.draft).toEqual({ text: AI });
    expect(d.body.sent).toEqual({ text: AI });
    expect(d.body.reasonCode).toBeNull();
    expect(d.body.secondsToSend).toBe(30);
    expect(d.body.tags).toEqual(["draft:inserted", "reply", "channel:email"]);
    expect(d.body.context.map((m) => m.role)).toEqual(["customer", "agent"]);
    // The body is a valid POST /v1/capture payload as the API parses it.
    expect(captureCreateSchema.safeParse(d.body).success).toBe(true);
  });
  it("a changed reply with require_reason and no reason is held: need-reason", () => {
    expect(
      decide({ sentText: "We need the adjuster's report before we can decide on coverage." }).action,
    ).toBe("need-reason");
  });
  it("a changed reply with a reason → edit capture carrying the code and the note", () => {
    const d = decide({
      sentText: "We need the adjuster's report before we can decide on coverage.",
      reasonCode: "missing_required_step",
      reason: " Inspection first ",
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.body.reasonCode).toBe("missing_required_step");
    expect(d.body.reason).toBe("Inspection first");
    expect(captureCreateSchema.safeParse(d.body).success).toBe(true);
  });
  it("with require_reason off a changed reply is captured without a reason", () => {
    const settings = settingsFrom({ require_reason: "false" });
    const d = decide({
      settings,
      sentText: "Different reply entirely, long enough to count as a changed answer.",
    });
    expect(d.action).toBe("capture");
    if (d.action === "capture") expect(d.body.reasonCode).toBeNull();
  });
  it("decision fields are diffed exactly", () => {
    const settings = settingsFrom({ decision_fields: "Coverage:coverage" });
    const d = decide({
      settings,
      conversation: { ...conversation, customFieldAttributes: [{ name: "Coverage", value: "denied" }] },
      snapshot: snapshotFrom({
        conversation: { ...conversation, customFieldAttributes: [{ name: "Coverage", value: "denied" }] },
        messages,
        settings,
      }),
      draftFields: { coverage: "covered" },
      reasonCode: "wrong_coverage_decision",
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changedFields).toEqual(["coverage"]);
    expect(d.body.draft.fields).toEqual({ coverage: "covered" });
    expect(d.body.sent.fields).toEqual({ coverage: "denied" });
  });
  it("skips with no draft or an empty send", () => {
    expect(decide({ draft: null })).toEqual({ action: "skip", why: "no-draft" });
    expect(decide({ sentText: "<p> </p>" })).toEqual({ action: "skip", why: "empty" });
  });
  it("keeps a recorded run's id and model", () => {
    const d = decide({
      draft: { ...draft, origin: "recorded", runId: "8c9f8a8e-6a43-4a5e-9d0e-6b2f0c1d2e3f", model: "m" },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.draftRunId).toBe("8c9f8a8e-6a43-4a5e-9d0e-6b2f0c1d2e3f");
    expect(d.body.tags?.[0]).toBe("draft:recorded");
  });
});
