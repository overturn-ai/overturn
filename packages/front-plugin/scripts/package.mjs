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
  rmSync(path.join(root, "dist", "overturn-front-plugin.zip"), { force: true });
  execFileSync("zip", ["-qr", path.join(root, "dist", "overturn-front-plugin.zip"), "."], { cwd: out });
  console.log("dist/overturn-front-plugin.zip");
} catch {
  console.log("dist/app (zip utility unavailable)");
}
