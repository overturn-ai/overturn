import { describe, it, expect } from 'vitest';
import { buildCapturePayload, countWords } from './capture';
import { GorgiasTicket } from './types';

describe('Gorgias Capture Logic', () => {
  const mockTicket: GorgiasTicket = {
    id: 12345,
    subject: 'Where is my order?',
    customer: { email: 'test@example.com', name: 'John Doe' }
  };

  it('should build a valid capture payload', () => {
    const payload = buildCapturePayload(
      mockTicket,
      'Draft text',
      'Sent text',
      'resolved',
      'Customer was happy'
    );

    expect(payload.source).toBe('gorgias');
    expect(payload.externalId).toBe('gr:12345');
    expect(payload.draft.text).toBe('Draft text');
    expect(payload.sent.text).toBe('Sent text');
    expect(payload.reason?.code).toBe('resolved');
    expect(payload.reason?.note).toBe('Customer was happy');
  });

  it('should format externalId with gr: prefix', () => {
    const payload = buildCapturePayload(mockTicket, 'd', 's');
    expect(payload.externalId).toMatch(/^gr:\d+$/);
  });

  it('should count words correctly', () => {
    expect(countWords('Hello world')).toBe(2);
    expect(countWords('  Multiple   spaces  ')).toBe(2);
    expect(countWords('')).toBe(0);
  });
});
