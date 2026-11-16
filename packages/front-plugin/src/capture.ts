import { CapturePayload, ReasonCode } from './types';

/**
 * Builds the capture payload for the Overturn API.
 * Mirrored from packages/zendesk-app/src/capture.ts
 */
export function buildCapturePayload(params: {
  conversationId: string;
  subject?: string;
  messages: Array<{ author: string; body: string; createdAt: string }>;
  draftText: string;
  sentText: string;
  reason?: ReasonCode;
  note?: string;
}): CapturePayload {
  return {
    source: 'front',
    externalId: `fr:${params.conversationId}`,
    context: {
      conversationId: params.conversationId,
      subject: params.subject,
      lastMessages: params.messages.slice(-5), // Keep last 5 for context
    },
    draft: {
      text: params.draftText,
    },
    sent: {
      text: params.sentText,
    },
    reason: params.reason,
    note: params.note,
  };
}

export async function sendCapture(payload: CapturePayload): Promise<void> {
  try {
    const response = await fetch('https://api.overturn.ai/v1/capture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error('Overturn Capture failed:', await response.text());
    }
  } catch (error) {
    console.error('Error sending capture to Overturn:', error);
    // Requirement 5: Never block the send - failed capture logs and gets out of the way.
  }
}
