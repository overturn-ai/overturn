import { createServer } from "node:http";
import { createHandler, type HandlerEnv } from "./handler";

/** `node dist/server.js`: the handler on Node's HTTP server, configured from the environment. */
const env = process.env as unknown as HandlerEnv;
const missing = [
  "OVERTURN_API_KEY",
  "WEBHOOK_SECRET",
  "GORGIAS_DOMAIN",
  "GORGIAS_USER",
  "GORGIAS_API_KEY",
].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing ${missing.join(", ")}; see README.md`);
  process.exit(1);
}
const handle = createHandler(env);
const port = Number(process.env.PORT ?? 8787);

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const method = req.method ?? "GET";
  const r = await handle(
    new Request(`http://localhost${req.url ?? "/"}`, {
      method,
      headers,
      ...(body && method !== "GET" && method !== "HEAD" ? { body } : {}),
    }),
  );
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(await r.text());
}).listen(port, () => console.log(`overturn-gorgias listening on :${port}`));
