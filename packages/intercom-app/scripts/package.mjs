import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, "dist", "main.js"), path.join(out, "main.js"));
cpSync(path.join(root, "README.md"), path.join(out, "README.md"));
// Node must treat the bundled main.js as ESM even outside this monorepo.
cpSync(path.join(root, "package.json"), path.join(out, "package.json"));
const zip = path.join(root, "dist", "overturn-intercom-app.zip");
rmSync(zip, { force: true });
execFileSync("zip", ["-qr", zip, "."], { cwd: out });
console.log("dist/overturn-intercom-app.zip");
