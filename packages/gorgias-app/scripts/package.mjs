// Assembles the uploadable Gorgias ticket sidebar widget bundle -> dist/overturn-gorgias-app.zip.

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

const zipPath = path.join(root, "dist", "overturn-gorgias-app.zip");
rmSync(zipPath, { force: true });

try {
  execFileSync("zip", ["-qr", zipPath, "."], { cwd: out });
  console.log("dist/overturn-gorgias-app.zip");
} catch {
  try {
    execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `Compress-Archive -Path '${out}\\*' -DestinationPath '${zipPath}' -Force`],
      { cwd: out },
    );
    console.log("dist/overturn-gorgias-app.zip");
  } catch {
    console.log("dist/app (zip not available; host dist/app directly)");
  }
}
