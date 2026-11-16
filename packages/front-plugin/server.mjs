import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const apiKey = process.env.OVERTURN_API_KEY;
const frontSecret = process.env.FRONT_PLUGIN_SECRET;
const apiUrl = (process.env.OVERTURN_API_URL ?? "https://api.overturn.run").replace(/\/+$/, "");
if (!apiKey || !frontSecret) throw new Error("OVERTURN_API_KEY and FRONT_PLUGIN_SECRET are required");

const session = createHash("sha256").update(`overturn-front:${frontSecret}`).digest("hex");
const equal = (given, expected) => {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
const authorized = (request) => {
  const cookie = request.headers.cookie?.match(/(?:^|;\s*)ov_front=([^;]+)/)?.[1];
  return equal(cookie, session);
};

const files = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/main.js": ["main.js", "application/javascript; charset=utf-8"],
  "/config.js": ["config.js", "application/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    if (!equal(url.searchParams.get("auth_secret"), frontSecret)) {
      response.writeHead(401).end("Unauthorized");
      return;
    }
    response.setHeader("Set-Cookie", `ov_front=${session}; HttpOnly; Secure; SameSite=None; Path=/`);
  } else if (!authorized(request)) {
    response.writeHead(401).end("Unauthorized");
    return;
  }

  if (request.method === "POST" && url.pathname === "/capture") {
    // The session cookie rides along on any POST to this host, including a
    // cross-site form post (which can carry a text/plain body). Three checks
    // keep that from becoming a CSRF channel: the Origin must be this host,
    // the content type must be JSON, and the request must carry the custom
    // header a cross-site form cannot set (and a cross-site fetch cannot set
    // without a CORS preflight this server never answers).
    const origin = request.headers.origin;
    let originHost = null;
    try {
      originHost = origin ? new URL(origin).host : null;
    } catch {
      originHost = "invalid";
    }
    if (origin && originHost !== request.headers.host) {
      response.writeHead(403).end("Cross-origin capture rejected");
      return;
    }
    if (request.headers["x-overturn-capture"] !== "1") {
      response.writeHead(403).end("Missing capture header");
      return;
    }
    if (!/^application\/json\b/.test(request.headers["content-type"] ?? "")) {
      response.writeHead(415).end("Expected application/json");
      return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1_000_000) {
          response.writeHead(413).end("Payload too large");
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = JSON.parse(body);
      if (payload?.source !== "front") {
        response.writeHead(400).end("Expected Front capture");
        return;
      }
      const upstream = await fetch(`${apiUrl}/v1/capture`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      response.writeHead(upstream.status, { "Content-Type": "application/json" });
      response.end(await upstream.text());
    } catch {
      response.writeHead(502).end("Capture failed");
    }
    return;
  }

  const file = files[url.pathname];
  if (request.method !== "GET" || !file) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    const target = path.join(root, file[0]);
    response.writeHead(200, { "Content-Type": file[1], "Content-Length": statSync(target).size });
    createReadStream(target).pipe(response);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(Number(process.env.PORT ?? 3000));
