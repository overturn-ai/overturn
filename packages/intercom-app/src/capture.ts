import { IntercomConversation, CapturePayload, IntercomOrigin } from './types';

export function buildCapturePayload(params: {
  conversation: IntercomConversation;
  draftText: string;
  sentText: string;
  origin: IntercomOrigin;
  reason?: string;
  note?: string;
}): CapturePayload {
  const { conversation, draftText, sentText, origin, reason, note } = params;

  // Extract context: Original message + last 5 parts for brevity
  const context: string[] = [];
  if (conversation.source?.body) {
    context.push(conversation.source.body);
  }

  const parts = conversation.conversation_parts?.conversation_parts || [];
  const recentParts = parts.slice(-5).map(p => p.body);
  context.push(...recentParts);

  return {
    source: 'intercom',
    externalId: `ic:${conversation.id}`,
    context,
    draft: {
      text: draftText,
      fields: {
        origin
      }
    },
    sent: {
      text: sentText
    },
    ...(reason && { reason }),
    ...(note && { note })
  };
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function determineOrigin(isFinDraft: boolean, hasManualEdits: boolean): IntercomOrigin {
  if (isFinDraft && !hasManualEdits) return 'draft:ai';
  if (!isFinDraft) return 'draft:manual';
  return 'unknown';
}
