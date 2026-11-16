import type { Draft, SentMessage } from '../../shared/types';

/**
 * Payload sent to the Overturn capture endpoint for Intercom.
 */
export interface CapturePayload {
  source: 'intercom';
  externalId: string; // "ic:<conversationId>"
  context: Record<string, unknown>;
  draft?: {
    text: string;
    fields?: Record<string, unknown>;
    origin: 'ai' | 'manual' | 'unknown';
  };
  sent?: {
    text: string;
    fields?: Record<string, unknown>;
    origin: 'ai' | 'manual' | 'unknown';
  };
  reason?: string;
  note?: string;
}

/**
 * Build the capture payload for Intercom.
 *
 * @param params - Parameters required to construct the payload.
 * @throws When `requireReason` is true but no reason is supplied.
 */
export function buildCapturePayload(params: {
  conversationId: string;
  draft?: Draft;
  sent?: SentMessage;
  reason?: string;
  note?: string;
  requireReason?: boolean;
}): CapturePayload {
  const { conversationId, draft, sent, reason, note, requireReason = false } = params;

  if (requireReason && (!reason || reason.trim() === '')) {
    throw new Error('Reason is required but not provided');
  }

  const payload: CapturePayload = {
    source: 'intercom',
    externalId: `ic:${conversationId}`,
    context: {
      conversationId,
    },
  };

  if (draft) {
    payload.draft = {
      text: draft.text,
      fields: draft.fields,
      origin: draft.origin ?? 'unknown',
    };
  }

  if (sent) {
    payload.sent = {
      text: sent.text,
      fields: sent.fields,
      origin: sent.origin ?? 'unknown',
    };
  }

  if (reason) {
    payload.reason = reason;
  }

  if (note) {
    payload.note = note;
  }

  return payload;
}
