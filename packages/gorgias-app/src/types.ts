export interface GorgiasTicket {
  id: number;
  subject: string;
  customer: {
    email: string;
    name: string;
  };
  messages?: Array<{
    body_text: string;
    from_agent: boolean;
  }>;
}

export interface Reason {
  id: string;
  label: string;
}

export const SUPPORT_REASON_PACK: Reason[] = [
  { id: 'resolved', label: 'Issue Resolved' },
  { id: 'info_provided', label: 'Information Provided' },
  { id: 'escalated', label: 'Escalated' },
  { id: 'order_update', label: 'Order Update' },
  { id: 'refund_processed', label: 'Refund Processed' }
];

export interface CapturePayload {
  source: 'gorgias';
  externalId: string;
  context: Record<string, any>;
  draft: {
    text: string;
    fields?: Record<string, any>;
  };
  sent: {
    text: string;
    fields?: Record<string, any>;
  };
  reason?: {
    code: string;
    note?: string;
  };
}
