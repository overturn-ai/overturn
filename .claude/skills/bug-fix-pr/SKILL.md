---
name: bug-fix-pr
description: Sentry catches the error → agent reads the stack trace → opens a fix PR in under 10 minutes → human approves. Use when triggered by the sentry-fix workflow or when handed a Sentry issue URL.
---

# Bug → fix PR

Budget: 10 minutes wall clock. If it is not fixed in 10, open the PR as draft with findings and stop.

1. Sentry MCP: `get_issue_details` for the issue. Pull the stack trace, breadcrumbs, affected release, event count, first/last seen, user count.
2. Graphify MCP: `graphify_find` the top in-app frame's symbol, `graphify_callers` one level up, `graphify_tests_for` the file. Do not grep the repo first — navigate the graph.
3. Reproduce in a test. If the failing path is covered, make the test fail the way Sentry shows; if not, write the smallest test that does. Run it. It must fail.
4. Fix. Smallest change. No refactors in a bug PR.
5. Run the test, then the package's `test` and `typecheck`. Run the security-check hook mentally: no new raw input to shell/SQL/URL.
6. Branch `fix/sentry-<short-id>`. Commit as Shireen Kadhium <shireenkadhium1@gmail.com>, no trailers. PR title: `fix: <symptom in user terms> (SENTRY-<id>)`. Body: Sentry link, root cause in 2 sentences, test added, how to verify. Label `agent-fix`.
7. Sentry MCP: add a comment on the issue with the PR link. Do not resolve it — the deploy resolves it.
8. Nightly log line.

Never fix by catching and swallowing the error. Never widen a type to `any` to make it compile.
