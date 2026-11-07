# Claims pack demo

A project full of what the Capture scorecard looks like before a team has its own numbers: 30 synthetic captures at a made-up carrier, sent through the public `POST /v1/capture`. 18 drafts went out untouched and 12 were fixed, across every reason code in the claims pack.

These numbers illustrate the scorecard. They are not results from any team, so don't quote them as results.

## Run it

Create a new project, mint a key for it (Settings → API keys), then:

```bash
OVERTURN_API_KEY=ov_live_... pnpm --filter @overturn-ai/example-claims-pack seed
```

Set `OVERTURN_BASE_URL` for a self-hosted API. Open **Capture** in the app. Rerunning fills in anything missing and changes nothing else. The script refuses a project with captures from the last year that are not from this demo.

## The pack

| | |
|---|---|
| Workflows | `claims-reply` (the letter), `coverage-decision` (the letter plus the decision) |
| Decision fields | `coverage`, `reserve`, `denial_reason`, scored exactly |
| Reason codes | `wrong_coverage_decision`, `missed_exclusion`, `reserve_too_low`, `reserve_too_high`, `wrong_amount_or_date`, `missing_required_step`, `tone_wording`, `policy_exception` |

The constants live in `@overturn-ai/shared` (`CLAIMS_AGENTS`, `CLAIMS_DECISION_FIELDS`, `CLAIMS_REASON_CODES`).

`tone_wording` fixes count on the scorecard but stay out of the suite, so this demo ends with 29 active cases and 1 archived.

All 30 rows are captured today, so **By week** shows one bar.
