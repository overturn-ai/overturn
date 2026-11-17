import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, encryptSettings, parseSettings } from "./settings";

describe("project settings encryption at rest", () => {
  const secret = "test-encryption-key-32-bytes-seed";

  it("encrypts reviewWebhookUrl and signing secrets with AES-256-GCM and decrypts on parseSettings", () => {
    const plain = parseSettings({
      reviewWebhookUrl: "https://hooks.slack.com/services/T00/B00/X00",
    });
    const stored = encryptSettings(plain, secret);
    expect(stored.reviewWebhookUrl).toMatch(/^enc:v1:/);
    expect(stored.reviewWebhookUrl).not.toContain("hooks.slack.com");

    // Two encryptions of the same secret produce distinct ciphertexts (random 96-bit IV).
    const stored2 = encryptSettings(plain, secret);
    expect(stored2.reviewWebhookUrl).not.toBe(stored.reviewWebhookUrl);

    const roundTripped = parseSettings(stored, secret);
    expect(roundTripped.reviewWebhookUrl).toBe("https://hooks.slack.com/services/T00/B00/X00");
  });

  it("encrypts nested *Secret fields (such as commerce webhook signing secrets) without touching non-secrets", () => {
    const raw = {
      reviewWebhookUrl: "https://example.com/webhook",
      commerce: {
        stripeSigningSecret: "whsec_live_1234567890",
        ryeSigningSecret: "rye_sec_abcdef",
        provider: "stripe",
      },
    };
    const stored = encryptSettings(raw, secret) as typeof raw;
    expect(stored.reviewWebhookUrl).toMatch(/^enc:v1:/);
    expect(stored.commerce.stripeSigningSecret).toMatch(/^enc:v1:/);
    expect(stored.commerce.ryeSigningSecret).toMatch(/^enc:v1:/);
    expect(stored.commerce.provider).toBe("stripe");

    expect(decryptSecret(stored.commerce.stripeSigningSecret, secret)).toBe("whsec_live_1234567890");
    expect(decryptSecret(stored.commerce.ryeSigningSecret, secret)).toBe("rye_sec_abcdef");
  });

  it("remains backwards-compatible with legacy plaintext rows and fails closed on tampered ciphertext", () => {
    const legacy = parseSettings(
      { reviewWebhookUrl: "https://hooks.slack.com/services/T11/B22/X33" },
      secret,
    );
    expect(legacy.reviewWebhookUrl).toBe("https://hooks.slack.com/services/T11/B22/X33");

    const ct = encryptSecret("https://hooks.slack.com/services/T11/B22/X33", secret);
    expect(decryptSecret(ct, "wrong-key")).toBeNull();
    expect(parseSettings({ reviewWebhookUrl: ct }, "wrong-key").reviewWebhookUrl).toBeNull();
  });
});
