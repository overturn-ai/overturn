import type { CaptureCreate } from "@overturn-ai/shared";
import type { DraftState, LastResult } from "./capture";

/** A capture that waits for a reason code. */
export interface PendingCapture {
  ticketId: string;
  body: CaptureCreate;
  changedFields: string[];
}

/** What the app remembers about one ticket. */
export interface TicketState {
  draft: DraftState | null;
  lastResult: LastResult | null;
  pending: PendingCapture | null;
  /** The run the last capture belongs to, so a new draft is captured again. */
  capturedRunId: string | null;
  /** The reply the pending capture is about, so the reason can be attached to it. */
  sentAt: number | null;
}

/** Where the app keeps the state of the tickets it has seen. */
export interface CaptureStore {
  get(ticketId: string): TicketState | undefined;
  set(ticketId: string, state: TicketState): void;
  delete(ticketId: string): void;
  keys(): string[];
}

/**
 * An in-process store.
 *
 * One instance per app process: the state is the reason a capture is waiting, and it is
 * short-lived by nature (the agent clicks the reason within the same shift). A deployment
 * with more than one process behind a load balancer should put this behind a shared store.
 */
export function createMemoryStore(): CaptureStore {
  const states = new Map<string, TicketState>();
  return {
    get: (ticketId) => states.get(ticketId),
    set: (ticketId, state) => {
      states.set(ticketId, state);
    },
    delete: (ticketId) => {
      states.delete(ticketId);
    },
    keys: () => [...states.keys()],
  };
}
