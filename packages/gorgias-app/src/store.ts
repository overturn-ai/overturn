import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CaptureStore, TicketState } from "./handler";

export interface StoreFile {
  v: 1;
  savedAt: string;
  tickets: Array<{ ticketId: string; state: TicketState }>;
}

function isStoreFile(v: unknown): v is StoreFile {
  if (!v || typeof v !== "object") return false;
  const f = v as Partial<StoreFile>;
  return f.v === 1 && Array.isArray(f.tickets);
}

/**
 * The state a restart must not lose: the draft in the reply box, the reason on file, the reply
 * already accounted for, and a capture waiting for its reason. Written atomically after every
 * change, read once at boot. One file is enough for one helpdesk on one instance; the interface is
 * the same a Postgres or Redis store would implement.
 */
export function createFileStore(path: string): CaptureStore {
  const tickets = new Map<string, TicketState>();
  let ready: Promise<void> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const load = async (): Promise<void> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isStoreFile(parsed)) return;
      for (const { ticketId, state } of parsed.tickets) {
        if (typeof ticketId === "string" && state && typeof state === "object") tickets.set(ticketId, state);
      }
    } catch (e) {
      // No file yet is the normal first boot; anything else is said out loud and the app starts empty.
      if (!(e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "ENOENT")) {
        console.error(`overturn-gorgias-app: could not read ${path}: ${e instanceof Error ? e.message : e}`);
      }
    }
  };

  const write = (): Promise<void> => {
    // Atomic and serialized: a crash mid-write leaves the previous good file, never a half one.
    writing = writing.then(async () => {
      const payload: StoreFile = {
        v: 1,
        savedAt: new Date().toISOString(),
        tickets: [...tickets].map(([ticketId, state]) => ({ ticketId, state })),
      };
      await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
      const tmp = `${path}.tmp`;
      await writeFile(tmp, `${JSON.stringify(payload)}\n`, "utf8");
      await rename(tmp, path);
    });
    return writing;
  };

  return {
    async get(ticketId) {
      ready ??= load();
      await ready;
      const found = tickets.get(ticketId);
      return found ? { ...found } : { ...EMPTY_TICKET };
    },
    async set(ticketId, state) {
      tickets.set(ticketId, { ...state });
      await write();
    },
  };
}

const EMPTY_TICKET: TicketState = {
  draft: null,
  reason: null,
  seenReplyId: null,
  consumedRunIds: [],
  lastResult: null,
  pending: null,
  note: null,
};
