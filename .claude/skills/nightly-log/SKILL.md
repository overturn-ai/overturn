---
name: nightly-log
description: End every session by appending a 5-line log entry to docs/wiki/log/YYYY-MM-DD.md so the whole company reads in 2 minutes. Use before stopping, always.
---

# Nightly log

File: `docs/wiki/log/<UTC date>.md`. Append, never overwrite. Commit it with the work (author: Shireen Kadhium <shireenkadhium1@gmail.com>, no trailers).

Exactly five lines per session, this shape:
```
### <agent role> · <HH:MM UTC> · <linear issue or "no ticket">
shipped: <what is live or in a PR, with link>
broke / blocked: <what failed, or "nothing">
learned: <one thing that should change how we work — or "nothing new">
needs shireen: <a decision or approval, or "nothing">
judge: <score>/10 — <judge's one line>
```

If "learned" is a mistake that could recur, also run the mistake-to-skill skill.
