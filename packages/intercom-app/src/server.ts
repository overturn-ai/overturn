import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import type { CaptureResult } from "@overturn-ai/shared";
import { CAPTURE_BUTTON_ID, type CanvasResponse, type FormState, formCanvas, messageCanvas } from "./canvas";
import {
  type AppSettings,
  type ConversationSnapshot,
  type DraftState,
  decideOnSend,
  draftOriginFrom,
  settingsFrom,
  statusLine,
} from "./capture";

export interface Config {
  settings: AppSettings;
  clientSecret: string;
  intercomToken: string;
  overturnApiKey: string;
}

export interface Deps {
  config: Config;
  fetch: typeof fetch;
  now?: () => number;
}

export interface HttpResult {
  status: number;
  body: unknown;
}

type Json = Record<string, unknown>;

const INTERCOM_API = "https://api.intercom.io";

const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export function configFromEnv(env: Record<string, string | undefined>): Config {
  return {
    settings: settingsFrom({
      overturn_base_url: env.OVERTURN_BASE_URL,
      agent: env.AGENT,
      reason_pack: env.REASON_PACK,
      require_reason: env.REQUIRE_REASON,
      capture_internal_notes: env.CAPTURE_INTERNAL_NOTES,
    }),
    clientSecret: env.INTERCOM_CLIENT_SECRET ?? "",
    intercomToken: env.INTERCOM_ACCESS_TOKEN ?? "",
    overturnApiKey: env.OVERTURN_API_KEY ?? "",
  };
}

/** Intercom signs the raw body with the app's client secret (HMAC-SHA256, hex). */
export function validSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim().toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

function iso(unixSeconds: unknown): string | null {
  return typeof unixSeconds === "number" ? new Date(unixSeconds * 1000).toISOString() : null;
}

/** Maps `GET /conversations/{id}` to what the capture builder needs. */
export function conversationFrom(raw: unknown, id: string): ConversationSnapshot {
  const c = obj(raw);
  const source = obj(c.source);
  const contacts = obj(c.contacts).contacts;
  const contact = obj(Array.isArray(contacts) ? contacts[0] : null);
  const part = (p: Json, partType: string) => {
    const author = obj(p.author);
    return {
      id: str(p.id) ?? undefined,
      body: str(p.body) ?? "",
      partType,
      authorType: str(author.type) ?? "user",
      authorName: str(author.name),
      authorEmail: str(author.email),
      createdAt: iso(p.created_at),
    };
  };
  const rawParts = obj(c.conversation_parts).conversation_parts;
  const parts = [
    part({ ...source, created_at: c.created_at }, "comment"),
    ...(Array.isArray(rawParts) ? rawParts : [])
      .map(obj)
      .filter((p) => p.part_type === "comment" || p.part_type === "note")
      .map((p) => part(p, p.part_type as string)),
  ];
  return {
    id,
    subject: str(source.subject) ?? str(c.title),
    contactEmail: str(contact.email),
    contactName: str(contact.name),
    parts,
    url: str(source.url),
  };
}

async function loadConversation(id: string, deps: Deps): Promise<ConversationSnapshot> {
  const res = await deps.fetch(
    `${INTERCOM_API}/conversations/${encodeURIComponent(id)}?display_as=plaintext`,
    {
      headers: { Authorization: `Bearer ${deps.config.intercomToken}`, Accept: "application/json" },
    },
  );
  if (!res.ok) throw new Error(`intercom ${res.status}`);
  return conversationFrom(await res.json(), id);
}

/** A drafting agent that recorded its run with the SDK: the draft is its output, and we were told. */
async function findRecordedDraft(
  id: string,
  deps: Deps,
): Promise<{ text: string; runId: string; model: string | null } | null> {
  const { settings, overturnApiKey } = deps.config;
  try {
    const res = await deps.fetch(
      `${settings.baseUrl}/v1/runs?externalId=${encodeURIComponent(`ic:${id}`)}&agent=${encodeURIComponent(settings.agent)}&limit=1`,
      { headers: { Authorization: `Bearer ${overturnApiKey}` } },
    );
    if (!res.ok) return null;
    const items = obj(await res.json()).items;
    const run = obj(Array.isArray(items) ? items[0] : null);
    const text = str(run.output);
    const runId = str(run.id);
    return text && runId ? { text, runId, model: str(run.model) } : null;
  } catch {
    return null;
  }
}

function conversationId(body: Json): string | null {
  const c = obj(body.conversation);
  const id = c.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}

/** The expert's reply: the latest admin message the customer saw (or a note, when notes are captured). */
function latestSend(conversation: ConversationSnapshot, settings: AppSettings) {
  const mine = conversation.parts.filter((p) => p.authorType === "admin" && p.body.trim());
  const comment = [...mine].reverse().find((p) => p.partType === "comment");
  const note = [...mine].reverse().find((p) => p.partType === "note");
  const pick = comment ?? (settings.captureInternalNotes ? note : undefined);
  return pick ? { text: pick.body, type: pick.partType } : { text: "", type: "comment" };
}

