import type { CapturePayload, CaptureMessage, CaptureContext } from '@overturn/common';
import type { ReasonPack } from '@overturn/common/reason';

/**
 * Build the payload sent to the Overturn capture endpoint for Gorgias.
 *
 * @param params - Information gathered from the Gorgias UI.
 * @returns The payload ready to be JSON‑stringified and POSTed.
 */
export function buildGorgiasCapturePayload(params: {
  ticketId: string;
  draft?: { text: string; fields?: Record<string, unknown> };
  sent?: { text: string; fields?: Record<string, unknown> };
  reasonPack?: ReasonPack;
  reasonCode?: string;
  reasonNote?: string;
  requireReason?: boolean;
}): CapturePayload {
  const {
    ticketId,
    draft,
    sent,
    reasonPack = 'support',
    reasonCode,
    reasonNote,
    requireReason = false,
  } = params;

  const context: CaptureContext = {
    source: 'gorgias',
    externalId: `gr:${ticketId}`,
    // Gorgias does not expose a full ticket object via the UI, but the
    // Overturn backend only needs an identifier for now. Additional fields can
    // be added later without breaking the contract.
    ticketId,
  };

  const messages: CaptureMessage[] = [];

  if (draft && draft.text) {
    messages.push({
      role: 'assistant',
      text: draft.text,
      fields: draft.fields,
    });
  }

  if (sent && sent.text) {
    messages.push({
      role: 'user',
      text: sent.text,
      fields: sent.fields,
    });
  }

  const payload: CapturePayload = {
    source: 'gorgias',
    externalId: `gr:${ticketId}`,
    context,
    messages,
    reasonPack,
    reasonCode,
    reasonNote,
    requireReason,
  };

  return payload;
}
