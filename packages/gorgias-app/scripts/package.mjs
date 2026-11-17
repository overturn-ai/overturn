// Assembles the deployable Gorgias app: the built server, its package.json and the README.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, "dist", "main.js"), path.join(out, "main.js"));
cpSync(path.join(root, "README.md"), path.join(out, "README.md"));
writeFileSync(
  path.join(out, "package.json"),
  `${JSON.stringify({ name: "overturn-gorgias-app", private: true, type: "module", main: "main.js", scripts: { start: "node main.js" }, engines: { node: ">=22" } }, null, 2)}\n`,
);
const name = "overturn-gorgias-app.zip";
try {
  rmSync(path.join(root, "dist", name), { force: true });
  execFileSync("zip", ["-qr", path.join(root, "dist", name), "."], { cwd: out });
  console.log(`dist/${name}`);
} catch {
  console.log("dist/app (zip not available; deploy the folder)");
}