function inputsFrom(body: Json): Json {
  return obj(body.input_values);
}

/** Never throws and never answers with an error status: a failure here must not get in the agent's way. */
export async function handle(
  req: { method: string; path: string; rawBody: string; signature?: string },
  deps: Deps,
): Promise<HttpResult> {
  if (req.method !== "POST") return { status: 404, body: { error: "not found" } };
  if (!validSignature(req.rawBody, req.signature, deps.config.clientSecret)) {
    return { status: 401, body: { error: "bad signature" } };
  }
  const now = deps.now ?? Date.now;
  const respond = (body: CanvasResponse): HttpResult => ({ status: 200, body });
  try {
    const body = obj(JSON.parse(req.rawBody || "{}"));
    const { settings } = deps.config;
    if (req.path === "/configure") {
      return respond(messageCanvas("Overturn is configured with environment variables on the server."));
    }
    const id = conversationId(body);
    if (!id) return respond(messageCanvas("Open a conversation to use Overturn."));

    if (req.path === "/initialize") {
      const recorded = await findRecordedDraft(id, deps);
      const form: FormState = {
        draftText: recorded?.text ?? "",
        origin: recorded ? "ai" : "unknown",
        reasonCode: null,
        note: "",
        draftAt: now(),
        runId: recorded?.runId,
        model: recorded?.model,
      };
      return respond(formCanvas({ settings, form }));
    }

    if (req.path === "/submit") {
      const input = inputsFrom(body);
      const stored = obj(obj(body.current_canvas).stored_data);
      const form: FormState = {
        draftText: str(input.draft_text) ?? "",
        origin: draftOriginFrom(input.draft_origin),
        reasonCode: str(input.reason_code),
        note: str(input.reason_note) ?? "",
        draftAt: typeof stored.draftAt === "number" ? stored.draftAt : now(),
        runId: str(stored.runId) ?? undefined,
        model: str(stored.model),
      };
      if (body.component_id !== CAPTURE_BUTTON_ID) return respond(formCanvas({ settings, form }));

      const conversation = await loadConversation(id, deps);
      // The recorded run is only the draft while the agent has not replaced its text.
      const draft: DraftState | null = form.draftText.trim()
        ? {
            text: form.draftText,
            origin: draftOriginFrom(form.origin),
            at: form.draftAt,
            ...(form.runId ? { runId: form.runId } : {}),
            model: form.model ?? null,
          }
        : null;
      const decision = decideOnSend({
        conversation,
        draft,
        send: latestSend(conversation, settings),
        reasonCode: form.reasonCode,
        reason: form.note,
        actor: str(obj(body.admin).email),
        settings,
        now: now(),
      });
      if (decision.action === "skip") {
        const text =
          decision.why === "no-draft"
            ? "Paste the AI draft above, then capture again."
            : decision.why === "internal-note"
              ? "The latest reply is an internal note; notes are not captured."
              : "Send your reply in the conversation first, then capture it.";
        return respond(formCanvas({ settings, form, message: { text, style: "muted" } }));
      }
      if (decision.action === "need-reason") {
        const what = decision.changedFields.length ? decision.changedFields.join(", ") : "reply";
        return respond(
          formCanvas({
            settings,
            form,
            message: { text: `You changed the ${what}. Pick why, then capture again.`, style: "error" },
          }),
        );
      }
      const res = await deps.fetch(`${settings.baseUrl}/v1/capture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deps.config.overturnApiKey}`,
        },
        body: JSON.stringify(decision.body),
      });
      if (!res.ok) {
        return respond(
          formCanvas({
            settings,
            form,
            message: { text: `Overturn could not save this correction (${res.status}).`, style: "error" },
          }),
        );
      }
      const result = (await res.json()) as CaptureResult;
      const line = statusLine(draft, {
        kind: result.kind,
        changed: result.changed,
        dedup: result.deduplicated,
      });
      return respond(
        messageCanvas(result.changed && result.case ? `${line}. Case: ${result.case.title}` : line),
      );
    }
    return { status: 404, body: { error: "not found" } };
  } catch {
    return respond(messageCanvas("Overturn could not save this correction (network).", "error"));
  }
}

export function startServer(deps: Deps, port: number): Server {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const header = req.headers["x-body-signature"];
      void handle(
        {
          method: req.method ?? "GET",
          path: (req.url ?? "/").split("?")[0] ?? "/",
          rawBody: Buffer.concat(chunks).toString("utf8"),
          signature: Array.isArray(header) ? header[0] : header,
        },
        deps,
      ).then((r) => {
        res.writeHead(r.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r.body));
      });
    });
  });
  return server.listen(port);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configFromEnv(process.env);
  if (!config.clientSecret || !config.overturnApiKey || !config.intercomToken) {
    console.error("Set INTERCOM_CLIENT_SECRET, INTERCOM_ACCESS_TOKEN and OVERTURN_API_KEY.");
    process.exit(1);
  }
  startServer({ config, fetch }, Number(process.env.PORT ?? 3000));
}
