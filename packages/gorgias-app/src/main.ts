import { createServer } from "node:http";
import { createApp, type GorgiasTicket, memoryStore, type Overturn } from "./app";
import { settingsFrom } from "./capture";

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const env = process.env;
const need = (k: string): string => {
  const v = env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const settings = settingsFrom({
  overturn_base_url: env.OVERTURN_BASE_URL,
  agent: env.OVERTURN_AGENT,
  reason_pack: env.OVERTURN_REASON_PACK,
  require_reason: env.OVERTURN_REQUIRE_REASON,
  capture_internal_notes: env.OVERTURN_CAPTURE_INTERNAL_NOTES,
  decision_fields: env.OVERTURN_DECISION_FIELDS,
  min_draft_chars: env.OVERTURN_MIN_DRAFT_CHARS,
  max_orders: env.OVERTURN_MAX_ORDERS,
});
const apiKey = need("OVERTURN_API_KEY");
const gorgiasUrl = need("GORGIAS_URL").replace(/\/+$/, "");
const gorgiasAuth = Buffer.from(`${need("GORGIAS_USERNAME")}:${need("GORGIAS_API_KEY")}`).toString("base64");

const call = async <T>(url: string, init: RequestInit, authorization: string): Promise<T> => {
  const r = await fetch(url, {
    ...init,
    headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json" },
  });
  if (!r.ok) throw new HttpError(r.status);
  return (await r.json()) as T;
};
const overturn: Overturn = {
  get: (path) => call(`${settings.baseUrl}${path}`, { method: "GET" }, `Bearer ${apiKey}`),
  post: (path, body) =>
    call(`${settings.baseUrl}${path}`, { method: "POST", body: JSON.stringify(body) }, `Bearer ${apiKey}`),
};

const app = createApp({
  settings,
  store: memoryStore(),
  overturn,
  fetchTicket: (id) =>
    call<GorgiasTicket>(
      `${gorgiasUrl}/api/tickets/${encodeURIComponent(id)}`,
      { method: "GET" },
      `Basic ${gorgiasAuth}`,
    ),
  token: need("OVERTURN_GORGIAS_TOKEN"),
  publicUrl: need("PUBLIC_URL"),
  gorgiasUrl,
  log: (m) => console.warn(`[overturn-gorgias] ${m}`),
});

const port = Number(env.PORT ?? 8788);
createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://local");
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
    void app({
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      body: Buffer.concat(chunks).toString("utf8"),
    }).then((r) => {
      res.writeHead(r.status, { "Content-Type": r.contentType ?? "application/json" });
      res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
    });
  });
}).listen(port, () => console.log(`overturn-gorgias listening on :${port}`));
