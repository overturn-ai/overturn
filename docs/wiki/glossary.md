# Glossary

- **Run / step** — one agent execution and its recorded model/tool calls (client-generated UUIDv7 ids).
- **Correction** — `{text, fields?}` plus a decision flip and a reason; the unit we sell. `require_reason` is on in the claims pack.
- **Correction record** — wrong output, fix, reason, who, model/prompt version. The core object.
- **Replay** — re-running recorded steps against another model and comparing final outputs via fingerprints.
- **Capture scorecard** — the forwardable summary of corrections per agent; the handoff from engineer to ops leader.
- **Owned model** — a model trained from a customer's own corrections; the moat.
- **Claims pack** — the claims defaults: workflows `claims-reply` and `coverage-decision`, decision fields `coverage`, `reserve`, `denial_reason`, eight reason codes. `examples/claims-pack` seeds a demo project with them.
