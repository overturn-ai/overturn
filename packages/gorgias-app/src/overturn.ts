import type { CaptureCreate } from "@overturn-ai/shared";
import type { RecordedRun } from "./capture";
import type { CaptureOutcome, OverturnPort } from "./handler";

export interface OverturnCredentials {
  /** `https://api.overturn.run`, or your own deployment. */
  baseUrl: string;
  /** A project API key: Settings → API keys. */
  apiKey: string;
}

export class OverturnError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OverturnError";
    this.status = status;
  }
}

interface RunRow {
  id?: unknown;
  agent?: unknown;
  output?: unknown;
  model?: unknown;
  endedAt?: unknown;
}

/** The Overturn API, over fetch: the drafting agent's recorded run, and the capture itself. */
export function createOverturnClient(
  creds: OverturnCredentials,
  fetchImpl: typeof fetch = fetch,
): OverturnPort {
  const base = creds.baseUrl.replace(/\/+$/, "");
  const authorization = `Bearer ${creds.apiKey}`;
  return {
    async lastRun(externalId, agent) {
      // The drafting agent may have recorded its run itself; if it did, the draft is its output.
      const query = `externalId=${encodeURIComponent(externalId)}&agent=${encodeURIComponent(agent)}&limit=1`;
      const res = await fetchImpl(`${base}/v1/runs?${query}`, {
        headers: { Authorization: authorization, Accept: "application/json" },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { items?: RunRow[] } | null;
      const run = body?.items?.[0];
      if (!run || typeof run.id !== "string") return null;
      const found: RecordedRun = {
        id: run.id,
        agent: typeof run.agent === "string" ? run.agent : agent,
        output: run.output,
        model: typeof run.model === "string" ? run.model : null,
        endedAt: typeof run.endedAt === "string" ? run.endedAt : null,
      };
      return found;
    },

    async capture(body: CaptureCreate): Promise<CaptureOutcome> {
      const res = await fetchImpl(`${base}/v1/capture`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "content-type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new OverturnError(`/v1/capture returned ${res.status}`, res.status);
      const r = (await res.json()) as {
        kind?: unknown;
        changed?: unknown;
        deduplicated?: unknown;
        case?: { title?: unknown } | null;
      } | null;
      return {
        kind: r?.kind === "approve" ? "approve" : "edit",
        changed: r?.changed === true,
        deduplicated: r?.deduplicated === true,
        case: typeof r?.case?.title === "string" ? { title: r.case.title } : null,
      };
    },
  };
}
