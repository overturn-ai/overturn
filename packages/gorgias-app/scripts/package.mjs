// Assembles the deployable Gorgias app: the built handler + the Gorgias integration and widget JSON.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "gorgias"), { recursive: true });
for (const f of ["handler.js", "server.js"]) cpSync(path.join(root, "dist", f), path.join(out, f));
cpSync(path.join(root, "README.md"), path.join(out, "README.md"));
writeFileSync(
  path.join(out, "package.json"),
  `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`,
);

// Placeholders the installer replaces (README.md → Install).
const { integrationBody, widgetTemplate } = await import(
  pathToFileURL(path.join(root, "dist", "setup.js")).href
);
const url = "https://YOUR-HANDLER-HOST";
const secret = "YOUR_WEBHOOK_SECRET";
const write = (name, data) =>
  writeFileSync(path.join(out, "gorgias", name), `${JSON.stringify(data, null, 2)}\n`);
write("integration.json", integrationBody(url, secret));
write("widget.support.json", widgetTemplate(url, secret, { reasonPack: "support" }));
write("widget.claims.json", widgetTemplate(url, secret, { reasonPack: "claims" }));

const zip = "overturn-gorgias-app.zip";
try {
  rmSync(path.join(root, "dist", zip), { force: true });
  execFileSync("zip", ["-qr", path.join(root, "dist", zip), "."], { cwd: out });
  console.log(`dist/${zip}`);
} catch {
  console.log("dist/app (zip not available; deploy the folder as is)");
}
