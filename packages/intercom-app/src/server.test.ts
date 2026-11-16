import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyIntercomSignature } from "./server";

describe("Intercom request signature", () => {
  const secret = "client-secret";
  const raw = JSON.stringify({ workspace_id: "ws_1", component_id: "capture" });
  const signature = createHmac("sha256", secret).update(raw, "utf8").digest("hex");

  it("accepts the HMAC the developer hub sends", () => {
    expect(verifyIntercomSignature(raw, signature, secret)).toBe(true);
    expect(verifyIntercomSignature(raw, signature.toUpperCase(), secret)).toBe(true);
  });

  it("rejects a missing, malformed or wrong-body signature", () => {
    expect(verifyIntercomSignature(raw, undefined, secret)).toBe(false);
    expect(verifyIntercomSignature(raw, "not-hex", secret)).toBe(false);
    expect(verifyIntercomSignature(`${raw} `, signature, secret)).toBe(false);
    expect(verifyIntercomSignature(raw, signature, "other-secret")).toBe(false);
  });
});
