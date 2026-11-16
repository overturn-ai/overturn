// Registers the Overturn app in a Gorgias helpdesk: the HTTP integration first, then the widget
// that reads its response. Idempotent per run only; run it once per helpdesk.

import { installConfigFrom, installGorgiasApp } from "../dist/install.js";

const config = installConfigFrom(process.env);
const { integrationId, widgetId } = await installGorgiasApp({
  creds: config.gorgias,
  appUrl: config.appUrl,
  settings: config.settings,
  token: config.token,
});
console.log(`integration ${integrationId}, widget ${widgetId} created in ${config.gorgias.domain}`);
console.log(`open a ticket in Gorgias: the Overturn card is in the right-hand sidebar`);
