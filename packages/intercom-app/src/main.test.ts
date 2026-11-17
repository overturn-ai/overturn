import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { startServer } from "./main.js";

let server: Server | undefined;
afterEach(async () => { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; });
describe("signed Canvas HTTP routes", () => {
  it("requires Intercom signature and bridge token, and returns a Canvas", async () => {
    server = startServer({ OVERTURN_API_KEY: "key", INTERCOM_CLIENT_SECRET: "client-secret", INTERCOM_BRIDGE_TOKEN: "bridge-token" });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no TCP port");
    const base = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({ conversation: { id: "test" } });
    const unsigned = await fetch(`${base}/canvas/initialize`, { method: "POST", body: payload });
    expect(unsigned.status).toBe(401);
    const signed = await fetch(`${base}/canvas/initialize`, { method: "POST", body: payload, headers: { "X-Body-Signature": createHmac("sha256", "client-secret").update(payload).digest("hex") } });
    expect(signed.status).toBe(200);
    expect(JSON.stringify(await signed.json())).toContain("Waiting for a draft");
    const bridge = await fetch(`${base}/bridge/draft`, { method: "POST", headers: { Authorization: "Bearer bridge-token", "Content-Type": "application/json" }, body: JSON.stringify({ conversation: { id: "test", messages: [] }, text: "Fin suggests this", origin: "fin_assist" }) });
    expect(await bridge.json()).toMatchObject({ ok: true, status: "draft-recorded" });
    const refreshed = await fetch(`${base}/canvas/initialize`, { method: "POST", body: payload, headers: { "X-Body-Signature": createHmac("sha256", "client-secret").update(payload).digest("hex") } });
    expect(JSON.stringify(await refreshed.json())).toContain("Draft inserted · 3 words");
  });
});
