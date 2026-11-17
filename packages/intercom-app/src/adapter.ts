import type { CaptureCreate } from "@overturn-ai/shared";
import { timingSafeEqual } from "node:crypto";
import { decideOnSend, DEFAULT_SETTINGS, originFrom, quickReasons, settingsFrom, statusLine, type ConversationSnapshot, type DraftState } from "./capture.js";

export interface BridgeConversation extends Omit<ConversationSnapshot, "messages"> {
  messages: Array<{ role: "customer" | "agent" | "note" | "system"; content: string; author?: string; at?: string }>;
}
export interface DraftEvent { conversation: BridgeConversation; text: string; origin?: string; at?: number; fields?: Record<string, unknown>; runId?: string; model?: string }
export interface SentEvent { conversation: BridgeConversation; text: string; fields?: Record<string, unknown>; actor?: string; at?: number }
export interface CanvasRequest { conversation: { id: string }; component_id: string; input_values?: Record<string, unknown> }
type Canvas = { canvas: { content: { components: Array<Record<string, unknown>> } } };
interface State { draft: DraftState; reasonCode: string | null; note: string; status: string | null; pending?: SentEvent }
export interface AdapterOptions { apiKey: string; bridgeToken: string; clientSecret: string; settings?: Record<string, unknown>; postCapture?: (body: CaptureCreate) => Promise<{ ok: boolean }> }
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function createAdapter(options: AdapterOptions) {
  const settings = settingsFrom(options.settings ?? {});
  const states = new Map<string, State>();
  const post = options.postCapture ?? (async (body: CaptureCreate) => {
    const response = await fetch(`${settings.baseUrl}/v1/capture`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` }, body: JSON.stringify(body) });
    return { ok: response.ok };
  });
  const authenticated = (token: string) => !!token && equal(token, options.bridgeToken);
  return {
    canvas(id: string): Canvas {
      const state = states.get(id);
      const components: Array<Record<string, unknown>> = [
        { type: "text", id: "draft_status", text: statusLine(state?.draft ?? null) },
        { type: "single-select", id: "reason_code", label: "Why did you change it?", options: quickReasons(settings).map((r) => ({ type: "option", id: r.code, text: r.label })) },
        { type: "textarea", id: "reason_note", label: "Anything else? (optional)", placeholder: "Optional note" },
        { type: "button", id: "save_reason", label: "Save reason", style: "primary", action: { type: "submit" } },
      ];
      if (state?.status) components.push({ type: "text", id: "capture_status", text: state.status });
      return { canvas: { content: { components } } };
    },
    async submit(request: CanvasRequest): Promise<Canvas> {
      const state = states.get(request.conversation.id);
      if (state && request.component_id === "save_reason") {
        const code = request.input_values?.reason_code;
        state.reasonCode = typeof code === "string" && quickReasons(settings).some((r) => r.code === code) ? code : null;
        const note = request.input_values?.reason_note;
        state.note = typeof note === "string" ? note : "";
        state.status = state.reasonCode ? "Reason saved" : "Select a reason before changing a draft";
        if (state.reasonCode && state.pending) await this.sent(state.pending, options.bridgeToken);
      }
      return this.canvas(request.conversation.id);
    },
    async draft(event: DraftEvent, token: string): Promise<{ ok: boolean; status: string }> {
      if (!authenticated(token)) return { ok: false, status: "unauthorized" };
      if (!event.conversation?.id || !event.text?.trim()) return { ok: false, status: "invalid-draft" };
      states.set(event.conversation.id, { draft: { text: event.text, origin: originFrom(event.origin), at: event.at ?? Date.now(), fields: event.fields, runId: event.runId, model: event.model }, reasonCode: null, note: "", status: null });
      return { ok: true, status: "draft-recorded" };
    },
    async sent(event: SentEvent, token: string): Promise<{ ok: boolean; status: string }> {
      if (!authenticated(token)) return { ok: false, status: "unauthorized" };
      if (!event.conversation?.id || typeof event.text !== "string") return { ok: false, status: "invalid-send" };
      const state = states.get(event.conversation.id);
      const decision = decideOnSend({ conversation: event.conversation, draft: state?.draft ?? null, sent: { text: event.text, fields: event.fields }, actor: event.actor ?? null, reasonCode: state?.reasonCode ?? null, reason: state?.note ?? "", settings, now: event.at });
      if (decision.action === "skip") {
        if (state && decision.why === "reason-required") {
          state.pending = event;
          state.status = "Select a reason; reply was already sent (capture pending)";
        }
        return { ok: true, status: decision.why };
      }
      try {
        if (!(await post(decision.body)).ok) throw new Error("capture HTTP error");
        states.delete(event.conversation.id);
        return { ok: true, status: "captured" };
      } catch {
        if (state) state.status = "Capture failed; reply was sent (retry capture from bridge)";
        return { ok: true, status: "capture-failed" };
      }
    },
  };
}
