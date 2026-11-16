import { buildCapturePayload } from './capture';

describe('buildCapturePayload (Intercom)', () => {
  it('creates payload with draft and sent messages', () => {
    const payload = buildCapturePayload({
      conversationId: '12345',
      draft: { text: 'AI suggestion', fields: { foo: 'bar' }, origin: 'ai' },
      sent: { text: 'Human reply', fields: {}, origin: 'manual' },
      reason: 'support',
      note: 'Extra context',
    });

    expect(payload).toEqual({
      source: 'intercom',
      externalId: 'ic:12345',
      context: { conversationId: '12345' },
      draft: { text: 'AI suggestion', fields: { foo: 'bar' }, origin: 'ai' },
      sent: { text: 'Human reply', fields: {}, origin: 'manual' },
      reason: 'support',
      note: 'Extra context',
    });
  });

  it('throws when reason is required but missing', () => {
    expect(() =>
      buildCapturePayload({
        conversationId: '123',
        draft: { text: 'draft' },
        requireReason: true,
      })
    ).toThrow('Reason is required but not provided');
  });

  it('defaults origin to unknown when not provided', () => {
    const payload = buildCapturePayload({
      conversationId: 'c1',
      draft: { text: 'draft' },
    });
    expect(payload.draft?.origin).toBe('unknown');
  });
});
