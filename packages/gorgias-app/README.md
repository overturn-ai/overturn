# Gorgias Capture Adapter

This package provides the same capture payload builder that the Zendesk app uses, but for Gorgias.

## Usage
```ts
import { buildGorgiasCapturePayload } from '@overturn/gorgias-app';

const payload = buildGorgiasCapturePayload({
  ticketId: '123',
  draft: { text: 'AI draft' },
  sent: { text: 'Human reply' },
  reasonPack: 'support',
  reasonCode: 'order_issue',
  reasonNote: 'Customer asked about order status',
  requireReason: true,
});

// POST payload to /v1/capture
```

## Development
```bash
# install dependencies for the whole repo
npm install

# build this package
npm run build --workspace @overturn/gorgias-app

# run tests
npm test --workspace @overturn/gorgias-app
```
