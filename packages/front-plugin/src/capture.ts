import type { CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import { normalizeCaptureText, REASON_PACKS, type ReasonPack, reasonPackFrom } from "@overturn-ai/shared/capture";

export interface FrontSettings {
  baseUrl: string;
  agent: string;
  requireReason: boolean;
  reasonPack: ReasonPack;
  minDraftChars: number;
}

export const DEFAULT_SETTINGS: FrontSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  reasonPack: "support",
  minDraftChars: 80,
};

export function stripHtml(html: string): string {
  return normalizeCaptureText(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

export async function capture(settings: FrontSettings, body: CaptureCreate): Promise<any> {
  const url = `${settings.baseUrl}/v1/capture`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Capture failed: ${response.statusText}`);
  return response.json();
}