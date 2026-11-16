# Front plugin implementation notes

- Entry point: Front sidebar plugin (`SIDE_PANEL` context).
- SDK methods used: `contextUpdates.subscribe`, `fetchDraft`, `listMessages`.
- Draft source: saved conversation draft (`conversation.draftId`), read through `fetchDraft`.
- Sent source: newest outbound message in the selected conversation.
- Capture: shared Overturn `CaptureCreate` contract, `source: front`, `externalId: fr:<conversation id>`.
- Reasons: shared `REASON_PACKS` (claims/support).
- Failure handling: POST errors are caught; Front message sending is never intercepted.
- Known gap: Front Plugin SDK does not expose a documented pre-send hook for blocking the send action. The plugin queues the capture until a reason is selected, but cannot prevent the message from being sent.
