---
title: Capture in the help desk
description: The Zendesk app and POST /v1/capture turn what the agent sent, versus what the AI drafted, into a scored case. No SDK in the way, any drafting vendor.
---

Your agents already review every AI draft before it goes out, in the reply box, and the fix vanishes into the ticket. Capture keeps it: what the AI (or the junior) drafted, what the agent sent, and the reason in one click. That is the QA record for AI drafts: the untouched rate and the fixes by reason on the Capture page, and a replayable case for every fix, whichever vendor wrote the draft. In claims, an adjuster changing a coverage decision or a reserve is the same capture with decision fields scored exactly.

Nothing has to be instrumented. If the drafting agent did record its run with the SDK, the correction attaches to that run; if not, the draft becomes the recorded run.

## Zendesk (no code)

The Overturn app sits in the ticket sidebar.

1. Create a project API key in Overturn (Settings → API keys).
2. Download `overturn-zendesk-app.zip` from the [latest release](https://github.com/overturn-ai/overturn/releases) and upload it in Admin Center → Apps and integrations → Zendesk Support apps → **Upload private app**.
3. Settings: `overturn_api_key` (kept server-side by Zendesk), `agent` (the workflow; one regression suite per workflow, default `claims-reply`), and optionally `decision_fields`: the custom fields that *are* the decision, as `id:label` pairs, e.g. `custom_field_123:status, custom_field_456:reserve`.

What the agent sees:

- **Draft inserted · 112 words** once an AI assist, macro or paste lands in the reply box. A drafting agent that recorded its run with the SDK (`externalId: "zd:<ticket id>"`) is found automatically. "Use the current text as the draft" marks it by hand.
- A **reason** box with quick picks: wrong coverage decision, wrong amount or date, missing required step, tone / wording, policy exception.
- On **Submit**, sent as drafted is an approve (no prompt); changed is an edit, with the reason as the case title and the judge's rubric. `require_reason` blocks a changed reply until there is one.

Overturn failing never blocks the send. The run page links back to the ticket.

Source: [`packages/zendesk-app`](https://github.com/overturn-ai/overturn/tree/main/packages/zendesk-app). Front, Salesforce Service Cloud and Gmail follow the same shape.

## Any other tool: `POST /v1/capture`

```http
POST /v1/capture
Authorization: Bearer ov_live_…

{
  "source": "zendesk",
  "externalId": "zd:48213",
  "agent": "claims-reply",
  "actor": "ray@carrier.com",
  "subject": "Roof leak after storm",
  "context": [
    { "role": "customer", "author": "dana@example.com", "content": "Water came through the ceiling after the storm…" },
    { "role": "note", "content": "HO-3, deductible $1,000, no prior claims." }
  ],
  "draft": { "text": "…adjuster will contact you within 5 business days…", "fields": { "status": "covered", "reserve": 4000 } },
  "sent":  { "text": "…adjuster will contact you within 2 business days…", "fields": { "status": "covered", "reserve": 6500 } },
  "reason": "Storm claims get 2-day contact; roof replacement, not repair"
}
```

Response: `{ kind: "edit", changed: true, changedFields: ["reserve"], runId, stepId, correction, case, deduplicated }`.

- `draft` and `sent` are `{ text, fields? }`. With fields, the frozen answer is `{ ...fields, reply: text }`: **fields are scored exactly, the prose by the judge**, so a rephrased paragraph is not a regression and a changed reserve is.
- `draftRunId` attaches to a run the drafting agent recorded; otherwise the latest run on the same `externalId` and `agent` whose answer equals the draft is used; otherwise a run is synthesized with one model step whose prompt is the rendered thread.
- The same fix on the same thread twice merges into one case.

SDKs and CLI:

```ts
await ov.capture({ source: "front", externalId: "cnv_1", agent: "claims-reply", context, draft: { text: aiDraft }, sent: { text: finalReply }, reason });
```

```python
ov.capture(external_id="cnv_1", agent="claims-reply", source="front", context=context, draft=ai_draft, sent=final_reply, reason=reason)
```

```bash
overturn capture --source zendesk --external-id zd:48213 --agent claims-reply \
  --draft @draft.txt --sent @sent.txt --reason "2-day SLA for storm claims" --context thread.json
```

## Then

```bash
overturn cases list --agent claims-reply
overturn replay --model openai/gpt-4.1-mini,together/deepseek-ai/DeepSeek-V4.1-Flash --agent claims-reply
overturn export --format sft --agent claims-reply      # the same log, as training data
```

The suite gates every prompt or model change; the export is the first step of [Owned models](/docs/owned-models/).
