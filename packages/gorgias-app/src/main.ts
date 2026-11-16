import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { configFrom } from "./config";
import { createGorgiasClient } from "./gorgias";
import { createHandler, type Handler } from "./handler";
import { createOverturnClient } from "./overturn";
import { createFileStore } from "./store";

const MAX_BODY = 256 * 1024;

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function headersFrom(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** The Node adapter: a web `Request` in, a web `Response` out, so the handler stays portable. */
export function toNodeRequestHandler(handler: Handler) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
    const payload = method === "GET" || method === "HEAD" ? undefined : await body(req);
    const response = await handler(new Request(url, { method, headers: headersFrom(req), body: payload }));
    const out = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(out);
  };
}

const config = configFrom(process.env);
const settings = config.settings;
const handler = createHandler({
  settings,
  gorgias: createGorgiasClient(config.gorgias, settings),
  overturn: createOverturnClient(config.overturn),
  // Durable by default: a restart must not lose a draft, a reason or a capture waiting for one.
  store: createFileStore(process.env.DATA_FILE ?? "./data/gorgias-state.json"),
});

const server = createServer((req, res) => {
  void toNodeRequestHandler(handler)(req, res).catch((e: unknown) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : "internal error" }));
  });
});

server.listen(config.port, () => {
  console.log(`overturn-gorgias-app listening on :${config.port} · agent ${settings.agent}`);
});
