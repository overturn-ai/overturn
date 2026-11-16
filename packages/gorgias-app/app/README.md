# What goes into a Gorgias helpdesk

Gorgias apps are not uploaded: an admin creates them through the REST API. `scripts/install.mjs`
posts these two objects with the account's own credentials (Settings → REST API) and prints their
ids; the files here are the exact payloads, with the default Overturn host.

- `integration.json` — a custom **HTTP integration**. Gorgias calls its URL whenever a ticket is
  created, updated or gets a message, and the JSON the URL answers with is what the sidebar renders.
  `{{ticket.id}}` is Gorgias' variable syntax: it is substituted at trigger time, so the literal
  braces must stay. A self-hosted deployment replaces the host.
- `widget.json` — the **ticket sidebar widget** that reads that JSON. `integration_id` is filled in
  by the installer; `meta.link` makes a row clickable, which is how a reason is one click.

Docs: [integrations and widgets](https://developers.gorgias.com/docs/create-integrations-and-widgets-programmatically),
[the widget object](https://developers.gorgias.com/reference/the-widget-object).
