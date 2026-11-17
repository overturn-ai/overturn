import { describe, expect, it } from "vitest";
import {
  createGorgiasDraftDetector,
  decideOnSend,
  extractOrderFields,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture.js";
import { DEFAULT_SETTINGS, type DraftState, type GorgiasTicketSnapshot } from "./types.js";

const sampleGorgiasTicket: GorgiasTicketSnapshot = {
  id: "904128",
  subject: "Where is my order #10842?",
  customerName: "Sarah Connor",
  customerEmail: "sarah@cyberdyne.com",
  messages: [
    {
      id: "msg_1",
      channel: "email",
      body_html: "<p>Hi, I ordered 3 items last Friday and haven't received a tracking update yet.</p>",
      from_agent: false,
      sender: {
        name: "Sarah Connor",
        email: "sarah@cyberdyne.com",
      },
      created_datetime: "2026-11-16T10:00:00Z",
    },
    {
      id: "msg_2",
      channel: "internal-note",
      body_text: "Shopify carrier fulfillment delayed due to weather in central hub.",
      from_agent: true,
      sender: {
        name: "Support Admin",
        email: "admin@store.com",
      },
      created_datetime: "2026-11-16T10:05:00Z",
    },
  ],
  orderContext: {
    orderId: "shopify_order_5521",
    orderNumber: "#10842",
    totalPrice: 149.99,
    financialStatus: "paid",
    fulfillmentStatus: "in_transit",
    trackingNumber: "UPS-1Z9999999999999999",
  },
  customFields: {
    vip_customer: true,
  },
  url: "https://store.gorgias.com/app/ticket/904128",
};

describe("Gorgias Capture Adapter Unit Suite", () => {
  it("criterion 1: detects draft landing in reply box and shows Draft inserted · N words", () => {
    const detector = createGorgiasDraftDetector({ minDraftChars: 25 });
    expect(detector.current()).toBeNull();

    // Sudden paste / macro insertion
    const draftText = "Hello Sarah, your order has shipped and tracking number is UPS-1Z9999999999999999.";
    const detected = detector.onReplyBox(draftText, false);

    expect(detected).not.toBeNull();
    expect(detected?.origin).toBe("preloaded");
    expect(detected?.wordCount).toBe(11);
    expect(statusLine(detected, null)).toBe("Draft inserted · 11 words");

    // AI assist draft
    detector.reset();
    const aiDraftText = "Hi Sarah, thank you for checking in. Your shipment is in transit with UPS.";
    const aiDetected = detector.onReplyBox(aiDraftText, true);
    expect(aiDetected).not.toBeNull();
    expect(aiDetected?.origin).toBe("ai_assist");
    expect(statusLine(aiDetected, null)).toBe("Draft from AI assist · 14 words");
  });

  it("criterion 2: offers support reason codes by default with order context fields", () => {
    const settings = settingsFrom({
      agent: "ecommerce-support",
      require_reason: "true",
      reason_pack: "support",
      include_order_context: "true",
    });

    expect(settings.agent).toBe("ecommerce-support");
    expect(settings.requireReason).toBe(true);
    expect(settings.reasonPack).toBe("support");

    const reasons = quickReasons(settings);
    expect(reasons.length).toBeGreaterThan(5);
    expect(reasons.some((r) => r.code === "wrong_amount_or_date")).toBe(true);

    const orderFields = extractOrderFields(sampleGorgiasTicket, settings);
    expect(orderFields.order_id).toBe("shopify_order_5521");
    expect(orderFields.order_number).toBe("#10842");
    expect(orderFields.order_total).toBe(149.99);
    expect(orderFields.tracking_number).toBe("UPS-1Z9999999999999999");
  });

  it("criterion 3: generates POST /v1/capture payload with source: gorgias and externalId: gr:<id>", () => {
    const draft: DraftState = {
      text: "Hello Sarah, your order has shipped and tracking number is UPS-1Z9999999999999999.",
      origin: "ai_assist",
      at: 1700000000000,
      wordCount: 12,
    };

    const decision = decideOnSend({
      ticket: sampleGorgiasTicket,
      draft,
      send: {
        text: "Hello Sarah, your order has shipped and tracking number is UPS-1Z9999999999999999.",
        isInternalNote: false,
      },
      reasonCode: null,
      reason: "",
      actor: "support@store.com",
      settings: DEFAULT_SETTINGS,
      now: 1700000025000,
    });

    expect(decision.action).toBe("capture");
    if (decision.action === "capture") {
      expect(decision.changed).toBe(false);
      expect(decision.body.source).toBe("gorgias");
      expect(decision.body.externalId).toBe("gr:904128");
      expect(decision.body.tags).toContain("draft:ai");
      expect(decision.body.tags).toContain("public-reply");
      expect(decision.body.draft.fields?.order_number).toBe("#10842");
      expect(decision.body.context.length).toBe(2);
      expect(decision.body.context[0].role).toBe("customer");
      expect(decision.body.context[1].role).toBe("note");
    }
  });

  it("criterion 4: honours require_reason when the draft was changed", () => {
    const draft: DraftState = {
      text: "Hello Sarah, your order is pending and will ship next week.",
      origin: "ai_assist",
      at: 1700000000000,
      wordCount: 11,
    };

    // Edited without reason
    const blocked = decideOnSend({
      ticket: sampleGorgiasTicket,
      draft,
      send: {
        text: "Hello Sarah, great news! Your order is already on the delivery vehicle today.",
        isInternalNote: false,
      },
      reasonCode: null,
      reason: "",
      actor: "agent@store.com",
      settings: { ...DEFAULT_SETTINGS, requireReason: true },
    });
    expect(blocked.action).toBe("need-reason");

    // Edited with reason
    const valid = decideOnSend({
      ticket: sampleGorgiasTicket,
      draft,
      send: {
        text: "Hello Sarah, great news! Your order is already on the delivery vehicle today.",
        isInternalNote: false,
      },
      reasonCode: "wrong_amount_or_date",
      reason: "Corrected inaccurate dispatch estimate",
      actor: "agent@store.com",
      settings: { ...DEFAULT_SETTINGS, requireReason: true },
    });

    expect(valid.action).toBe("capture");
    if (valid.action === "capture") {
      expect(valid.changed).toBe(true);
      expect(valid.body.reasonCode).toBe("wrong_amount_or_date");
      expect(valid.body.reason).toBe("Corrected inaccurate dispatch estimate");
    }
  });

  it("criterion 5: never blocks send and skips gracefully on empty/no-draft", () => {
    const noDraft = decideOnSend({
      ticket: sampleGorgiasTicket,
      draft: null,
      send: { text: "Quick message", isInternalNote: false },
      reasonCode: null,
      reason: "",
      actor: "agent@store.com",
      settings: DEFAULT_SETTINGS,
    });
    expect(noDraft.action).toBe("skip");

    const emptySend = decideOnSend({
      ticket: sampleGorgiasTicket,
      draft: { text: "Some draft", origin: "manual", at: Date.now(), wordCount: 2 },
      send: { text: "   ", isInternalNote: false },
      reasonCode: null,
      reason: "",
      actor: "agent@store.com",
      settings: DEFAULT_SETTINGS,
    });
    expect(emptySend.action).toBe("skip");
  });

  it("stripHtml cleans rich HTML tags correctly", () => {
    expect(stripHtml("<div>Order status: <b>Shipped</b><br/>Thanks!</div>")).toBe(
      "Order status: Shipped\nThanks!",
    );
  });
});
