import { settingsFrom } from "./capture";
import { createIntercomServer } from "./server";

const apiKey = process.env.OVERTURN_API_KEY?.trim();
if (!apiKey) {
  console.error("OVERTURN_API_KEY is required");
  process.exit(1);
}

const settings = settingsFrom({
  overturn_base_url: process.env.OVERTURN_BASE_URL,
  agent: process.env.OVERTURN_AGENT,
  require_reason: process.env.OVERTURN_REQUIRE_REASON,
  reason_pack: process.env.OVERTURN_REASON_PACK,
  decision_fields: process.env.OVERTURN_DECISION_FIELDS,
  min_draft_chars: process.env.OVERTURN_MIN_DRAFT_CHARS,
});

const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST?.trim() || "0.0.0.0";
const server = createIntercomServer({
  settings,
  apiKey,
  clientSecret: process.env.INTERCOM_CLIENT_SECRET?.trim() || null,
});

server.listen(port, host, () => {
  console.log(`Overturn Intercom app listening on http://${host}:${port}`);
  console.log(`Initialize: POST http://${host}:${port}/intercom/initialize`);
  console.log(`Submit:     POST http://${host}:${port}/intercom/submit`);
});
