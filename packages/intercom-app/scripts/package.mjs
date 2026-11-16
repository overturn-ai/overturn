// Assembles the uploadable Intercom app bundle: the built server, the app config and the README.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, "app"), out, { recursive: true });
cpSync(path.join(root, "dist", "server.js"), path.join(out, "server.js"));
cpSync(path.join(root, "README.md"), path.join(out, "README.md"));

try {
  rmSync(path.join(root, "dist", "overturn-intercom-app.zip"), { force: true });
  execFileSync("zip", ["-qr", path.join(root, "dist", "overturn-intercom-app.zip"), "."], { cwd: out });
  console.log("dist/overturn-intercom-app.zip");
} catch {
  console.log("dist/app (zip not available; deploy the folder)");
}
