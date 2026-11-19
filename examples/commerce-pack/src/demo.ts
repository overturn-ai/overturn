/**
 * The commerce pack end to end, against a real Overturn.
 *
 *   OVERTURN_API_KEY=ov_live_... pnpm --filter @overturn-ai/example-commerce-pack demo
 *
 * A buying agent orders the wrong mug; the customer refunds it; Stripe posts the refund to the
 * webhook; the refund becomes a case; the case is replayed. Nothing here is commerce-specific
 * below the webhook: the event lands as an ordinary correction on the run that bought the thing.
 */
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Overturn } from "@overturn-ai/sdk";
import type { CaptureStats, Project, PurchaseSnapshot } from "@overturn-ai/shared";
import { formatMoney } from "@overturn-ai/shared";

export const WEBHOOK_SECRET = "whsec_demo_commerce_pack";

const CATALOGUE = [
  { sku: "MUG-B", title: "Blue mug, 12oz", quantity: 1, unitPriceCents: 1200 },
  { sku: "MUG-R", title: "Red mug, 12oz", quantity: 1, unitPriceCents: 1100 },
  { sku: "MUG-B-16", title: "Blue mug, 16oz", quantity: 1, unitPriceCents: 1600 },
];

export const SNAPSHOT: PurchaseSnapshot = {
  instruction: "We're low on the blue mugs the office uses. Reorder two, nothing over $30 each.",
  cart: [],
  catalogue: CATALOGUE,
  budgetCents: 6000,
  currency: "usd",
};

/** What the agent decided — the red mug, because the blue one was out of stock that morning. */
export const WRONG_DECISION = { action: "buy" as const, items: [{ sku: "MUG-R", quantity: 2 }] };

/** A Stripe refund event, signed the way Stripe signs one. */
export function stripeRefund(opts: {
  paymentIntent: string;
  amountCents: number;
  metadata: Record<string, string>;
}): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify({
    id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    type: "charge.refunded",
    data: {
      object: {
        id: `ch_${Math.random().toString(36).slice(2, 10)}`,
        payment_intent: opts.paymentIntent,
        amount: opts.amountCents,
        amount_refunded: opts.amountCents,
        currency: "usd",
        refunds: { data: [{ reason: "requested_by_customer" }] },
        metadata: opts.metadata,
      },
    },
  });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
  return { body, headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}` } };
}

export interface DemoResult {
  runId: string;
  caseId: string | null;
  amountCents: number;
  attributedCents: number;
  pendingCents: number;
  lostByModel: CaptureStats["cost"]["byModel"];
}

export async function runDemo(ov: Overturn, baseUrl: string): Promise<DemoResult> {
  // 0. The project trusts this signing secret. In production you paste it in Settings → Commerce.
  const project = await ov.api.request<Project>("PATCH", "/v1/project", {
    settings: { commerce: { stripeWebhookSecret: WEBHOOK_SECRET } },
  });

  // 1. The agent decides, and we record what it saw. The returned metadata rides on the payment.
  const orderId = `order_${Date.now()}`;
  const { runId, metadata } = await ov.recordPurchase({
    externalId: orderId,
    agent: "purchasing-agent",
    snapshot: SNAPSHOT,
    decision: WRONG_DECISION,
    model: "openai/gpt-4.1-mini",
    agentVersion: "buyer-2.1",
  });

  // 2. The customer refunds it: wrong mug, the blue 12oz was what they wanted.
  const { body, headers } = stripeRefund({
    paymentIntent: orderId,
    amountCents: 2200,
    metadata: {
      ...metadata,
      overturn_corrected_sku: "MUG-B",
      overturn_corrected_quantity: "2",
      overturn_reason_code: "wrong_item",
    },
  });
  const res = await fetch(`${baseUrl}/v1/commerce/webhooks/stripe/${project.id}`, {
    method: "POST",
    headers,
    body,
  });
  const delivered = (await res.json()) as { caseId?: string | null; amountCents?: number; skipped?: string };
  if (delivered.skipped) throw new Error(`webhook did nothing: ${delivered.skipped}`);

  // 3. A person says the agent was at fault. Without this the refund is money that moved: on the
  // scorecard as pending, out of the suite. Most refunds stop here, and should.
  const [correction] = await ov.api.request<{ id: string }[]>("GET", "/v1/corrections", undefined, { runId });
  await ov.api.request("PATCH", `/v1/corrections/${correction!.id}/attribution`, {
    reasonCode: "wrong_variant",
    note: "ordered the red mug; the instruction asked for blue",
  });

  // 4. The money is on the scorecard, against the model version that spent it.
  const stats = await ov.api.request<CaptureStats>("GET", "/v1/capture/stats", undefined, { days: 30 });
  return {
    runId,
    caseId: delivered.caseId ?? null,
    amountCents: delivered.amountCents ?? 0,
    attributedCents: stats.cost.attributedCents,
    pendingCents: stats.cost.pendingCents,
    lostByModel: stats.cost.byModel,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const apiKey = process.env.OVERTURN_API_KEY;
  if (!apiKey) throw new Error("OVERTURN_API_KEY is required");
  const baseUrl = process.env.OVERTURN_BASE_URL ?? "https://api.overturn.run";
  const ov = new Overturn({ apiKey, baseUrl });
  const out = await runDemo(ov, baseUrl);
  console.log(`run ${out.runId}`);
  console.log(`case ${out.caseId} — ${formatMoney(out.amountCents)} refunded, attributed to the agent`);
  console.log(`scorecard: ${formatMoney(out.attributedCents)} lost to agent errors`);
  for (const m of out.lostByModel)
    console.log(`  ${m.model} ${m.agentVersion ?? ""}: ${formatMoney(m.attributedCents)} lost`);
  console.log("\nnpx overturn replay --model <model> --tag commerce   # the case is in the suite now");
  await ov.shutdown();
}
