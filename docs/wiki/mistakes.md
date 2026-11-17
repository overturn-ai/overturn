# Mistakes

Date · what happened · where the fix landed. One line each.
2026-11-07 · Branched from local `main` 6 commits behind `origin/main`, which showed lint errors already fixed upstream · `CLAUDE.md` and `AGENTS.md`, Git section: fetch and branch from `origin/main`.
2026-11-16 · Wired marketing analytics for overturn.run being served from this repo; it is a Framer page at www.overturn.run that mounts `framer/landing.js`, and the docs are on docs.overturn.run. The first version would have sent nothing in production · `CLAUDE.md` and `AGENTS.md`, Stack section: where each site is served from
2026-11-16 · Called the commerce pack done on green vitest runs; adding `moneyAtRiskCents` and `currency` to the gate type left two untouched `report.test.ts` fixtures red in `tsc`, which the judge caught twice · `CLAUDE.md` and `AGENTS.md`, Stack section: typecheck per package after widening a shared type.
2026-11-17 · The commerce pack added three codes to `SUITE_EXCLUDED_REASON_CODES` and broke a claims-pack test that asserted every excluded code appears in claims data — found by CI, not by me, because I ran five packages' tests and not the examples' · `examples/claims-pack/src/seed.e2e.test.ts` now asserts the intersection, and the CLAUDE.md rule is the root `pnpm test` and `pnpm typecheck`, not a hand-picked list.
