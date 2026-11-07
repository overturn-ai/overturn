---
name: four-versions
description: Diverge then converge on UI. Use before writing frontend code for any new or reworked screen — produce 4 versions in Paper, then merge the picked pieces.
---

# Four versions of every screen

No frontend code until this has run for the screen.

1. Read the design-system skill for this repo first. All four versions live inside it (type, color, spacing, density). Variation is in layout, hierarchy, and interaction — not in brand.
2. Produce exactly four artboards in Paper (Paper MCP, `write_html`). Name them `<screen> / A..D`. Each must take a different bet:
   - A: the obvious layout, done well.
   - B: the densest version that still breathes.
   - C: the version that optimizes for the first-time user (the "confused" persona).
   - D: the version that optimizes for the phone.
3. Export each (`export`, PNG, 2x) and show all four side by side with one line each on what the bet is.
4. Shireen picks pieces ("header from B, table from D"). Merge into a single `<screen> / final` artboard. Do not add anything she did not pick.
5. Only now write code, from `get_jsx` on the final artboard, adapted to the repo's components.

If Paper Desktop is not running (MCP at http://127.0.0.1:29979/mcp unreachable), do the four versions as four self-contained HTML files under `design/<screen>/{a,b,c,d}.html`, screenshot them with Playwright, and proceed the same way.

Screenshots she sends with "make it feel like this" → see make-it-feel-like-this skill.
