import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { type CaptureTransport, handleCanvasRequest } from "./app";
import { errorCanvas } from "./canvas";
import type { AppSettings } from "./capture";
import { createHttpCaptureTransport } from "./transport";

const MAX_BODY_BYTES = 1_000_000;

export interface IntercomServerOptions {
  settings: AppSettings;
  apiKey: string;
  /** Intercom signs every Canvas Kit request with the app's OAuth client secret. */
  clientSecret?: string | null;
  capture?: CaptureTransport;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "error" | "log">;
}

/** HMAC-SHA256 of the raw request body, as Intercom's X-Body-Signature header. */
export function verifyIntercomSignature(
  rawBody: string,
  signature: string | undefined,
  clientSecret: string,
): boolean {
  if (!signature) return false;
  const provided = signature.trim().toLowerCase();
  const expected = createHmac("sha256", clientSecret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isCanvasRoute(path: string): boolean {
  return ["/", "/initialize", "/submit", "/intercom/initialize", "/intercom/submit"].includes(path);
}

/** Builds the HTTP server Intercom calls for the initialize and submit flows. */
export function createIntercomServer(opts: IntercomServerOptions): Server {
  const capture =
    opts.capture ??
    createHttpCaptureTransport({
      baseUrl: opts.settings.baseUrl,
      apiKey: opts.apiKey,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  const logger = opts.logger ?? console;

  return createHttpServer(async (req, res) => {
    if (req.method !== "POST" || !isCanvasRoute(req.url ?? "")) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 413, { error: "request body too large" });
      return;
    }
    if (opts.clientSecret) {
      const signature = req.headers["x-body-signature"];
      const header = Array.isArray(signature) ? signature[0] : signature;
      if (!verifyIntercomSignature(raw, header, opts.clientSecret)) {
        sendJson(res, 401, { error: "invalid signature" });
        return;
      }
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return;
    }
    try {
      const canvas = await handleCanvasRequest(body, {
        settings: opts.settings,
        capture,
        logger,
        now: () => Date.now(),
      });
      sendJson(res, 200, canvas);
    } catch (error) {
      // Canvas Kit can only render a response; never fail into a dead end.
      logger.error("intercom canvas request failed", error);
      sendJson(res, 200, errorCanvas(opts.settings, "Overturn could not read this request."));
    }
  });
}
