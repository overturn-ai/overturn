// Assembles the uploadable Gorgias app: the integration, the sidebar widget and their README.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, "app"), out, { recursive: true });

// Gorgias has no upload step: an admin creates the integration and the widget through the REST API.
// scripts/install.mjs posts exactly these two objects, so the zip is what to hand an admin who
// would rather read it first.
const zip = (name) => {
  try {
    rmSync(path.join(root, "dist", name), { force: true });
    execFileSync("zip", ["-qr", path.join(root, "dist", name), "."], { cwd: out });
    console.log(`dist/${name}`);
  } catch {
    console.log("dist/app (zip not available; the folder is the same thing)");
  }
};
zip("overturn-gorgias-app.zip");
