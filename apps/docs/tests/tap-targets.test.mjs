// Phone tap targets on the landing page that the persona suite measures (tests/personas/personas.ts).
// The announcement link is a flex item, so its height is its own line box plus padding: it has to reach 44px.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const landing = readFileSync(path.join(here, "../site/index.html"), "utf8");

it("announcement bar link is at least 44px tall on a phone", () => {
  const fontSize = Number(landing.match(/\.ann\{[^}]*font-size:(\d+)px/)[1]);
  const lineHeight = Number(landing.match(/body\{[^}]*line-height:([\d.]+)/)[1]);
  const phone = landing.slice(landing.indexOf("every tap target is at least 44px"));
  const pad = Number(phone.match(/\.ann a\{padding-block:(\d+)px/)[1]);
  assert.ok(fontSize * lineHeight + 2 * pad >= 44, `${fontSize * lineHeight + 2 * pad}px`);
});
