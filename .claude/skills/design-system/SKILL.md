---
name: design-system
description: Overturn's visual system — product UI (app.overturn.run) and marketing site (overturn.run) have different references. Read before designing or styling anything in this repo.
---

# Overturn design system

Two surfaces, two references. Do not blend them.

## Product UI (apps/web) — reference: Raindrop's app (raindrop.ai)
Dark, dense, built for people who read traces all day.
- Background `#0B0C0F`, surface `#121419`, raised `#181B22`, line `#23272F`. Text `#E6E8EE`, secondary `#9AA1AE`, muted `#6B7280`.
- Left icon rail (56px) + optional 240px secondary nav. Content fills; no max-width on tables.
- Color is reserved for verdicts and severity: pass `#3DDC97`, fail `#FF5C5C`, flaky/warn `#FFB547`, info `#5B8DEF`. Nothing else is colored. Buttons are neutral; the primary action is a light fill (`#E6E8EE` on dark) — never a brand blue.
- Type: Inter/system at 13px for tables and 14px for prose; mono (JetBrains Mono / ui-monospace) for ids, model names, JSON, diffs. Tabular numbers everywhere.
- Rows 32px in tables, 36px in lists. Hover raises to `surface`. Selected row gets a 2px left rule in the verdict color.
- Diffs: side-by-side at ≥1280px, stacked below. Removed in fail-tint, added in pass-tint, at 12% alpha.
- Light theme exists (`?theme=light`, `ov-theme`) and must stay readable, but dark is the design.
- Motion: 120ms. No skeleton shimmer; a quiet progress bar at the top.

## Marketing site (apps/docs → overturn.run) — reference: past.dev
Light, editorial, calm. The opposite of the app on purpose.
- Warm white page, ink text, one accent used once (hero illustration and primary CTA).
- Hero: headline ≤ 9 words ("Every time a human fixes your agent, Overturn keeps it."), 3D illustration with hover micro-interactions, real product screens in the white version of the app.
- Sections in order: hero → numbered quickstart (1-2-3, copyable commands) → with/without comparison → how it works (capture → correction record → regression test → owned model) → claims-teams-first → FAQ → footer.
- Type: Inter or Geist, headline 500 weight, 48px max; body 17px/1.6, 680px measure.
- Logo: the "Pinwheel" mark (four rotating half-disc blades) + lowercase "overturn" wordmark, wordmark lighter and smaller than the mark. Never a SemiBold wordmark.
- No vertical grid lines, no dark sections, no gradients, no stock illustration, no logos we have not earned.

## Both
Sentence case. No emoji. Empty states say what to do next. Status words are exact: pass / fail / flaky / pending — never "success"/"error".
