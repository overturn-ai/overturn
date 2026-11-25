// Assembles the uploadable Intercom Canvas Kit app: manifest + assets + translations + the built script.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "assets"), { recursive: true });
cpSync(path.join(root, "app"), out, { recursive: true });
cpSync(path.join(root, "dist", "main.global.js"), path.join(out, "assets", "main.js"));

const zip = (name) => {
  try {
    rmSync(path.join(root, "dist", name), { force: true });
    execFileSync("zip", ["-qr", path.join(root, "dist", name), "."], { cwd: out });
    console.log(`dist/${name}`);
  } catch {
    console.log("dist/app (zip not available; upload the folder with Intercom CLI)");
  }
};
zip("overturn-intercom-app.zip");
const manifestPath = path.join(out, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, private: false }, null, 2)}\n`);
