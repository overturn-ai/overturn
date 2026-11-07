import type { CaptureAnswer, CaptureMessage } from "./schemas.js";

/** Whitespace-insensitive comparison: a re-wrapped paragraph is the same answer. */
export function normalizeCaptureText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}

/**
 * The answer a capture freezes: the text alone when there are no fields, else the fields
 * with the text under `reply`. That shape is what the auto scorer expects: short fields are
 * scored exactly, the prose is left to the judge.
 */
export function captureAnswerValue(a: CaptureAnswer): unknown {
  const text = a.text.trim();
  const fields = a.fields ?? {};
  if (Object.keys(fields).length === 0) return text;
  return { ...fields, reply: text };
}

export interface CaptureDiff {
  changed: boolean;
  textChanged: boolean;
  changedFields: string[];
}

/** What the expert changed between the draft and what they sent. */
export function diffCaptureAnswers(draft: CaptureAnswer, sent: CaptureAnswer): CaptureDiff {
  const textChanged = normalizeCaptureText(draft.text) !== normalizeCaptureText(sent.text);
  const keys = new Set([...Object.keys(draft.fields ?? {}), ...Object.keys(sent.fields ?? {})]);
  const changedFields = [...keys]
    .filter((k) => stableJson(draft.fields?.[k] ?? null) !== stableJson(sent.fields?.[k] ?? null))
    .sort();
  return { changed: textChanged || changedFields.length > 0, textChanged, changedFields };
}

const ROLE_LABEL: Record<CaptureMessage["role"], string> = {
  customer: "Customer",
  agent: "Agent",
  note: "Internal note",
  system: "System",
};

/** The thread rendered as the user turn of the frozen prompt, oldest first. */
export function renderCaptureContext(
  context: CaptureMessage[],
  opts: { subject?: string | null; fields?: Record<string, unknown> } = {},
): string {
  const parts: string[] = [];
  if (opts.subject) parts.push(`Subject: ${opts.subject}`);
  const fieldKeys = Object.keys(opts.fields ?? {});
  if (fieldKeys.length > 0) {
    parts.push(`Fields to decide: ${fieldKeys.join(", ")}\nCurrent values: ${JSON.stringify(opts.fields)}`);
  }
  for (const m of context) {
    const who = m.author ? `${ROLE_LABEL[m.role]} (${m.author})` : ROLE_LABEL[m.role];
    const when = m.at ? ` · ${m.at}` : "";
    parts.push(`${who}${when}:\n${m.content.trim()}`);
  }
  return parts.join("\n\n");
}

/** The system turn of the frozen prompt: what the drafting model was asked to do. */
export function captureSystemPrompt(agent: string, source: string): string {
  return `You are drafting the next reply for the "${agent}" workflow in ${source}. Answer the thread below as the expert on this team would: accurate, complete, and in the team's voice. When decision fields are listed, return the reply text and the decided values.`;
}

/** The claims pack: one regression suite per workflow. */
export const CLAIMS_AGENTS = { reply: "claims-reply", decision: "coverage-decision" } as const;

/** The claims pack: the fields that are the decision. Scored exactly; the letter around them is not. */
export const CLAIMS_DECISION_FIELDS = ["coverage", "reserve", "denial_reason"] as const;

/** The claims pack: why an adjuster changed a draft, as codes the scorecard counts. */
export const CLAIMS_REASON_CODES = [
  { code: "wrong_coverage_decision", label: "Wrong coverage decision" },
  { code: "missed_exclusion", label: "Missed exclusion" },
  { code: "reserve_too_low", label: "Reserve too low" },
  { code: "reserve_too_high", label: "Reserve too high" },
  { code: "wrong_amount_or_date", label: "Wrong amount or date" },
  { code: "missing_required_step", label: "Missing required step" },
  { code: "tone_wording", label: "Tone / wording" },
  { code: "policy_exception", label: "Policy exception" },
] as const;

/** The support pack: why any support or ops agent changed an AI draft. Vendor- and domain-neutral. */
export const SUPPORT_REASON_CODES = [
  { code: "wrong_answer", label: "Wrong answer" },
  { code: "missing_information", label: "Missing information" },
  { code: "wrong_amount_or_date", label: "Wrong amount or date" },
  { code: "missing_required_step", label: "Missing required step" },
  { code: "against_policy", label: "Against policy" },
  { code: "should_escalate", label: "Should have escalated" },
  { code: "tone_wording", label: "Tone / wording" },
  { code: "wrong_language_or_format", label: "Wrong language / format" },
] as const;

export type ReasonPack = "claims" | "support";
export type ReasonCodeOption = { readonly code: string; readonly label: string };

/** The quick-pick reasons an installer chooses from; one pack per workflow. */
export const REASON_PACKS: Record<ReasonPack, readonly ReasonCodeOption[]> = {
  claims: CLAIMS_REASON_CODES,
  support: SUPPORT_REASON_CODES,
};

export function reasonPackFrom(raw: unknown): ReasonPack {
  return raw === "support" ? "support" : "claims";
}

/** Corrections with these codes are kept as evidence but never enter the suite or the export. */
export const SUITE_EXCLUDED_REASON_CODES: readonly string[] = ["tone_wording"];

export function reasonCodeLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  for (const pack of Object.values(REASON_PACKS)) {
    const hit = pack.find((c) => c.code === code);
    if (hit) return hit.label;
  }
  return code.replace(/_/g, " ");
}
