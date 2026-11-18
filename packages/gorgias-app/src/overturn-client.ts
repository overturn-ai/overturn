import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import type { DraftState } from "./capture";

/** One run as the runs endpoint returns it. */
interface RunItem {
  id: string;
  output?: unknown;
  agent?: string;
  startedAt?: string | null;
}

/** What the app needs from Overturn. Small enough to mock in a test. */
export interface OverturnClient {
  /** The draft a drafting agent recorded for this ticket, if any. */
  findDraft(externalId: string, agent: string): Promise<DraftState | null>;
  /** Posts the capture and returns what Overturn made of it. */
  capture(body: CaptureCreate): Promise<CaptureResult>;
}

export interface OverturnClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Injected so a test can run the client without a network. */
  fetch?: typeof fetch;
}

/**
 * The Overturn client the app talks to.
 *
 * The draft comes from a drafting agent that recorded its run with the SDK for this ticket
 * (`externalId: "gr:<ticket id>"`). Gorgias has no endpoint for the unsent reply box, so
 * that run is the only way to know the draft was written by an assist rather than by the agent.
 */
export function createOverturnClient(options: OverturnClientOptions): OverturnClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const headers = {
    Authorization: `Bearer ${options.apiKey}`,
    "Content-Type": "application/json",
  };
  return {
    async findDraft(externalId: string, agent: string): Promise<DraftState | null> {
      const url = `${base}/v1/runs?externalId=${encodeURIComponent(externalId)}&agent=${encodeURIComponent(
        agent,
      )}&limit=1`;
      const response = await doFetch(url, { headers });
      if (!response.ok) return null;
      const payload = (await response.json()) as { items?: RunItem[] };
      const run = payload.items?.[0];
      if (!run) return null;
      const text = typeof run.output === "string" ? run.output : "";
      if (!text.trim()) return null;
      const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
      return {
        text,
        // The run is the evidence an assist wrote it.
        origin: "recorded",
        runId: run.id,
        model: null,
        at: Number.isFinite(started) ? Math.floor(started / 1000) : Math.floor(Date.now() / 1000),
      };
    },
    async capture(body: CaptureCreate): Promise<CaptureResult> {
      const response = await doFetch(`${base}/v1/capture`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Overturn answered ${response.status}`);
      return (await response.json()) as CaptureResult;
    },
  };
}
