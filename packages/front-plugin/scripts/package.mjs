// Assembles the Front sidebar plugin: a static page (index.html + style.css + the built script).
// Front loads a plugin from a URL, so the zip is what you put on any static host (or a CDN
// bucket) and point the app's Sidebar Plugin feature at.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "plugin");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, "app"), out, { recursive: true });
cpSync(path.join(root, "dist", "main.global.js"), path.join(out, "main.js"));

const name = "overturn-front-plugin.zip";
try {
  rmSync(path.join(root, "dist", name), { force: true });
  execFileSync("zip", ["-qr", path.join(root, "dist", name), "."], { cwd: out });
  console.log(`dist/${name}`);
} catch {
  console.log("dist/plugin (zip not available; host the folder as is)");
}
