# SOC 2 Type I readiness (during the build freeze)

Goal: a Type I report by end of January 2027, with the auditor and platform chosen in November. Vanta or Drata; pick Vanta unless Drata is cheaper for a one-person company on the call. Most of the controls already exist in the repo; the rest are policies to write and settings to flip.

**Already true (point the auditor at it)**
- Code review and CI on every change to main (`.github/workflows/ci.yml`); signed-in author on every commit.
- Encryption at rest (Railway Postgres) and in transit (TLS everywhere; `domainWhitelist` in the Zendesk app).
- Per-project API keys, hashed at rest; magic-link sign-in; no passwords stored.
- Retention and deletion built in (`settings.retentionDays`, project delete cascades).
- Export redaction (`packages/shared/src/redact.ts`); hosted-model switch (`settings.privacy.hostedModelCalls`).
- Audit of who started each replay (`startedBy`).
- Secrets only in `.env`, Railway and GitHub Actions secrets (`.env.example` shipped).

**To do, in order (each is a day or less)**
1. Sign up for the compliance platform with shireen@overturn.run; connect GitHub (org overturn-ai), Railway, Google Workspace. *(Shireen: accounts.)*
2. Turn on 2FA enforcement for the GitHub org and Google Workspace. *(Shireen: admin settings.)*
3. Accept the platform's policy templates for: information security, access control, change management, incident response, vendor management, data retention, business continuity. Edit the names and the retention numbers to match the product (30 days raw runs). *(Can be drafted by Claude once the platform is connected.)*
4. Vendor list: Railway, GitHub, Google Workspace, Together, OpenAI, Anthropic, Google, OpenRouter, Zendesk (marketplace), Clay, YAMM. Attach each vendor's SOC 2 / DPA link.
5. Risk assessment: one spreadsheet, ten rows, from the platform template.
6. Background check and security training for the one employee (Shireen); the platform sells both.
7. Enable Railway's database backups and note the schedule; add a restore test to the calendar (quarterly).
8. Pick the auditor from the platform's marketplace; Type I observation is a point in time, so book the date once items 1–7 are green.

**Not needed for Type I**: pen test (do one before Type II), HIPAA (no PHI on hosted), ISO 27001.
