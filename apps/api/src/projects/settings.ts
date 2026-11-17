import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { type ProjectSettings, projectSettingsSchema } from "@overturn-ai/shared";

const ENC_PREFIX = "enc:v1:";
const SENSITIVE_KEY_RE = /(?:Secret|WebhookUrl)$/;

function deriveKey(secret?: string): Buffer {
  const material =
    secret ?? process.env.SETTINGS_ENCRYPTION_KEY ?? process.env.AUTH_SECRET ?? "dev-secret-change-me";
  return createHash("sha256").update(material).digest();
}

/** Encrypts a plaintext secret string with AES-256-GCM (`enc:v1:<iv>:<tag>:<ciphertext>`). */
export function encryptSecret(plaintext: string, secret?: string): string {
  if (plaintext.startsWith(ENC_PREFIX)) return plaintext;
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

/**
 * Decrypts an `enc:v1:...` envelope back to plaintext. Plaintext values written before
 * encryption-at-rest was enabled are returned unchanged; tampered or wrong-key values return null.
 */
export function decryptSecret(value: string, secret?: string): string | null {
  if (!value.startsWith(ENC_PREFIX)) return value;
  const parts = value.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) return null;
  try {
    const iv = Buffer.from(parts[0]!, "base64url");
    const tag = Buffer.from(parts[1]!, "base64url");
    const ct = Buffer.from(parts[2]!, "base64url");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function transformSecrets(
  value: unknown,
  mode: "encrypt" | "decrypt",
  secret?: string,
  keyName = "",
): unknown {
  if (typeof value === "string") {
    if (mode === "decrypt" && value.startsWith(ENC_PREFIX)) {
      return decryptSecret(value, secret);
    }
    if (mode === "encrypt" && value.length > 0 && SENSITIVE_KEY_RE.test(keyName)) {
      return encryptSecret(value, secret);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => transformSecrets(item, mode, secret, keyName));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = transformSecrets(v, mode, secret, k);
    }
    return out;
  }
  return value;
}

/** Encrypts sensitive project settings fields (`reviewWebhookUrl`, `*Secret`) before JSONB storage. */
export function encryptSettings<T extends Record<string, unknown>>(settings: T, secret?: string): T {
  return transformSecrets(settings, "encrypt", secret) as T;
}

/** Settings as stored (jsonb, possibly older shape or encrypted at rest) → current defaults filled in. */
export function parseSettings(raw: unknown, secret?: string): ProjectSettings {
  const decrypted = transformSecrets(raw ?? {}, "decrypt", secret);
  const parsed = projectSettingsSchema.safeParse(decrypted);
  return parsed.success ? parsed.data : projectSettingsSchema.parse({});
}
