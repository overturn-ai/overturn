import { GorgiasTicket, CapturePayload, Reason } from './types';

export function buildCapturePayload(
  ticket: GorgiasTicket,
  draftText: string,
  sentText: string,
  reasonCode?: string,
  note?: string
): CapturePayload {
  if (!ticket.id) {
    throw new Error('Ticket ID is required');
  }

  const payload: CapturePayload = {
    source: 'gorgias',
    externalId: `gr:${ticket.id}`,
    context: {
      subject: ticket.subject,
      customer: ticket.customer,
      // Include minimal message history for context
      last_messages: ticket.messages?.slice(-3).map(m => ({
        text: m.body_text,
        is_agent: m.from_agent
      }))
    },
    draft: {
      text: draftText
    },
    sent: {
      text: sentText
    }
  };

  if (reasonCode) {
    payload.reason = {
      code: reasonCode,
      ...(note ? { note } : {})
    };
  }

  return payload;
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
