import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";

declare const chrome: {
  storage: { local: { get(keys: string[]): Promise<Record<string, unknown>> } };
  runtime: { onMessage: { addListener(handler: (message: unknown, sender: { url?: string }, respond: (result: unknown) => void) => boolean | void): void } };
};

/** Credentials stay in extension storage/background, never in the ticket page or capture payload. */
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!sender.url || !/^https:\/\/[^/]+\.gorgias\.com\//.test(sender.url)) return;
  if (!message || typeof message !== "object" || !("type" in message) || message.type !== "capture" || !("body" in message)) return;
  const body = message.body as CaptureCreate;
  if (body.source !== "gorgias" || !/^gr:\d+$/.test(body.externalId)) return;
  void (async () => {
    try {
      const values = await chrome.storage.local.get(["overturn_api_key", "overturn_base_url"]);
      const key = values.overturn_api_key;
      if (typeof key !== "string" || !key) throw new Error("Configure an Overturn API key in extension options");
      const base = typeof values.overturn_base_url === "string" && values.overturn_base_url.trim() ? values.overturn_base_url.trim() : "https://api.overturn.run";
      const url = new URL("/v1/capture", base);
      if (url.protocol !== "https:") throw new Error("HTTPS Overturn URL required");
      const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json() as CaptureResult;
      respond({ ok: true, changed: result.changed, dedup: result.deduplicated });
    } catch (error) {
      respond({ ok: false, error: error instanceof Error ? error.message : "network" });
    }
  })();
  return true;
});
