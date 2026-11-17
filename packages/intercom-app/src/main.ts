import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createAdapter, type BridgeConversation, type CanvasRequest, type DraftEvent, type SentEvent } from "./adapter.js";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function conversation(value: unknown): BridgeConversation | null {
  const raw = object(value);
  if (!raw || typeof raw.id !== "string" || !raw.id || !Array.isArray(raw.messages)) return null;
  const messages: BridgeConversation["messages"] = [];
  for (const item of raw.messages) {
    const msg = object(item);
    if (!msg || !["customer", "agent", "note", "system"].includes(String(msg.role)) || typeof msg.content !== "string") return null;
    messages.push({ role: msg.role as BridgeConversation["messages"][number]["role"], content: msg.content, ...(typeof msg.author === "string" ? { author: msg.author } : {}), ...(typeof msg.at === "string" ? { at: msg.at } : {}) });
  }
  return { id: raw.id, messages, subject: typeof raw.subject === "string" ? raw.subject : null, url: typeof raw.url === "string" ? raw.url : null };
}
function signatureValid(raw: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected); const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
export function startServer(env: NodeJS.ProcessEnv = process.env) {
  if (!env.OVERTURN_API_KEY || !env.INTERCOM_BRIDGE_TOKEN || !env.INTERCOM_CLIENT_SECRET) throw new Error("Set OVERTURN_API_KEY, INTERCOM_BRIDGE_TOKEN and INTERCOM_CLIENT_SECRET");
  const adapter = createAdapter({ apiKey: env.OVERTURN_API_KEY, bridgeToken: env.INTERCOM_BRIDGE_TOKEN, clientSecret: env.INTERCOM_CLIENT_SECRET, settings: { overturn_base_url: env.OVERTURN_BASE_URL, agent: env.OVERTURN_AGENT, reason_pack: env.REASON_PACK, require_reason: env.REQUIRE_REASON } });
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { reply(res, 404, { error: "not found" }); return; }
    try {
      const bytes = await readBody(req);
      const path = req.url?.split("?")[0];
      const canvas = path === "/canvas/initialize" || path === "/canvas/submit";
      if (canvas && !signatureValid(bytes, req.headers["x-body-signature"]?.toString() ?? "", env.INTERCOM_CLIENT_SECRET!)) { reply(res, 401, { error: "unauthorized" }); return; }
      const raw: unknown = JSON.parse(bytes.toString("utf8"));
      const body = object(raw);
      if (!body) { reply(res, 400, { error: "invalid body" }); return; }
      if (canvas) {
        const cnv = object(body.conversation);
        if (typeof cnv?.id !== "string" || !cnv.id) { reply(res, 400, { error: "missing conversation" }); return; }
        if (path === "/canvas/initialize") reply(res, 200, adapter.canvas(cnv.id));
        else reply(res, 200, await adapter.submit({ conversation: { id: cnv.id }, component_id: typeof body.component_id === "string" ? body.component_id : "", input_values: object(body.input_values) ?? {} } satisfies CanvasRequest));
        return;
      }
      const token = (req.headers.authorization ?? "").replace(/^Bearer /i, "");
      if (path === "/bridge/draft" || path === "/bridge/sent") {
        const cnv = conversation(body.conversation);
        if (!cnv || typeof body.text !== "string") { reply(res, 400, { error: "invalid conversation or text" }); return; }
        const result = path === "/bridge/draft"
          ? await adapter.draft({ conversation: cnv, text: body.text, origin: typeof body.origin === "string" ? body.origin : undefined, fields: object(body.fields) ?? undefined, at: typeof body.at === "number" ? body.at : undefined, runId: typeof body.runId === "string" ? body.runId : undefined, model: typeof body.model === "string" ? body.model : undefined } satisfies DraftEvent, token)
          : await adapter.sent({ conversation: cnv, text: body.text, fields: object(body.fields) ?? undefined, actor: typeof body.actor === "string" ? body.actor : undefined, at: typeof body.at === "number" ? body.at : undefined } satisfies SentEvent, token);
        reply(res, result.ok ? 200 : 401, result); return;
      }
      reply(res, 404, { error: "not found" });
    } catch { reply(res, 400, { error: "invalid request" }); }
  });
  return server;
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startServer().listen(Number(process.env.PORT ?? "3000"), () => console.log("Intercom Canvas Kit adapter listening"));
}
