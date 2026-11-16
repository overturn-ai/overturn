import { buildGorgiasCapturePayload } from './capture';

describe('buildGorgiasCapturePayload', () => {
  it('creates payload with draft and sent messages', () => {
    const payload = buildGorgiasCapturePayload({
      ticketId: '12345',
      draft: { text: 'Draft reply', fields: { foo: 'bar' } },
      sent: { text: 'Final reply' },
    });

    expect(payload.source).toBe('gorgias');
    expect(payload.externalId).toBe('gr:12345');
    expect(payload.messages).toHaveLength(2);
    expect(payload.messages[0]).toMatchObject({ role: 'assistant', text: 'Draft reply', fields: { foo: 'bar' } });
    expect(payload.messages[1]).toMatchObject({ role: 'user', text: 'Final reply' });
  });

  it('includes reason pack and optional note', () => {
    const payload = buildGorgiasCapturePayload({
      ticketId: '1',
      draft: { text: 'draft' },
      reasonPack: 'support',
      reasonCode: 'order_issue',
      reasonNote: 'Customer asked about order status',
    });

    expect(payload.reasonPack).toBe('support');
    expect(payload.reasonCode).toBe('order_issue');
    expect(payload.reasonNote).toBe('Customer asked about order status');
  });

  it('honours requireReason flag', () => {
    const payload = buildGorgiasCapturePayload({
      ticketId: '2',
      draft: { text: 'draft' },
      requireReason: true,
    });
    expect(payload.requireReason).toBe(true);
  });

  it('does not block send when reason is missing but not required', () => {
    const payload = buildGorgiasCapturePayload({
      ticketId: '3',
      sent: { text: 'sent' },
    });
    expect(payload.requireReason).toBeFalsy();
    expect(payload.reasonCode).toBeUndefined();
  });
});
