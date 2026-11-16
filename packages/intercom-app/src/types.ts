export type IntercomOrigin = 'draft:ai' | 'draft:manual' | 'unknown';

export interface IntercomConversationPart {
  id: string;
  body: string;
  author: {
    type: 'admin' | 'user' | 'bot';
    id: string;
  };
  created_at: number;
}

export interface IntercomConversation {
  id: string;
  source: {
    body: string;
  };
  conversation_parts: {
    conversation_parts: IntercomConversationPart[];
  };
}

export interface CapturePayload {
  source: 'intercom';
  externalId: string;
  context: string[];
  draft: {
    text: string;
    fields: {
      origin: IntercomOrigin;
    };
  };
  sent: {
    text: string;
  };
  reason?: string;
  note?: string;
}

export interface ReasonOption {
  id: string;
  text: string;
}

export const DEFAULT_REASONS: ReasonOption[] = [
  { id: 'correct', text: 'Correct' },
  { id: 'minor_edit', text: 'Minor Edits' },
  { id: 'major_edit', text: 'Major Edits' },
  { id: 'wrong_info', text: 'Wrong Information' },
  { id: 'tone_issue', text: 'Tone/Style Issue' }
];
