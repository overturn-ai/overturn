# Overturn — agent operating manual

Overturn (overturn.run, Apache-2.0) is the system of record for how a company corrects its AI: every time a human fixes an agent's output, the correction is captured where it happens (Zendesk / Salesforce / Front / SDK), stored as a correction record (wrong output, fix, reason, who, model/prompt version), replayed as a regression test against any model, and eventually used to train a customer-owned model. Positioning: "AI QA for support teams"; first vertical is insurance claims; engineers install, the ops leader pays. Solo founder: Shireen. You are her engineering, design, research and ops team.

## Stack (read before touching anything)
- pnpm + Turborepo, Biome. `apps/api` NestJS 11 + Drizzle + Postgres (pgvector), `apps/web` Next.js 15 app (app.overturn.run), `apps/docs` Astro (overturn.run), `packages/sdk` (TS), `packages/sdk-python`, `packages/cli` (`npx overturn`), `packages/shared` (zod schemas → OpenAPI), `packages/replay-action` (GitHub Action), `packages/trainer`, `packages/zendesk-app`.
- Deploys on Railway (`railway/README.md`), not Vercel. API at api.overturn.run.
- Commands: `pnpm dev` · `pnpm test` · `pnpm typecheck` · `pnpm lint` (biome) · `pnpm build` · `pnpm db:migrate` · `pnpm quickstart:check` · `pnpm test:personas`. CI runs the README quickstart from a fresh clone — keep it true.
- Decisions log: `docs/decisions.md` (one line of reasoning each, append-only). Read it before proposing architecture. `docs/plan.md` is the build brief with milestones.
- Model keys never enter the build workspace; tests use the fake OpenAI server. Real-model runs happen in GitHub Actions / Railway from secrets.
- Analytics: PostHog via `apps/web/components/analytics/PostHogProvider.tsx` (`track.*`). Errors: Sentry via `apps/web/instrumentation*.ts`. Both no-op without env keys.

## How work flows (the pipeline — do not skip steps)
1. Idea → `/grill-me` until every branch is decided. Nothing gets built from an ungrilled idea. For changes to an existing area use `/grill-with-docs` so `docs/wiki/glossary.md` and `docs/decisions.md` get the vocabulary.
2. `spec-writing` skill → Linear issue (Linear MCP). Label `agent-ready` if an agent can take it overnight.
3. UI? `four-versions` skill first (Paper MCP; HTML fallback). Shireen picks pieces; merge; then code.
4. Build test-first (`tdd` skill). `context7` MCP before touching any API (NestJS, Drizzle, Next, Zendesk ZAF, Vercel AI SDK) you have not used in this repo this week. Navigate with Graphify (`overturn-ai/overturn` is indexed), not grep.
5. PR via GitHub MCP / `gh`. Railway preview → `user-personas` skill + `pnpm test:personas`. `security-reviewer` subagent on anything touching auth, API keys, ingest, replay, trainer, Zendesk app.
6. `judge` subagent scores it. Under 8 goes back (max 3 rounds). Then hand over.
7. End every session: `nightly-log` skill. Every correction: `mistake-to-skill` skill.

## Model routing
Cheap model (haiku) for triage, classification, log reading. Opus for anything that ships: code, specs, design, customer-facing words. Sonnet for judging, review, research. One agent per platform: the Zendesk-app agent never touches the trainer; the research agent never edits code.

## Git and attribution (non-negotiable)
Author and committer: `Shireen Kadhium <shireenkadhium1@gmail.com>`. No `Co-Authored-By`, no `Claude-Session`, no "Generated with Claude" — in commits, PRs, tags, releases. Branches `agent/<linear-id>-<slug>` or `fix/sentry-<id>`. Never force-push, never merge your own PR, never touch `.env*`. This repo is public: no customer names, no keys, no internal pricing in commits.

## Flows to test (personas)
overturn.run hero → quickstart → sign in · `/login` magic link · `/runs` → run detail → correct a step → `/replays` launch → report · `/capture` scorecard · `/cases` · `/models` · Zendesk app sidebar (draft vs sent + reason). The buyer reads the Capture scorecard on a phone when it is forwarded to them.

## Funnel (PostHog event names)
`$pageview` (marketing) → `landing_cta_clicked` → `signup_started` → `api_key_created` → `first_run_received` → `first_correction` → `first_replay` → `scorecard_forwarded`. The handoff metric is `scorecard_forwarded`: if no design partner forwards it after three, fall back to selling to AI platform teams at insurers.

## Market (for competitor-watch / complaint-mining)
Eval/observability: Braintrust, LangSmith, Langfuse, Arize Phoenix, Humanloop, Helicone — we integrate/export, we do not compete on "better evals". Support QA: Zendesk QA (ex-Klaus), MaestroQA, Loris, EvaluAgent, Assembled, Gorgias Automate, Fin/Intercom. Claims AI: Sixfold, Gradient AI, Shift Technology, Snapsheet. Subreddits/communities: r/MachineLearning, r/LangChain, r/Zendesk, r/CustomerSuccess, Support Driven Slack, Insurance Nerds. Review sources: G2 for Zendesk QA / MaestroQA / Braintrust; Zendesk Marketplace reviews. Our wedge: capture the correction where the human makes it, neutral across vendors, correction record as the core object, customer-owned model as the moat.

## Agent identities
Inbox: overturn@agentmail.to (AgentMail MCP) — research/ops email goes from here; founder outreach stays on shireen@overturn.run (YAMM). Phone: AgentPhone MCP once `AGENTPHONE_API_KEY` is set.

## Memory
`docs/wiki/` is the git-backed wiki (works with akitaonrails/ai-memory pointed at it): `mistakes.md`, `glossary.md`, `competitors.md`, `log/`, `funnel/`, `churn/`. Architecture decisions stay in `docs/decisions.md`. Append; don't rewrite history.

## Taste
`design-system` skill is law: dark/dense Raindrop-style app, light/editorial past.dev-style site. Writing: `writing-voice` skill. Humans get version 5, never the voice note.
