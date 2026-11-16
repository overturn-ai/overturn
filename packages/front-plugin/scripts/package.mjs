// Assembles the hostable plugin bundle: the static page + the built script, zipped.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, "app"), out, { recursive: true });
cpSync(path.join(root, "dist", "main.global.js"), path.join(out, "main.js"));

try {
  const name = "overturn-front-plugin.zip";
  rmSync(path.join(root, "dist", name), { force: true });
  execFileSync("zip", ["-qr", path.join(root, "dist", name), "."], { cwd: out });
  console.log(`dist/${name}`);
} catch {
  console.log("dist/app (zip not available; host the folder as-is)");
}
