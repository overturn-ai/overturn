import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import { createHttpCaptureTransport } from "./transport";

const body: CaptureCreate = {
  source: "intercom",
  externalId: "ic:conv_1",
  agent: "support-reply",
  context: [],
  draft: { text: "draft" },
  sent: { text: "sent" },
};

const result = {
  kind: "edit",
  changed: true,
  deduplicated: false,
} as unknown as CaptureResult;

describe("HTTP capture transport", () => {
  it("posts the payload to /v1/capture with the bearer key", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const transport = createHttpCaptureTransport({
      baseUrl: "https://ov.internal/",
      apiKey: "ov_live_test",
      fetchImpl,
    });
    await expect(transport.capture(body)).resolves.toStrictEqual(result);
    const call = calls[0];
    if (!call) throw new Error("no fetch call");
    const headers = (call.init?.headers ?? {}) as Record<string, string>;
    expect(call.url).toBe("https://ov.internal/v1/capture");
    expect(call.init?.method).toBe("POST");
    expect(headers.Authorization).toBe("Bearer ov_live_test");
    expect(call.init?.body).toBe(JSON.stringify(body));
  });

  it("throws with the status so the canvas can say the send was not blocked", async () => {
    const fetchImpl: typeof fetch = async () => new Response("nope", { status: 503 });
    const transport = createHttpCaptureTransport({
      baseUrl: "https://ov.internal",
      apiKey: "ov_live_test",
      fetchImpl,
      timeoutMs: 1000,
    });
    await expect(transport.capture(body)).rejects.toMatchObject({ status: 503 });
  });

  it("aborts a hanging request at the timeout", async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const transport = createHttpCaptureTransport({
      baseUrl: "https://ov.internal",
      apiKey: "ov_live_test",
      fetchImpl,
      timeoutMs: 5,
    });
    await expect(transport.capture(body)).rejects.toThrow("aborted");
  });

  it("does not leak the key into an error message", async () => {
    const fetchImpl: typeof fetch = async () => new Response("bad key", { status: 401 });
    const transport = createHttpCaptureTransport({
      baseUrl: "https://ov.internal",
      apiKey: "ov_live_secret",
      fetchImpl,
    });
    const error = await transport.capture(body).catch((e: unknown) => e);
    expect(String(error)).not.toContain("ov_live_secret");
  });
});
