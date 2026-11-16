// Assembles the uploadable Front plugin: manifest + assets + the built script.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "plugin");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, "plugin"), out, { recursive: true });
cpSync(path.join(root, "dist", "main.global.js"), path.join(out, "main.js"));

const zip = (name) => {
  try {
    rmSync(path.join(root, "dist", name), { force: true });
    execFileSync("zip", ["-qr", path.join(root, "dist", name), "."], { cwd: out });
    console.log(`dist/${name}`);
  } catch {
    console.log("dist/plugin (zip not available; upload the folder directly)");
  }
};
zip("overturn-front-plugin.zip");
