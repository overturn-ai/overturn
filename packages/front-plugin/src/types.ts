export type ReasonCode = 
  | 'too_long' | 'too_short' | 'wrong_tone' | 'inaccurate' 
  | 'formatting' | 'missing_info' | 'hallucination' | 'other';

export interface CapturePayload {
  source: 'front';
  externalId: string;
  context: {
    conversationId: string;
    subject?: string;
    lastMessages: Array<{
      author: string;
      body: string;
      createdAt: string;
    }>;
  };
  draft: {
    text: string;
    fields?: Record<string, unknown>;
  };
  sent: {
    text: string;
    fields?: Record<string, unknown>;
  };
  reason?: ReasonCode;
  note?: string;
}

export interface PluginState {
  originalDraft: string | null;
  currentReason: ReasonCode | null;
  note: string;
  requireReason: boolean;
}
