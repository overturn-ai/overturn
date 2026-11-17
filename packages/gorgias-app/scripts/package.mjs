// Assembles the uploadable Gorgias app bundle: manifest + built script.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, "manifest.json"), path.join(out, "manifest.json"));
cpSync(path.join(root, "dist", "main.js"), path.join(out, "main.js"));

try {
  rmSync(path.join(root, "dist", "overturn-gorgias-app.zip"), { force: true });
  execFileSync("zip", ["-qr", path.join(root, "dist", "overturn-gorgias-app.zip"), "."], { cwd: out });
  console.log("dist/overturn-gorgias-app.zip");
} catch {
  console.log("dist/app (zip not available; package folder ready)");
}
