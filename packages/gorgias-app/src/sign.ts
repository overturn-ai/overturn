import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Gorgias puts the app's shared secret in the integration URL, because a custom integration can only
 * send plain query parameters. That is fine for the one call Gorgias makes, but the links the card
 * shows an agent end up in browser history, chat and screenshots: they must not carry the secret.
 *
 * So the app signs them instead. Every link carries what it is for, when it expires, and an HMAC of
 * both under the shared secret. Nothing about the secret leaves the process, a link is useless
 * outside the one action it names, and it stops working on its own.
 */

/** Long enough for a ticket left open over a shift, short enough to not be forever. */
export const LINK_TTL_MS = 24 * 60 * 60 * 1000;

export type LinkAction = "reason" | "draft";

/** What a link authorizes: one action, one ticket, and (for a reason) one code. */
export function linkPayload(action: LinkAction, ticketId: string, extra?: string): string {
  return extra === undefined ? `${action}:${ticketId}` : `${action}:${ticketId}:${extra}`;
}

function hmac(secret: string, payload: string, exp: number): string {
  return createHmac("sha256", secret).update(`${payload}:${exp}`).digest("hex").slice(0, 32);
}

export function signLink(
  secret: string,
  action: LinkAction,
  ticketId: string,
  opts: { extra?: string; now?: number; ttlMs?: number } = {},
): { exp: number; sig: string } {
  const exp = (opts.now ?? Date.now()) + (opts.ttlMs ?? LINK_TTL_MS);
  return { exp, sig: hmac(secret, linkPayload(action, ticketId, opts.extra), exp) };
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyLink(
  secret: string,
  action: LinkAction,
  ticketId: string,
  exp: string | null,
  sig: string | null,
  opts: { extra?: string; now?: number } = {},
): boolean {
  if (!exp || !sig) return false;
  const expires = Number(exp);
  if (!Number.isFinite(expires) || expires < (opts.now ?? Date.now())) return false;
  return sameSecret(sig, hmac(secret, linkPayload(action, ticketId, opts.extra), expires));
}
