// Assembles the deployable bundle: the built handlers + the app definitions
// (HTTP integration + sidebar widget) + the README, zipped.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, "app"), out, { recursive: true });
for (const f of ["main.js", "main.cjs"]) cpSync(path.join(root, "dist", f), path.join(out, f));
cpSync(path.join(root, "README.md"), path.join(out, "README.md"));

try {
  const name = "overturn-gorgias-app.zip";
  rmSync(path.join(root, "dist", name), { force: true });
  execFileSync("zip", ["-qr", path.join(root, "dist", name), "."], { cwd: out });
  console.log(`dist/${name}`);
} catch {
  console.log("dist/app (zip not available; deploy the folder as-is)");
}
