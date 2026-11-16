import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import type { CaptureTransport } from "./app";

export interface HttpTransportOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Posts a capture to Overturn. Network and API failures throw; the handler catches them. */
export function createHttpCaptureTransport(opts: HttpTransportOptions): CaptureTransport {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    async capture(body: CaptureCreate): Promise<CaptureResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(`${opts.baseUrl.replace(/\/+$/, "")}/v1/capture`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          const error = new Error(`Overturn capture failed (${response.status})`);
          Object.assign(error, { status: response.status, detail });
          throw error;
        }
        const parsed: unknown = await response.json();
        return parsed as CaptureResult;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
