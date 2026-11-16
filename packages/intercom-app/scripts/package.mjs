// Assembles the uploadable Intercom app: manifest + assets + the built bundle.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const out = path.join(dist, "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "assets"), { recursive: true });
if (existsSync(path.join(root, "app"))) {
  cpSync(path.join(root, "app"), out, { recursive: true });
}
for (const file of readdirSync(dist)) {
  if (file.endsWith(".js") || file.endsWith(".cjs") || file.endsWith(".d.ts")) {
    cpSync(path.join(dist, file), path.join(out, file));
  }
}

const zip = (name) => {
  try {
    rmSync(path.join(dist, name), { force: true });
    execFileSync("zip", ["-qr", path.join(dist, name), "."], { cwd: out });
    console.log(`dist/${name}`);
  } catch {
    console.log("dist/app (zip not available; upload the folder)");
  }
};
zip("overturn-intercom-app.zip");
const manifestPath = path.join(out, "manifest.json");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, private: false }, null, 2)}\n`);
  zip("overturn-intercom-app-marketplace.zip");
}
