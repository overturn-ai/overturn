/**
 * Redaction at the export boundary. The record keeps what the expert saw (replay needs it);
 * what leaves as training data does not. Presets cover the identifiers every claims thread
 * carries; custom patterns are regex sources an admin adds per project.
 */
export const REDACT_PRESETS = {
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  phone: /(?<![\d-])(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b(?![\d-])/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  card: /\b(?:\d[ -]?){13,19}\b/g,
} as const;
export type RedactPreset = keyof typeof REDACT_PRESETS;
export const REDACT_PRESET_NAMES = Object.keys(REDACT_PRESETS) as RedactPreset[];

export interface RedactSpec {
  presets: RedactPreset[];
  /** Regex sources, applied with the g and i flags. Invalid sources are skipped. */
  patterns: string[];
}

export function redactString(s: string, spec: RedactSpec): string {
  let out = s;
  for (const p of spec.presets) {
    const re = REDACT_PRESETS[p];
    if (re) out = out.replace(re, `[${p.toUpperCase()}]`);
  }
  for (const src of spec.patterns) {
    let re: RegExp;
    try {
      re = new RegExp(src, "gi");
    } catch {
      continue;
    }
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

/** Walks any JSON value and redacts every string in it. Keys are left alone. */
export function redactValue<T>(v: T, spec: RedactSpec): T {
  if (spec.presets.length === 0 && spec.patterns.length === 0) return v;
  if (typeof v === "string") return redactString(v, spec) as T;
  if (Array.isArray(v)) return v.map((x) => redactValue(x, spec)) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = redactValue(x, spec);
    return out as T;
  }
  return v;
}

/** "email,phone,custom:\\bclaim-\\d+" style CSV from a query string into a spec; "none" is empty. */
export function parseRedactSpec(csv: string | null | undefined, fallback: RedactSpec): RedactSpec {
  if (csv === null || csv === undefined || csv.trim() === "") return fallback;
  if (csv.trim() === "none") return { presets: [], patterns: [] };
  const presets: RedactPreset[] = [];
  const patterns: string[] = [];
  for (const part of csv.split(",")) {
    const t = part.trim();
    if (!t) continue;
    if (t.startsWith("custom:")) patterns.push(t.slice("custom:".length));
    else if ((REDACT_PRESET_NAMES as string[]).includes(t)) presets.push(t as RedactPreset);
  }
  return { presets, patterns };
}
