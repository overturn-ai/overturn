---
title: Overturn
description: QA for AI-drafted replies — captured in the help desk, scored by team, replayed before every model change.
---

Overturn is QA for AI-drafted replies. The [Zendesk app](/docs/capture/) records what the AI drafted, what the agent sent and why, whichever vendor wrote the draft; the scorecard says how often the draft was right, by team and by week; and every fix replays as a regression test against any model or prompt, with tools answered from the recording so nothing fires twice. Engineers get the same loop from the SDK. Open source, Apache-2.0, self-hosted on one Postgres or hosted at [app.overturn.run](https://app.overturn.run).

![Record a run, correct a step, get a case, replay it against another model, read the report](/loop.gif)

## The loop

1. **Record.** Wrap the model client you already have (`ov.wrapOpenAI`, `ov.wrapAnthropic`, the Vercel AI SDK middleware) or send OpenTelemetry spans. Every prompt, tool call and answer is stored with a fingerprint.
2. **Correct, where the expert already works.** The [Zendesk app](/docs/capture/) diffs what the AI drafted against what the agent sent and asks for a one-line reason; `POST /v1/capture` does the same from any tool. Or approve / edit / reject / escalate in the web app, in your own product with `<CorrectButton>`, from the Slack message each run posts, or via the API.
3. **Case.** Each correction freezes the step's exact input, the run's tool recordings and the expected answer, scored on the decision fields of the answer, not its prose.
4. **Replay.** `overturn replay --model anthropic/claude-sonnet-4-5` re-runs the cases with tools answered from the recording. Side-effect tools are refused, never executed. Comma-separate models for a case × model matrix.
5. **Report.** Regressions first, then still wrong, then fixed, each with baseline, target and the human's correction side by side, plus a receipt of what was and wasn't tested.

## Where to start

- Your agents review AI drafts in Zendesk: [Capture](/docs/capture/), no code.
- Hosted and want to see it in ten minutes: [Hosted app](/docs/hosted/).
- Running your own: [Quickstart](/docs/quickstart/) and [Self-hosting](/docs/self-hosting/).
- Already recording: [SDK & CLI](/docs/sdk/).
